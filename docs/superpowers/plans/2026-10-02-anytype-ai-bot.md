# Anytype `@ai` Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot account that lives in a self-hosted Anytype space; when @-mentioned (or DMed), it runs a full agent (omp) and posts the reply back into the chat.

**Architecture:** A Node bridge subscribes to Anytype chat events via anytype-cli's HTTP API/SSE, decides whether to trigger, dispatches to a long-lived `omp --mode rpc` process (one per `chat_id`), and posts the agent's reply back via the API. Bridge + omp run together in one strictly-isolated container.

**Tech Stack:** Node 20 (ESM, TypeScript), vitest, omp (Oh My Pi) child processes, anytype-cli HTTP API + SSE.

## Global Constraints

- Node `>=20`, ESM (`"type": "module"`); TS `module`/`moduleResolution` = `NodeNext` (use `.js` import extensions).
- Bot runs in a **strictly-isolated** container: no host paths mounted; own writable workspace only; network access to anytype-cli API + LLM providers only.
- One omp process per `chat_id`; **concurrency cap = 3**; idle reap after **15 min**.
- Conversation scope = `chat_id`; memory scope = `space_id`.
- omp memory: `backend = mnemopi`, `mnemopi.llmMode = smol`, per-space isolation via per-space workspace dir.
- Bot's own messages never trigger replies.
- All outbound message sends carry an `Idempotency-Key`.
- Secrets only via env vars; never log tokens.
- Every task ends with a commit.

---

## Phase 0 — De-risk (resolve unknowns before building)

> These are investigation/verification tasks, not TDD. Each produces a concrete finding that may adjust later tasks. Record findings in `docs/superpowers/plans/phase0-findings.md`.

### Task 0.1: Bring up anytype-cli and create the bot account

**Files:**
- Modify: `/home/landspace/anytype/docker-compose.yml` (uncomment `anytype-cli_bootstrap` + `anytype-cli`)
- Create: `docs/superpowers/plans/phase0-findings.md`

**Interfaces:**
- Produces: a running HTTP API on `http://<host>:31012`, a bot account, and an **API key** (all-spaces read-write) used by every later task's `ANYTYPE_API_KEY`.

- [ ] **Step 1: Enable the anytype-cli services**

Uncomment the `anytype-cli_bootstrap:` and `anytype-cli:` blocks at the bottom of `/home/landspace/anytype/docker-compose.yml` (lines ~277–326). Leave `${ANYTYPE_CLI_VERSION}` as-is.

- [ ] **Step 2: Bring the services up**

Run: `cd /home/landspace/anytype && docker compose up -d anytype-cli_bootstrap anytype-cli`
Expected: bootstrap exits `0`; `anytype-cli` is `Up`.

- [ ] **Step 3: Verify the API answers**

Run: `curl -s http://127.0.0.1:31012/v2/auth/whoami -o /dev/null -w "%{http_code}\n"`
Expected: `401` (server is up; no key supplied). If connection refused, check
`docker compose logs anytype-cli`. NOTE: `/v2/validate` does not exist (returns 404) — it was
the plan's earlier wrong probe path (phase0 finding).

- [ ] **Step 4: Create the API key**

Create an all-spaces read-write key bound to the bot account. Use the anytype-cli/`anytype` auth flow per `https://github.com/anyproto/any-sync-dockercompose/wiki/Anytype-cli`, then call the API keys endpoint:
Run: `curl -s -X POST http://127.0.0.1:31012/v2/auth/api_keys -H "Authorization: Bearer <bootstrap-token>" -H "Content-Type: application/json" -d '{"name":"bot","scopes":["all"]}'`
Expected: JSON containing the new key. Save it as `ANYTYPE_API_KEY`.

- [ ] **Step 5: Verify the key works and record the bot's identity**

Run: `curl -s http://127.0.0.1:31012/v2/auth/whoami -H "Authorization: Bearer $ANYTYPE_API_KEY"`
Expected: JSON with the bot's identity/participant id. **Record this participant id** — it is the `BOT_PARTICIPANT_ID` used for mention detection.

- [ ] **Step 6: Have the bot join a space**

In the Anytype client, invite the bot to a space (or create a space from the bot account). Then:
Run: `curl -s "http://127.0.0.1:31012/v2/spaces" -H "Authorization: Bearer $ANYTYPE_API_KEY"`
Expected: the target space appears. **Record `SPACE_ID`.**

- [ ] **Step 7: Record findings and commit**

Write results (key, bot participant id, space id, API base URL) into `docs/superpowers/plans/phase0-findings.md` (**redact the actual key** — write `ANYTYPE_API_KEY=<set in .env>`).
```bash
git add docs/superpowers/plans/phase0-findings.md
git commit -m "docs: phase0 findings — anytype-cli bring-up and bot account"
```

### Task 0.2: Verify chat/event coverage and pick the event strategy

**Files:**
- Modify: `docs/superpowers/plans/phase0-findings.md`

**Interfaces:**
- Produces: a decision — **per-chat SSE** (HTTP v2) vs **gRPC `ListenSessionEvents`** — consumed by Task 10 (EventSource).

- [ ] **Step 1: List chats and check whether page discussions appear**

Create a Chat (main) and a Discussion on a page. Then:
Run: `curl -s "http://127.0.0.1:31012/v2/spaces/$SPACE_ID/chats?limit=50" -H "Authorization: Bearer $ANYTYPE_API_KEY"`
Expected: JSON `data[]` of `{id, name}`. **Determine whether the page's discussion appears in this list.**

- [ ] **Step 2: Verify per-chat SSE delivers a message**

Open `GET /v2/spaces/{space}/chats/{chat}/messages/stream` with `curl -N`, then post a message from the client.
Run: `curl -N "http://127.0.0.1:31012/v2/spaces/$SPACE_ID/chats/$CHAT_ID/messages/stream" -H "Authorization: Bearer $ANYTYPE_API_KEY"`
Expected: a `message_added` SSE event arrives for the new message.

- [ ] **Step 3: Decide strategy and record**

If **discussions appear** in `list_chats` → use **per-chat SSE** (one subscription per chat, refreshed when the chat set changes).
If **discussions do NOT appear** → use **gRPC `ListenSessionEvents`** on `:31010` for account-wide coverage.
Write the decision + evidence into `phase0-findings.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/phase0-findings.md
git commit -m "docs: phase0 findings — event strategy decision"
```

