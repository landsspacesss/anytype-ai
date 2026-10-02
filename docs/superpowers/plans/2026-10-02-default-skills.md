# 默认技能（第一批）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 bot 加 6 个随镜像分发的默认 pi skill（5 个工作流 + 1 个写技能的 meta 技能），无代码改动。

**Architecture:** 每个技能 = `docker/skills/<name>/SKILL.md`（YAML frontmatter + 中文正文）。`ensureSkillsConfig` 启动时把 `docker/skills/<name>/SKILL.md` 拷进 pi 的 agentDir `skills/`（**只拷 `SKILL.md`，不拷子目录**——所以脚本一律**内联**在 SKILL.md 里，不建 `scripts/`）。技能靠现有工具（`anytype_*`/`bash`/`web_*`）组合，**不新增工具**。

**Tech Stack:** Markdown（Agent Skills 规范）、Docker、现有容器工具（`pdftotext`/`unzip`/`python3` 标准库）。

## Global Constraints

- 规范（https://agentskills.io/specification）：`name` ≤64、仅 `[a-z0-9-]`、不以 `-` 起止、无连续 `--`、**必须等于目录名**；`description` ≤1024、非空、写「做什么 + 何时用」、**不得含 `<` 或 `>`**（加载器当 XML 标签拒收）。
- 正文中文；结构含「速查表 + 步骤 + 注意/坑」，对齐既有 `docker/skills/fix-image-orientation/SKILL.md`。
- 正文 <500 行；脚本**内联**（当前 `ensureSkillsConfig` 只拷 `SKILL.md`）。
- **无新依赖**：`.xls` 不支持；xlsx via 标准库 `zipfile`+`xml.etree`；csv via `csv`。
- 参考实现的工具名：`anytype_download_file`、`anytype_download_images`、`crop_image`、`anytype_create_note`、`anytype_insert_markdown`、`anytype_read_object`、`anytype_update_object`、`web_search`、`web_fetch`、`bash`。
- 提交信息英文，风格 `feat:/docs:`。
- 实机验证用 `docker build` + 重建 bot；技能"bot 自己触发"需用户在 dev-test 发消息（无法自动化）。

## 校验命令（每个技能任务复用）

```bash
node -e '
const fs=require("fs"),path=require("path");
const dir=process.argv[1];
const s=fs.readFileSync(path.join(dir,"SKILL.md"),"utf8");
const m=s.match(/^---\r?\n([\s\S]*?)\r?\n---/); if(!m) throw new Error("no frontmatter");
const lines=m[1].split(/\r?\n/);
const get=k=>{const l=lines.find(x=>x.startsWith(k+":"));return l?l.slice(k.length+1).trim():undefined;};
const name=get("name"), desc=get("description");
if(!name||!desc) throw new Error("name/description required");
if(name!==path.basename(dir)) throw new Error("name != dir name: "+name);
if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error("bad name charset: "+name);
if(name.length>64) throw new Error("name too long");
if(desc.length>1024) throw new Error("description too long");
if(/[<>]/.test(desc)) throw new Error("description contains angle brackets");
const body=s.slice(m[0].length).trim();
if(body.length<50) throw new Error("body too short");
console.log("OK", name, "desc="+desc.length+" chars, body="+body.split(/\r?\n/).length+" lines");
' docker/skills/<name>
```

---

### Task 1: `pdf-to-note`

**Files:**
- Create: `docker/skills/pdf-to-note/SKILL.md`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: pdf-to-note
description: Use when the user gives you a PDF, Word document, or text file — as a chat attachment, a loose file object, or a URL — and wants it turned into a structured Anytype note. Also use when asked to "summarize this document", "把这个 PDF 整理成笔记", or to extract key points from an uploaded file.
---

# 文件/PDF → 结构化笔记

## 是什么

把用户给的文档（PDF / docx / txt）读成文字，整理成一篇**带标题和要点**的 Anytype 笔记。

## 速查

| 步骤 | 怎么做 |
|---|---|
| 拿到文件 | 聊天附件 → `anytype_download_file {id}`；散文件对象 → 同；URL → 直接 `web_fetch` |
| PDF 取文 | `bash`：`pdftotext -layout <file> -` |
| docx 取文 | `bash`：`unzip -p <file> word/document.xml`，再用 python 标准库去标签 |
| txt | `bash`：`cat <file>` |
| **扫描件/图片 PDF** | `pdftotext` 会几乎空白 → 改用 `anytype_download_images`（若是页面）或把 PDF 转图后 `crop_image` 看图 |
| 写笔记 | `anytype_create_note {name, markdown}` |

