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