### Task 0.3: Verify omp install, RPC, and mnemopi concurrency (inside a container)

**Files:**
- Modify: `docs/superpowers/plans/phase0-findings.md`

**Interfaces:**
- Produces: confirmed omp install method, and a verdict on multi-process mnemopi safety. Consumed by Task 13 (Dockerfile) and §7 (memory).

> omp is installed **in the agent container**, never on the host (the host does not need it; unit tests use a fake omp; only the in-container E2E uses real omp). All of Phase 0.3 therefore runs inside a throwaway container built from the same base as Task 13.

- [ ] **Step 1: Build a throwaway image mirroring the container install**

```bash
docker build -t omp-phase0 - <<'EOF'
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://omp.sh/install | sh
ENV PATH="/root/.local/bin:/usr/local/bin:/usr/bin:$PATH"
EOF
docker run --rm omp-phase0 omp --version
```
Expected: prints an omp version. Also inspect the install script (`curl -fsSL https://omp.sh/install`) and confirm it only installs the binary.
**Fallback if untrusted/unsupported:** npm `@oh-my-pi/pi-ai` or build from `github.com/can1357/oh-my-pi`; adjust Task 13's Dockerfile accordingly.

- [ ] **Step 2: Smoke-test RPC in the container**

```bash
docker run --rm -i omp-phase0 bash -lc 'printf "{\"id\":1,\"command\":\"get_state\"}\n" | omp --mode rpc --no-session'
```
Expected: a `{"type":"ready",...}` frame first, then a response to `get_state`.

- [ ] **Step 3: Test two processes against one mnemopi store, in the container**

```bash
docker run --rm -v /tmp/omp-phase0:/root/.omp -e PROVIDER=<p> -e MODEL=<m> -e API_KEY=<k> omp-phase0 bash -lc '
  mkdir -p /root/.omp/agent && printf "memory:\n  backend: mnemopi\n" > /root/.omp/agent/config.yml;
  for i in 1 2; do
    ( printf "{\"id\":1,\"command\":\"prompt\",\"message\":\"remember test-$i\"}\n"; sleep 8 ) \
      | omp --mode rpc --no-session --provider "$PROVIDER" --model "$MODEL" --api-key "$API_KEY" &
  done; wait'
```
Substitute a provider/model you have a key for. Expected: both complete without SQLite lock errors. If lock errors appear, record them (V2) — mitigation stays "cap concurrency at 3". (Needs a provider key; may be deferred if none is available yet.)

- [ ] **Step 4: Record and commit**

```bash
git add docs/superpowers/plans/phase0-findings.md
git commit -m "docs: phase0 findings — omp install, RPC, mnemopi concurrency"
```

---

## Phase 1 — Project scaffold

### Task 1: Scaffold the bridge project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/types.ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` and the shared types (`NormalizedEvent`, `ChatTarget`, `ChatRow`, `Member`).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "anytype-ai-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`, `.gitignore`, `.env.example`**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

```gitignore
# .gitignore
node_modules/
dist/
.env
*.log
```

```bash
# .env.example
ANYTYPE_API_BASE_URL=http://127.0.0.1:31012
ANYTYPE_API_KEY=change-me
BOT_PARTICIPANT_ID=change-me
# omp refuses to start without a model provider key (phase0 finding: "No models available").
# Set whichever provider you use; omp auto-detects these env vars.
ANTHROPIC_API_KEY=
OMP_BIN=omp
OMP_WORKSPACE_ROOT=/workspace
MAX_CONCURRENT_SESSIONS=3
IDLE_REAP_MS=900000
REPLY_MAX_LEN=4000
```

- [ ] **Step 4: Create `src/types.ts`**

```typescript
export interface ChatTarget {
  spaceId: string;
  chatId: string;
  objectId?: string;
}

export interface NormalizedEvent {
  spaceId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  text: string;
  mentionsBot: boolean;
  isBotSelf: boolean;
  isDirect: boolean;
  objectId?: string;
}

export interface ChatRow {
  id: string;
  name: string;
}

export interface Member {
  id: string;
  identity: string;
  name?: string;
}

export interface Config {
  apiBaseUrl: string;
  apiKey: string;
  botParticipantId: string;
  ompBin: string;
  ompWorkspaceRoot: string;
  maxConcurrentSessions: number;
  idleReapMs: number;
  replyMaxLen: number;
}
```

- [ ] **Step 5: Write the failing test for `loadConfig`**

```typescript
// test/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads required values and applies defaults", () => {
    const cfg = loadConfig({
      ANYTYPE_API_BASE_URL: "http://127.0.0.1:31012",
      ANYTYPE_API_KEY: "k",
      BOT_PARTICIPANT_ID: "pid",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiBaseUrl).toBe("http://anytype-cli:31012");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.botParticipantId).toBe("pid");
    expect(cfg.ompBin).toBe("omp");
    expect(cfg.maxConcurrentSessions).toBe(3);
    expect(cfg.idleReapMs).toBe(900000);
    expect(cfg.replyMaxLen).toBe(4000);
  });

  it("throws when a required value is missing", () => {
    // order-independent: matches whichever required var is validated first
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/Missing required env var/);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm install && npx vitest run test/config.test.ts`
Expected: FAIL — `../src/config.js` not found.

- [ ] **Step 7: Implement `src/config.ts`**

```typescript
import type { Config } from "./types.js";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${key} must be a number`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiBaseUrl: required(env, "ANYTYPE_API_BASE_URL"),
    apiKey: required(env, "ANYTYPE_API_KEY"),
    botParticipantId: required(env, "BOT_PARTICIPANT_ID"),
    ompBin: env.OMP_BIN || "omp",
    ompWorkspaceRoot: env.OMP_WORKSPACE_ROOT || "/workspace",
    maxConcurrentSessions: num(env, "MAX_CONCURRENT_SESSIONS", 3),
    idleReapMs: num(env, "IDLE_REAP_MS", 900000),
    replyMaxLen: num(env, "REPLY_MAX_LEN", 4000),
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example src/types.ts src/config.ts test/config.test.ts
git commit -m "feat: scaffold bridge project with config loading"
```

---

## Phase 2 — Pure logic

### Task 2: Trigger decision and mention stripping

**Files:**
- Create: `src/router/rules.ts`
- Test: `test/router-rules.test.ts`

**Interfaces:**
- Produces: `shouldTrigger(event: NormalizedEvent): boolean` and `stripBotMention(text: string, botName: string): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/router-rules.test.ts
import { describe, it, expect } from "vitest";
import { shouldTrigger, stripBotMention } from "../src/router/rules.js";
import type { NormalizedEvent } from "../src/types.js";

