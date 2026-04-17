# Contract: Anthropic Messages API（对外接口）

**Feature**: 001-claw-proxy-gateway
**Date**: 2026-04-13
**Source**: spec FR-001/FR-007, DESIGN §5, SDD 实现基线

本文档定义代理对外暴露的 HTTP 接口契约（客户端视角）。

---

## Endpoints

### POST /v1/messages（主入口）

**Request**:

```jsonc
{
  "model": "string",           // 必填；可含 "upstreamId|modelId" 前缀
  "messages": [                // Anthropic Messages 格式
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 4096,          // 必填
  "stream": false,             // 可选，默认 false
  "system": "string | [...]",  // 可选
  "tools": [...],              // 可选
  "tool_choice": {...},        // 可选
  "stop_sequences": [...]      // 可选
}
```

**Headers**:

| Header | 说明 |
|--------|------|
| `x-api-key` | 设备认证 token（与 Authorization 二选一） |
| `Authorization` | `Bearer <token>` |
| `X-WoiCrew-Session-Id` | 可选，会话标识（写入 JSONL `session_id`） |
| `Content-Type` | `application/json` |

**Response (非流式)**: `200 OK`, `Content-Type: application/json`

```jsonc
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "...",
  "content": [
    { "type": "thinking", "thinking": "..." },
    { "type": "text", "text": "..." },
    { "type": "tool_use", "id": "...", "name": "...", "input": {...} }
  ],
  "stop_reason": "end_turn | tool_use | max_tokens | stop_sequence",
  "usage": { "input_tokens": 100, "output_tokens": 50 }
}
```

**Response (流式)**: `200 OK`, `Content-Type: text/event-stream`

事件顺序（MUST）：

1. `event: message_start` — `data: { "type": "message_start", "message": {...} }`
2. `event: content_block_start` — `data: { "type": "content_block_start", "index": 0, "content_block": { "type": "text", ... } }`
3. `event: content_block_delta` — `data: { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "..." } }`
4. `event: content_block_stop` — `data: { "type": "content_block_stop", "index": 0 }`
5. `event: message_delta` — `data: { "type": "message_delta", "delta": { "stop_reason": "..." }, "usage": {...} }`
6. `event: message_stop` — `data: { "type": "message_stop" }`

### GET /healthz

**Response**: `200 OK`

```json
{ "ok": true }
```

### POST /v1/messages/count_tokens（Stub）

**Response**: `200 OK`

```json
{ "input_tokens": 0 }
```

### POST /api/event_logging/batch（Stub）

**Response**: `204 No Content`（无 body）

### 其他路径

**Response**: `404`

```json
{ "type": "error", "error": { "type": "not_found_error", "message": "..." } }
```

---

## 错误响应格式

所有错误返回统一 JSON 结构：

```json
{ "type": "error", "error": { "type": "<error_type>", "message": "<描述>" } }
```

| HTTP | error.type | 触发场景 |
|------|------------|----------|
| 400 | `invalid_request_error` | body 过大 / 非法 JSON |
| 401 | `authentication_error` | 无 token / 认证失败 |
| 403 | `permission_error` | 无可用上游 |
| 404 | `not_found_error` | 未知路径 |
| 500 | `api_error` | 代理未捕获异常 |
| 502 | `api_error` | 上游网络失败 |

流式中途错误：在已 `writeHead` 后发 SSE `event: error` 事件，然后 `res.end()`。
