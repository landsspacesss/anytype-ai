# 运维手册 — Anytype `@ai` Bot

在自建 Anytype 网络里，`@anytype-bot` 或私聊它，它就会以完整 agent 身份回复，并能读写你空间里的对象。

---

## 1. 它由什么组成

```
┌────────────────────── 主机 (server) ──────────────────────┐
│                                                            │
│  [anytype 栈]  /home/landspace/anytype                     │
│    ├─ any-sync 节点们 (同步后端)                            │
│    └─ anytype-cli  ← 提供 HTTP API (127.0.0.1:31012)       │
│          ▲                                                 │
│          │ HTTP                                          │
│  [ai-bot 容器]  anytype-ai-bot:latest                      │
│    └─ node dist/main.js                                    │
│         • SSE 订阅每个聊天 → 收消息                         │
│         • 内嵌 pi SDK（同进程，无子进程）跑 agent           │
│         • 自带 Anytype 工具 / 文件工具                      │
│         • 回复写回聊天                                      │
│          │                                                 │
│          └─→ (网络) → deepseek 等模型 API                  │
└────────────────────────────────────────────────────────────┘
```

**关键点**：bot 容器用 `network_mode: service:anytype-cli` **共享 anytype-cli 的网络命名空间**——因为 anytype-cli 的 API 只绑容器回环，且校验 Host 头（用服务名访问会被 403）。所以 bot 必须经 `127.0.0.1:31012` 访问它。

| 东西 | 位置 |
|---|---|
| bot 源码 | `/home/landspace/anytype-ai-bot` |
| bot 运行配置 | `/home/landspace/anytype-ai-bot/.env`（**不提交**，含密钥） |
| bot 编排文件 | `docker-compose.bot.yml`（用"合并 compose"方式启动） |
| any-sync 栈 | `/home/landspace/anytype`（`docker-compose.yml`） |
| bot 长期状态 | Docker 卷 `bot_state` → 容器内 `/root/.pi/agent` |
| **每空间工作区/记忆** | Docker 卷 `bot_workspace` → 容器内 `/workspace/<spaceId>/` |

---

## 2. 日常操作

所有 `docker compose` 命令都要**两个 `-f` 合并**（因为 `service:anytype-cli` 只有在同一 compose 项目里才解析得到）。为方便，先设个别名：

```bash
alias aibot='docker compose -f /home/landspace/anytype/docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml'
```

```bash
aibot ps                      # 看状态
aibot logs -f ai-bot          # 看实时日志
aibot restart ai-bot          # 重启
aibot stop ai-bot             # 停（数据保留）
aibot up -d ai-bot            # 起
```

> 容器设了 `restart: unless-stopped`：**主机重启、进程崩溃都会自动拉起**，一般不用手动管。

### 改代码后重新部署

```bash
cd /home/landspace/anytype-ai-bot
npm run build                 # 编译 TS → dist/
docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype
docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml \
  up -d --force-recreate ai-bot
```

> 改了 `.env` 也要 `--force-recreate` 才会生效（env 是容器启动时读的）。

---

## 3. 让 bot 进入一个新空间

Anytype **没有"全局空间"**——成员是**逐空间**的。所以每个空间都得单独邀请 bot：

1. 在 Anytype 客户端打开目标空间 → **成员/Members → 邀请 → 生成邀请链接**
2. 在**服务器**上让 bot 加入：
   ```bash
   docker exec anytype-anytype-cli-1 sh -c "anytype space join '<邀请链接>'"   # 注意给链接加引号（含 #）
   ```
3. 客户端会收到**加入请求 → 批准**
4. 确认已加入：
   ```bash
   docker exec anytype-anytype-cli-1 anytype space list
   ```
5. **无需重启**：bot 每 60 秒重新扫描一次空间/聊天，会自动发现新加入的空间和新建立的聊天并订阅（日志里会打印 `subscribed …` / `discovery: N chat(s)`）。想立即生效可 `aibot restart ai-bot`。

> API key 是 `--all-spaces` 的，覆盖 bot 所在的**所有**空间（含以后加入的），**不用改 key**。
>
> bot 在每个空间里有个**独立的成员 id**（`_participant_<spaceId>_<identity>`）。这个由程序自动按身份解析，你**不用手动填**。

---

## 4. 换模型 / 换 provider

bot 用**内嵌的 pi SDK**，pi 自动识别常见的 provider 环境变量。编辑 `.env`：

```bash
DEEPSEEK_API_KEY=sk-...      # 当前用的
# 或 ANTHROPIC_API_KEY=...   # 换个 provider 就换成它的变量
```

然后 `docker compose ... up -d --force-recreate ai-bot`。

> 当前用的是 **DeepSeek V4.1**（模型 id `deepseek-flash`，**原生多模态、能看图**）。pi 的内置模型表还没有 V4.1，所以用 `docker/models.json` 手动注册（含 `input:["text","image"]`）；该文件在启动时被复制进 pi 的 agent 目录（见 `src/agent/pi-session.ts` 的 `ensureModelsConfig`）。用 `PI_MODEL` 环境变量切换模型。

---

