# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`anytype-ai` — a standalone service that puts a Notion-like AI assistant inside a
**self-hosted Anytype** network. A bot account joins spaces; when @-mentioned (or in
a DM) it runs an agent turn and posts the reply back into the Anytype chat.

It is **its own container**, decoupled from the Anytype server: it talks to the
`anytype-cli` HTTP API and does **not** modify the `any-sync-dockercompose` stack.
The only coupling is that the Anytype side must have the `anytype-cli` service
enabled (it serves the local API on `:31012`).

## Commands

```bash
npm install
npm run build            # tsc -> dist/
npm test                 # vitest run (whole suite, ~330 tests)
npx vitest run test/router.test.ts                    # one file
npx vitest run -t "posts once, coalesces edits"       # one test by name
npm run test:watch
```

Deploy (build image, then recreate **only the bot** so unrelated any-sync services
aren't touched). The bot must run **merged into the any-sync compose project** so
`network_mode: service:anytype-cli` resolves:

```bash
docker build -t anytype-ai-bot:latest .
cd /path/to/any-sync-dockercompose
docker compose -f docker-compose.yml -f /path/to/anytype-ai-bot/docker-compose.bot.yml \
  up -d --force-recreate --no-deps ai-bot
```

`.env` changes need `--force-recreate` (env is read at container start). See
`docs/RUNBOOK.md` for operations and `README.md` / `README.zh-CN.md` for users.

## Architecture

```
Anytype chat ──SSE──► bridge (this repo) ──► embedded pi AgentSession (in-process)
                          │                         └─ tools: anytype_* / web_* / agent
                          └── posts the reply back via the Anytype HTTP API
```

**`src/main.ts` is the whole wiring.** Reading it top-to-bottom explains the system:
config → `WatchStore` → `SessionManager` (our per-chat client pool) → `Router` (+
optional live-status transport) → `onEvent` (per inbound message) → `discover()`
(finds spaces/chats/discussions and opens an SSE stream per chat) → three intervals
(discovery re-scan, idle session reaper, cron watch scheduler) → shutdown.

Flow of one message: `src/anytype/stream.ts` (SSE) → `src/anytype/events.ts`
(`normalizeMessage`) → `main.onEvent` → slash-command check (`src/commands`) else
`Router.handle` (`src/router/router.ts`) → `SessionManager.run(chatId, prompt, onProgress)`
→ `src/agent/pi-session.ts` `createPiClient` (embedded pi SDK) → reply.

Key facts that span multiple files:

- **The agent runs in-process via the pi SDK** (`@earendil-works/pi-coding-agent`),
  not a subprocess. `createPiClient` builds an `AgentSession` with our custom tools,
  subscribes to its events (collecting `text_delta`, forwarding tool/thinking events
  as `AgentProgress`), and exposes the `ManagedClient` interface (`src/session/manager.ts`).
- **Live chat output is a sequence of bubbles, not one status line.**
  `AgentProgress` gained a `narration` kind; `pi-session` runs streamed text through a
  `TextSegmenter` so narration (text before a tool) is separated from the answer (the
  last segment). `src/reply/status.ts` `StatusReporter` is a sequence of rotating
  bubbles — a narration edits the current bubble in place, a following tool opens a
  new one — and `finish(reply)` drops every transient bubble, then `sendLines` posts
  one message per (non-blank) line.
- **Tools live in `src/agent/anytype-tools.ts`** (one big `createAnytypeTools(deps)`),
  with `web-search.ts`, `web-fetch.ts`, `subagents.ts` alongside. Child (sub)agent
  sessions are built with the same tools but **without** `runSubagent`/`agentRegistry`,
  so they cannot recurse.
- **Scope model:** the workspace dir is per **space** (`/workspace/<spaceId>/` holds
  `AGENTS.md`, `MEMORY.md`, `files/`, `images/`), but the conversation is per **chat**
  (its persisted JSONL lives in `/workspace/sessions/<chatId>/`). Memory is shared
  across a space's chats; conversation history is not.
- **The console (global assistant) is one designated space that gets global powers.**
  `main.ts` picks it from `CONSOLE_SPACE_ID` (env, wins) or `<workspaceRoot>/console.json`
  (`{spaceId, chatId?, bootstrappedAt}`). A console session gets `CONSOLE_TOOLS` — an
  **unconditionally read-only** set (no writers — its own set stays read-only in
  every mode) plus
  `anytype_list_spaces` / `anytype_memories` and a `space` (id or name) param on the
  read tools (`anytype_list_objects` / `anytype_search` / `anytype_read_object`) so it
  can read from **any** joined space. Its workspace is `/workspace/_global` (its memory
  is the global one); **normal sessions are unchanged** and cannot see other spaces.
- **The console lock gates cross-space delegation.** `consoleUnlocked` is **per-chat**
  and **default locked**; it is toggled only by `/yolo` on the console (`auto`→unlock,
  `readonly`/`ask`/`off`→lock, no arg reports it) and is **not** the approval-mode
  switch. Unlocked, the console's ACTIVE tool set gains `anytype_run_in_space(space,
  task)`, which dispatches a **parameterized one-shot worker** —
  `createChildAgent({ spaceId, cwd, readOnly: false })` bound to the TARGET space's
  workspace (`/workspace/<spaceId>`, its own `AGENTS.md`/`MEMORY.md`) and discarded
  after the task. The worker gets the same tools **minus** `subagent`/`agent`, so it
  **cannot recurse**; an unknown/typo'd target space **throws** (no fallback to another
  space). The console's **own** tools stay read-only in every mode — only the worker
  writes, and only to its one target.
- **The console can be connected from a link** via `/join <link>` (a bridge slash
  command, handled without the agent) or the `anytype_join_space` tool (registered
  **only** in console sessions, and only on an explicit user ask). An invite link
  joins that shared space (`SpaceJoin`); a 1:1 link (`hi.any.coop/<identity>#<key>`)
  mirrors the user's one-to-one space (`WorkspaceCreate`) and records it in
  `<workspaceRoot>/console.json` — the container must be restarted for it to take
  effect. At boot with no console configured, `main.ts` prints the bot's own 1:1 link.
