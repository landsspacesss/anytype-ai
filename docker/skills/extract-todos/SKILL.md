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
