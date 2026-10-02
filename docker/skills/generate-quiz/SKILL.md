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