## 步骤

1. 判断文件来源：附件/散文件用 `anytype_download_file`（返回容器内路径）；URL 用 `web_fetch`。
2. 取文字：`.pdf`→`pdftotext -layout <path> -`；`.docx`→`unzip -p <path> word/document.xml` 后去 XML 标签；`.txt`→`cat`。
3. **若 PDF 文本几乎为空**（多半是扫描件）→ 用 `crop_image`/`anytype_download_images` 走"看图"路线（多模态读图）。
4. 整理成 markdown：`# 标题` + 一句话摘要 + `## 要点` 列表 +（可选）`## 原文摘录`。**保留原文事实，别编造**。
5. `anytype_create_note {name:"<文档标题>", markdown:"<整理结果>"}`。
6. 回报：新笔记 id + 一句"来源是 XXX 文件"。

## 注意 / 坑

- 大文件：先抽章节标题（`pdftotext` 输出里找行首编号/大写标题），只精读关键段，别把整本塞进上下文。
- docx 的 XML 里 `<w:p>` 是段落、`<w:t>` 是文字——用 python 里 `xml.etree` 取所有 `w:t` 拼接。
- 表格在 `pdftotext -layout` 里能大致对齐；需要精确表格时改成看图。
- 聊天里的图片附件用 `anytype_read_object`（能直接看），**不是** pdftotext。
```

- [ ] **Step 2: 校验 frontmatter**

Run: `node -e '<上面的校验脚本>' docker/skills/pdf-to-note`
Expected: `OK pdf-to-note desc=… chars, body=… lines`

- [ ] **Step 3: 实测 `pdftotext` 可用**

Run: `docker exec anytype-ai-bot-1 sh -c 'command -v pdftotext && echo ok'`
Expected: 打印路径 + `ok`

- [ ] **Step 4: 提交**

```bash
git add docker/skills/pdf-to-note/SKILL.md
git commit -m "feat(skills): pdf-to-note — turn a document into a structured note"
```

---

### Task 2: `research-note`

**Files:**
- Create: `docker/skills/research-note/SKILL.md`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: research-note
description: Use when the user asks you to research a topic and save the findings as an Anytype note — e.g. "查一下 X 并写成笔记", "研究一下 X", "帮我调研 X 并存下来". Also use when a question needs current web info and the answer should be kept as a note with sources.
---

# 网页研究 → 带来源的笔记

## 是什么

针对一个主题，联网搜几个来源、读正文，写成一篇**带来源链接**的 Anytype 笔记。

## 速查

| 步骤 | 工具 |
|---|---|
| 搜来源 | `web_search {query}` → 返回答案 + 来源链接列表 |
| 读正文 | `web_fetch {url}` → 网页 Markdown（默认）|
| 写笔记 | `anytype_create_note {name, markdown}`，结尾列 `## 来源` |

## 步骤

1. `web_search` 查主题；记下 2–4 个**相关**来源链接（跳过明显不相关的）。
2. 对关键来源 `web_fetch` 读正文（若某站连不上——容器网络受限——换下一个来源，别卡住）。
3. 综合成 markdown：`# 主题` + 摘要 + `## 要点` + `## 来源`（裸 URL 一行一个）。
4. `anytype_create_note`。
5. 回报：笔记 id + 用了几个来源。

## 注意 / 坑