## 5. 记忆（按空间）

记忆是**每个空间一份**，就是工作区里的两个文件：

| 文件 | 作用 |
|---|---|
| `/workspace/<spaceId>/AGENTS.md` | **给 AI 的指令**：告诉它"你是 Anytype 里的助手"、要主动记笔记、怎么用工具。pi 启动时会自动加载。 |
| `/workspace/<spaceId>/MEMORY.md` | **AI 自己写的长期笔记**（"记住X"→ 写这里；下次对话先读它）。 |

**作用域**：工作区目录按 **space** 分（`/workspace/<spaceId>/`），所以**同一空间里的多个聊天共享同一份记忆**——在聊天 A 说"记住X"，聊天 B 也能读到。但**对话上下文是按聊天隔离**的（每个聊天一条独立对话线，互不串）。

### 笔记的讨论（Discussion）

每篇笔记/对象下面有一个**讨论**，它本身也是一个聊天（有自己的 chat id）。bot 会自动订阅它们——所以你可以**在笔记的讨论里 @anytype-bot**，它会读那篇笔记的上下文并回复。

- **上下文**：每篇笔记的讨论是**独立对话线**（按各自的 chat id）。
- **记忆**：与同空间其他聊天/讨论**共享**。
- 讨论**不在** `listChats` 里返回——bot 是从对象列表里读出每个对象的 `discussion` id 来订阅的（见 `src/anytype/discussion.ts`）。

查看某空间的记忆：
```bash
docker exec anytype-ai-bot-1 cat /workspace/<space-id>/MEMORY.md
```

**改提示词**（比如调整记忆策略、身份描述）：改 `src/agent/pi-session.ts` 里 `ensureAgentFiles()` 的模板 → 重新部署。注意它**只在 AGENTS.md 不存在时才写**，已存在的空间需手动更新：
```bash
docker exec anytype-ai-bot-1 sh -c 'cat > /workspace/<space-id>/AGENTS.md' < 新模板.md
```

**聊天输出纯文本**：AGENTS.md 模板里有一段"聊天输出格式"，要求 bot 在**聊天里发纯文本、不要 Markdown**（标题/粗体/表格/链接等——Anytype 聊天不渲染，会原样显示）。但**写进页面正文**（create_note/insert_markdown）仍用规范 Markdown。想改这条规则就改模板里那段。

---

## 6. bot 有哪些能力

| 工具 | 作用 |
|---|---|
| `anytype_list_objects` | 列出对象（默认：页面/笔记，已过滤聊天/系统对象）。**带 `type`**（如 `image`/`file`/`task`）可枚举**该类型的全部对象**——包括**没放进页面的散图/散文件**（默认列表看不到它们）|
| `anytype_search` | 按文本搜空间内容 |
| `anytype_read_object` | 读某篇：**正文按块还原成 Markdown**（标题 `#`、列表 `-`/缩进、待办 `- [x]`、代码围栏、引用 `>`、图片 `![名](id)`），并**附带页面图片**（缩放到 ≤1600px 作为图片内容发给多模态模型，所以它能"看图"） |
| `anytype_download_file` | 把**任意散文件**（PDF/docx/xlsx/txt…）下到容器 `/workspace/<space>/files/`，返回路径+类型+大小；**内容怎么解析交给 agent**（容器内有 `pdftotext`/`unzip`/`file`/`python3`，它能自己抽文字）|
| `anytype_download_images` | 把某篇的**图片下载到容器**（`/workspace/<space>/images/<id>/`），返回路径和像素尺寸 |
| `crop_image` | **查看/裁剪**一张本地图片：给区域比例（x,y,width,height 取 0~1 的小数）就裁剪放大——看小字/手写最有效；不给则看整图 |
| `anytype_create_note` | 新建页面 |
| `anytype_update_object` | 改标题 / 追加正文 |
| `anytype_edit_object` | **改正文里某段文字**（pi-edit 风格：给 `find` 原文→`replace` 新文，可 `replace_all`）|
| `anytype_update_block` | 改某个块的字段（如 `set:{checked:true}` 勾选待办），按块 id 或文本定位 |
| `anytype_delete_block` | 删某个块（可 `recursive` 连子树），按块 id 或文本定位 |
| `anytype_delete_object` | **删**对象 |
| `anytype_set_property` | 给对象**设属性/打标签** |
| `anytype_list_properties` / `anytype_create_property` | 列/建**属性**（`text/number/select/multi_select/date/checkbox/url/email/phone/files/objects`）|
| `anytype_list_types` | 列**类型** |
| `anytype_create_type` / `anytype_update_type` / `anytype_delete_type` | **建/改/删对象类型**（如自定义 "Project"/"Recipe"）：可设 layout（`basic/note/todo/profile/bookmark/set/collection`）、emoji 图标、字段（`properties`）|
| `anytype_create_collection` | 建**集合**（把对象归类到一起）|
| `anytype_collection_items` | 给集合**加/移**对象 |
| `anytype_upload_file` | **上传文件**（给 URL 或容器内文件路径）|
| `anytype_insert_markdown` | **精确插入** Markdown 到对象（`before`/`after` 指定位置或 `position` 首/尾；支持表格等）|
| `anytype_templates` | 模板**列/建/删**（`action: list/create/delete`）；`anytype_create_note` 可带 `template_id` 套用 |
| `anytype_send_message` / `anytype_react` / `anytype_edit_message` / `anytype_delete_message` | **聊天操作**：在当前聊天发消息 / 加 emoji 反应 / 改 / 删消息。**发消息可带附件**（`attachments` = 文件对象 id 数组，先用 `anytype_upload_file` 上传拿 id）——图片/文件会显示在消息里 |
| `anytype_watch` | **订阅**某篇笔记，按 **cron 计划**检查（`action: add/remove/list/schedule/check`）。**可带 `prompt` 指令**——变化时让 AI 去读该对象并按指令处理；不填则只发 diff |
| `web_search` | **联网搜索**当前信息（走 DeepSeek 托管的 Anthropic `web_search`，**同一个 key**；返回答案+来源链接）|
| `subagent` | **派子代理（一次性）**：把独立子任务交给一个全新隔离会话跑（带同样工具、**不能再派子代理**），返回结果。适合「分别总结多篇 / 批量搜读」——保持主上下文干净。每次是一次完整模型调用（费 token）|
| `agent` | **常驻命名子代理**（类 Claude Code 团队）：`action: spawn/message/list/kill`。`spawn` 一个**有名字**的子代理，之后可**反复 `message`** 它——**它保留自己的对话记忆**（跨轮存活）。适合「让它持续跟进一件事，我陆续追加要求」。⚠️ 子代理**看不到当前聊天**，指令要自包含；不能再派生；闲置 `SUBAGENT_IDLE_MS` 后回收，上限 `MAX_SUBAGENTS`（默认 5）|
| `web_fetch` | **抓网页内容**：用内置的 **Lightpanda 无头浏览器**（官方 glibc 版）取具体 URL，默认转 **Markdown**（也可 html/semantic）。适合读 `web_search` 找到的那个页面。⚠️ bot 容器在受限网络，Google/维基等**连不上**，国内站/bing/github 可以。|
| pi 内置 | 读写文件（含图片）、跑命令、搜索等（完整 agent） |

