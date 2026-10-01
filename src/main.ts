import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { AnytypeClient } from "./anytype/client.js";
import { resolveBotParticipantId } from "./anytype/members.js";
import { subscribeChat } from "./anytype/stream.js";
import { OmpClient } from "./omp/client.js";
import { SessionManager } from "./session/manager.js";
import { Router } from "./router/router.js";
import { ReplySink } from "./reply/sink.js";
import type { NormalizedEvent } from "./types.js";

/** omp memory scope is per-SPACE: one workspace directory per space id. */
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
      const dir = workspaceFor(cfg.ompWorkspaceRoot, spaceId);
      fs.mkdirSync(dir, { recursive: true });
      return OmpClient.spawn({
        bin: cfg.ompBin,
        args: ["--mode", "rpc", "--no-session", "--name", `chat-${chatId}`],
        cwd: dir,
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

  const onEvent = (e: NormalizedEvent): void => {
    void router.handle(e);
  };

  // Discover spaces -> chats and subscribe to each chat's SSE stream.
  // Captured ONCE before any subscription: the stream replays recent history as
  // `message_added` on connect, and any message older than this start instant is
  // backlog we must not answer. One shared timestamp keeps every subscription
  // consistent regardless of discovery order.
  const startedAt = new Date().toISOString();
  const spaces = await api.listSpaces();
  let subscriptions = 0;
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
      subscriptions++;
      console.log(`subscribed space=${space.id} chat=${chat.id} direct=${isDirect}`);
    }
  }
  console.log(
    `started: ${spaces.length} space(s), ${chatTargets.size} chat(s), ${subscriptions} subscription(s)`,
  );

  const reaper = setInterval(() => {
    void sessions.reapIdle();
  }, Math.min(cfg.idleReapMs, 60000));

  const shutdown = async (): Promise<void> => {
    controller.abort();
    clearInterval(reaper);
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
