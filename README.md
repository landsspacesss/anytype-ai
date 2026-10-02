# anytype-ai

**Bring a Notion-like AI assistant into Anytype.**

Anytype is a great, private, local-first Notion alternative — but it has no AI.
`anytype-ai` adds one: an `@ai` assistant that lives **inside your self-hosted
Anytype**. Mention it (or DM it) in any chat and it just answers, with a full
agent behind it — it reads, searches, writes and edits your notes, sees images,
reads files, searches the web, and can run scheduled checks. Notion AI, but
running on your own server over your own end-to-end-encrypted network.

> 中文文档见 [README.zh-CN.md](README.zh-CN.md).

## What it can do

- **Chat** — the reply is plain text (no Markdown noise in chat).
- **Notes** — list / search / read / create / edit / delete pages, blocks, tags,
  properties, types, collections, templates.
- **See images** — reads images on a page (downscales and sends them to a
  multimodal model); download + crop to zoom into scans and handwriting.
- **Read any loose file** — downloads PDFs / docx / xlsx / txt and extracts text
  with shell tooling (`pdftotext`, `unzip`, `python3`).
- **Web** — `web_search` (hosted search) and `web_fetch` (a real headless
  browser via [Lightpanda](https://github.com/lightpanda-io/browser), returns Markdown).
- **Memory** — a durable `MEMORY.md` per space; the agent records things proactively.
- **Scheduled watches** — subscribe to an object on a cron; when it changes the AI
  runs your instruction (e.g. "summarize the changes") and posts back.
- **Sub-agents** — one-shot `subagent`, and persistent named agents (`agent`
  spawn/message/list/kill) you can talk to across turns.
- **Barge-in** — send another message while it is working and the older one is
  dropped: the running turn is interrupted so the newest message wins. The
  default policy never cuts a write (create/update/delete) short.
- **Slash commands** — `/new` `/clear` `/compact` `/model` `/effort` `/yolo` `/interrupt` `/help`.
- **Persistent history** — per-chat conversation survives restarts.

## Architecture — this is a standalone service

`anytype-ai` is **its own service, separate from your Anytype server**. It is a
single small container that talks to your Anytype stack over the local HTTP API.
It is **not** part of `any-sync` / `any-sync-dockercompose` and does not modify it.

```
┌─────────────── your Anytype stack (separate) ───────────────┐
│  any-sync nodes …  +  anytype-cli  (local HTTP API :31012)   │
└───────────────────────────────▲─────────────────────────────┘
                                 │ HTTP/SSE + API key
┌───────────────────────────────┴─────────────────────────────┐
│  anytype-ai  (this project — one container)                  │
│    bridge + embedded pi agent  →  your model API (e.g. DeepSeek) │
└──────────────────────────────────────────────────────────────┘
```

The only coupling is one setting on the Anytype side: the **`anytype-cli` service
must be enabled** in your any-sync compose file (it provides the bot's HTTP API).
This project ships only the bot's own `docker-compose.bot.yml`.

## Requirements

- Docker + Docker Compose v2.
- A running self-hosted Anytype network with **`anytype-cli` enabled** (serves the
  local HTTP API on port 31012). See the any-sync-dockercompose docs.
- A model API key. The defaults use **DeepSeek** (also powers `web_search`).
- Node 22 only if you build/run outside Docker.

## Quick start

```bash
git clone https://github.com/landsspacesss/anytype-ai anytype-ai
cd anytype-ai
cp .env.example .env      # then edit it (see below)
npm install && npm run build
docker build -t anytype-ai-bot:latest .
```

Run it **merged into your any-sync compose project** so the shared network
namespace resolves (`network_mode: service:anytype-cli`):

```bash
cd /path/to/any-sync-dockercompose
docker compose -f docker-compose.yml -f /path/to/anytype-ai/docker-compose.bot.yml \
  up -d --no-deps ai-bot
```

Then, in your Anytype client, **invite the bot account into a space** and give it
the **Editor** role (a Viewer cannot post messages).

## Configuration (`.env`)

| Key | Meaning |
|---|---|
| `ANYTYPE_API_BASE_URL` | Bot's HTTP API URL (default `http://127.0.0.1:31012`) |
| `ANYTYPE_API_KEY` | API key for the bot's Anytype account |
| `BOT_IDENTITY` | The bot account's stable identity (its participant id is space-scoped) |
| `BOT_DISPLAY_NAME` | Display name, used to strip `<mention>` tags |
| `DEEPSEEK_API_KEY` | Model key (agent + `web_search`) |
| `PI_MODEL` / `SEARCH_MODEL` | Model ids (default `deepseek-flash`, V4.1 multimodal) |
| `MAX_CONCURRENT_SESSIONS`, `IDLE_REAP_MS` | Per-chat session pool |
| `WATCH_TICK_MS`, `WATCH_DEFAULT_CRON`, `WATCH_MAX_MISSES` | Scheduled watches |
| `TZ` | Timezone cron is evaluated in (e.g. `Asia/Shanghai`) |
| `SESSION_PERSIST` | `false` disables the persistent per-chat history |
| `MAX_SUBAGENTS`, `SUBAGENT_IDLE_MS` | Named sub-agent pool |
| `LIGHTPANDA_BIN`, `WEB_FETCH_TIMEOUT_MS`, `WEB_FETCH_MAX_CHARS` | `web_fetch` |

## Development

```bash
npm install
npm run build     # tsc
npm test          # vitest (290 tests)
```

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for operations (deploy, add a space,
change the model, where state lives, troubleshooting).

## License

Apache-2.0 (see [`LICENSE`](LICENSE)). Third-party notices in [`NOTICE`](NOTICE) —
note that **Lightpanda is AGPL-3.0** and is fetched at build time, not bundled.
