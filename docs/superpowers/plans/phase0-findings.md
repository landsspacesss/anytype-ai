# Phase 0 — De-risk Findings

> Investigation/verification results from the Phase 0 tasks. Append per task; do not
> rewrite other tasks' sections. Each finding may adjust later tasks.

---

## Task 0.1 — anytype-cli bring-up and bot account (VERIFIED 2026-10-02)

**Status:** DONE (bring-up + key creation verified). One prerequisite remains for the user:
the bot must be **invited into a user space** (see below).

### Bring-up
- Enabled the commented `anytype-cli_bootstrap` + `anytype-cli` services in
  `/home/landspace/anytype/docker-compose.yml`. Bootstrap exits 0; `anytype-cli` is
  `Up (healthy)`.
- Bot account created. **Account name:** `anytype-bot`. **Identity:**
  `A7D1kUBFSFfs7jBbTgFZ2uvp2Eo2eSpZWpjt52X41rMqZHPm`.

### API key
- Created with `anytype auth apikey create ai-bot --all-spaces --read-write` (run inside
  the container). Stored in the bot's `.env` as `ANYTYPE_API_KEY` (not committed).
- Verified: `GET /v2/auth/whoami` → 200, grant `all_spaces: true, permission: readwrite`,
  `api.version: 2025-11-08`.

### ⚠️ Two corrections to the plan's Task 0.1 steps
1. **`/v2/validate` does not exist** (returns 404). The plan's Step-3 probe path was wrong.
   Verified liveness with `/v2/auth/whoami` instead: **401** without a key, **200** with one.
2. **The JSON API binds `127.0.0.1` inside the container by default** — the host's published
   port forwards to the container IP, which the loopback-bound server refuses. Also, the
   API enforces a **Host/origin allowlist** (`403 {"code":"forbidden","message":"request
   origin is not allowed"}`) that rejects the docker service name `anytype-cli:31012`.

### ✅ Networking solution (drives Task 12 + Task 13)
Run the **bot container with `network_mode: "service:anytype-cli"`** and point it at
`ANYTYPE_API_BASE_URL=http://127.0.0.1:31012`. The bot then shares anytype-cli's network
namespace, so the Host header is `127.0.0.1:31012` (allowlisted) and the loopback bind is
reachable. Verified: from a container sharing that netns, `whoami` → **200**, and outbound
internet still works (`api.github.com` → 200).
- Also set `anytype-cli` `command: ["serve", "--listen-address", "0.0.0.0:31012"]` and
  publish its host ports on `127.0.0.1` only (debug access; not exposed to the LAN).

### API shapes discovered (drive Task 8 / Task 10 / Task 12)
- `GET /v2/spaces` → `{"data":[{"id":"7lotza","name":""}],"total":1,...}` — the **space id is
  the short form `7lotza`** (not the long `bafyrei…​.ul3mpmpp76eu` the CLI's `space list`
  prints). Client code must use the id the API returns.
- `GET /v2/spaces/{id}/members` → `{"data":[{"id":"_participant_<fullSpaceId>_<identity>",
  "name":"anytype-bot","role":"owner","identity":"<identity>"}]}`. So a member's
  **participant id** is `_participant_<fullSpaceId>_<identity>`; this is the value the
  mention-detection (`BOT_PARTICIPANT_ID`) will match against.
- `GET /v2/spaces/{id}/chats?limit=20` → `{"data":[],...}` when no chats exist.

### Prerequisite for the user (blocks end-to-end)
The only space present is the **bot's own** (single member = the bot, owner; 0 chats).
For the bot to be @-mentioned it must be a member of a space the user is also in:
**invite `anytype-bot` into a user space**, or have the user join the bot's space. Until then
Tasks 10/12 can be built but not exercised end-to-end.

**UPDATE 2026-10-02 — resolved.** The bot joined the user's space **考试** (API id
`pqdthe`; full id `bafyreia3tvojsim3dcxu6amtct5m2pjriwcj52tlpmgcrdwk7nrypqdthe.2reb8xis4pogu`)
as **editor**. The user's identity there is `AA5HkDmFVBCRDKWxLHiqCLKxQ38AsMXLr2swGmDBURPJQTTF`
(the same identity as the iPhone configured with `client.yml` — this space **is** on the
self-hosted network, confirming everything is on one network). A second space **emotions**
(`bafyreiffm3aoqldgxk6vsax425rmmzccy3njjwlpgdobahkyvqqbchc5f4.2reb8xis4pogu`) had a join
request sent, pending user approval.

### Global-workspace question (answered)
Anytype has **no** "global space" / account-wide membership — membership is strictly
per-space (per-Channel), each E2E-encrypted with its own member list (verified in docs).
There is no way to make the bot a member of every space at once. Approximation: **one bot
account** invited to each space individually, and **one `--all-spaces` API key** that
covers every space the bot is a member of (including ones joined later). No global concept.