> **筛选搜索**：`anytype_search` 支持 `filters`（按属性/标签条件筛，如"带某标签的页"）。
>
> **订阅按 cron 计划检查**——每个订阅有自己的 5 段 cron（分 时 日 月 周，**本地时区**），调度器每 `WATCH_TICK_MS`（默认 60 秒）tick 一次，只检查当前分钟命中的订阅。因为是 Anytype **没有对象变更事件流**，所以仍是「到点拉取 + diff」。新订阅默认 `WATCH_DEFAULT_CRON`（`*/30 * * * *`）。订阅记录存在 `/workspace/watches.json`，重启不丢。**取不到订阅对象时不会贸然退订**——先调对象列表确认是否真的没了，只有连续 `WATCH_MAX_MISSES`（默认 3）次确认不在列表里才退订；纯网络抖动会保留订阅。

> **订阅可带指令（重点）**：订阅时给 `prompt`（如 `总结这篇文章的变化`、`检查未完成待办并提醒我`），cron 命中且检测到变化时，AI 会**自己去读该对象、按指令处理**，把结果发回聊天——不是干巴巴地念 diff。典型用法：**`订阅"日常试卷1"，每天9点总结一下变化`**。

> **图片变化也能测**：diff 不只看文字——图片块会记它的 `object_id`，所以**换图**（同一块换了张图）也会触发，摘要里给 `换图：旧id → 新id`；新增图片给 `新增图片 object_id=…`。触发语带上这些 id，AI 就能**只取变了的图**（`anytype_download_images`）再处理，而不是重读整页。局限：靠 `object_id` 变化判定；若 Anytype 原地改同一文件对象（同 id 换字节）则测不出（需下载比字节，太重，未做）。


**看扫描件/考卷的最佳流程**（模型会自动这么做）：`anytype_read_object` 看整页概览 → `anytype_download_images` 拿原图 → `crop_image` 裁剪区域放大看清细节。

**触发规则**：被 `@anytype-bot` 时回复；**私聊**（成员 ≤2 的聊天）里每条都回；bot 自己的消息永不触发。

**实时工具反馈**：回合较慢（超过 `TOOL_STATUS_DELAY_MS`，默认 1.5s）时，bot 会在聊天里发一条**气泡**，先显示状态行「🧠 思考中…」/「⏳ 正在 <工具>(<关键参数>)…」；模型一输出正文（工具调用前的**旁白**），这条气泡就**原地变成正文**；出正文后**再调工具才另开**一条气泡（没出正文的工具直接复用当前气泡）。回合结束**中间气泡全部撤回，只留最终答案**，并把答案**按行拆成多条消息**发送（空行跳过）；若模型只写了正文、末尾没再调工具，则该正文整体就是答案。用 `TOOL_STATUS=false` 关闭气泡，答案仍按行发。