- **容器网络受限**：Google/Wikipedia 等连不上；bing/baidu/知乎/github 可以。某源 `web_fetch` 失败就换，别报错停住。
- **必须标来源**：每个关键结论后面能对上来源；文末列所有 URL。
- 别把搜索摘要当正文——尽量 `web_fetch` 读原文再总结。
- 主题很宽就先跟用户确认范围（或先给出大纲再展开）。
```

- [ ] **Step 2: 校验 frontmatter**

Run: `node -e '<校验脚本>' docker/skills/research-note`
Expected: `OK research-note …`

- [ ] **Step 3: 提交**

```bash
git add docker/skills/research-note/SKILL.md
git commit -m "feat(skills): research-note — web research saved as a sourced note"
```

---

### Task 3: `extract-todos`

**Files:**
- Create: `docker/skills/extract-todos/SKILL.md`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: extract-todos
description: Use when the user wants the action items, to-dos, or tasks pulled out of an Anytype page — e.g. "把待办抽出来", "这页有哪些 action item", "extract the todos". Produces a checkbox list.
---

# 从一页抽待办清单

## 是什么

读一篇 Anytype 页，把其中的**行动项/待办**抽出来，写成勾选列表（`- [ ]`）。

## 速查

| 步骤 | 工具 |
|---|---|
| 读页 | `anytype_read_object {id}` |
| 写清单 | `anytype_insert_markdown {id, markdown, position:"last"}`（追加到原页）或 `anytype_create_note`（另立新页）|
| 待办写法 | `- [ ] 内容`（复选框） |

## 步骤

1. `anytype_read_object` 读目标页（页面 id 从对话/`anytype_list_objects` 拿）。
2. 抽取行动项：祈使句、"需要/要/待/请"、`TODO`、"记得"、负责+动作等；**只抽动作**，别把陈述句都算上。
3. 判断去向：用户说"加到这页"→追加到原页；否则**默认另立新页**（更安全，不动原页）。
4. 生成 `- [ ] <内容>`（可加粗体标记来源小节）。
5. 追加：`anytype_insert_markdown {id:"<页id>", position:"last", markdown:"## 待办\n- [ ] A\n- [ ] B"}`；或 `anytype_create_note`。
6. 回报：抽了几条、写到哪里。

## 注意 / 坑

- **别漏也别编**：只抽原文里真实存在的动作；不确定的宁可少抽。
- 默认**不动原页**（另立新页），除非用户明确要追加——避免弄乱用户的页。
- 已经勾选过的（`- [x]`）算已完成，若要保留就原样带上。
```

- [ ] **Step 2: 校验 frontmatter**

Run: `node -e '<校验脚本>' docker/skills/extract-todos`
Expected: `OK extract-todos …`

- [ ] **Step 3: 提交**

```bash
git add docker/skills/extract-todos/SKILL.md
git commit -m "feat(skills): extract-todos — pull action items from a page"
```

---

### Task 4: `generate-quiz`

**Files:**
- Create: `docker/skills/generate-quiz/SKILL.md`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: generate-quiz
description: Use when the user wants a quiz, flashcards, or study questions generated from an Anytype page — e.g. "给这页出题", "生成抽认卡", "帮我做个小测验". Produces question/answer items.
---

# 从一页生成测验/抽认卡

## 是什么

读一篇 Anytype 页，把它变成**测验题**或**抽认卡**（问答对）。

## 速查

| 步骤 | 工具 |
|---|---|
| 读页 | `anytype_read_object {id}` |
| 生成 | 针对页内**事实/定义/公式**出题 |
| 写下来 | `anytype_create_note`（新建）或 `anytype_insert_markdown`（追加）|
| 抽认卡写法 | `**问：** …` / `**答：** …`，一卡一段 |
| 测验写法 | `1. 题干\n   - A …\n   - B …` + 文末 `## 答案` |

## 步骤

1. `anytype_read_object` 读页。
2. 出 5–10 题，每题只考页内**真实存在**的内容；覆盖不同点（定义/事实/推导/应用）。
3. 选形式：用户说"抽认卡"→问答对；否则默认选择题+答案。
4. `anytype_create_note {name:"<页名> 测验", markdown}` 或 `anytype_insert_markdown`。
5. 回报：几题、写到哪、答案在哪。

## 注意 / 坑