- **`src/anytype/grpc.ts` is a minimal bridge to anytype-heart** (plaintext h2c, a
  `token` metadata header read fresh from the mounted anytype-cli config →
  `~/.anytype/config.json`). It exposes **only** `AppGetVersion` / `WorkspaceCreate`
  / `SpaceJoin`. **Never call other RPCs** — some are removed stubs that
  `panic("should be removed")` and kill anytype-cli (the bot's `service:anytype-cli`
  netns then goes stale and needs a `--force-recreate --no-deps` bot recreate). The
  CLI config dir must be mounted read-only; see `docker-compose.bot.yml`.
- **The model is registered manually.** `docker/models.json` adds DeepSeek V4.1
  (`deepseek-flash`, multimodal) because pi's built-in table predates it; pi's agent
  dir is a volume mount, so `ensureModelsConfig` copies it in at startup.
- **Watches poll + diff** — Anytype has **no object-change event stream**. Each watch
  carries a 5-field cron evaluated in **local time** (`TZ`); `pollDueWatches` fires due
  watches once per matching minute, and a watch with a `prompt` runs an agent turn.
- **The bot resolves its own participant id per space** by matching `BOT_IDENTITY` in
  the member list (participant ids are space-scoped).
- **Barge-in: a newer message wins.** `SessionManager.run` keeps the executing turn
  at `entry.turns[0]`; if anything is already in flight it marks every pending turn
  `superseded` (they resolve `""`, so the Router posts nothing) and calls
  `client.requestInterrupt()`. The per-chat `InterruptPolicy` decides *when* the
  running turn stops — `step` (default) aborts now while thinking/reading but waits
  for an in-flight **write** tool to finish, `immediate` aborts now regardless. The
  policy lives in `pi-session.ts` (`decideInterrupt` / `isInterruptibleTool`, an
  allow-list so unknown tools default to "not safe"), and the interrupted turn's
  `prompt()` returns `""` so no half-written reply is posted. `/interrupt [now|step]`
  sets it and applies it to the running turn right away.
