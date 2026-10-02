import path from "node:path";
import { loadConfig } from "./config.js";
import { AnytypeClient } from "./anytype/client.js";
import { resolveBotParticipantId } from "./anytype/members.js";
import { subscribeChat } from "./anytype/stream.js";
import { createPiClient, ensureAgentFiles } from "./agent/pi-session.js";
import { SessionManager } from "./session/manager.js";
import { Router } from "./router/router.js";
import { ReplySink } from "./reply/sink.js";
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
  const api = new AnytypeClient({ baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey });
  const controller = new AbortController();

  // Populated during discovery; createClient needs the chat's space to pick a
  // workspace, so this map must be filled before any event can arrive.
  const chatTargets = new Map<string, ChatInfo>();

  const sessions = new SessionManager({
    maxConcurrent: cfg.maxConcurrentSessions,
    idleMs: cfg.idleReapMs,
    createClient: async (chatId) => {
      const spaceId = chatTargets.get(chatId)?.spaceId ?? "unknown";
      const dir = workspaceFor(cfg.agentWorkspaceRoot, spaceId);
      // Seed a per-space AGENTS.md/MEMORY.md contract before the session starts
      // (pi auto-loads AGENTS.md from cwd at session creation).
      ensureAgentFiles(dir);
      return createPiClient({ cwd: dir, agentDir: cfg.piAgentDir, api, spaceId });
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

  const onEvent = (e: NormalizedEvent): void => {
    void router.handle(e);
  };

  // Captured ONCE before any subscription: the stream replays recent history as
  // `message_added` on connect, and any message older than this start instant is
  // backlog we must not answer. One shared timestamp keeps every subscription
  // consistent regardless of discovery order.
  const startedAt = new Date().toISOString();
  const subscribed = new Set<string>(); // chat ids already subscribed

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
      }
      console.log(`discovery: ${chatTargets.size} chat(s) subscribed`);
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

  const shutdown = async (): Promise<void> => {
    controller.abort();
    clearInterval(reaper);
    clearInterval(discoverTimer);
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