- **不能考页外知识**：题目和答案都要能从该页推出，否则用户没法用它复习。
- 答案另起 `## 答案` 段，别直接跟在题后（否则自测没意义）。
- 页内容太少（<3 个知识点）就如实说，别硬凑。
```

- [ ] **Step 2: 校验 frontmatter**

Run: `node -e '<校验脚本>' docker/skills/generate-quiz`
Expected: `OK generate-quiz …`

- [ ] **Step 3: 提交**

```bash
git add docker/skills/generate-quiz/SKILL.md
git commit -m "feat(skills): generate-quiz — quiz/flashcards from a page"
```

---

### Task 5: `spreadsheet-to-note`（含内联 xlsx/csv 解析 + 实测）

**Files:**
- Create: `docker/skills/spreadsheet-to-note/SKILL.md`

- [ ] **Step 1: 实测内联解析脚本**（先证明脚本能跑，再写进 skill）

造样本并跑（在容器里）：

```bash
docker exec -w /tmp anytype-ai-bot-1 python3 - <<'PY'
import csv, io, zipfile, xml.etree.ElementTree as ET
# --- csv ---
csvtext = "姓名,年龄\n张三,20\n李四,30\n"
rows = list(csv.reader(io.StringIO(csvtext)))
print("CSV rows:", rows)
# --- xlsx (build a minimal one) ---
NS="{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
wb = zipfile.ZipFile("/tmp/s.xlsx","w")
wb.writestr("xl/workbook.xml", f'<workbook xmlns="{NS[1:-1]}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>')
wb.writestr("xl/sharedStrings.xml", f'<sst xmlns="{NS[1:-1]}"><si><t>姓名</t></si><si><t>年龄</t></si><si><t>张三</t></si><si><t>20</t></si></sst>')
wb.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{NS[1:-1]}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>20</v></c></row></sheetData></worksheet>')
wb.close()
# parse
z = zipfile.ZipFile("/tmp/s.xlsx")
ss = [ "".join(t.text or "" for t in si.iter(NS+"t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml")) ]
print("shared:", ss)
sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
for row in sheet.iter(NS+"row"):
    cells = []
    for c in row.iter(NS+"c"):
        v = c.find(NS+"v"); val = v.text if v is not None else ""
        if c.get("t") == "s": val = ss[int(val)]
        cells.append(val)
    print("row:", cells)
PY
```
Expected: `CSV rows: [['姓名','年龄'],['张三','20'],['李四','30']]` … `shared: ['姓名','年龄','张三','20']` … `row: ['姓名','年龄']` / `row: ['张三','20']`

- [ ] **Step 2: 写 SKILL.md**（内联同一套解析逻辑）

```markdown
---
name: spreadsheet-to-note
description: Use when the user gives you a .xlsx or .csv file (chat attachment, loose file, or URL) and wants its contents turned into an Anytype note or Markdown table — e.g. "把这个表格整理成笔记", "读一下这个 xlsx", "把这份表格存进来". Does not handle the legacy .xls binary format.
---

# 表格（xlsx/csv）→ 笔记

## 是什么

把 `.xlsx` / `.csv` 读成数据，**每个工作表 dump 成一张 Markdown 表格**，写成 Anytype 笔记。

**不支持 `.xls`（老二进制格式）**——遇到就提示用户另存为 xlsx/csv。

## 速查

| 步骤 | 工具 |
|---|---|
| 拿到文件 | 附件/散文件 → `anytype_download_file {id}`；URL → 先下到本地 |
| 看是什么 | `bash`：`file <path>`（区分 xlsx=zip / csv=text / xls=老格式）|
| 解析 | `bash` python3（**仅标准库**，见下）|
| 写笔记 | `anytype_create_note {name, markdown}` |

## 解析脚本（内联，标准库）

```python
import csv, sys, zipfile, xml.etree.ElementTree as ET
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

def md_table(rows):
    rows = [["" if c is None else str(c) for c in r] for r in rows]
    if not rows: return ""
    out = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"]*len(rows[0])) + " |"]
    for r in rows[1:]:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)

def read_csv(path):
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        return [list(r) for r in csv.reader(f)]

def read_xlsx(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
        ss = ["".join(t.text or "" for t in si.iter(NS+"t")) for si in sst]
    books = {}
    wbx = ET.fromstring(z.read("xl/workbook.xml"))
    for sh in wbx.iter(NS+"sheet"):
        books[sh.get("name")] = sh.get("sheetId")
    sheets = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
    result = []
    for i, sname in enumerate(sheets):
        rows = []
        for row in ET.fromstring(z.read(sname)).iter(NS+"row"):
            cells = []
            for c in row.iter(NS+"c"):
                v = c.find(NS+"v"); val = v.text if v is not None else ""
                if c.get("t") == "s" and val != "": val = ss[int(val)]
                cells.append(val)
            rows.append(cells)
        title = list(books.keys())[i] if i < len(books) else sname
        result.append((title, rows))
    return result

path = sys.argv[1]
if path.lower().endswith(".csv"):
    print("## " + path.split("/")[-1]); print(md_table(read_csv(path)))
else:
    for title, rows in read_xlsx(path):
        print(f"## {title}"); print(md_table(rows[:200])); print()
```

