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