**消息附件**：聊天消息带的文件/图片（`attachments`）会**一并告诉 agent**（附上每个的 id 和类型）。它能：**图片**用 `anytype_read_object` 直接看；**其他文件**用 `anytype_download_file` 下载后再用 shell 工具解析。⚠️ 群聊里带附件的消息仍需 **@bot** 才触发（跟普通消息同一规则）。

### 聊天指令（消息以 `/` 开头）

| 指令 | 作用 |
|---|---|
| `/new`（或 `/clear`） | **清空当前聊天的对话**，开新的（不记得之前） |
| `/compact` | 压缩当前对话（省上下文） |
| `/model [名]` | 查看 / 切换本聊天的模型（如 `deepseek-v4-pro`） |
| `/effort [low\|medium\|high\|max]` | 查看 / 设置思考等级 |
| `/yolo [auto\|ask\|readonly]` | **审批模式**（默认 `auto`）：`auto`=全部工具、从不过问；`ask`=写/危险操作需你批准（见第 7 节）；`readonly`=不能写。别名 `on`→auto、`off`→ask、`ro`→readonly。无参数=查看当前模式。**在控制台里语义不同**：`auto`=**解锁**（可派 worker 到其它空间）、`readonly`（或 `ask`/`off`）=**锁定**、无参数=报告锁定状态；控制台**自身始终只读**（见第 8 节「控制台派 worker」）|
| `/approve [all]` | **批准**待批准的操作：`/approve` 只放行这一个，`/approve all` 放行本次及**本回合**后续全部（见第 7 节）|
| `/deny` | **拒绝**待批准的操作（见第 7 节）|
| `/interrupt [now\|step]` | **打断策略**：`now`=新消息一到就打断当前回合；`step`=**等当前这一步**（思考/读）结束再打断——**写操作进行中则等它写完**（默认）。设置**立即生效**，会作用于进行中的回合 |
| `/join <链接>` | **加入空间**（邀请链接）或**接入控制台**（你的 1:1 链接）——不经 agent，直接处理（见第 8 节）|
| `/run <名> [k=v …]` | **跑工作流**：按序执行确定性步骤（见〈工作流（Workflows）〉一节）；`/run <名> --resume <runId>` 从断点续跑 |
| `/runs` | 列出最近的工作流运行（见〈工作流（Workflows）〉一节）|
| `/help` | 列出指令 |

> 指令只在**会触发**的消息里生效（即私聊，或被 @ 的群聊消息）。执行指令**不经过** agent，直接回结果。
> **对话历史已持久化**（`/workspace/sessions/<chat>/…jsonl`），重启不丢；`/new` 才清空。可用 `SESSION_PERSIST=false` 关掉持久化。

### 打断（barge-in）

bot 还在跑一个回合时，你**再发一条**（或 @bot）会**打断当前回合并优先处理最新那条**：

- **旧消息会被丢弃**：排队里还没开始的旧消息直接作废，只跑最新的那条。被中断的回合**不会发出半截回复**（状态占位消息也会被撤回）。
- **打断时机**由 `/interrupt` 的策略决定：
  - `step`（**默认**）：模型**思考中**或**读操作中** → 立即打断；**写操作（建/改/删对象、上传、发消息…）进行中** → **等这次写调用结束再打断**，避免留下半成品。
  - `now`：一律立刻打断（可能把一次写操作打断在半途）。
- 实测（`sleep 8` 作为写操作）：`now` 约 2.5 秒即停，`step` 约 8.8 秒（写完才停）。
- **打断后对话能继续**：被打断只影响当前回合，会话历史仍然可用，下一条消息照常回答。
- 只有**普通消息**和 `/interrupt` 会打断；`/model`、`/effort`、`/yolo` 等设置类指令**不会**打断正在跑的回合。

---

## 默认技能

镜像内置 **8 个默认 pi 技能**（源码在 `docker/skills/`，启动时由 `ensureSkillsConfig` 拷进 pi 的 agent 目录）。技能是**模型自动触发**的——bot 从每个技能的 `description` 判断当前任务是否匹配，匹配就自己选用；你也可以**点名**（如「用 pdf-to-note 把附件整理成笔记」）。

| 技能 | 作用 |
|---|---|
| `fix-image-orientation` | 修 EXIF 横躺的图（下载→摆正→重传→换图块）|
| `pdf-to-note` | 给个 PDF/docx/txt → 结构化笔记 |
| `research-note` | 「研究/查一下 X 并存成笔记」→ 带来源链接的笔记 |
| `extract-todos` | 从某页抽待办（`- [ ]` 复选框）|
| `generate-quiz` | 从某页生成测验/抽认卡 |
| `spreadsheet-to-note` | .xlsx/.csv → Markdown 表格笔记（**不支持** .xls 老格式）|
| `creating-skills` | meta：教 bot 按 Agent Skills 规范写新 `SKILL.md` |
| `model-provider-config` | 教 bot 改 `/root/.pi/agent/models.json`：新增/修改 provider（API 地址、key、模型清单）。改完 **`/new` 或重启**才生效 |

**加一个技能** = 在 `docker/skills/<名字>/SKILL.md` 写好，然后 **rebuild 镜像**。注意 `ensureSkillsConfig` **只拷 `SKILL.md`**——技能目录里的**其它文件不会进容器**，所以脚本/模板要**内联进 `SKILL.md`**（或用其它方式带进镜像）。

