# anytype-ai

**Bring a Notion-like AI assistant into Anytype.**

Anytype is a great, private, local-first Notion alternative — but it has no AI.
`anytype-ai` adds one: an `@ai` assistant that lives **inside your self-hosted
Anytype**. Mention it (or DM it) in any chat and it just answers, with a full
agent behind it — it reads, searches, writes and edits your notes, sees images,
reads files, searches the web, and can run scheduled checks. Think "Notion AI",
but running on your own server, over your own encrypted sync network.

> 在自建的 **Anytype** 里引入一个**类 Notion 的 AI 助手**：在聊天里 @ 它（或私聊），
> 它就能读写你的笔记、看图、读文件、联网搜索、定时检查——像一个住在你空间里的 AI。

> Built on [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi)
> (the agent runtime) and Anytype's local HTTP API. Runs as one small container
> next to an [`any-sync-dockercompose`](https://github.com/anyproto/any-sync-dockercompose)
> stack.

## What it can do

- **Chat** — reply is plain text (no Markdown noise in chat).
- **Notes** — list / search / read / create / edit / delete pages, blocks, tags,
  properties, types, collections, templates.
- **See images** — reads images on a page (downscales and sends them to a
  multimodal model); download + crop to zoom into scans/handwriting.
- **Read any loose file** — downloads PDFs / docx / xlsx / txt and extracts text
  with shell tooling (`pdftotext`, `unzip`, `python3`).
- **Web** — `web_search` (hosted search) and `web_fetch` (a real headless browser
  via [Lightpanda](https://github.com/lightpanda-io/browser), returns Markdown).
- **Memory** — a durable `MEMORY.md` per space; the agent records things proactively.
- **Scheduled watches** — subscribe to an object on a cron; when it changes the AI
  runs your instruction (e.g. "summarize the changes") and posts back.
- **Sub-agents** — one-shot `subagent`, and persistent named agents (`agent`
  spawn/message/list/kill) you can talk to across turns.
- **Slash commands** — `/new` `/clear` `/compact` `/model` `/effort` `/yolo` `/help`.
- **Persistent history** — per-chat conversation survives restarts.

## Requirements

- Docker + Docker Compose v2
- A running self-hosted Anytype network with **`anytype-cli`** enabled (it serves
  the local HTTP API on port 31012). See the any-sync-dockercompose docs.
- A DeepSeek API key (used for the agent model and for `web_search`).
- Node 22 only if you build/run outside Docker.

## Quick start

```bash
git clone <this repo> anytype-ai-bot
cd anytype-ai-bot
cp .env.example .env      # then edit it (see below)
npm install && npm run build
docker build -t anytype-ai-bot:latest .
```

Run it **merged into the any-sync compose project** (so `anytype-cli` resolves for
the bot's shared network namespace):

```bash
cd /path/to/any-sync-dockercompose
docker compose -f docker-compose.yml -f /path/to/anytype-ai-bot/docker-compose.bot.yml \
  up -d --no-deps ai-bot
```

Then, in your Anytype client, **invite the bot account into a space** and give it
the **Editor** role (a Viewer can't post).

## Configuration (`.env`)

| Key | Meaning |
|---|---|
| `ANYTYPE_API_BASE_URL` | Bot's HTTP API URL (default `http://127.0.0.1:31012`) |
| `ANYTYPE_API_KEY` | API key for the bot's Anytype account |
| `BOT_IDENTITY` | The bot account's stable identity (participant id is space-scoped) |
| `BOT_DISPLAY_NAME` | Display name, used to strip `<mention>` tags |
| `DEEPSEEK_API_KEY` | Model key (agent + `web_search`) |
| `PI_MODEL` / `SEARCH_MODEL` | Model ids (default `deepseek-flash`, V4.1 multimodal) |
| `MAX_CONCURRENT_SESSIONS`, `IDLE_REAP_MS` | Per-chat session pool |
| `WATCH_TICK_MS`, `WATCH_DEFAULT_CRON`, `WATCH_MAX_MISSES` | Scheduled watches |
| `TZ` | Timezone cron is evaluated in (e.g. `Asia/Shanghai`) |
| `SESSION_PERSIST` | `false` disables the persistent per-chat history |
| `MAX_SUBAGENTS`, `SUBAGENT_IDLE_MS` | Named sub-agent pool |
| `LIGHTPANDA_BIN`, `WEB_FETCH_TIMEOUT_MS`, `WEB_FETCH_MAX_CHARS` | `web_fetch` |

## Architecture (short)

```
Anytype chat  ──SSE──►  bridge (this repo, Node)
                          ├─ Router: trigger decision → session
                          ├─ pi SDK agent session (in-process, per chat)
                          │     └─ tools: anytype_* / web_search / web_fetch / agent
                          └─ posts the reply back via the Anytype API
```

The bot shares `anytype-cli`'s network namespace (`network_mode: service:anytype-cli`)
so it can reach the loopback-only API.

## Development

```bash
npm install
npm run build     # tsc
npm test          # vitest
```

See `docs/RUNBOOK.md` for operations (deploy, add a space, change the model,
where state lives, troubleshooting).

## License

Apache-2.0 (see `LICENSE`). Third-party notices in `NOTICE` — note that
**Lightpanda is AGPL-3.0** and is fetched at build time, not bundled in this repo.
