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
