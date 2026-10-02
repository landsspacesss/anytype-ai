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
import csv, sys, re, zipfile, xml.etree.ElementTree as ET
NS  = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"

def esc(s):
    return str(s).replace("|", "\\|").replace("\n", " ").replace("\r", " ")

def md_table(rows):
    rows = [[esc("" if c is None else c) for c in r] for r in rows]
    if not rows: return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    for r in rows[1:]:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)

def col_index(ref):
    m = re.match(r"([A-Z]+)", ref or "")
    if not m: return None
    n = 0
    for ch in m.group(1): n = n * 26 + (ord(ch) - 64)
    return n - 1

def read_csv(path):
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        return [list(r) for r in csv.reader(f)]

def read_xlsx(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(NS + "si"):
            ss.append("".join(t.text or "" for t in si.iter(NS + "t")))
    rels = {}
    if "xl/_rels/workbook.xml.rels" in z.namelist():
        for rel in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")).iter(PKG + "Relationship"):
            rels[rel.get("Id")] = rel.get("Target")
    out = []
    for sh in ET.fromstring(z.read("xl/workbook.xml")).iter(NS + "sheet"):
        target = rels.get(sh.get(RNS + "id"), "")
        if not target: continue
        if not target.startswith("xl/"): target = "xl/" + target.lstrip("/")
        rows = []
        for row in ET.fromstring(z.read(target)).iter(NS + "row"):
            cells = []
            for c in row.iter(NS + "c"):
                idx = col_index(c.get("r"))
                if idx is None: idx = len(cells)
                while len(cells) < idx: cells.append("")   # fill skipped (empty) cells
                v = c.find(NS + "v"); val = v.text if v is not None else ""
                if c.get("t") == "s" and val not in (None, ""):
                    try: val = ss[int(val)]
                    except (ValueError, IndexError): pass
                cells.append(val if val is not None else "")
            rows.append(cells)
        out.append((sh.get("name"), rows))
    return out

path = sys.argv[1]
try:
    if path.lower().endswith(".csv"):
        print("# " + path.split("/")[-1]); print(md_table(read_csv(path)))
    else:
        for title, rows in read_xlsx(path):
            print(f"## {title}"); print(md_table(rows[:200]))
            if len(rows) > 200: print(f"（已截断，共 {len(rows)} 行）")
            print()
except zipfile.BadZipFile:
    print("不是有效的 .xlsx（可能是老的 .xls 或损坏文件）——请另存为 .xlsx 或 .csv。", file=sys.stderr)
    sys.exit(2)
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