> ⚠️ **新增**技能 rebuild 即可；**修改**一个已部署过的技能，rebuild **不会**覆盖（启动时只补缺、不覆盖），需先删掉容器卷里的旧副本：`docker exec anytype-ai-bot-1 rm -rf /root/.pi/agent/skills/<name>` 再重建。

---

## 7. 审批模式（auto / ask / readonly）

`/yolo` 控制**每个聊天**的审批模式（新会话的默认值由 `APPROVAL_MODE` 决定，默认 `auto`）。三种模式：

| 模式 | 行为 |
|---|---|
| `auto`（普通空间默认） | **从不过问**，所有工具直接执行。行为与以往一致。 |
| `ask` | 写/危险工具调用**不立即执行**：bot 先在聊天里发 `⚠️ 想执行 <工具>(<参数>)，回复 /approve、/approve all 或 /deny`，然后**等待**。你回 `/approve`（只放行这一个）、`/approve all`（放行本次及**本回合**后续全部）或 `/deny`（拒绝）。**超时 = 拒绝**（默认 5 分钟，`APPROVAL_TIMEOUT_MS`）。⚠️ `ask` 模式下 `subagent` / `agent` **直接拒绝**（它们会绕过审批）——想委派子代理请先 `/yolo auto`。 |
| `readonly` | **完全不能写**（只保留安全只读工具）。子代理**仍允许**，但**子会话同样是只读**——委派也写不了。 |

用法：

- `/yolo`（无参数）→ 查看当前模式。
- `/yolo auto|ask|readonly` → 设置（别名：`on`→auto，`off`→ask，`ro`→readonly）。

> ⚠️ **行为变更**：`/yolo off` 过去表示「只读」，**现在表示 `ask`**（每个写操作都要你批准）。要只读请改用 **`/yolo readonly`**。

`APPROVAL_MODE` 环境变量设置**新会话**（非控制台）的默认模式；`APPROVAL_TIMEOUT_MS` 设置 `ask` 模式下等待批准的超时（毫秒，超时即拒绝）。

**控制台不受影响（但有例外）**：控制台**自身始终只读**，可它在控制台里的 `/yolo` **不是**审批模式开关，而是**控制台锁**：`/yolo auto` **解锁**（可派 worker 到其它空间）、`/yolo readonly`（或 `ask`/`off`）**锁定**、`/yolo` 无参数报告当前锁定/解锁。默认**锁定**。详见第 8 节「控制台派 worker（跨空间委派）」。

---

## 8. 控制台（全局助手）

**控制台**是**一个特定空间**（一个 1:1 空间）——它被授予**跨空间的全局能力**，作为你统一查询各空间的入口。**普通空间完全不受影响**：它们看不到别的空间。

**指定哪个空间是控制台**（两种方式，env 优先）：

| 方式 | 做法 |
|---|---|
| 环境变量 | `.env` 里设 `CONSOLE_SPACE_ID=<space-id>`（**优先级更高**，覆盖文件）|
| 记录文件 | 写 `/workspace/console.json`：`{"spaceId": "<space-id>", "chatId": "…", "bootstrappedAt": "<ISO 时间>"}`（`chatId` 可省，discovery 会自行解析）|

### 接入控制台（推荐：把 1:1 链接发给 bot）

**把「你自己的 1:1 链接」发给 bot**（或直接发 `/join <你的 1:1 链接>`），bot 就会**镜像你的 1:1 空间**并把它记为控制台。链接从哪来：Anytype 客户端 → **账户头像 → 1:1 图标 → Copy Link**（形如 `https://hi.any.coop/<identity>#<key>`，或 `anytype://hi/?id=…&key=…`）。

bot 启动时若**尚未配置控制台**，会在日志里打印**它自己的** 1:1 链接。于是有两种模式：

| 模式 | 做法 | 说明 |
|---|---|---|
| **A** | 你打开 **bot 自己**的链接 | 自建网络上**未必走得通**：对端身份要经 heart 的 inbox 送达 bot，在这里**不可靠**（日志 `wait profile: got nil profile` / `acl-notifications … apply on empty tree disallowed`）|
| **B（推荐，可靠）** | 你把**自己**的 1:1 链接发给 bot（或 `/join <链接>`） | bot 镜像它 → 控制台接入成功 |

- **1:1 链接** → 镜像该 1:1 空间（`WorkspaceCreate`）并记到 `/workspace/console.json`；**需重启 bot 容器**才生效（`… up -d --force-recreate --no-deps ai-bot`）。
- **邀请链接**（`anytype://invite/?cid=..&key=..` 或 `https://<host>/<cid>#<key>`）→ bot 加入该共享空间（`SpaceJoin`），随后自动发现 + 订阅，**无需重启**。
- 模型也可调用 **`anytype_join_space`** 工具做同样的事，但**仅控制台会话**内可用，且**只有用户明确要求**时才该调。

**在控制台会话里，助手可以：**

