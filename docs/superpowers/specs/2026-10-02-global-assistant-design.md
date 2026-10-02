# 全局助手（控制台）设计

日期：2026-10-02
状态：待实现

## 1. 背景与目标

当前 bot 的能力**按空间隔离**：每个会话只认自己所在的 space（工具绑死一个 `spaceId`），memory 也按 space 分（`/workspace/<spaceId>/MEMORY.md`）。用户想要一个**全局助手**：

1. **跨空间只读** —— 能读取 bot 已加入的**所有**空间的内容；
2. **全局 memory** —— 一份全局记忆，并能汇总只读各空间的记忆；
3. **接受加入链接** —— 把一个邀请链接发给它，它自己加入空间。

### 安全前提（已确认）

**全局能力只在「控制台」生效**。其他任何空间里，bot 的行为与现状完全一致（只看当前空间）——这样避免在**有别人的共享空间**里 @ 它时，把你**其他私有空间**的内容泄露出去。

在控制台里，对 Anytype 内容**完全只读**（memory 是本地文件，仍可写）。

## 2. 术语

- **控制台（console）**：一个专门的 **1:1 空间**（`SpaceType.OneToOne`），承载全局能力。
- **普通会话**：除控制台外的所有空间/讨论 —— 行为不变。

## 3. 控制台识别与引导（核心）

### 3.1 原理

1:1 是**双方各自按（对方身份 + 共享 key）推导出同一个空间**。要让 bot 侧出现这个空间，bot 必须自己**镜像建一次**（`WorkspaceCreate`，gRPC）——这正是之前打通 1:1 用到的机制。

`WorkspaceCreate` 请求形状（已实测可用，**非** stub，不会 panic）：

```
Rpc.Workspace.Create.Request {
  details: Struct { oneToOneIdentity: "<对方identity>", oneToOneRequestMetadataKey: "<key>",
                    spaceType: 4 /*OneToOne*/, spaceAccessType: 2 /*Shared*/ },
  useCase: 1  /*CHAT_SPACE*/
}
```

### 3.2 引导的两种模式（都实现）

- **模式 B（保证可用）**：用户把自己的 1:1 链接（客户端账号页 1:1 图标 → 复制链接，形如 `https://hi.any.coop/<userIdentity>#<key>`）发给 bot。bot 解析出 `(userIdentity, key)` → 镜像建 → 记下空间 id。**已在实机验证。**
- **模式 A（便捷，best-effort）**：bot 启动时**自造链接** `anytype://hi/?id=<botIdentity>&key=<随机key>` 并醒目打印。用户打开它 → 用户客户端按该 key 建空间。

  ⚠️ **风险（需实测）**：模式 A 要全自动，bot 必须**知道用户的身份**才能镜像建；该身份本应由 **1:1 inbox 请求**送达——而实测显示自建网络的**通知链是坏的**（`acl-notifications: ... apply on empty tree disallowed`）。因此 A 可能**无法自动完成**，需要用户补一步（把自己的链接回贴，退化为 B）。
  - **实现策略**：A 打印链接后进入等待；若能通过 inbox 拿到用户身份则自动完成；**否则提示用户"把你的 1:1 链接发我"**，走 B。
  - 这样 A 不会比 B 更差，只是多了一条更省的路径。

### 3.3 持久化

引导成功后写 `console.json`（同 `watches.json` 风格，存于 workspace 根）：

```json
{ "spaceId": "<空间id>", "chatId": "<该空间聊天id>", "bootstrappedAt": "<ISO>" }
```

启动时读它 → 该 spaceId 即控制台；**无需配置、重建也自动认**。也可用 `CONSOLE_SPACE_ID` 环境变量**显式覆盖**（便于排障/迁移）。

### 3.4 兼容

- boot 时 `discover()` 若发现该 1:1 空间（`members.length<=2` → `isDirect`），照常订阅。
- 控制台判定：`spaceId === console.json.spaceId`（或环境变量值）。

## 4. 跨空间只读

**只在控制台会话注册**以下能力（普通会话不变）：

- **`anytype_list_spaces`**（新工具）：列出 bot 已加入的全部空间（id + 名字）。
- **`space` 参数**（可选，默认当前空间）：加到 `anytype_search`、`anytype_list_objects`、`anytype_read_object` 上。值可为空间 id 或名字（名字经 `listSpaces` 解析）。

**只读强制方式**：控制台会话**根本不注册任何写工具**（create/update/delete/edit/send/react/upload/collection/template/type/property/watch 等）。模型没有工具可用 = 无法写。比"提示词约束"可靠。

