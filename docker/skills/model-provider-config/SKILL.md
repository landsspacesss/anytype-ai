---
name: model-provider-config
description: Use when the user wants to add, change, or fix an AI model or provider — its API base URL, key, or model list — e.g. "加一个 provider", "换个 API", "配置模型", "改模型配置", "add a model provider", "set the API key for X", "为什么这个模型不能用". Edits pi's models.json so new providers/models become switchable via /model.
---

# 修改模型 / 提供商配置

## 是什么

pi 的模型注册表是一个 JSON 文件：**`/root/.pi/agent/models.json`**（即 agentDir 下的 `models.json`，容器里是 `bot_state` 卷）。
改它就能**新增/修改 provider**（API 地址、key、模型清单）。改完新 provider 会出现在 `/model` 列表里，可被聊天或工作流的 `model:` 指定。

## 文件结构

```json
{
  "providers": {
    "<provider名>": {
      "api": "openai-completions",          // 本 bot 只走 OpenAI 兼容协议
      "baseUrl": "https://…/v1",            // 注意带 /v1（或该服务的 chat 端点前缀）
      "apiKey": "$ENV_VAR 或 直接字面量",
      "models": [
        { "id": "<模型id>", "name": "<显示名>", "input": ["text"], "contextWindow": 131072, "maxTokens": 8192 }
      ]
    }
  }
}
```

要点：
- `api` 必须是 **`"openai-completions"`**（OpenAI 兼容的 `/chat/completions`）。原生 Anthropic/Gemini 端点不适用。
- `apiKey` 可以是**字面量**，也可以 `"$VAR"` 从环境变量取。容器里已有的 key 变量：`DEEPSEEK_API_KEY`、`NVIDIA_API_KEY`、`OPENCODE_API_KEY`。
- 模型的 `id` 用**该服务真实接受的 id**（如 `google/diffusiongemma-26b-a4b-it`、`space-bunny-free`、`gpt-5.5`）。名字里有斜杠也没关系。
- 支持工具调用（tool calling）的模型才能用于工作流的 `agent` 步骤。

## 怎么改（步骤）

1. **先备份**：`cp /root/.pi/agent/models.json /root/.pi/agent/models.json.bak`
2. 读当前文件，**在 `providers` 里加/改**你要的那个 provider（保留其它 provider，别整体覆盖）。
3. 写回，**必须是合法 JSON**。写完验证：
   `node -e "JSON.parse(require('fs').readFileSync('/root/.pi/agent/models.json','utf8'));console.log('ok')"`
   （`node` 在本镜像可用；不合法会有报错，改回备份再重试。）
4. **生效时机**：注册表在**每次新建会话时**读取。所以要**开新对话**（`/new`）或重启 bot 才生效——当前会话不变。告诉用户这一点。
5. 验证：让用户 `/model` 看新模型是否在列。

## 排障（用户问"为什么这个模型不能用"）

- **读得到列表、但调用 403/401**：key 没推理权限，或 key 不对（不是我们代码的问题）。
- **410 / Gone**：模型已下线。
- **402 / Insufficient funds**：账户没余额。
- **调用"成功"但输出为空**：多半模型侧出错被吞了（常见原因就是上面的 401/403/402/模型名错）。换个模型或用 `fallback` 验证。
- **免费额度**：某些服务（如 OpenCode Zen）的 `*-free` 模型**只能在其官方客户端里用**，外部 API 会 403；但也有个别 `-free` 模型是允许 API 调用的，逐个实测为准。

## 注意

- 这个文件**含密钥**：别把 key 明文整个回显到聊天里。
- 改动只影响**之后新建**的会话；不会破坏当前对话。