- **列出所有已加入的空间**（`anytype_list_spaces`）；
- **读任意空间**：给 `anytype_list_objects` / `anytype_search` / `anytype_read_object` 传 `space` 参数（**空间 id 或名称**）即可跨空间读取；
- **读记忆**：把**全局** `MEMORY.md` 连同**每个空间**的 `MEMORY.md` 一起读回（`anytype_memories`，按空间名分别标注）。

**控制台会话无条件只读**：它的工具集里**没有任何写工具**（建/改/删/编辑/发送/上传/订阅/属性/类型/集合/模板……），所以模型**物理上写不了**——这是**靠不注册这些工具**实现的，**不是靠提示词**。`/yolo` 在控制台里**无效**（会回「控制台始终只读（/yolo 在此无效）」）。

**工作区**：控制台会话的工作区固定为 `/workspace/_global`（它的记忆即**全局记忆**）；普通空间仍各自用 `/workspace/<spaceId>/`。

### 控制台派 worker（跨空间委派）

控制台**自身写不了任何东西**，但它可以把**写任务委派给别的空间**，由那边的 worker 去写——控制台自己始终保持只读。

**控制台锁**：控制台**默认锁定**（只读、不能派 worker），用 `/yolo` 开锁/上锁（**按聊天**记录，重启不丢）：

| 命令 | 作用 |
|---|---|
| `/yolo auto` | **解锁**——控制台获得 `anytype_run_in_space` 工具，可派 worker |
| `/yolo readonly`（或 `ask`/`off`） | **锁定** |
| `/yolo`（无参数） | 报告当前是「已解锁」还是「锁定」 |

> ⚠️ 控制台里的 `/yolo` **不是**审批模式开关（那只是普通空间的），它只控制这把**控制台锁**。

**解锁后**，控制台会多出一个工具 **`anytype_run_in_space(space, task)`**：把一个**一次性 worker** 派到**目标空间**（`space` 给空间 **id 或名称**）。

- worker 在**那个空间自己的工作区/记忆**里跑（该空间的 `AGENTS.md` / `MEMORY.md`），**既能读、也能写那个空间**，任务结束即**销毁**（每次都是全新的）。
- `task` 必须**自包含**——worker **看不到**控制台的对话，要把它需要的信息全写进去。
- **控制台自身永不写**：任何模式下控制台**自己的工具始终只读**；真正写入的只有 worker，且**只写它被指定的那一个空间**。
- worker **不能再派 worker**（没有子代理工具，无法递归）；`space` **写错/不存在会直接报错**（**绝不**回退到别的空间）。
- **普通（非控制台）空间完全不受影响。**

**用法示例**：在控制台里先 `/yolo auto`，然后对它说：

> 去 <空间名> 新建/整理一篇 …（把要做的事说清楚）

### 控制台设「某空间直接响应」（`anytype_set_space_direct`）

默认触发规则：**私聊（空间 ≤2 人）**直接回，**多人空间**里聊天要 **@ 机器人**才回。
> **多人空间会标注发言人**：在 **>2 人**的空间里，bot 把消息喂给模型时会加个前缀 **`[发言人名字] 消息`**，让模型分得清是你还是别人在说（私聊不加）。这是**内部**标注，聊天里看不到。

控制台可**按整个空间**覆盖这条规则，工具 **`anytype_set_space_direct(space, mode)`**（控制台专属，随时可用，不需要解锁）：

| mode | 效果 |
|---|---|
| `direct` | 该空间**所有聊天**都直接响应（**不用 @**）——适合把整个空间当成"随时喊话" |
| `group` | 该空间**所有聊天**都要 **@** 才响应 |
| `auto` | 恢复自动（按成员数判定） |

- `space` 给空间 **id 或名称**；对所有聊天**立即生效**，并**持久化**（重启不丢，存 `<工作区>/direct-overrides.json`）。
- 典型用法：控制台里说「把『考试』空间设成 direct」。改回「把『考试』设成 auto」。
- ⚠️ 副作用：设成 `direct` 后，该空间的聊天里 `/join` 也会被允许（`/join` 原本只在私聊可用）——因为 `direct` 就是"当作私聊"。

### gRPC 桥（`src/anytype/grpc.ts`）

控制台接入 / 加入空间走一个**小本地 gRPC 桥**，直连 anytype-heart 的 `127.0.0.1:31010`（**明文 h2c**）。每次调用都**重新**从 CLI 配置（`~/.anytype/config.json` → `sessionToken`）读 `token` metadata——所以 anytype-cli 重启换了新 token 也能跟上。

- **只暴露三个方法**：`AppGetVersion`（安全的健康探测）、`WorkspaceCreate`（镜像 1:1）、`SpaceJoin`（加入共享空间）。
- **⚠️ 部署要求**：bot 容器必须**只读挂载** anytype-cli 的配置目录，桥才能读到 token。已在 `docker-compose.bot.yml`：`${ANYTYPE_CLI_CONFIG_DIR:-/home/landspace/anytype/storage/anytype-cli}:/root/.anytype:ro`。
- **⚠️ 绝不要调用其他 RPC**：有些 anytype-heart 方法是**已移除的桩**，会 `panic("should be removed")`、**打死 anytype-cli 进程**——之后 bot 的 `service:anytype-cli` netns 变陈旧（日志全是 `fetch failed`），必须 `docker compose … up -d --force-recreate --no-deps ai-bot` 才能恢复。（早前探测 `WorkspaceGetAll` 就是这样。）

