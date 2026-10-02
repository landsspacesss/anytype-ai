# 默认技能（第一批）设计

日期：2026-10-02
状态：待实现

## 1. 背景与目标

bot 已有 `docker/skills/fix-image-orientation/`（EXIF 横躺修图）作为**随镜像分发的默认 pi skill** 范例。用户想要一批开箱可用的默认技能——都是**多步骤工作流**，靠现有工具（`anytype_*` / `bash` / `web_*`）组合，**不新增工具**（符合"能力优先写成 skill"的偏好）。

pi 的 skill 机制：目录含 `SKILL.md`（frontmatter `name`/`description`）；从 `<agentDir>/skills/` 发现；`ensureSkillsConfig` 在启动时把 `docker/skills/*` 拷进 agentDir（**只补不覆盖**，已存在的不动）。

## 2. 本批技能（6 个）

每个 `docker/skills/<name>/SKILL.md`：frontmatter `description` 写**做什么 + 何时用**（对齐官方 Agent Skills 规范；以 "Use when …" 起头、含具体触发词；**不含尖括号 `<…>`**，否则加载器当 XML 标签拒收）；正文中文，含「速查表 + 步骤 + 注意/坑」，风格对齐 `fix-image-orientation`。依赖现有工具，无新代码。

| 目录 | description 触发 | 步骤（工具组合） |
|---|---|---|
| `pdf-to-note` | 用户给一个 PDF/docx/txt 等文件（聊天附件、散文件、或 URL）想整理成笔记时 | `anytype_download_file`（附件给 id）→ `bash`：`pdftotext`(.pdf) / `unzip -p` 读 docx 的 `word/document.xml` / `cat`(.txt)；**扫描件**改用 `anytype_download_images`+`crop_image` 看图 → `anytype_create_note` 写成**带标题/要点**的结构化笔记 |
| `research-note` | 用户要"研究/查一下 X 并写成笔记"时 | `web_search` 取来源 → `web_fetch` 读正文 → `anytype_create_note` 写一篇**带来源链接**的笔记（标注每个来源） |
| `extract-todos` | 用户想把某页里的待办/行动项抽出来时 | `anytype_read_object` 读页 → 抽取行动项 → 用 `- [ ]` 复选框 `anytype_insert_markdown` 到新页或原页 |
| `generate-quiz` | 用户想从某页生成测验/抽认卡时 | `anytype_read_object` 读页 → 生成 Q&A / 抽认卡 → `anytype_create_note`（或 `anytype_insert_markdown`）|
| `spreadsheet-to-note` | 用户给一个 .xlsx/.csv 文件想整理成笔记/表格时 | `anytype_download_file` → `bash` python3（**仅标准库**）解析 → 每个工作表 dump 成 **Markdown 表格** → `anytype_create_note` / `anytype_insert_markdown` |
| `creating-skills` | 用户想"新建一个技能 / 把某个流程沉淀成技能 / 教 bot 一个新技能"时 | 见 §2.1（meta 技能：教 bot 怎么写 SKILL.md）|

### 2.1 `creating-skills`（meta 技能）

一个"写技能的技能"——教 bot 按**官方 Agent Skills 规范**新建一个 pi skill。内容（浓缩官方 spec + 最佳实践，非照搬 Claude Code 的 skill-creator）：

- **格式**：`SKILL.md` = YAML frontmatter + Markdown。必填 `name`、`description`；可选 `license`/`compatibility`/`metadata`/`allowed-tools`。
- **硬约束**：`name` ≤64，仅小写字母/数字/连字符，不以连字符开头/结尾、无连续连字符，**且必须与目录同名**；`description` ≤1024、非空、写**做什么+何时用**、**不得含 `<…>`**。
- **放哪**：本 bot 的技能随镜像走 `docker/skills/<name>/SKILL.md`（`ensureSkillsConfig` 启动拷进 agentDir 的 `skills/`）；也可放 `<agentDir>/skills/`。改完需 `docker build` + 重启。
- **description = 触发器**（最常见失效点）：具体、含用户会说的关键词/触发词；宁可"偏积极"。用户口令也算触发词。
- **正文**：简短祈使步骤；**"注意/坑"段**价值最高（写那些违反直觉的具体纠正）；短模板内联、长内容入 `references/`；单文件 <500 行（≈5000 tokens）；渐进披露（metadata→正文→引用文件按需）。
- **流程**：从**真实任务**出发（做过第 2–3 次再沉淀）→ 写 `SKILL.md` → 校验 frontmatter（name 与目录一致、description 无尖括号）→ 用真实任务试触发 → 迭代。
- 附一行："官方规范：https://agentskills.io/specification"。

## 3. 表格解析（xlsx/csv，仅标准库）

容器有 `unzip`/`python3`（stdlib：`csv`/`zipfile`/`xml.etree`），**无** openpyxl/pandas/xlrd/libreoffice。

- **.csv**：python3 `csv` 模块直接读 → Markdown 表格。
- **.xlsx**：是 zip → `zipfile` 读 `xl/sharedStrings.xml`（共享字符串，`t="s"` 的单元格引用其索引）与 `xl/worksheets/sheetN.xml`（行 `<row>`、单元格 `<c r= t=><v>`）→ 拼成**每表一个 Markdown 表格**。用 `xl/workbook.xml` 里的 sheet 名做标题。
- **.xls（老二进制）**：**不支持**——skill 明确提示用户另存为 xlsx/csv（零新依赖的取舍）。
- 解析脚本嵌入 `SKILL.md`（一段可复制的 `python3 - <<'PY' …` 或随附 `docker/skills/spreadsheet-to-note/xlsx2md.py`）。**大表**：截断到合理行数（如每表前 200 行）+ 注明"已截断"。

## 4. 非目标（YAGNI）

- 不加任何新工具（纯 skill）。
- 不支持 `.xls`（老格式）、不装 openpyxl/xlrd/libreoffice。
- 不做"每日笔记/翻译"（本批未选）。
- 不改 `ensureSkillsConfig` 逻辑（已够用）。

## 5. 测试 / 验证

- **无代码改动** → 无需单测。
- **静态**：每个 `SKILL.md` frontmatter 合法（`name` 仅字母数字连字符；`description` 以 "Use when" 起头、无流程摘要）；`docker build` 后 `node -e` 用一个 `DefaultResourceLoader({agentDir}).reload()` 确认 **6 个技能**（含既有 `fix-image-orientation`）都被发现。
- **关键脚本实测**（在容器内，dev-test 或 `/tmp` 造样本）：
  - csv 解析脚本：造一个小 csv → 跑 → 得到 Markdown 表格；
  - xlsx 解析脚本：**手工造**一个最小 xlsx（zip 含 `[Content_Types].xml`/`xl/workbook.xml`/`xl/worksheets/sheet1.xml`/`xl/sharedStrings.xml`）→ 跑 → 得到表格；
  - `pdftotext` 可用性（`command -v`）。
- **端到端"bot 自己按技能跑"仍需用户在 dev-test 里发消息触发**（bot 只处理用户消息）。

## 6. 交付

- 5 个 `docker/skills/<name>/SKILL.md`（+ 可选 `spreadsheet-to-note/xlsx2md.py`）。
- 文档：`RUNBOOK.md` 加一节「默认技能」列这 5 个 + 触发方式；`README.zh-CN.md` 能力列表补一句。
- 部署：`docker build` + 重建 bot；启动日志/探针确认技能被发现。