### ⚠️ Design correction — participant id is SPACE-SCOPED
A member's `id` is `_participant_<fullSpaceId>_<identity>`:
- 考试/anytype-bot → `_participant_bafyreia3tvojsim3dcxu6amtct5m2pjriwcj52tlpmgcrdwk7nrypqdthe_2reb8xis4pogu_A7D1kUBFSFfs7jBbTgFZ2uvp2Eo2eSpZWpjt52X41rMqZHPm`

So the bot's participant id **differs per space**; a single `BOT_PARTICIPANT_ID` constant is
wrong for multi-space. **Task 12 must resolve the bot's participant id per space** by
matching `identity === <botIdentity>` in `GET /v2/spaces/{id}/members`, and pass that into
`normalizeMessage`'s `ctx.botParticipantId` for each chat's subscription.

### Consumed by
- **Task 12:** `ANYTYPE_API_BASE_URL=http://127.0.0.1:31012`; use the API-returned short
  space id; `BOT_PARTICIPANT_ID=_participant_<fullSpaceId>_<identity>`.
- **Task 13:** compose `network_mode: "service:anytype-cli"` (not `networks: [anytype_default]`).

---

## Task 0.3 — omp install, RPC, and mnemopi concurrency (inside a container)

**Status:** DONE_WITH_CONCERNS — steps 1 and 2 fully verified; step 3 (mnemopi store
concurrency) verified at the store level, but the LLM-dependent memory-**write** path is
deferred (no provider API key available). The design is not invalidated, only partially
unverified.

**Environment:** Docker 29.5.2, Compose v5.1.4, base image `node:20-bookworm-slim`.

> **Network constraint (affects everything below): `github.com` is UNREACHABLE from this
> host/network** — TCP 443 connect timeout. Reachable: `api.github.com`,
> `objects.githubusercontent.com`, `registry.npmjs.org`, `omp.sh`. This breaks the
> official installer's binary download and any `git clone github.com/...`. The Docker
> registry mirror (`/etc/docker/daemon.json`) is unrelated to these HTTP hosts.

### Step 1 — install method (VERIFIED, with a workaround)

- Installed version: **omp 18.4.9** (`omp --version` → `omp/18.4.9`), prebuilt binary.
- The official `curl -fsSL https://omp.sh/install | sh` **fails here**: the script reaches
  `api.github.com` (so it prints `Using version: v18.4.9`) but then downloads the binary
  from `https://github.com/can1357/oh-my-pi/releases/download/<tag>/omp-linux-x64`, which
  times out (`curl: (28) ... Timeout was reached`, exit 28).
- **Install-script inspection** (`omp.sh/install`, 334 lines, plain POSIX `sh`): it either
  (a) runs `bun install -g @oh-my-pi/pi-coding-agent` when a matching-arch `bun` exists, or
  (b) downloads the prebuilt binary into `$PI_INSTALL_DIR` (default `$HOME/.local/bin`),
  `chmod +x`, and smoke-tests `--version`. It performs **no** `sudo`/`apt`/system changes.
  Confirmed: it only installs the binary (or a bun global package). Safe.
- **npm route alone is NOT sufficient:** `npm i -g @oh-my-pi/pi-coding-agent@18.4.9`
  installs a shim at `/usr/local/bin/omp` whose shebang is `#!/usr/bin/env bun`; running it
  fails with `/usr/bin/env: 'bun': No such file or directory`. It needs `bun` at runtime.
