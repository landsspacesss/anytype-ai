import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config.js";
import { AnytypeClient } from "./anytype/client.js";
import { resolveBotParticipantId } from "./anytype/members.js";
import { extractDiscussionId } from "./anytype/discussion.js";
import { subscribeChat } from "./anytype/stream.js";
import { createPiClient, ensureAgentFiles, ensureModelsConfig } from "./agent/pi-session.js";
import { SessionManager } from "./session/manager.js";
import { Router } from "./router/router.js";
import { ReplySink } from "./reply/sink.js";
import { WatchStore } from "./watch/store.js";
import { pollDueWatches } from "./watch/scheduler.js";
import type { NormalizedEvent } from "./types.js";

/** Agent memory scope is per-SPACE: one workspace directory per space id. */
function workspaceFor(root: string, spaceId: string): string {
  return path.join(root, spaceId);
}

interface ChatInfo {
  spaceId: string;
  chatId: string;
  objectId?: string;
  isDirect: boolean;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Register the custom model (DeepSeek V4.1 = `deepseek-flash`) into pi's agent
  // dir. The dir is a volume mount, so this can't be baked into the image.
  const agentDir = cfg.piAgentDir ?? path.join(os.homedir(), ".pi", "agent");
  ensureModelsConfig(agentDir);
  const api = new AnytypeClient({ baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey });
  const controller = new AbortController();

  // Populated during discovery; createClient needs the chat's space to pick a
  // workspace, so this map must be filled before any event can arrive.
  const chatTargets = new Map<string, ChatInfo>();

  // Durable object-change subscriptions, persisted under the workspace root so
  // they survive restarts. Loaded once at boot; the poll loop below keeps them
  // fresh. (Anytype has no object event stream, so we poll + diff.)
  const watchStore = new WatchStore(path.join(cfg.agentWorkspaceRoot, "watches.json"), cfg.watchDefaultCron);
  watchStore.load();

  const sessions = new SessionManager({
    maxConcurrent: cfg.maxConcurrentSessions,
    idleMs: cfg.idleReapMs,
    createClient: async (chatId) => {
      const spaceId = chatTargets.get(chatId)?.spaceId ?? "unknown";
      const dir = workspaceFor(cfg.agentWorkspaceRoot, spaceId);
      // Seed a per-space AGENTS.md/MEMORY.md contract before the session starts
      // (pi auto-loads AGENTS.md from cwd at session creation).
      ensureAgentFiles(dir);
      return createPiClient({
        cwd: dir,
        agentDir: cfg.piAgentDir,
        api,
        spaceId,
        store: watchStore,
        chatId,
        defaultWatchCron: cfg.watchDefaultCron,
        modelId: cfg.piModel,
        searchApiKey: cfg.searchApiKey,
        searchModel: cfg.searchModel,
      });
    },
  });

  const sink = new ReplySink({
    maxLen: cfg.replyMaxLen,
    send: (target, text, key) => api.sendMessage(target.spaceId, target.chatId, text, key),
    keyFor: (target) => `${target.chatId}-${Date.now()}`,
  });

  const router = new Router({
    botName: cfg.botDisplayName,
    run: (_spaceId, chatId, prompt) => sessions.run(chatId, prompt),
    send: (target, text) => sink.send(target, text),
  });

  // Cache of object id -> display name, used to tell the agent which page a
  // discussion comment belongs to.
  const objectNames = new Map<string, string>();
  async function discussionContext(e: NormalizedEvent): Promise<string | undefined> {
    if (!e.objectId) return undefined;
    let name = objectNames.get(e.objectId);
    if (name === undefined) {
      try {
        const doc = (await api.getObjectRaw(e.spaceId, e.objectId)) as
          | { properties?: { name?: unknown } }
          | null;
        const n = doc?.properties?.name;
        name = typeof n === "string" ? n : "";
      } catch {
        name = "";
      }
      objectNames.set(e.objectId, name);
    }
    const label = name ? `「${name}」` : `（id ${e.objectId}）`;
    return (
      `（上下文：你正在 Anytype 页面 ${label} 的「讨论区」，这条消息是针对该页面的评论。` +
      `需要了解页面内容时，用 anytype_read_object 读取对象 ${e.objectId}。）`
    );
  }

  const onEvent = (e: NormalizedEvent): void => {
    void (async () => {
      if (e.objectId) e.contextNote = await discussionContext(e);
      await router.handle(e);
    })().catch((err) => console.warn(`handle failed: ${String(err)}`));
  };

  // Captured ONCE before any subscription: the stream replays recent history as
  // `message_added` on connect, and any message older than this start instant is
  // backlog we must not answer. One shared timestamp keeps every subscription
  // consistent regardless of discovery order.
  const startedAt = new Date().toISOString();
  const subscribed = new Set<string>(); // chat/discussion ids already subscribed
  const checkedObjects = new Set<string>(); // object ids whose discussion we've examined

