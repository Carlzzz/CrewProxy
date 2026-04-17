# Contract: 上游 API（代理出站接口）

**Feature**: 001-claw-proxy-gateway
**Date**: 2026-04-13
**Source**: spec IR-008, DESIGN §10/§14, SDD 附录 B/C

本文档定义代理对上游 LLM 服务的出站请求契约。

---

## API 形态选择

由 `UpstreamConfig.provider` 决定：

| provider | API 形态 | 请求路径 | 函数 |
|----------|----------|----------|------|
| `openai` | Responses API | `/v1/responses` | `buildOpenAIResponsesURL` |
| 其他任意值 / 空 | Chat Completions | `/v1/chat/completions` | `buildOpenAIChatCompletionsURL` |

---

## Chat Completions 请求

**Method**: `POST`
**URL**: `{baseURL}/v1/chat/completions`（经 `buildOpenAIChatCompletionsURL` 规范化尾斜杠、`/v1` 等）

```jsonc
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 4096,
  "stream": true,
  "stream_options": { "include_usage": true },  // 仅流式时添加
  "tools": [...],
  "tool_choice": "auto"
}
```

**Headers**:

| Header | 值 |
|--------|-----|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <上游 apiKey>` |

**流式响应**: `text/event-stream`，`data: {"choices":[{"delta":{...}}]}`

**非流式响应**: JSON，含 `choices[0].message` + `usage`

---

## Responses API 请求

**Method**: `POST`
**URL**: `{baseURL}/v1/responses`

由 `convertChatCompletionsRequestToResponsesRequest` 将 Chat 形态转为 Responses `input` 结构。

**流式响应**: `text/event-stream`，事件名如 `response.output_text.delta`、`response.completed` 等。

**非流式响应**: JSON，由 `convertResponsesToOpenAIResponse` 先转为伪 Chat 响应再走统一
`openAIToAnthropic` 逻辑。

---

## URL 构建与 404 候选

### Chat Completions

- 主 URL: `buildOpenAIChatCompletionsURL(baseURL)`
- 若为 Gemini（`baseURL` 含 `generativelanguage.googleapis.com`）：额外生成 `v1beta`/`v1` 互换候选
- 候选用 `Set` 去重

### Responses

- 单一 URL: `buildOpenAIResponsesURL(baseURL)`

---

## Provider 管道对上游请求的变形（spec 附录 C）

在 `anthropicToOpenAI` 之后、`fetch` 之前，以下变形按顺序施加：

1. **model 设置**: 使用路由解析后的 modelId
2. **Claude 名重写**: 非 anthropic/openai provider + claude-* → 上游默认 model
3. **API 类型**: `resolveUpstreamAPIType`
4. **filterOpenAIToolsForProvider**: `openai` 时过滤 `skill` tool + 改 `tool_choice`
5. **remapMessageRolesForMiniMax**: `minimax` 时 `developer` → `system`
6. **hydrateOpenAIRequestToolCalls**: 回填缓存 extra_content / Gemini 占位
7. **normalizeMaxTokensField**: chat 时 openai 新模型 `max_tokens` → `max_completion_tokens`
8. **mergeSystemMessages**: chat 时合并多 system 为一条
9. **convertToResponses**: responses 时整体转换
10. **stream_options**: 流式 + chat 时 `include_usage = true`

---

## 认证服务（外部依赖）

**URL**: `GET {WOICLAW_AUTH_HOST}{WOICLAW_AUTH_USER_PATH}?deviceId={token}`

**成功响应**: HTTP 200

```json
{ "rc": 0, "data": { "name": "张三", "mainAccount": "...", "userId": "..." } }
```

**失败**: HTTP 非 200，或 `rc !== 0`，或 `data.name` 为空 → 代理返回 401。
