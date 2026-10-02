# demo —— 演示工作流

一个**不依赖目标空间**的可运行示例（只用 `shell` / `http`，不碰 `anytype` / `agent`）：

1. `hello` —— `shell`：打印一行；
2. `fetch` —— `http`：抓取 `https://example.com` 的响应体；
3. `report` —— `shell`：把上一步的响应体（截前 120 字节）打印出来，演示
   `{{ steps.<id>.output }}` 插值把前一步的输出喂给后一步。

运行：在任意聊天里发 **`/run demo`**；看历史用 **`/runs`**。