  // Discover spaces -> chats and subscribe to any chat not yet subscribed.
  // Runs at startup AND periodically, so chats created after boot are picked up
  // without a restart. Overlapping runs are skipped.
  let discovering = false;
  async function discover(): Promise<void> {
    if (discovering) return;
    discovering = true;
    try {
      const spaces = await api.listSpaces();
      for (const space of spaces) {
        const members = await api.listMembers(space.id).catch((err) => {
          console.warn(`listMembers failed for space ${space.id}: ${String(err)}`);
          return [];
        });

        // The bot's participant id is space-scoped; resolve it from this space's
        // member list by identity, falling back to the configured constant.
        let botParticipantId = cfg.botParticipantId;
        if (cfg.botIdentity) {
          const resolved = resolveBotParticipantId(members, cfg.botIdentity);
          if (!resolved) {
            console.warn(`bot identity not found in space ${space.id}; skipping`);
            continue;
          }
          botParticipantId = resolved;
        }

        const isDirect = members.length <= 2;

        const chats = await api.listChats(space.id).catch((err) => {
          console.warn(`listChats failed for space ${space.id}: ${String(err)}`);
          return [];
        });
        for (const chat of chats) {
          if (subscribed.has(chat.id)) continue;
          subscribed.add(chat.id);
          chatTargets.set(chat.id, { spaceId: space.id, chatId: chat.id, isDirect });
          void subscribeChat(
            {
              baseUrl: cfg.apiBaseUrl,
              apiKey: cfg.apiKey,
              spaceId: space.id,
              chatId: chat.id,
              isDirect,
              botParticipantId,
              since: startedAt,
              onEvent,
            },
            controller.signal,
          );
          console.log(`subscribed space=${space.id} chat=${chat.id} direct=${isDirect}`);
        }

        // Page/object Discussions are chats too, but `listChats` does not include
        // them — discover them from the object list (each object exposes its
        // discussion id). Each discussion gets its own chat_id, so it is its own
        // conversation context. Only real objects hold a discussion, so absent
        // ids are simply skipped.
        const objects = await api.listObjects(space.id).catch((err) => {
          console.warn(`listObjects failed for space ${space.id}: ${String(err)}`);
          return [];
        });
        for (const obj of objects) {
          if (checkedObjects.has(obj.id)) continue;
          checkedObjects.add(obj.id);
          const doc = await api.getObjectRaw(space.id, obj.id).catch(() => null);
          const discussionId = extractDiscussionId(doc);
          if (!discussionId || subscribed.has(discussionId)) continue;
          subscribed.add(discussionId);
          chatTargets.set(discussionId, {
            spaceId: space.id,
            chatId: discussionId,
            objectId: obj.id,
            isDirect: false,
          });
          void subscribeChat(
            {
              baseUrl: cfg.apiBaseUrl,
              apiKey: cfg.apiKey,
              spaceId: space.id,
              chatId: discussionId,
              isDirect: false,
              objectId: obj.id,
              botParticipantId,
              since: startedAt,
              onEvent,
            },
            controller.signal,
          );
          console.log(`subscribed discussion object=${obj.id} chat=${discussionId}`);
        }
      }
      console.log(`discovery: ${chatTargets.size} chat(s)/discussion(s) subscribed`);
    } finally {
      discovering = false;
    }
  }

  await discover();

  // Re-scan periodically so newly created chats are subscribed automatically.
  const discoverTimer = setInterval(() => {
    void discover().catch((err) => console.warn(`discovery failed: ${String(err)}`));
  }, 60000);

  const reaper = setInterval(() => {
    void sessions.reapIdle();
  }, Math.min(cfg.idleReapMs, 60000));

  // Tick the cron scheduler: each watch is checked only when its own cron
  // matches the current (local) minute. Overlapping runs are skipped (same guard
  // style as `discovering`). A freshly added watch is already baselined by the
  // tool, so it does not notify on the first check.
  let polling = false;
  const watchTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    void pollDueWatches({
      store: watchStore,
      api,
      maxMisses: cfg.watchMaxMisses,
      // A watch may carry a user-defined `prompt`. When it does, a change runs
      // an agent turn in that watch's chat (the agent reads the object itself
      // and follows the instruction), then posts the reply. Without a prompt we
      // keep the old behavior: post the raw diff summary.
      notify: async (rec, text) => {
        const prompt = rec.prompt?.trim();
        console.log(`watch fire: '${rec.label}' (prompt? ${prompt ? "yes" : "no"}) -> chat ${rec.chatId}`);
        const key = `watch-${rec.objectId}-${Date.now()}`;
        if (prompt) {
          try {
            const trigger =
              `（定时检查：你订阅的对象「${rec.label}」发生了变化。${text}\n` +
              `请按用户要求处理：${prompt}\n` +
              `可先用 anytype_read_object 读取对象 ${rec.objectId} 了解最新内容。）`;
            const reply = await sessions.run(rec.chatId, trigger);
            if (reply.trim()) {
              await api.sendMessage(rec.spaceId, rec.chatId, reply, key);
            } else {
              console.warn(`watch agent run for '${rec.label}' produced an empty reply`);
            }
          } catch (err) {
            console.warn(`watch agent run failed for '${rec.label}': ${String(err)}`);
          }
        } else {
          await api.sendMessage(rec.spaceId, rec.chatId, text, key);
        }
      },
    })
      .catch((err) => console.warn(`watch poll failed: ${String(err)}`))
      .finally(() => {
        polling = false;
      });
  }, cfg.watchTickMs);

  const shutdown = async (): Promise<void> => {
    controller.abort();
    clearInterval(reaper);
    clearInterval(discoverTimer);
    clearInterval(watchTimer);
    await sessions.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