## 5. memory（仅控制台）

- **新增全局一份**：`/workspace/_global/MEMORY.md`（+ `AGENTS.md` 模板）。控制台会话的 `cwd` 指向 `/workspace/_global`，于是它天然读写全局记忆。
- **汇总只读各空间**：新工具 **`anytype_memories()`** —— 返回全局 memory + 各空间 `/workspace/<spaceId>/MEMORY.md` 的内容（带空间名/标题），供模型查看"我在各处记了什么"。
- 各空间原有的 memory 行为不变。

## 6. 接受加入链接（仅控制台）

- 新工具 **`anytype_join_space(link)`**：
  - **邀请链接**（`anytype://invite/?cid=..&key=..` 或 `https://<host>/<cid>#<key>`）→ gRPC `SpaceJoin`。
  - **1:1 链接**（`anytype://hi/?id=..&key=..` 或 `https://hi.any.coop/<id>#<key>`）→ gRPC `WorkspaceCreate`（镜像）。
  - 返回结果（成功=新空间 id/名字；失败=错误原因）。
- **由模型判断**是否调用（用户说"加入这个"才调；只是贴个链接讨论则不调）。工具描述里写清用途，引导模型。

## 7. 组件与接口

新增/改动（尽量小、可单测）：

| 单元 | 作用 | 依赖 |
|---|---|---|
| `src/anytype/grpc.ts` | anytype-heart gRPC 客户端：明文 h2c + `token` metadata；`workspaceCreate`/`spaceJoin`；token 从 `~/.anytype/config.json` 读、失效自动重读 | `@grpc/grpc-js`、proto stub |
| `src/console/bootstrap.ts` | 解析 1:1 / 邀请链接；镜像建控制台；生成 bot 自造链接 | `grpc.ts` |
| `src/console/store.ts` | `console.json` 读写 | fs |
| `src/agent/anytype-tools.ts` | 加 `anytype_list_spaces` / `anytype_memories` / `anytype_join_space`；给 3 个读工具加 `space` 参数；导出 `READONLY_TOOLS` 供控制台复用 | 既有 |
| `src/agent/pi-session.ts` | 按 `isConsole` 决定注册哪些工具（控制台=只读集+全局工具，cwd=`_global`） | 既有 |
| `src/main.ts` | boot 时读 console.json / 环境变量；`createClient` 传 `isConsole`；控制台会话 cwd 指向 `_global` | 既有 |

**gRPC 依赖**：`@grpc/grpc-js` + 由官方 heart proto（`pb/protos/commands.proto`）生成的 stub。**注意**：只用**已验证为真 handler** 的方法（`WorkspaceCreate`、`SpaceJoin`、`AppGetVersion`），**绝不碰** `WorkspaceGetAll` 之类 `should be removed` 的桩（会 panic 打死 cli）。

## 8. 配置

| 项 | 说明 |
|---|---|
| `CONSOLE_SPACE_ID` | 可选，显式指定控制台空间；覆盖 `console.json` |
| `GRPC_ADDR` | 默认 `127.0.0.1:31010` |
| `ANYTYPE_CLI_CONFIG` | CLI 配置路径，默认 `/root/.anytype/config.json`（读 sessionToken） |

## 9. 测试

- **单元**：链接解析（4 种格式，含非法）；`console.json` 读写；`space` 参数解析（id/名字）；**控制台工具集 = 只读且不含任何写工具**（断言）；`anytype_memories` 汇总格式。
- **实机冒烟**（`docker run` 新镜像）：镜像建一个链接 → 空间出现 + 能读到另一空间的对象；对控制台尝试写 → 确认**无写工具**。
- gRPC 层可用 `AppGetVersion` 做无副作用连通性探针。

## 10. 分阶段

- **阶段 1（低风险，不引入新 gRPC 调用）**：控制台识别（`console.json` + 环境变量）+ 跨空间只读 + 全局 memory/汇总。控制台空间可先由**手工写入 `console.json`** 指定。
- **阶段 2**：`src/anytype/grpc.ts` + 模式 A/B 引导 + `anytype_join_space`。

## 11. 未决风险

1. **模式 A 的 inbox 依赖**（见 3.2）——可能退化为 B；需实测。
2. **`@grpc/grpc-js` 打进镜像**的体积/构建影响（可接受）。
3. proto 版本漂移：仅用少数稳定方法 + 运行期容错。
4. 1:1 是**独立空间**——控制台里**看不到其他空间的正文**，只能靠只读工具按需拉取；"指定 space 读写"仍不在本设计内（只读）。