**用法**：把上面存成 `/tmp/x2md.py`，然后 `bash`：`python3 /tmp/x2md.py <表路径>`。

## 步骤

1. `anytype_download_file`（或先下 URL）拿到本地路径；`file <path>` 确认类型。
2. 若 `file` 说是老 `.xls`（"Composite Document File"）→ 告诉用户不支持，**请另存为 .xlsx 或 .csv**，停。
3. 跑解析脚本（把上面内联脚本写进 `/tmp/x2md.py`）→ 得到每表的 Markdown 表格。
4. 组装 markdown：`# <文件名>` + 每个工作表 `## <表名>` + 表格；**大表截断**到前 ~200 行并注明"（已截断）"。
5. `anytype_create_note {name, markdown}`。
6. 回报：几个工作表、各多少行、写到哪。

## 注意 / 坑

- **只标准库**：容器没有 openpyxl/pandas——上面的脚本只用了 `csv`/`zipfile`/`xml.etree`。别 `import pandas`。
- **`.xls` 不支持**：老二进制格式，标准库读不了；提示用户转 xlsx/csv（别硬试）。
- xlsx 里 `t="s"` 的单元格是**共享字符串索引**——不查 `sharedStrings.xml` 会读出数字乱码。
- 大表别整张塞进笔记：截断 + 说明，或先问用户要哪些行/列。
- 中文编码：csv 用 `encoding="utf-8", errors="replace"`；GBK 的 csv 可能乱码，可试 `encoding="gbk"`。
```

- [ ] **Step 3: 校验 frontmatter**

Run: `node -e '<校验脚本>' docker/skills/spreadsheet-to-note`
Expected: `OK spreadsheet-to-note …`

- [ ] **Step 4: 提交**

```bash
git add docker/skills/spreadsheet-to-note/SKILL.md
git commit -m "feat(skills): spreadsheet-to-note — xlsx/csv to a Markdown-table note"
```

---

### Task 6: `creating-skills`（meta 技能）

**Files:**
- Create: `docker/skills/creating-skills/SKILL.md`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: creating-skills
description: Use when the user wants to create a new skill, turn a procedure into a reusable skill, or teach the bot a new skill — e.g. "写个技能", "把这个流程沉淀成技能", "教 bot 一个新技能". Explains the Agent Skills SKILL.md format and where skills live in this bot.
---

# 写一个新技能（SKILL.md）

## 是什么

教 bot 按 **Agent Skills 规范**新建一个 pi 技能：一个含 `SKILL.md`（YAML frontmatter + Markdown 正文）的目录。
官方规范：https://agentskills.io/specification

## frontmatter（必填两个）

| 字段 | 约束 |
|---|---|
| `name` | ≤64；仅小写字母/数字/连字符；不以 `-` 起止、无 `--`；**必须等于目录名** |
| `description` | ≤1024；非空；写**做什么 + 何时用**（含用户会说的关键词/触发词）；**不得含 `<` 或 `>`** |

可选：`license`、`compatibility`、`metadata`、`allowed-tools`（本环境用不到通常可不写）。

## 放哪 / 怎么生效

- 本 bot 的技能**随镜像**分发：`docker/skills/<name>/SKILL.md`。启动时 `ensureSkillsConfig` 把 `<name>/SKILL.md` 拷进 pi 的 agentDir `skills/`（**只拷 SKILL.md，不拷子目录**）。
- 改完要 `docker build` + 重建 bot 才生效。
- 也可直接放 `<agentDir>/skills/<name>/SKILL.md`（即时生效，但不随镜像走）。

## 好技能的要点

- **description = 触发器**（最常见的失效点）：写清"什么时候该用"，用用户实际会说的词；宁可"偏积极"一点。若技能总不被触发，先改 description。
- 正文给**祈使式步骤**；**"注意/坑"段价值最高**——写那些违反直觉的具体纠正。
- 短模板**内联**；长参考材料放 `references/`（当前实现不拷子目录，故本 bot 里优先内联或放正文）。
- 单文件 <500 行（≈5000 tokens）。渐进披露：metadata 常驻 → 触发时加载正文 → 引用文件按需。
- 从**真实任务**出发（做过第 2–3 次再沉淀），别写通用套话。

## 步骤

1. 想清技能**何时**该被触发（写进 description 的开头）。
2. 建目录 `docker/skills/<name>/`，写 `SKILL.md`（照上面约束）。
3. 自检：`name` 与目录一致、description 无尖括号、正文有"步骤 + 坑"。
4. 若有脚本，**内联**进正文（当前不拷子目录）。
5. 告诉用户需要 `docker build` + 重建才生效；并在真实场景里试触发、按需迭代。

## 注意 / 坑

- **name 必须等于目录名**，否则不加载。
- **description 里别写 `<` `>`**——加载器当 XML 标签，会整份拒收。
- 脚本别指望 `scripts/` 子目录被拷进来（只拷 SKILL.md）——内联最稳。
```