- **Approval mode is per-chat and three-valued** — `ApprovalMode = "auto" | "ask" |
  "readonly"` (`src/agent/approval.ts`). `auto` never asks (default; env
  `APPROVAL_MODE` sets the default for new **non-console** sessions). `ask` enforces a
  real gate: a pi extension registered via `pi.on("tool_call")` returns `{block:true}`
  for a write/unsafe tool unless the user replies `/approve` / `/approve all` / `/deny`
  (timeout = **deny**, `APPROVAL_TIMEOUT_MS`, default 5 min); `subagent`/`agent` are
  **refused outright** in `ask` (they'd bypass the gate). That extension is registered
  through a caller-supplied `DefaultResourceLoader` that **MUST be `await reload()`ed**
  (`buildSessionResourceLoader`) — the SDK uses a caller-supplied loader **as-is** and
  never auto-reloads it, so a missing reload silently drops the gate. `readonly` drops
  every write tool, and its child sessions are set to `SAFE_TOOLS`-only. The console's
  **own** tools are always `CONSOLE_TOOLS`/read-only; `/yolo` on the console is **not**
  the approval switch but toggles the console lock (see the console-lock bullet above).
  **Behavior change:**
  `/yolo off` now means `ask` (it used to mean "read-only"); read-only is `/yolo
  readonly`.

## Anytype API gotchas (learned the hard way)

- The HTTP API binds loopback-only inside its container and enforces a Host/origin
  allowlist → the bot must **share `anytype-cli`'s network namespace** and use
  `http://127.0.0.1:31012`. A docker service-name URL is rejected with 403.
- **Deleted objects still read `200`** (soft delete); the real "gone" signal is the id
  **disappearing from `listObjects`**. That's why watch deletion-probing lists instead
  of trusting a read failure.
- **Loose files/images** (not placed in a page) are **absent from `listObjects`**. The
  only way to enumerate them is a type query — see `AnytypeClient.listObjectsOfType`
  (used by `anytype_list_objects {type}`).
- **Chats cannot be deleted** via the API (no endpoint) — only messages can.
- **`properties.name`** is a string normally but a **1-element array** after a
  `set_properties` patch; renderers tolerate both.
- Chat **attachments** (`attachments: [{id,type}]`) are surfaced to the agent by the
  Router (images → `anytype_read_object`, other files → `anytype_download_file`).
- **1:1 DMs are not spaces** and have no API surface — only space chats and page
  discussions are reachable. Bot output must be **plain text in chat** (no Markdown;
  Anytype chat doesn't render it) — enforced via the `AGENTS.md` template in
  `src/agent/pi-session.ts`.
- Requires the bot's space role to be **Editor** (a Viewer gets 403 posting).

## Testing notes

- Tests are pure/unit (no live API). Fake the `AnytypeClient` / `fetch`; the agent is
  never invoked in tests.
- When changing the **event-stream or tool-progress** shapes, update the fakes in
  `test/router.test.ts` and `test/anytype-events.test.ts` accordingly.
- `SessionManager` tests encode barge-in: a second `run()` for a chat supersedes the
  first, so the earlier promise resolves `""`. A fake client that wants to emulate a
  real interrupt implements `requestInterrupt()` and returns `""` from `prompt()`
  once aborted.
- `pi-session.ts` is not unit-tested against a live SDK (no provider key in CI) —
  because of that, `decideInterrupt` / `isInterruptibleTool` are deliberately pure
  and exported so they *can* be tested. Verify real abort behaviour with a live
  `docker run` script (see the interruption note above): confirm an interrupted turn
  yields `""`, that the **next** turn still works, and that `step` lets a `bash
  sleep N` finish while `immediate` kills it.
- Live smoke tests (see `docs/superpowers/plans/phase0-findings.md` for verified API
  shapes) must run against a **fresh `docker run` of the new image** — `docker exec`
  into the running container tests the OLD image.

## Reference

- `docs/RUNBOOK.md` — operations (deploy, add a space, change model, where state lives,
  troubleshooting). It is in Chinese.
- `docs/superpowers/specs/` and `docs/superpowers/plans/phase0-findings.md` — the design
  and the verified-against-live-API findings that drive many implementation details.
- `NOTICE` — Lightpanda is **AGPL-3.0** (fetched at build time, not bundled); pi /
  typebox are MIT, sharp is Apache-2.0. Project license: Apache-2.0.