**⚠️ 已知限制**：对一个**已存在**的 1:1 空间调用 `WorkspaceCreate` 会**挂到客户端 ~15 秒超时**——因为 heart 尝试重发 inbox 邀请、而在自建网络上取不到对端 profile（`inboxsender: … wait profile: got nil profile`）。**全新**的 1:1 则几秒返回。实际影响：用链接 `/join` 一个**新的** 1:1 没问题；对**已接入**的控制台重跑可能返回超时（**无害**——控制台本来就能用）。

---

## 工作流（Workflows）

**工作流 = 引擎编排的一串有序步骤**（像 GitHub Actions），**确定性执行**；只有**必要的那一步**才调用 AI（`agent` 是四种步骤之一，不是全程 agent）。引擎负责按序跑、记录每步状态/日志、失败重试、中断后从断点续跑。它与「技能」分开存放：技能是"给 agent 的知识"，工作流是"给引擎的脚本"。

**定义**：`docker/workflows/<name>/workflow.yaml`（源码内；构建镜像时 `COPY docker/workflows /app/workflows`，启动时由 `ensureWorkflowsConfig` 拷进 pi agent 目录的 `workflows/`，**只补缺不覆盖**——改已部署过的先删卷内副本再重建，同技能）。字段：

| 字段 | 说明 |
|---|---|
| `name` | **必填**，工作流名（`/run <名>` 用它）|
| `description` | 可选，说明文字 |
| `on.cron` | 可选，5 段 cron（**本地时区**）；缺省=仅手动 |
| `on.notify` | 可选，cron 跑时的**触发聊天**（结果发到哪个 chat）|
| `steps` | **必填**，非空数组，按序执行 |

每个 step 有 `id`（必填、唯一）、`uses`（步骤类型）、`with`（参数），可选 `if` / `retry`。

**四种步骤类型**（`with` 键）：

| `uses` | `with` 键 | 输出（存 `steps.<id>.output`）|
|---|---|---|
| `shell` | `run`（命令串，**必填**）、可选 `cwd` | stdout（超 8000 字符截断）|
| `anytype` | `op`（必填）+ 该 op 参数；可选 `space`（缺省=触发聊天的空间）。已实现 op：`read_object`(`id`)、`search`(`query`)、`list_objects`、`create_note`(`name`/`markdown`)、`send_message`(`chat`/`text`/可选 `attachments`=文件对象 id 数组) | 结果文本 / JSON |
| `http` | `url`（**必填**）、可选 `method`（默认 `GET`）/ `headers` / `body` | 响应体（截断）|
| `agent` | `prompt`（**必填**）、可选 `space` / `tools` / `model` / `fallback` | 绑目标 space 的一次性子会话返回的**文本**。`model` 覆盖该步模型（用 `/model` 列出的 id）；`fallback` 是**备用模型**（主模型报错或返回空时自动改用）；`tools` 限定该步可用工具 |

**审批**：

- 写操作（`anytype` 的 create/send 步骤、`agent` 步骤）按**该 run 所在聊天**的审批模式执行：`auto` 放行、`readonly` 拒绝、`ask` 在聊天里弹 `/approve`/`/deny`；控制台自身只读，需先 `/yolo auto` 解锁才能跑写型工作流。

**变量插值** `{{ … }}`：可用 `{{ steps.<id>.output }}`（前一步输出）、`{{ on.cron }}` / `{{ on.notify }}`（触发上下文）。**只做字面替换**（未知变量→空串），**不是表达式引擎**。

**`if:`**：简单条件——`<左> == <右>` / `<左> != <右>`（字符串比较，两侧引号会剥掉），否则按整串**真值**（空 / `false` / `0` / `no` → 假）。**`retry: N`**：该步失败后**额外重试** N 次（默认 0）。

### 运行与续跑

| 命令 | 作用 |
|---|---|
| `/run <名> [k=v …]` | 手动跑一个工作流（结果回帖在**发出命令的聊天**）|
| `/run <名> --resume <runId>` | 从**第一个非 `done` 的步骤**续跑（已完成的步不重跑，用其存下的 output）|
| `/runs` | 列出最近 10 条运行（新→旧）|

- 每个 run 一个目录 **`/workspace/workflow-runs/<id>/`**（可用 `WORKFLOW_RUN_DIR` 覆盖）：
  - `state.json`：`{ id, name, trigger, chatId, spaceId, status, steps:[{id,uses,status,output?,error?,startedAt,endedAt}] }`；run `status ∈ running|done|failed`，步 `status ∈ pending|running|done|failed|skipped`。
  - `log.ndjson`：逐步日志；`steps/<id>.out`：该步产出。