- [ ] **Step 2: 校验 frontmatter**

Run: `node -e '<校验脚本>' docker/skills/creating-skills`
Expected: `OK creating-skills …`

- [ ] **Step 3: 提交**

```bash
git add docker/skills/creating-skills/SKILL.md
git commit -m "feat(skills): creating-skills — author a new SKILL.md (Agent Skills spec)"
```

---

### Task 7: 文档 + 构建 + 部署 + 验证

**Files:**
- Modify: `docs/RUNBOOK.md`、`README.zh-CN.md`

- [ ] **Step 1: 文档**

- `RUNBOOK.md`：加一节「默认技能」列出 6 个（`pdf-to-note`/`research-note`/`extract-todos`/`generate-quiz`/`spreadsheet-to-note`/`creating-skills`）+ 触发方式（模型按 description 自动触发；也可直接说"用 <技能名> 做…"）+ 一句"加技能=写 `docker/skills/<name>/SKILL.md` 再重建"。
- `README.zh-CN.md`：能力列表补一句「**默认技能** —— 内置若干工作流技能（PDF→笔记、联网研究→带来源笔记、抽待办、生成测验、表格→笔记，以及"写技能"）」。

- [ ] **Step 2: 构建 + 部署**

```bash
docker build -t anytype-ai-bot:latest .
cd /home/landspace/anytype && docker compose -f docker-compose.yml -f /home/landspace/anytype-ai-bot/docker-compose.bot.yml up -d --force-recreate --no-deps ai-bot
```

- [ ] **Step 3: 验证 7 个技能被发现**

```bash
docker exec anytype-ai-bot-1 node -e '
const { DefaultResourceLoader } = require("/app/node_modules/@earendil-works/pi-coding-agent");
(async () => { const l = new DefaultResourceLoader({ cwd: "/tmp", agentDir: "/root/.pi/agent" }); await l.reload();
  const names = l.getSkills().skills.map(s=>s.name); console.log("skills:", names.join(", "));
  console.log("count:", names.length, "-> expect 7 (fix-image-orientation + 6)"); })();'
```
Expected: 7 个名字都列出，含 `pdf-to-note`/`research-note`/`extract-todos`/`generate-quiz`/`spreadsheet-to-note`/`creating-skills`。

- [ ] **Step 4: 提交**

```bash
git add docs/RUNBOOK.md README.zh-CN.md
git commit -m "docs: default skills (pdf/research/todos/quiz/spreadsheet/creating-skills)"
```

---

## 自检记录

- **Spec 覆盖**：§2 五个工作流技能 → T1–T5；§2.1 meta 技能 → T6；§3 表格解析（标准库、xls 不支持）→ T5；§5 验证（静态 frontmatter + 脚本实测 + 7 个被发现）→ 各任务校验步 + T7；§6 交付（文档+部署）→ T7。未覆盖项：无。
- **占位符扫描**：无 TBD/TODO；每个 SKILL.md 给了完整正文；校验命令是完整可跑的 `node -e`。
- **一致性**：目录名与 `name` 一致（pdf-to-note/research-note/extract-todos/generate-quiz/spreadsheet-to-note/creating-skills）；工具名与既有实现一致（`anytype_download_file`/`anytype_create_note`/`anytype_insert_markdown`/`anytype_read_object`/`web_search`/`web_fetch`/`bash`）。
- **风险**：`ensureSkillsConfig` 只拷 `SKILL.md`（不拷子目录）→ 已决定脚本内联（T5 明说）。技能能否被"模型自动触发"依赖 description 质量——需在真实场景试用后迭代（无法在本计划里自动化）。