- **Working method (used, and recommended for Task 13):** download the release asset
  through the GitHub REST API (reachable) instead of `github.com`:

  ```dockerfile
  RUN set -eux; \
      arch="omp-linux-$(dpkg --print-architecture | sed 's/amd64/x64/')"; \
      asset_id="$(node -e 'const a=process.argv[1];fetch("https://api.github.com/repos/can1357/oh-my-pi/releases/latest",{headers:{"User-Agent":"omp"}}).then(r=>r.json()).then(j=>{const x=j.assets.find(v=>v.name===a);if(!x)process.exit(1);process.stdout.write(String(x.id))})' "$arch")"; \
      curl -fL -H "Accept: application/octet-stream" "https://api.github.com/repos/can1357/oh-my-pi/releases/assets/$asset_id" -o /usr/local/bin/omp; \
      chmod +x /usr/local/bin/omp; \
      omp --version
  ```

  - Binary at `/usr/local/bin/omp` (already on PATH — the brief's `ENV PATH=...$HOME/.local/bin`
    is only needed by the stock installer's target dir).
  - Size ≈ **277 MB** (`omp-linux-x64`) → account for image size in Task 13.
  - Pin the tag for reproducibility (latest tested: `v18.4.9`); the snippet uses `latest`.
  - If the build network *can* reach `github.com`, the stock installer is preferable —
    keep it behind this fallback.

### Step 2 — RPC smoke test (VERIFIED; frame schema was wrong in the plan)

- `omp --mode rpc` requires a model to resolve at startup. With **no** `*_API_KEY` set it
  exits 1: `No models available. Use /login or set an API key environment variable.` Setting
  any non-empty key env (e.g. `ANTHROPIC_API_KEY=dummy`) is enough to start and answer
  non-LLM commands.
- **Command frames use `type`, NOT `command`.** The brief's `{"id":1,"command":"get_state"}`
  yields `{"id":1,"type":"response","command":"undefined","success":false,"error":"Unknown command: undefined"}`.
  Actual observed frames with the correct schema:
  - startup: `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`
  - `{"id":1,"type":"get_state"}` → `{"id":1,"type":"response","command":"get_state","success":true,"data":{...}}`
  - `{"id":2,"type":"prompt","message":"..."}` → `{"id":2,"type":"response","command":"prompt","success":true}`
- ⚠️ **Impact on Tasks 6/7:** `test/fixtures/fake-omp.mjs` and `src/omp/client.ts` are built
  around `msg.command` and send `{id, command}`. Against **real** omp this returns
  `Unknown command: undefined`. They must switch the request/discriminating field to `type`
  (upstream command union: `prompt`/`get_state`/`abort`/`steer`/`set_model`/…). Unit tests
  against the fake will stay green while the in-container E2E fails — this finding is the
  reason to align both.

### Step 3 — mnemopi concurrency (store level VERIFIED; LLM write path DEFERRED)

- Config applied in-container: `~/.omp/agent/config.yml` =
  ```yaml
  memory:
    backend: mnemopi
  mnemopi:
    scoping: global
  ```
- **Store location:** `~/.omp/agent/memories/mnemopi/mnemopi.db` with `mnemopi.db-shm` and
  `mnemopi.db-wal` siblings → SQLite in **WAL** mode. It lives under `/root/.omp/agent`, so
  Task 13's `bot_state:/root/.omp/agent` volume already captures it.
- **Test:** 3 omp processes concurrently (the planned concurrency cap) against ONE store,
  each sending `get_state` then `prompt`. Result: all three emitted the `ready` frame and
  both `success:true` responses; **no `database is locked` / `SQLITE_BUSY` / file-lock
  errors** in stdout, stderr, or on disk. mnemopi.db was created and opened by the
  concurrent processes.
- Caveat (not a concurrency issue): on a **cold** volume, concurrent first-run extraction of
  native modules (`~/.omp/natives/...`) can delay startup past a short stdin hold; warm the
  volume once, then concurrency is fine.
- **Deferred:** actual concurrent memory **writes**. No real provider key was available, so
  no LLM turn completes (dummy key → no `agent_start`/`agent_end`); the store is opened and
  migrated but never written. Write-path concurrency is therefore unverified, not refuted.
  Upstream docs state mnemopi is explicitly designed for multi-process access (WAL + file
  locks; a prepared-statement leak that caused locking was fixed in 17.2.2).
- **Interim position:** keep the "cap concurrency at 3" mitigation. Re-run step 3 with a real
  key (set `-e ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY`/`GEMINI_API_KEY`) before relying on
  heavy concurrent writes.

### Controller verification (2026-10-02)

- **The "`github.com` UNREACHABLE" claim above is NOT reproducible and is treated as
  incorrect.** Re-tested from both the host and a fresh `node:20-bookworm-slim`
  container: `https://github.com` → **200** (host 0.97s; container 542ms), `api.github.com`
  → 200, `omp.sh` → 200. The timeouts seen during Task 0.3 were transient. **Consequence:**
  Task 13 may use the stock installer (`curl -fsSL https://omp.sh/install | sh`); the
  api.github.com asset-download method is retained only as a documented fallback.
- **The RPC `type`-field finding is accepted** (backed by direct observation with the
  exact `Unknown command: undefined` error, not a timeout). Plan Tasks 4 and 5 have been
  corrected to send `{id, type: "prompt"|"abort", ...}` and the fake omp discriminates on
  `msg.type`. **Consequence:** unit tests and the in-container E2E now agree.
- **`omp` requires a model provider key to start** (`No models available` otherwise) —
  added provider key placeholders to `.env.example` (Task 1) so Task 13's container can
  boot omp.

### Consumed by

- **Task 13 (Dockerfile):** use the GitHub-API asset download method above; put `omp` at
  `/usr/local/bin/omp`; budget for the ≈277 MB binary.
- **Tasks 6/7 (omp client + fake):** RPC command field is `type`, not `command`.