- **失败语义**：某步失败（重试用尽）→ **中止**，run 标 `failed`，状态保留；用 `--resume` 从那一步继续。
- **cron 触发**：`on.cron` 命中当前（本地）分钟即起一次 run（每个工作流每分钟至多一次）；该 run 的**触发聊天**为 `on.notify`。
- **工作流状态对话**：引擎在每步状态变化时投递生命周期事件（`▶ 步名 …`、`✅/❌/⏭`）到一个**专门的聊天**——**仅当** env `WORKFLOW_STATUS_CHAT` 设了对应 chat id **且**该聊天被发现了才投递；**不会自动建群**（未设=不投递状态事件）。

**v1 限制**：

- `k=v` 参数目前被**接受但尚未注入模板**（保留给后续）。
- `{{ env.X }}` 目前**恒为空**（v1 不注入容器 env）。
- `shell` / `http` 步骤**不额外加审批闸门**（与普通会话里的 bash 同等待遇）。
- 状态对话**不会自动创建**，需显式设 `WORKFLOW_STATUS_CHAT`。

---

## 9. 排障

| 现象 | 原因 / 处理 |
|---|---|
| 日志 `fatal: listSpaces failed: 401` 后自动恢复 | anytype-cli 重启时的瞬时鉴权失败，容器会自动重启；忽略即可。若反复出现，见下条。 |
| 反复 401 / 连不上 API | `docker ps` 看 anytype-cli 是否健康；`aibot restart ai-bot`。 |
| 日志里 `oom ready timeout` | **已废弃**（那是旧 omp 时代的错误）。若还出现说明跑的是旧镜像，重建。 |
| 收到消息但长时间不回复、无反应 | ① 看 `aibot logs ai-bot` 有无报错；② 消息是否比 bot 启动时间早（订阅时会跳过历史回放）；③ 重启 bot（刷新 SSE 订阅）。 |
| 连发几条消息，只有**最后一条**有回复 | **正常**：这是打断（barge-in）——旧消息被丢弃、只跑最新那条。想改打断时机用 `/interrupt now\|step`（见第 6 节）。 |
| `ask` 模式下 bot 一直卡着不动 | **正常**——它在等你 `/approve` 或 `/deny`（或在 5 分钟后自动拒绝）。回复 `/approve`、`/approve all` 或 `/deny` 即可继续（见第 7 节）。 |
| 打断了一次写操作，对象像是只写了一半 | 说明当时策略是 `now`。改成 `/interrupt step`（默认）——写操作进行中会**等它写完**再打断。 |
| 问"笔记"它去翻本地文件 | 应调 `anytype_*` 工具。检查 `AGENTS.md` 是否有身份提示段，以及它是否在 bot 所在空间里。 |
| 回复很慢（分钟级） | 那是旧 omp 架构。当前是内嵌 pi SDK，正常 **几秒**。 |
| 内存 | 正常空闲 ~70–100MB；上限 2G。看 `docker stats anytype-ai-bot-1`。 |
| 容器停了 | `docker ps -a` 看退出码；`restart: unless-stopped` 一般会自动拉起。 |
| 控制台 / `/join` 加入失败 | ① 确认 bot 容器**只读挂载**了 anytype-cli 配置目录（桥靠它读 `sessionToken`，见第 8 节）；② **别调 `WorkspaceGetAll` 之类桩方法**——会打死 anytype-cli，需重建 bot（`… up -d --force-recreate --no-deps ai-bot`）；③ 对**已存在**的 1:1 重跑 `/join` 可能超时——**无害**，控制台已可用。 |
| 控制台说做不到派 worker | 它处于**锁定**态。先在控制台里发 `/yolo auto` **解锁**（见第 8 节「控制台派 worker」）。`/yolo readonly`（或 `ask`/`off`）会重新锁定。 |

---

## 10. 关键常量（速查）

| 项 | 值 |
|---|---|
| bot 账号身份 | `<bot-identity>` |
| bot 显示名 | `anytype-bot` |
| anytype-cli API | `http://127.0.0.1:31012`（容器内经共享 netns；主机经 `127.0.0.1:31012`） |
| anytype-cli 容器 | `anytype-anytype-cli-1` |
| bot 容器 | `anytype-ai-bot-1` |
| 测试空间 | `<space-name>`（API id `<space-id>`） |
| `APPROVAL_MODE` | 新会话默认审批模式（`auto`/`ask`/`readonly`，默认 `auto`） |
| `APPROVAL_TIMEOUT_MS` | `ask` 模式待批准超时，超时即拒绝（默认 `300000`，即 5 分钟） |

---

## 11. 从零重建（灾难恢复）

1. 起 any-sync 栈（含 anytype-cli）：见 `/home/landspace/anytype` 的说明；`anytype-cli` 两段服务已在 `docker-compose.yml` 中启用。
2. 建 bot 账号 + key：
   ```bash
   docker exec anytype-anytype-cli-1 anytype auth apikey create ai-bot --all-spaces --read-write
   ```
   把得到的 key 填进 `.env` 的 `ANYTYPE_API_KEY`。
3. 让 bot 加入各空间（见第 3 节）。
4. 把 `.env` 其余项填好（身份、provider key）。
5. 构建并启动（见第 2 节）。

> 记忆存在 Docker 卷 `bot_workspace` 里，只要卷还在就不会丢。
