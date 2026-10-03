import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config.js";
import { AnytypeClient } from "./anytype/client.js";
import { resolveBotParticipantId } from "./anytype/members.js";
import { extractDiscussionId } from "./anytype/discussion.js";
import { subscribeChat } from "./anytype/stream.js";
import { createPiClient, ensureAgentFiles, ensureModelsConfig, ensureSkillsConfig, ensureWorkflowsConfig } from "./agent/pi-session.js";
import { ApprovalGate } from "./agent/approval.js";
import type { ApprovalMode } from "./agent/approval.js";
import { SessionManager } from "./session/manager.js";
import { sanitize } from "./util/sanitize.js";
import { Router } from "./router/router.js";
import { shouldTrigger, stripBotMention } from "./router/rules.js";
import { parseCommand } from "./commands/parse.js";
import { handleCommand, type CommandContext } from "./commands/handler.js";
import { WorkflowRunStore } from "./workflow/store.js";
import { runWorkflow, type RunEvent } from "./workflow/runner.js";
import { findWorkflow, listWorkflows, loadWorkflow } from "./workflow/registry.js";
import type { StepContext } from "./workflow/steps.js";
import { ReplySink } from "./reply/sink.js";
import { WatchStore } from "./watch/store.js";
import { pollDueWatches } from "./watch/scheduler.js";
import { cronMatches } from "./watch/cron.js";
import { readConsole } from "./console/console-store.js";
import { HeartGrpc } from "./anytype/grpc.js";
import { bootstrapFromLink, botOneToOneLink, newRequestKey } from "./console/bootstrap.js";
import type { ChatTarget, NormalizedEvent } from "./types.js";

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
  // Copy the baked-in pi skills (docker/skills/) into the agent dir, same
  // volume-mount workaround as models.json.
  ensureSkillsConfig(agentDir);
  ensureWorkflowsConfig(agentDir);

  // The global-console space: one space with cross-space read powers and a
  // shared workspace. Stage 1 has no auto-bootstrap — a human writes
  // `/workspace/console.json` or sets CONSOLE_SPACE_ID. Env wins over the file.
  const consoleFile = path.join(cfg.agentWorkspaceRoot, "console.json");
  const consoleRec = readConsole(consoleFile);
  const consoleSpaceId = cfg.consoleSpaceId ?? consoleRec?.spaceId;
  const isConsoleSpace = (spaceId: string): boolean => !!consoleSpaceId && spaceId === consoleSpaceId;

  // Heart gRPC client + the link-driven bootstrap, shared by `/join` and the
  // `anytype_join_space` tool. The client is lazy (connects on first call).
  const grpcClient = new HeartGrpc({});
  const joinSpace = async (link: string): Promise<{ ok: boolean; message: string }> => {
    // Whether a console was already configured BEFORE this call (env or console.json).
    const hadConsole = !!consoleSpaceId;
    const r = await bootstrapFromLink(grpcClient, link, consoleFile);
    if (!r.ok) return { ok: false, message: `失败：${r.error}` };
    if (r.kind === "onetoone") {
      return hadConsole
        ? { ok: true, message: `控制台已接入（空间 ${r.spaceId}）` }
        : {
            ok: true,
            message:
              `已接入控制台（空间 ${r.spaceId}）。` +
              `重启 bot 容器后生效（用你的合并 compose：docker compose -f docker-compose.yml -f <bot>/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot）。`,
          };
    }
    return { ok: true, message: "已加入空间（邀请链接）。bot 会自动发现并订阅它。" };
  };

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

  // Each chat's persisted JSONL lives here; /new deletes it so history is gone.
  const chatSessionDirFor = (chatId: string): string | undefined =>
    cfg.sessionPersist ? path.join(cfg.agentWorkspaceRoot, "sessions", sanitize(chatId)) : undefined;

  const sessions: SessionManager = new SessionManager({
    maxConcurrent: cfg.maxConcurrentSessions,
    idleMs: cfg.idleReapMs,
    // Initial approval mode for a chat that never had one set (env APPROVAL_MODE).
    defaultApprovalMode: cfg.approvalMode,
    // After /new: drop this chat's persisted session files so the fresh session
    // neither resumes nor leaves stale history on disk.
    clearHistory: async (chatId) => {
      const dir = chatSessionDirFor(chatId);
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
    createClient: async (chatId) => {
      const spaceId = chatTargets.get(chatId)?.spaceId ?? "unknown";
      // The console session shares one global workspace (`_global`) rather than
      // a per-space dir, so its memory covers every space.
      const consoleSession = isConsoleSpace(spaceId);
      const dir = consoleSession
        ? path.join(cfg.agentWorkspaceRoot, "_global")
        : workspaceFor(cfg.agentWorkspaceRoot, spaceId);
      // Seed a per-space AGENTS.md/MEMORY.md contract before the session starts
      // (pi auto-loads AGENTS.md from cwd at session creation).
      ensureAgentFiles(dir);
      // Give each chat its own persistent session dir so its conversation
      // history is written to disk (JSONL) and resumed after a restart. When
      // SESSION_PERSIST=false we pass nothing and the session stays in-memory.
      // After /new, resumeFor() is false once → the new session starts fresh.
      const chatSessionDir = chatSessionDirFor(chatId);
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
        lightpandaBin: cfg.webFetchBin,
        webFetchTimeoutMs: cfg.webFetchTimeoutMs,
        webFetchMaxChars: cfg.webFetchMaxChars,
        maxSubagents: cfg.maxSubagents,
        subagentIdleMs: cfg.subagentIdleMs,
        chatSessionDir,
        resume: sessions.resumeFor(chatId),
        isConsole: consoleSession,
        agentWorkspaceRoot: cfg.agentWorkspaceRoot,
        // The console session gets the join implementation (drives
        // `anytype_join_space`); passed through only when it is a console.
        ...(consoleSession ? { console: { workspaceRoot: cfg.agentWorkspaceRoot, joinSpace } } : {}),
        // A brand-new client adopts the chat's current interrupt policy, so a
        // policy set via /interrupt survives an idle-reap/rebuild.
        interruptPolicy: sessions.getInterruptPolicy(chatId),
        // Wire this chat's approval gate (ask mode) and its current mode, so a
        // mode set via /yolo survives an idle-reap/rebuild.
        approvalGate: gateFor({ spaceId, chatId }),
        approvalMode: consoleSession ? "readonly" : sessions.getApprovalMode(chatId),
        // Console lock (unlocked by /yolo auto): gates whether the console can
        // dispatch workers. Ignored by normal sessions.
        consoleUnlocked: sessions.getConsoleUnlocked(chatId),
      });
    },
  });

  // Monotonic nonce so two sends in the same millisecond (e.g. consecutive
  // answer lines, or two status bubbles) never share an idempotency key — a
  // collision would make the Anytype API dedupe one away.
  let sendSeq = 0;

  const sink = new ReplySink({
    maxLen: cfg.replyMaxLen,
    send: (target, text, key) => api.sendMessage(target.spaceId, target.chatId, text, key),
    keyFor: (target) => `${target.chatId}-${Date.now()}-${++sendSeq}`,
  });

  // One approval gate per chat; its `post` writes the prompt into that chat.
  // The gate is created lazily on first client build and reused across rebuilds,
  // so a pending /approve-all decision is remembered for the chat's lifetime.
  const gates = new Map<string, ApprovalGate>();
  const gateFor = (target: ChatTarget): ApprovalGate => {
    let g = gates.get(target.chatId);
    if (!g) {
      g = new ApprovalGate({
        timeoutMs: cfg.approvalTimeoutMs,
        post: (text) =>
          api.sendMessage(
            target.spaceId,
            target.chatId,
            text,
            `approval-${target.chatId}-${Date.now()}`,
          ),
      });
      gates.set(target.chatId, g);
    }
    return g;
  };

  // Live tool-call status transport: post a placeholder that returns its id so
  // the Router can edit it as tools run and delete it when the turn ends. Only
  // wired when TOOL_STATUS is on.
  const status = cfg.toolStatus
    ? {
        post: (t: ChatTarget, text: string) =>
          api.sendMessageReturningId(t.spaceId, t.chatId, text, `status-${t.chatId}-${Date.now()}-${++sendSeq}`),
        edit: (t: ChatTarget, id: string, text: string) =>
          api.editMessage(t.spaceId, t.chatId, id, text),
        remove: (t: ChatTarget, id: string) => api.deleteMessage(t.spaceId, t.chatId, id),
      }
    : undefined;

  const router = new Router({
    botName: cfg.botDisplayName,
    run: (_spaceId, chatId, prompt, onProgress) => sessions.run(chatId, prompt, onProgress),
    send: (target, text) => sink.send(target, text),
    ...(status ? { status, statusDelayMs: cfg.toolStatusDelayMs } : {}),
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

  // Workflow run plumbing shared by the manual (`/run`) path and the cron
  // trigger below. Hoisted to main scope so BOTH use the SAME run store, step
  // context factory and status emitter — never re-created per call.
  const runStore = new WorkflowRunStore(cfg.workflowRunDir);
  // Build a StepContext for the chat that TRIGGERED a run: its `agent` steps run
  // one-shot children bound to each step's target space, via the same runInSpace
  // the console worker uses (strict resolve; unknown -> throw).
  const stepCtxFor = (chatId: string): StepContext => ({
    api,
    spaceId: chatTargets.get(chatId)?.spaceId ?? "",
    workspaceDir: cfg.agentWorkspaceRoot,
    runAgent: async (space, prompt) => {
      const c = await sessions.ensure(chatId);
      if (!c.runInSpace) throw new Error("runInSpace unavailable on client");
      return c.runInSpace(space, prompt);
    },
    approve: async ({ tool, detail }) => {
      const spaceId = chatTargets.get(chatId)?.spaceId ?? "";
      // The console is read-only until unlocked via /yolo auto (spec §7).
      if (isConsoleSpace(spaceId)) return sessions.getConsoleUnlocked(chatId);
      const mode = sessions.getApprovalMode(chatId);
      if (mode === "auto") return true;
      if (mode === "readonly") return false;
      return gateFor({ spaceId, chatId }).request(tool, detail); // ask → prompt in the chat
    },
  });
  function formatRunEvent(e: RunEvent): string {
    const head = `▶ ${e.runId} ${e.name}`;
    switch (e.status) {
      case "run-start": return `${head} · 开始`;
      case "running": return e.stepId ? `▶ ${e.stepId} …` : head;
      case "skipped": return `⏭ ${e.stepId}`;
      case "failed": return `❌ ${e.stepId}: ${e.detail ?? ""}`;
      case "done": return e.stepId ? `✅ ${e.stepId}${e.detail ? ` → ${e.detail.split(/\r?\n/)[0].slice(0, 120)}` : ""}` : `${head} · ✅ 完成`;
      default: return `${head} · ${e.status}`;
    }
  }
  // Lifecycle events go to the status board ONLY when WORKFLOW_STATUS_CHAT is set
  // AND that chat was discovered (so we know its space). No auto-create.
  const emitRun = (e: RunEvent): void => {
    const chatId = cfg.workflowStatusChat;
    if (!chatId) return;
    const spaceId = chatTargets.get(chatId)?.spaceId;
    if (!spaceId) return;
    void api.sendMessage(spaceId, chatId, formatRunEvent(e), `wf-${e.runId}-${e.stepId ?? e.status}-${++sendSeq}`).catch((err) => console.warn(`workflow status post failed: ${String(err)}`));
  };

  const onEvent = (e: NormalizedEvent): void => {
    void (async () => {
      if (e.objectId) e.contextNote = await discussionContext(e);

      // Slash commands are handled by the bridge (never forwarded to the
      // agent). They only apply to messages that would otherwise trigger a turn
      // (DM or @-mention), and never to the bot's own messages.
      if (shouldTrigger(e)) {
        const stripped = stripBotMention(e.text, cfg.botDisplayName) || e.text;
        const parsed = parseCommand(stripped);
        if (parsed) {
          const doRun = async (chatId: string, name: string, args: string, resumeRunId?: string): Promise<{ ok: boolean; message: string }> => {
            const entry = findWorkflow(cfg.workflowDir, name);
            if (!entry) {
              const avail = listWorkflows(cfg.workflowDir).map((e) => e.name).join(", ") || "无";
              return { ok: false, message: `未知工作流：${name}（可用：${avail}）` };
            }
            try {
              const def = loadWorkflow(entry);
              const spaceId = chatTargets.get(chatId)?.spaceId ?? "";
              const state = await runWorkflow(def, {
                store: runStore, ctx: stepCtxFor(chatId), chatId, spaceId,
                trigger: resumeRunId ? "resume" : "manual",
                ...(resumeRunId ? { resumeRunId } : {}),
                emit: emitRun,
                scope: { env: {} },
              });
              return { ok: state.status === "done", message: `工作流 ${name} ${state.status === "done" ? "✅ 完成" : "❌ " + state.status}（run ${state.id}）` };
            } catch (err) {
              return { ok: false, message: `工作流失败：${err instanceof Error ? err.message : String(err)}` };
            }
          };
          const listRuns = (): { id: string; name: string; status: string; when: string }[] => {
            try {
              return fs.readdirSync(cfg.workflowRunDir)
                .map((id) => runStore.load(id))
                .filter((s): s is NonNullable<typeof s> => !!s)
                .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
                .slice(0, 10)
                .map((s) => ({ id: s.id, name: s.name, status: s.status, when: s.createdAt }));
            } catch { return []; }
          };
          const ctx: CommandContext = {
            chatId: e.chatId,
            getClient: () => sessions.get(e.chatId),
            ensureClient: () => sessions.ensure(e.chatId),
            reset: () => sessions.reset(e.chatId),
            defaultModel: cfg.piModel,
            getInterruptPolicy: () => sessions.getInterruptPolicy(e.chatId),
            setInterruptPolicy: (p) => sessions.setInterruptPolicy(e.chatId, p),
            // /join changes global state (joins a space / rewires the console), so
            // only allow it from a PRIVATE (2-person) chat — never from a
            // multi-member shared space, where any member could otherwise make the
            // bot join an attacker-controlled space or hijack the console.
            joinSpace: e.isDirect
              ? joinSpace
              : async () => ({ ok: false, message: "／join 只能在私聊或控制台（两人空间）里使用。" }),
            getApprovalMode: () => sessions.getApprovalMode(e.chatId),
            setApprovalMode: (mode) => sessions.setApprovalMode(e.chatId, mode),
            approvePending: (kind) => sessions.approvePending(e.chatId, kind),
            runWorkflow: (name, args, resumeRunId) => doRun(e.chatId, name, args, resumeRunId),
            listRuns: () => listRuns(),
            isConsole: isConsoleSpace(e.spaceId),
            getConsoleUnlocked: () => sessions.getConsoleUnlocked(e.chatId),
            setConsoleUnlocked: (on) => sessions.setConsoleUnlocked(e.chatId, on),
          };
          const reply = await handleCommand(parsed.command, parsed.args, ctx);
          if (reply && reply.trim().length > 0) {
            await api.sendMessage(e.spaceId, e.chatId, reply, `${e.chatId}-cmd-${Date.now()}`);
          }
          return;
        }
      }

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

  // No console configured yet: print the bot's own 1:1 link (best-effort) so a
  // human can connect one, or send the bot a link to /join.
  if (!consoleSpaceId) {
    const botId = cfg.botIdentity ?? "(bot identity unknown)";
    const link = botOneToOneLink(botId, newRequestKey());
    console.log(
      `\n=== 控制台未设置 ===\n把你的 1:1 链接发给 bot（或运行 /join <链接>）即可接入控制台。\n` +
        `（bot 侧链接，打开后可能仍需把你自己链接回贴一次：${link}）\n`,
    );
  }

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

  // Workflow cron: each workflow whose `on.cron` matches the current local minute
  // runs once (guarded per workflow per minute). This is an INDEPENDENT timer,
  // separate from the object-watch scheduler above; it never touches `watchTimer`
  // state. A single unparseable workflow is skipped, never crashing the tick.
  const wfFiredMinute = new Map<string, string>();
  const wfTimer = setInterval(() => {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
    for (const entry of listWorkflows(cfg.workflowDir)) {
      let def;
      try { def = loadWorkflow(entry); } catch { continue; }
      const cron = def.on?.cron;
      if (!cron || !cronMatches(cron, now)) continue;
      if (wfFiredMinute.get(entry.name) === key) continue;
      wfFiredMinute.set(entry.name, key);
      const notify = def.on?.notify ?? "";
      if (!notify) console.warn(`workflow cron '${entry.name}' has no on.notify — result will not be posted`);
      void (async () => {
        try {
          const state = await runWorkflow(def, {
            store: runStore,
            ctx: stepCtxFor(notify),
            chatId: notify,
            spaceId: chatTargets.get(notify)?.spaceId ?? "",
            trigger: "cron",
            emit: emitRun,
            scope: { env: {} },
          });
          // Post the run RESULT to the chat it was scheduled for (spec §6: cron
          // result → on.notify), mirroring the manual path's command reply.
          const spaceId = notify ? chatTargets.get(notify)?.spaceId : undefined;
          if (!spaceId) return;
          const last = [...state.steps].reverse().find((s) => s.output && s.output.trim());
          const headline = `工作流 ${def.name} ${state.status === "done" ? "✅ 完成" : "❌ " + state.status}`;
          const body = last?.output ? `\n${last.output}` : "";
          await api
            .sendMessage(spaceId, notify, headline + body, `wf-${state.id}-result-${++sendSeq}`)
            .catch((err) => console.warn(`workflow cron result post failed: ${String(err)}`));
        } catch (err) {
          console.warn(`workflow cron '${entry.name}' failed: ${String(err)}`);
        }
      })();
    }
  }, cfg.watchTickMs);

  const shutdown = async (): Promise<void> => {
    controller.abort();
    clearInterval(reaper);
    clearInterval(discoverTimer);
    clearInterval(watchTimer);
    clearInterval(wfTimer);
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