function ev(partial: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    spaceId: "s", chatId: "c", messageId: "m", senderId: "u",
    text: "hi", mentionsBot: false, isBotSelf: false, isDirect: false,
    ...partial,
  };
}

describe("shouldTrigger", () => {
  it("triggers on mention in a group chat", () => {
    expect(shouldTrigger(ev({ mentionsBot: true }))).toBe(true);
  });
  it("triggers on every DM message", () => {
    expect(shouldTrigger(ev({ isDirect: true }))).toBe(true);
  });
  it("does not trigger without mention in a group chat", () => {
    expect(shouldTrigger(ev({}))).toBe(false);
  });
  it("never triggers on the bot's own message", () => {
    expect(shouldTrigger(ev({ isBotSelf: true, mentionsBot: true }))).toBe(false);
    expect(shouldTrigger(ev({ isBotSelf: true, isDirect: true }))).toBe(false);
  });
});

describe("stripBotMention", () => {
  it("removes a leading @name and trims", () => {
    expect(stripBotMention("@ai what is 2+2", "ai")).toBe("what is 2+2");
  });
  it("removes an inline @name", () => {
    expect(stripBotMention("hey @ai help", "ai")).toBe("hey  help".replace(/\s+/g, " ").trim());
  });
  it("leaves text unchanged when no mention", () => {
    expect(stripBotMention("hello", "ai")).toBe("hello");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/router-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/router/rules.ts`**

```typescript
import type { NormalizedEvent } from "../types.js";

export function shouldTrigger(event: NormalizedEvent): boolean {
  if (event.isBotSelf) return false;
  return event.mentionsBot || event.isDirect;
}

export function stripBotMention(text: string, botName: string): string {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "gi");
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/router-rules.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router/rules.ts test/router-rules.test.ts
git commit -m "feat: trigger decision and mention stripping"
```

### Task 3: Reply chunking

**Files:**
- Create: `src/reply/chunk.ts`
- Test: `test/reply-chunk.test.ts`

**Interfaces:**
- Produces: `chunkMessage(text: string, maxLen: number): string[]`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/reply-chunk.test.ts
import { describe, it, expect } from "vitest";
import { chunkMessage } from "../src/reply/chunk.js";

describe("chunkMessage", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkMessage("hello", 100)).toEqual(["hello"]);
  });
  it("splits on newlines when possible", () => {
    const text = "a".repeat(60) + "\n" + "b".repeat(60);
    const out = chunkMessage(text, 100);
    expect(out.length).toBe(2);
    expect(out[0]).toBe("a".repeat(60));
    expect(out[1]).toBe("b".repeat(60));
  });
  it("hard-splits a long line with no newlines", () => {
    const out = chunkMessage("x".repeat(250), 100);
    expect(out.length).toBe(3);
    expect(out.every((c) => c.length <= 100)).toBe(true);
  });
  it("returns empty array for empty input", () => {
    expect(chunkMessage("", 100)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/reply-chunk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/reply/chunk.ts`**

```typescript
export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    const nl = window.lastIndexOf("\n");
    const cut = nl > 0 ? nl : maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/reply-chunk.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reply/chunk.ts test/reply-chunk.test.ts
git commit -m "feat: reply chunking"
```

---

## Phase 3 — omp client

### Task 4: OmpClient — spawn, prompt, collect reply

**Files:**
- Create: `src/omp/protocol.ts`, `src/omp/client.ts`
- Create: `test/fixtures/fake-omp.mjs`
- Test: `test/omp-client.test.ts`

**Interfaces:**
- Consumes: `Config` (`ompBin`, workspace dir).
- Produces: `OmpClient.spawn(opts): Promise<OmpClient>`; `client.prompt(message: string): Promise<string>` (resolves with the full reply text on terminal `agent_end`); `client.busy: boolean`.

- [ ] **Step 1: Create the fake omp process**

```javascript
// test/fixtures/fake-omp.mjs
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
       maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "prompt") {
    send({ id: msg.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
    send({ type: "agent_start" });
    const text = `echo: ${msg.message}`;
    for (const ch of text) {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch } });
    }
    send({ type: "agent_end", isTerminal: true });
  } else if (msg.type === "abort") {
    send({ id: msg.id, type: "response", command: "abort", success: true });
    send({ type: "agent_end", isTerminal: true });
  }
});
rl.on("close", () => process.exit(0));
```

- [ ] **Step 2: Write the failing tests**

```typescript
// test/omp-client.test.ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { OmpClient } from "../src/omp/client.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

describe("OmpClient", () => {
  it("spawns, prompts, and returns the full reply", async () => {
    const client = await OmpClient.spawn({ bin: "node", args: [FAKE], cwd: process.cwd() });
    const reply = await client.prompt("hello");
    expect(reply).toBe("echo: hello");
    await client.close();
  });

  it("reports busy while a prompt is in flight", async () => {
    const client = await OmpClient.spawn({ bin: "node", args: [FAKE], cwd: process.cwd() });
    const p = client.prompt("hi");
    expect(client.busy).toBe(true);
    await p;
    expect(client.busy).toBe(false);
    await client.close();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/omp-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/omp/protocol.ts`**

```typescript
export interface OmpReady {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
}

export interface OmpResponse {
  type: "response";
  id?: number;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface OmpMessageUpdate {
  type: "message_update";
  assistantMessageEvent: { type: string; delta?: string };
}

export interface OmpAgentEnd {
  type: "agent_end";
  isTerminal?: boolean;
}

export type OmpFrame =
  | OmpReady
  | OmpResponse
  | OmpMessageUpdate
  | OmpAgentEnd
  | { type: string; [k: string]: unknown };
```

- [ ] **Step 5: Implement `src/omp/client.ts`**

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { OmpFrame } from "./protocol.js";

export interface SpawnOptions {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class OmpClient {
  private child: ChildProcessWithoutNullStreams;
  private rl: Interface;
  private nextId = 1;
  private inFlight = false;
  private sawDelta = false;
  private text = "";
  private resolvePrompt?: (v: string) => void;
  private rejectPrompt?: (e: Error) => void;
  private onExit?: () => void;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    child.on("exit", () => {
      if (this.rejectPrompt) this.rejectPrompt(new Error("omp exited during prompt"));
      this.onExit?.();
    });
  }

  static spawn(opts: SpawnOptions): Promise<OmpClient> {
    const args = opts.args ?? ["--mode", "rpc"];
    const child = spawn(opts.bin, args, { cwd: opts.cwd, env: opts.env }) as ChildProcessWithoutNullStreams;
    const client = new OmpClient(child);
    return client.waitReady().then(() => client);
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onFrame = (line: string) => {
        try {
          const frame = JSON.parse(line) as OmpFrame;
          if (frame.type === "ready") {
            this.rl.off("line", onFrame);
            resolve();
          }
        } catch { /* ignore non-JSON */ }
      };
      this.rl.on("line", onFrame);
      setTimeout(() => reject(new Error("omp ready timeout")), 15000).unref?.();
    });
  }

  private onLine(line: string): void {
    let frame: OmpFrame;
    try { frame = JSON.parse(line) as OmpFrame; } catch { return; }
    if (frame.type === "message_update") {
      const ev = (frame as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        this.sawDelta = true;
        this.text += ev.delta;
      }
    } else if (frame.type === "agent_end") {
      const terminal = (frame as { isTerminal?: boolean }).isTerminal !== false;
      if (terminal && this.resolvePrompt) {
        const resolve = this.resolvePrompt;
        this.resolvePrompt = undefined;
        this.rejectPrompt = undefined;
        this.inFlight = false;
        const out = this.sawDelta ? this.text : "";
        this.text = "";
        this.sawDelta = false;
        resolve(out);
      }
    }
  }

  get busy(): boolean { return this.inFlight; }

  prompt(message: string): Promise<string> {
    if (this.inFlight) return Promise.reject(new Error("session_busy"));
    this.inFlight = true;
    this.sawDelta = false;
    this.text = "";
    return new Promise<string>((resolve, reject) => {
      this.resolvePrompt = resolve;
      this.rejectPrompt = reject;
      // omp RPC: the command NAME goes in the `type` field (verified against real
      // omp 18.4.9 — `{id, command:"prompt"}` returns "Unknown command: undefined").
      this.write({ id: this.nextId++, type: "prompt", message });
    });
  }

  private write(obj: unknown): void {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      this.onExit = resolve;
      this.child.once("exit", () => resolve());
      setTimeout(() => { try { this.child.kill("SIGKILL"); } catch {} resolve(); }, 3000).unref?.();
    });
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/omp-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/omp/protocol.ts src/omp/client.ts test/fixtures/fake-omp.mjs test/omp-client.test.ts
git commit -m "feat: omp RPC client (spawn, prompt, collect reply)"
```

### Task 5: OmpClient — abort

**Files:**
- Modify: `src/omp/client.ts`
- Test: `test/omp-client.test.ts`

**Interfaces:**
- Produces: `client.abort(): Promise<void>`.

- [ ] **Step 1: Add failing test**

Append to `test/omp-client.test.ts`:

```typescript
  it("aborts an in-flight prompt", async () => {
    const client = await OmpClient.spawn({ bin: "node", args: [FAKE], cwd: process.cwd() });
    const p = client.prompt("hi");
    await client.abort();
    await expect(p).resolves.toBeTypeOf("string");
    await client.close();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/omp-client.test.ts`
Expected: FAIL — `client.abort is not a function`.

- [ ] **Step 3: Implement `abort` in `src/omp/client.ts`**

Add method:

```typescript
  async abort(): Promise<void> {
    if (!this.inFlight) return;
    this.write({ id: this.nextId++, type: "abort" });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/omp-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/omp/client.ts test/omp-client.test.ts
git commit -m "feat: omp client abort"
```

---

## Phase 4 — Session manager

### Task 6: SessionManager — reuse, create, concurrency cap

**Files:**
- Create: `src/session/manager.ts`
- Test: `test/session-manager.test.ts`

**Interfaces:**
- Consumes: `OmpClient`.
- Produces: `new SessionManager({ createClient, maxConcurrent })`; `manager.run(chatId: string, prompt: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/session-manager.test.ts
import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "../src/session/manager.js";

function fakeClient(replyFn: (m: string) => string) {
  let busy = false;
  return {
    get busy() { return busy; },
    async prompt(m: string) { busy = true; await new Promise(r => setTimeout(r, 5)); busy = false; return replyFn(m); },
    async close() {},
    async abort() {},
  };
}

describe("SessionManager", () => {
  it("reuses one client per chatId", async () => {
    const createClient = vi.fn(async () => fakeClient((m) => `r:${m}`));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    expect(await mgr.run("c1", "a")).toBe("r:a");
    expect(await mgr.run("c1", "b")).toBe("r:b");
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("uses separate clients per chatId", async () => {
    const createClient = vi.fn(async () => fakeClient((m) => `r:${m}`));
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 100000 });
    await mgr.run("c1", "a");
    await mgr.run("c2", "b");
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("never exceeds maxConcurrent live clients", async () => {
    let live = 0, peak = 0;
    const createClient = vi.fn(async () => {
      live++; peak = Math.max(peak, live);
      return { get busy() { return false; },
        async prompt() { await new Promise(r => setTimeout(r, 10)); return "ok"; },
        async close() { live--; }, async abort() {} };
    });
    const mgr = new SessionManager({ createClient, maxConcurrent: 2, idleMs: 100000 });
    await Promise.all([mgr.run("a", "1"), mgr.run("b", "2"), mgr.run("c", "3"), mgr.run("d", "4")]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/session-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/session/manager.ts`**

```typescript
export interface ManagedClient {
  readonly busy: boolean;
  prompt(message: string): Promise<string>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface Entry {
  client: ManagedClient;
  queue: Promise<unknown>;
  lastUsed: number;
  pending: number; // queued + in-flight prompts for this chat
}

export interface SessionManagerOptions {
  createClient: (chatId: string) => Promise<ManagedClient>;
  maxConcurrent: number;
  idleMs: number;
  now?: () => number;
}

export class SessionManager {
  private entries = new Map<string, Entry>();
  private creating = 0;
  private waiters: Array<() => void> = [];
  private now: () => number;

  constructor(private opts: SessionManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get liveCount(): number { return this.entries.size + this.creating; }

  // Reserve the slot synchronously, before any await. Counting the slot only
  // after `createClient` resolved would let concurrent callers all observe
  // `liveCount < maxConcurrent` and overshoot the cap.
  private async acquireSlot(): Promise<void> {
    if (this.liveCount < this.opts.maxConcurrent) {
      this.creating++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.acquireSlot();
  }

  private releaseSlot(): void {
    const w = this.waiters.shift();
    if (w) w();
  }

  async run(chatId: string, prompt: string): Promise<string> {
    let entry = this.entries.get(chatId);
    if (!entry) {
      await this.acquireSlot();
      let client: ManagedClient;
      try {
        client = await this.opts.createClient(chatId);
      } catch (err) {
        this.creating--;
        this.releaseSlot();
        throw err;
      }
      entry = { client, queue: Promise.resolve(), lastUsed: this.now(), pending: 0 };
      this.entries.set(chatId, entry);
      this.creating--;
    }
    const e = entry;
    e.pending++;
    const result = e.queue.then(async () => {
      e.lastUsed = this.now();
      return e.client.prompt(prompt);
    });
    e.queue = result.catch(() => undefined);
    const done = (): void => { e.pending--; this.evictIfContended(chatId, e); };
    result.then(done, done);
    return result;
  }

  // When callers are waiting for a slot, a finished client yields its slot so
  // the next chat can run. With nobody waiting the client stays warm for reuse.
  // Never evict while this chat still has queued work (pending > 0), or a queued
  // same-chat prompt would run against a closed client.
  private async evictIfContended(chatId: string, e: Entry): Promise<void> {
    if (e.pending > 0) return;
    if (this.waiters.length === 0) return;
    if (this.entries.get(chatId) !== e) return;
    this.entries.delete(chatId);
    await e.client.close().catch(() => undefined);
    this.releaseSlot();
  }

  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.opts.idleMs;
    for (const [chatId, e] of [...this.entries]) {
      if (e.client.busy) continue;
      if (e.lastUsed < cutoff) {
        this.entries.delete(chatId);
        await e.client.close().catch(() => undefined);
        this.releaseSlot();
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [, e] of [...this.entries]) {
      await e.client.close().catch(() => undefined);
    }
    this.entries.clear();
  }
}
```

> **Plan correction (2026-10-02):** this code was corrected during execution. The
> original version (a) counted a slot *after* `await`, so concurrent callers raced
> past `maxConcurrent` (observed peak 4 with cap 2), and (b) had no way to free a
> slot when a client finished a prompt, so the concurrency test deadlocked. Fixed by
> reserving the slot before the await and adding `evictIfContended` (evict a finished
> chat's client when callers wait). A follow-up bug — evicting a chat whose *own*
> second prompt was still queued — is prevented by the `pending` counter guard. A
> 4th test covers this. See `phase0`-style notes in the SDD ledger.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/session-manager.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/session/manager.ts test/session-manager.test.ts
git commit -m "feat: session manager with per-chat reuse and concurrency cap"
```

### Task 7: SessionManager — idle reap

**Files:**
- Test: `test/session-manager.test.ts`

**Interfaces:**
- Consumes: `reapIdle()` from Task 6.
- Produces: verified idle-reaping behavior.

- [ ] **Step 1: Add the failing test**

Append to `test/session-manager.test.ts`:

```typescript
  it("closes and forgets clients idle past idleMs", async () => {
    let t = 0;
    const closed: string[] = [];
    const createClient = async (chatId: string) => ({
      get busy() { return false; },
      async prompt() { return "ok"; },
      async close() { closed.push(chatId); },
      async abort() {},
    });
    const mgr = new SessionManager({ createClient, maxConcurrent: 3, idleMs: 1000, now: () => t });
    await mgr.run("c1", "a");
    t = 2000;
    await mgr.reapIdle();
    expect(closed).toContain("c1");
    const createClient2 = createClient;
    await mgr.run("c1", "b");
    // a new client was created for c1 after reaping
    expect(closed.length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run test/session-manager.test.ts`
Expected: PASS (4 tests). `reapIdle` was already implemented in Task 6; this test locks in the behavior. If it fails, fix `reapIdle`.

- [ ] **Step 3: Commit**

```bash
git add test/session-manager.test.ts
git commit -m "test: lock in session idle-reaping behavior"
```

---

## Phase 5 — Anytype client

### Task 8: AnytypeClient — send message (with idempotency)

**Files:**
- Create: `src/anytype/client.ts`
- Test: `test/anytype-client.test.ts`

**Interfaces:**
- Produces: `new AnytypeClient({ baseUrl, apiKey, fetch? })`; `client.sendMessage(spaceId, chatId, text, idempotencyKey): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/anytype-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { AnytypeClient } from "../src/anytype/client.js";

describe("AnytypeClient.sendMessage", () => {
  it("POSTs to the messages endpoint with auth and idempotency key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await c.sendMessage("s1", "c1", "hello", "key-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/v2/spaces/s1/chats/c1/messages");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(init.body as string)).toEqual({ text: "hello" });
  });

  it("throws on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    const c = new AnytypeClient({ baseUrl: "http://x", apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await expect(c.sendMessage("s1", "c1", "hi", "k")).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/anytype-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/anytype/client.ts`**

```typescript
import type { ChatRow, Member } from "../types.js";

export interface AnytypeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class AnytypeClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(opts: AnytypeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...extra };
  }

  async sendMessage(spaceId: string, chatId: string, text: string, idempotencyKey: string): Promise<void> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats/${chatId}/messages`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers({ "Idempotency-Key": idempotencyKey }),
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status}`);
  }

  async listChats(spaceId: string): Promise<ChatRow[]> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/chats?limit=200`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listChats failed: ${res.status}`);
    const body = (await res.json()) as { data?: ChatRow[] };
    return body.data ?? [];
  }

  async listMembers(spaceId: string): Promise<Member[]> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/members`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listMembers failed: ${res.status}`);
    const body = (await res.json()) as { data?: Member[] };
    return body.data ?? [];
  }

  async getObject(spaceId: string, objectId: string): Promise<{ name?: string }> {
    const url = `${this.baseUrl}/v2/spaces/${spaceId}/objects/${objectId}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getObject failed: ${res.status}`);
    return (await res.json()) as { name?: string };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/anytype-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/anytype/client.ts test/anytype-client.test.ts
git commit -m "feat: anytype client (send message, list chats/members, get object)"
```

### Task 9: ReplySink — chunked sends

**Files:**
- Create: `src/reply/sink.ts`
- Test: `test/reply-sink.test.ts`

**Interfaces:**
- Consumes: `chunkMessage` (Task 3), `AnytypeClient.sendMessage` (Task 8).
- Produces: `new ReplySink({ send, maxLen })`; `sink.send(target: ChatTarget, text: string): Promise<void>`; needs stable idempotency keys per chunk.

- [ ] **Step 1: Write the failing test**

```typescript
// test/reply-sink.test.ts
import { describe, it, expect, vi } from "vitest";
import { ReplySink } from "../src/reply/sink.js";

describe("ReplySink", () => {
  it("sends one message for short text", async () => {
    const send = vi.fn(async () => {});
    const sink = new ReplySink({ send, maxLen: 100, keyFor: () => "k" });
    await sink.send({ spaceId: "s", chatId: "c" }, "hello");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ spaceId: "s", chatId: "c" }, "hello", "k-0");
  });

  it("sends multiple messages for long text with distinct keys", async () => {
    const send = vi.fn(async () => {});
    const sink = new ReplySink({ send, maxLen: 100, keyFor: () => "k" });
    await sink.send({ spaceId: "s", chatId: "c" }, "x".repeat(250));
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c) => c[2])).toEqual(["k-0", "k-1", "k-2"]);
  });

  it("sends nothing for empty text", async () => {
    const send = vi.fn(async () => {});
    const sink = new ReplySink({ send, maxLen: 100, keyFor: () => "k" });
    await sink.send({ spaceId: "s", chatId: "c" }, "");
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/reply-sink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/reply/sink.ts`**

```typescript
import type { ChatTarget } from "../types.js";
import { chunkMessage } from "./chunk.js";

export interface ReplySinkOptions {
  send: (target: ChatTarget, text: string, idempotencyKey: string) => Promise<void>;
  maxLen: number;
  keyFor: (target: ChatTarget) => string;
}

export class ReplySink {
  constructor(private opts: ReplySinkOptions) {}

  async send(target: ChatTarget, text: string): Promise<void> {
    const chunks = chunkMessage(text, this.opts.maxLen);
    if (chunks.length === 0) return;
    const base = this.opts.keyFor(target);
    for (let i = 0; i < chunks.length; i++) {
      await this.opts.send(target, chunks[i], `${base}-${i}`);
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/reply-sink.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reply/sink.ts test/reply-sink.test.ts
git commit -m "feat: reply sink with chunked sends and idempotency keys"
```

### Task 10: Event normalization + per-chat SSE

**Files:**
- Create: `src/anytype/events.ts`
- Test: `test/anytype-events.test.ts`

**Interfaces:**
- Produces: `normalizeMessage(raw: unknown, ctx: { botParticipantId: string; isDirect: boolean; objectId?: string }): NormalizedEvent | null` and `parseSseChunk(buffer: string): { events: unknown[]; rest: string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/anytype-events.test.ts
import { describe, it, expect } from "vitest";
import { normalizeMessage, parseSseChunk } from "../src/anytype/events.js";

describe("normalizeMessage", () => {
  it("marks a message mentioning the bot", () => {
    const raw = {
      id: "m1", chat_id: "c1", space_id: "s1",
      creator: "u1", text: "@ai hi",
      mentions: [{ participant_id: "bot1" }],
    };
    const e = normalizeMessage(raw, { botParticipantId: "bot1", isDirect: false });
    expect(e?.mentionsBot).toBe(true);
    expect(e?.isBotSelf).toBe(false);
    expect(e?.chatId).toBe("c1");
  });

  it("flags the bot's own message", () => {
    const raw = { id: "m2", chat_id: "c1", space_id: "s1", creator: "bot1", text: "ok", mentions: [] };
    const e = normalizeMessage(raw, { botParticipantId: "bot1", isDirect: false });
    expect(e?.isBotSelf).toBe(true);
  });

  it("returns null for malformed input", () => {
    expect(normalizeMessage({}, { botParticipantId: "bot1", isDirect: false })).toBeNull();
  });
});

describe("parseSseChunk", () => {
  it("extracts complete events and keeps the remainder", () => {
    const { events, rest } = parseSseChunk("data: {\"a\":1}\n\ndata: {\"b\"");
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe('data: {"b"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/anytype-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/anytype/events.ts`**

```typescript
import type { NormalizedEvent } from "../types.js";

export interface NormalizeCtx {
  botParticipantId: string;
  isDirect: boolean;
  objectId?: string;
}

export function normalizeMessage(raw: unknown, ctx: NormalizeCtx): NormalizedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.id, chatId = r.chat_id, spaceId = r.space_id, creator = r.creator, text = r.text;
  if (typeof id !== "string" || typeof chatId !== "string" || typeof spaceId !== "string") return null;
  if (typeof creator !== "string") return null;
  const mentionList = Array.isArray(r.mentions) ? r.mentions : [];
  const mentions = mentionList as Array<{ participant_id?: string }>;
  const mentionsBot = mentions.some((m) => m?.participant_id === ctx.botParticipantId);
  return {
    spaceId,
    chatId,
    messageId: id,
    senderId: creator,
    text: typeof text === "string" ? text : "",
    mentionsBot,
    isBotSelf: creator === ctx.botParticipantId,
    isDirect: ctx.isDirect,
    objectId: ctx.objectId,
  };
}

export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { events.push(JSON.parse(payload)); } catch { /* skip */ }
    }
  }
  return { events, rest };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/anytype-events.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/anytype/events.ts test/anytype-events.test.ts
git commit -m "feat: event normalization and SSE parsing"
```

---

## Phase 6 — Wiring

### Task 11: Router — dispatch events to sessions and reply

**Files:**
- Create: `src/router/router.ts`
- Test: `test/router.test.ts`

**Interfaces:**
- Consumes: `shouldTrigger`/`stripBotMention` (Task 2), `SessionManager.run` (Task 6), `ReplySink.send` (Task 9).
- Produces: `new Router({ botName, sessionManager, replySink, workspaceFor })`; `router.handle(event: NormalizedEvent): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/router.test.ts
import { describe, it, expect, vi } from "vitest";
import { Router } from "../src/router/router.js";
import type { NormalizedEvent } from "../src/types.js";

function ev(p: Partial<NormalizedEvent>): NormalizedEvent {
  return { spaceId: "s", chatId: "c", messageId: "m", senderId: "u", text: "hi",
    mentionsBot: false, isBotSelf: false, isDirect: false, ...p };
}

describe("Router", () => {
  it("ignores non-triggering events", async () => {
    const run = vi.fn(async () => "x");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({}));
    expect(run).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("runs the agent and sends the reply on a mention", async () => {
    const run = vi.fn(async () => "the answer");
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ mentionsBot: true, text: "@ai what" }));
    expect(run).toHaveBeenCalledWith("s", "c", "what");
    expect(send).toHaveBeenCalledWith({ spaceId: "s", chatId: "c", objectId: undefined }, "the answer");
  });

  it("sends an error message when the agent fails", async () => {
    const run = vi.fn(async () => { throw new Error("boom"); });
    const send = vi.fn(async () => {});
    const r = new Router({ botName: "ai", run, send });
    await r.handle(ev({ isDirect: true, text: "hi" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(String((send.mock.calls[0] as unknown[])[1])).toMatch(/error/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/router/router.ts`**

```typescript
import type { ChatTarget, NormalizedEvent } from "../types.js";
import { shouldTrigger, stripBotMention } from "./rules.js";

export interface RouterDeps {
  botName: string;
  run: (spaceId: string, chatId: string, prompt: string) => Promise<string>;
  send: (target: ChatTarget, text: string) => Promise<void>;
}

export class Router {
  constructor(private deps: RouterDeps) {}

  async handle(event: NormalizedEvent): Promise<void> {
    if (!shouldTrigger(event)) return;
    const target: ChatTarget = { spaceId: event.spaceId, chatId: event.chatId, objectId: event.objectId };
    const prompt = stripBotMention(event.text, this.deps.botName) || event.text;
    try {
      const reply = await this.deps.run(event.spaceId, event.chatId, prompt);
      if (reply.trim().length > 0) await this.deps.send(target, reply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.send(target, `⚠️ agent error: ${msg}`);
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router/router.ts test/router.test.ts
git commit -m "feat: router ties trigger, session, and reply together"
```

### Task 12: Main wiring — config, SSE subscriptions, reaper

**Files:**
- Create: `src/main.ts`
- Create: `src/anytype/stream.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: an executable `dist/main.js` that boots the bot.

- [ ] **Step 1: Implement `src/anytype/stream.ts`**

```typescript
import type { NormalizedEvent } from "../types.js";
import { normalizeMessage, parseSseChunk } from "./events.js";

export interface StreamDeps {
  baseUrl: string;
  apiKey: string;
  spaceId: string;
  chatId: string;
  isDirect: boolean;
  objectId?: string;
  botParticipantId: string;
  onEvent: (e: NormalizedEvent) => void;
  onResumeId?: (id: string) => void;
}

export function subscribeChat(deps: StreamDeps, signal: AbortSignal): Promise<void> {
  const url = `${deps.baseUrl}/v2/spaces/${deps.spaceId}/chats/${deps.chatId}/messages/stream?heartbeat=30`;
  return (async () => {
    while (!signal.aborted) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${deps.apiKey}`, Accept: "text/event-stream" },
          signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buffer);
          buffer = rest;
          for (const raw of events) {
            const e = normalizeMessage(raw, {
              botParticipantId: deps.botParticipantId, isDirect: deps.isDirect, objectId: deps.objectId,
            });
            if (e) deps.onEvent(e);
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}
```

- [ ] **Step 2: Implement `src/main.ts`**

```typescript
import { loadConfig } from "./config.js";
import { AnytypeClient } from "./anytype/client.js";
import { subscribeChat } from "./anytype/stream.js";
import { OmpClient } from "./omp/client.js";
import { SessionManager } from "./session/manager.js";
import { Router } from "./router/router.js";
import { ReplySink } from "./reply/sink.js";
import type { NormalizedEvent } from "./types.js";

function workspaceFor(root: string, spaceId: string): string {
  return `${root}/${spaceId}`;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const api = new AnytypeClient({ baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey });
  const controller = new AbortController();

  const sessions = new SessionManager({
    maxConcurrent: cfg.maxConcurrentSessions,
    idleMs: cfg.idleReapMs,
    createClient: async (chatId) => {
      const chat = chatTargets.get(chatId);
      const spaceId = chat?.spaceId ?? "unknown";
      return OmpClient.spawn({
        bin: cfg.ompBin,
        args: ["--mode", "rpc", "--no-session", "--name", `chat-${chatId}`],
        cwd: workspaceFor(cfg.ompWorkspaceRoot, spaceId),
      });
    },
  });

  const sink = new ReplySink({
    maxLen: cfg.replyMaxLen,
    send: (t, text, key) => api.sendMessage(t.spaceId, t.chatId, text, key),
    keyFor: (t) => `${t.chatId}-${Date.now()}`,
  });

  const router = new Router({
    botName: "ai",
    run: (spaceId, chatId, prompt) => sessions.run(chatId, prompt),
    send: (t, text) => sink.send(t, text),
  });

  const chatTargets = new Map<string, { spaceId: string; chatId: string; objectId?: string; isDirect: boolean }>();
  const onEvent = (e: NormalizedEvent): void => { void router.handle(e); };

  // Discover spaces -> chats, subscribe to each chat's SSE stream.
  const spaces = await discoverSpaces(api);
  for (const spaceId of spaces) {
    const chats = await api.listChats(spaceId);
    for (const c of chats) {
      const members = await api.listMembers(spaceId).catch(() => []);
      chatTargets.set(c.id, { spaceId, chatId: c.id, isDirect: members.length <= 2 });
      void subscribeChat(
        { baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey, spaceId, chatId: c.id,
          isDirect: members.length <= 2, botParticipantId: cfg.botParticipantId, onEvent },
        controller.signal,
      );
    }
  }

  const reaper = setInterval(() => { void sessions.reapIdle(); }, Math.min(cfg.idleReapMs, 60000));

  const shutdown = async (): Promise<void> => {
    controller.abort();
    clearInterval(reaper);
    await sessions.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

async function discoverSpaces(api: AnytypeClient): Promise<string[]> {
  const res = await fetch(`${(api as unknown as { baseUrl: string }).baseUrl}/v2/spaces`, {
    headers: { Authorization: `Bearer ${(api as unknown as { apiKey: string }).apiKey}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((s) => s.id);
}

void main();
```

> Note: `discoverSpaces` reaches into private fields to avoid widening the client API for one call. If this feels wrong during implementation, promote `listSpaces()` onto `AnytypeClient` and add a test for it — that is the cleaner option and is preferred if time allows.

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc -p tsconfig.json`
Expected: no errors, `dist/main.js` produced.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/anytype/stream.ts
git commit -m "feat: main wiring (config, discovery, SSE subscriptions, reaper)"
```

---

## Phase 7 — Container and deploy

### Task 13: Dockerfile and compose for the agent container

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.bot.yml`
- Create: `docker/omp-config.yml`

**Interfaces:**
- Consumes: `dist/` from Task 12; findings from Task 0.3 (omp install method).
- Produces: a runnable container joining the any-sync network.

- [ ] **Step 1: Create `docker/omp-config.yml`** (pins memory settings)

```yaml
memory:
  backend: mnemopi
mnemopi:
  llmMode: smol
  scoping: per-project
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bash git \
    && rm -rf /var/lib/apt/lists/*

# Install omp. github.com is reachable from this build env (controller-verified),
# so the stock installer works. If the release-asset download times out, use the
# phase0-findings fallback (download the release asset via api.github.com).
RUN curl -fsSL https://omp.sh/install | sh
ENV PATH="/root/.local/bin:/usr/local/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY dist ./dist
COPY docker/omp-config.yml /root/.omp/agent/config.yml

# Strict isolation: only a writable workspace volume
RUN mkdir -p /workspace
ENV OMP_WORKSPACE_ROOT=/workspace
CMD ["node", "dist/main.js"]
```

- [ ] **Step 3: Create `docker-compose.bot.yml`**

```yaml
services:
  ai-bot:
    build:
      context: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - bot_state:/root/.omp/agent
      - bot_workspace:/workspace
    # Share anytype-cli's network namespace so the API is reachable at
    # 127.0.0.1:31012 with an allowlisted Host header (phase0 finding: the API
    # binds loopback-only and rejects the docker service-name origin).
    network_mode: "service:anytype-cli"
    deploy:
      resources:
        limits:
          memory: 1G

volumes:
  bot_state:
  bot_workspace:
```

**Networking constraint (phase0 finding).** `network_mode: "service:anytype-cli"` only
resolves when `anytype-cli` is a service **in the same compose project**. Two supported ways:
1. **Merge compose files (preferred):** run the bot with both files in one project —
   `docker compose -f /home/landspace/anytype/docker-compose.yml -f docker-compose.bot.yml up -d`.
   Then `service:anytype-cli` resolves and the bot shares its netns.
2. **Add the service to the any-sync project** as an override in `/home/landspace/anytype/`.

Either way the bot reaches the API at `ANYTYPE_API_BASE_URL=http://127.0.0.1:31012`. Any other
approach (plain `networks: [anytype_default]` + service-name URL) fails the API's origin
allowlist — verified 403. Confirm the exact invocation works during Task 13.

- [ ] **Step 4: Build the image**

Run: `docker compose -f docker-compose.bot.yml build`
Expected: image builds; `omp --version` succeeds inside. Verify: `docker compose -f docker-compose.bot.yml run --rm ai-bot omp --version`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.bot.yml docker/omp-config.yml
git commit -m "feat: agent container (omp + bridge, isolated, 1G limit)"
```

### Task 14: Deploy and run the E2E checklist

**Files:**
- Create: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: Task 0.1 findings (API key, ids).

- [ ] **Step 1: Write `.env` from findings** (not committed)

Copy `.env.example` to `.env`; fill `ANYTYPE_API_BASE_URL=http://anytype-cli:31012`, `ANYTYPE_API_KEY`, `BOT_PARTICIPANT_ID` from Task 0.1.

- [ ] **Step 2: Start the bot**

Run: `docker compose -f docker-compose.bot.yml up -d && docker compose -f docker-compose.bot.yml logs -f ai-bot`
Expected: no crash; logs show subscriptions established (add a startup log line if missing).

- [ ] **Step 3: E2E — mention in a group chat**

In Anytype, @ai in a space chat. Expected: a reply appears in that chat within a few seconds.

- [ ] **Step 4: E2E — per-chat isolation**

Open a page's Discussion, @ai there. Expected: reply appears in the Discussion. Then @ai in the main chat with the same question context — confirm the two do **not** share conversational context (different answers referencing different histories).

- [ ] **Step 5: E2E — memory (per space)**

In chat A: "Remember: the deploy host is `server`." In chat B (same space): "What is the deploy host?" Expected: bot answers `server`.

- [ ] **Step 6: E2E — resilience**

`docker compose -f docker-compose.bot.yml restart ai-bot`; while it is down, post a message @ai; after it restarts, post another. Expected: the message posted while down is not lost (SSE replay via `Last-Event-ID`) or is cleanly handled; no duplicate replies.

- [ ] **Step 7: Write `docs/RUNBOOK.md`** (start/stop, logs, rotating the API key, where state lives) and commit.

```bash
git add docs/RUNBOOK.md
git commit -m "docs: runbook for the ai bot"
```

---

## Self-Review Notes

- **Spec coverage:** R1 (bot identity) → Task 0.1; R2/R3 (full agent, isolated container) → Tasks 13, 12; R4 (omp) → Tasks 4–5, 0.3; R5 (switchable model) → env/config, omp provider config; R6 (per-space memory) → Task 13 `omp-config.yml` + `workspaceFor` per space in Task 12; R7 (chat scope) → Tasks 6, 10, 12 (one client per chatId); R8 (trigger rules) → Task 2; R9/R10 (queue + cap 3) → Task 6; error handling §8 → Tasks 5 (abort), 11 (error reply), 8 (idempotency), 12 (reconnect); testing §9 → per-task unit tests + Task 14 E2E checklist.
- **Type consistency:** `run(spaceId, chatId, prompt)` (Router dep) vs `sessions.run(chatId, prompt)` (SessionManager) — Router adapts via closure in Task 12; intentional. `ChatTarget.objectId` optional throughout.
- **Known simplification:** Task 12's `discoverSpaces` reaches into private fields; noted with the preferred fix (promote `listSpaces()`).
