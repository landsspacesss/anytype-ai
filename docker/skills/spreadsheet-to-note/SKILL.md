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
