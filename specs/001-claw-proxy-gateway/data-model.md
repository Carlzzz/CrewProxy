# Data Model: Claw Proxy

**Feature**: 001-claw-proxy-gateway
**Date**: 2026-04-13
**Source**: spec.md Key Entities + DESIGN §3 + SDD 附录 A

---

## 核心实体

### UpstreamConfig

上游 LLM 服务的配置描述，存在于 `proxy-config.json` 的 `defaultUpstream` 或
`upstreamsById` 中。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `baseURL` | string | ✅ | 上游 API 基础 URL |
| `apiKey` | string | ✅ | 上游 API 密钥 |
| `model` | string | ✅ | 默认模型名（请求未指定时使用） |
| `provider` | string? | — | 决定 API 形态与清洗链（`openai` → Responses，其余 → Chat Completions） |

**约束**: `baseURL` 不含尾部路径（由代理拼接 `/v1/chat/completions` 或 `/v1/responses`）。
`apiKey` 不得出现在日志中。

---

### ProxyConfig（JSON 文件顶层）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `port` | number | — | 监听端口（默认 3456） |
| `host` | string | — | 绑定地址（默认 `0.0.0.0`） |
| `defaultUpstream` | UpstreamConfig | — | 默认上游 |
| `upstreamsById` | Record<string, UpstreamConfig> | — | 按 id 索引的多上游 |

**约束**: `port` 热加载不生效（需重启）。至少需要 `defaultUpstream` 或单上游 env 模式之一。

---

### ProxyRuntimeContext

进程内运行时状态，热加载时整表替换。

| 字段 | 类型 | 说明 |
|------|------|------|
| `upstreamsByIdMap` | Map<string, UpstreamConfig> | 从 `upstreamsById` 构建 |
| `defaultUpstream` | UpstreamConfig \| undefined | 默认上游引用 |

**生命周期**: `loadConfig` 时创建；`fs.watch` 热加载时整表替换引用（Node 单线程，并发请求读同一快照）。

---

### StreamState

流式处理过程中的可变状态（每请求一个实例）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `contentIndex` | number | 当前 content block 索引 |
| `currentBlockType` | string? | 当前块类型（`thinking` / `text` / `tool_use`） |
| `toolCalls` | Map<number, ToolCallState> | 按 index 聚合的 tool call 状态 |
| `lastUsage` | UsageState | 累积 usage（Math.max 合并策略） |
| `messageStarted` | boolean | 是否已发 `message_start` |
| `outputAccumulator` | string[] | 文本+思考输出累积（用于 usage log） |

---

### ToolCallState（StreamState 内嵌）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | tool call id |
| `name` | string | 函数名 |
| `argumentsBuffer` | string | JSON 片段累积 |
| `extraContent` | unknown? | extra_content / thought_signature |

---

### UsageState

| 字段 | 类型 | 说明 |
|------|------|------|
| `input_tokens` | number | Math.max 合并 |
| `output_tokens` | number | Math.max 合并 |
| `input_cached_token` | number | Math.max 合并 |

---

### UsageRecord（JSONL 单行）

一次真实上游调用完成后写入的用量记录。完整字段见 spec 附录 A。

关键字段分类：

| 分类 | 字段 |
|------|------|
| 身份 | `app`、`clientid`、`username` |
| 模型 | `modelid`、`routing_key` |
| 用量 | `input_token`、`output_token`、`input_cached_token` |
| 时间 | `start_time`、`out_time`、`cost_time` |
| 载荷摘要 | `input_content`、`output_content`、`input_fulltext` |
| 元数据 | `stream`、`request_size`、`response_size`、`session_id` |

---

### AuthResult

外部认证服务成功响应后提取的信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 用户名（写入 JSONL `username`） |
| `mainAccount` | string? | 主账号（可选） |
| `userId` | string? | 用户 ID（可选） |

**约束**: 认证成功条件为 HTTP 200 + `rc === 0` + `data.name` 非空字符串。

---

## 进程级缓存

### toolCallExtraContentById

| 属性 | 值 |
|------|-----|
| 结构 | `Map<string, unknown>` |
| 容量 | ≤ 1024 条（FIFO 淘汰） |
| 用途 | 缓存上游 tool call 的 `extra_content`/`thought_signature`，下轮请求 `hydrateOpenAIRequestToolCalls` 回填 |
| 生命周期 | 进程级；多实例不共享 |

---

## 实体关系

```text
ProxyConfig
├── defaultUpstream: UpstreamConfig
└── upstreamsById: { [id]: UpstreamConfig }
         ↓ loadConfig
ProxyRuntimeContext
├── defaultUpstream → UpstreamConfig
└── upstreamsByIdMap → Map<string, UpstreamConfig>

请求流：
  Request → AuthResult? → resolveUpstream → UpstreamConfig
                                               ↓
                                          StreamState (流式) → UsageRecord
                                          或 直接响应 (非流式) → UsageRecord
```
