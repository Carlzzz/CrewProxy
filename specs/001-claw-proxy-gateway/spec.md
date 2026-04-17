# Feature Specification: Claw Proxy（统一 LLM 代理网关）

**Feature Branch**: `001-claw-proxy-gateway`
**Created**: 2026-04-13
**Status**: Draft
**Input**: Claw Proxy — HTTP 网关，对外 Anthropic Messages API，对内转发 OpenAI 兼容上游（Chat Completions / Responses）。
**基线文档**: `docs/WoiCrew-Proxy-SDD-Functional-Spec.md`（FR/IR/附录）、`docs/DESIGN-WoiClaw-Proxy.md`（详设）

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Agent 经网关完成一次对话（Priority: P1）

基于 Claude Agent SDK 的客户端将 Base URL 指向本代理，使用 Anthropic Messages 语义发起
普通或流式对话；代理完成鉴权后将请求转发至配置的 OpenAI 兼容上游，并返回 Anthropic
兼容响应。

**Why this priority**: 这是代理的核心使命——协议转换与透传；没有此能力则项目无价值。

**Independent Test**: 配置单上游 + 模拟认证服务通过后，非流式与流式各一次完整对话。

**Acceptance Scenarios**:

1. **Given** 合法设备 token 与可用上游，**When** `POST /v1/messages`（`stream: false`），**Then** 返回 Anthropic 兼容 JSON message + JSONL 写入一条用量记录。
2. **Given** 同上，**When** `POST /v1/messages`（`stream: true`），**Then** SSE 事件流可被 Claude SDK 解析至结束 + 流结束后 JSONL 写入一条用量记录。
3. **Given** 上游支持工具调用，**When** 请求含 `tools` 定义且上游返回 `tool_calls`，**Then** 响应包含正确的 Anthropic `tool_use` content block。

---

### User Story 2 — 未授权不得消耗算力（Priority: P1）

未通过设备鉴权的请求不得触发任何大模型上游调用。

**Why this priority**: 安全底线——认证是所有真实调用的前提。

**Independent Test**: 发送无 token / 过期 token 的请求，验证 401 且无上游网络出站。

**Acceptance Scenarios**:

1. **Given** 请求无 `x-api-key` 且无 `Authorization: Bearer`，**When** `POST /v1/messages`，**Then** 返回 401 `authentication_error`，无上游请求发出。
2. **Given** 认证服务返回非成功响应（404/401/500 或 `rc !== 0`），**When** 同上，**Then** 返回 401，无上游请求发出。
3. **Given** 认证服务网络不可达，**When** 同上，**Then** 返回 401，无上游请求发出。

---

### User Story 3 — 多上游与模型前缀路由（Priority: P2）

运维人员通过配置多个上游，终端用户通过 `model` 字段的 `upstreamId|modelId` 前缀
选择不同的大模型服务商。

**Why this priority**: 多上游能力是产品差异化核心，但可在单上游 MVP 之上增量交付。

**Independent Test**: 配置多个上游，分别以 `deepseek|deepseek-chat`、`ali|qwen-plus`、
无前缀形式发请求，验证路由正确。

**Acceptance Scenarios**:

1. **Given** `upstreamsById` 含 `deepseek` 条目，**When** `model` 为 `deepseek|deepseek-chat`，**Then** 请求发往 deepseek 上游，上游收到 `model=deepseek-chat`。
2. **Given** `upstreamsById` 不含 `unknown`，**When** `model` 为 `unknown|gpt-4o`，**Then** 回落 `defaultUpstream`，上游收到 `model=gpt-4o`。
3. **Given** `model` 无 `|` 分隔符，**When** 请求到达，**Then** 使用 `defaultUpstream`。
4. **Given** 无 `defaultUpstream` 且 `upstreamId` 未命中，**When** 请求到达，**Then** 返回 403 `permission_error`，无上游请求。

---

### User Story 4 — SDK 内部模型 Stub（Priority: P2）

Claude Agent SDK 会在建联时用内部 model 名做自检；这些请求须被代理短路返回，
不触发鉴权和上游调用。

**Why this priority**: 保证 SDK 正常初始化，且不浪费算力和认证资源。

**Independent Test**: 发送 `model: claude-haiku-4-5-20251001` 的请求，验证立即返回
stub 响应且无鉴权/上游调用。

**Acceptance Scenarios**:

1. **Given** `model` 为 `claude-haiku-4-5-20251001`（无 `|` 前缀），**When** `POST /v1/messages`（`stream: false`），**Then** 返回合法 Anthropic JSON message，无鉴权调用、无上游调用、无 JSONL 真实用量。
2. **Given** 同上，**When** `stream: true`，**Then** 返回完整 SSE 闭合（`message_start` → `content_block_start` → `message_stop`）。
3. **Given** `model` 为 `ali|claude-sonnet-4-20250514`（含 `|` 前缀），**When** 请求到达，**Then** 不触发 stub，走正常鉴权 + 上游路由。

---

### User Story 5 — 用量落盘与可选 ES 同步（Priority: P2）

每次真实上游调用结束后，将用量以 JSONL 格式写入本地文件；可选地增量同步至
Elasticsearch 用于统计与审计。

**Why this priority**: 用量可观测是运营基础，但对核心转发流程无阻塞依赖。

**Independent Test**: 完成一次对话后检查 `logs/usage-YYYY-MM-DD.jsonl` 新增一行；
启动 ES 同步后检查索引中出现对应文档。

**Acceptance Scenarios**:

1. **Given** 非流式调用完成，**When** 检查 JSONL，**Then** 包含 `app`、`clientid`、`username`、`modelid`、`input_token`、`output_token`、`start_time`、`out_time`、`session_id`、`routing_key` 等字段。
2. **Given** 流式调用完成，**When** 检查 JSONL，**Then** 同上；若上游未返回 usage 则 token 字段为 0。
3. **Given** JSONL 文件超过 `WOICLAW_USAGE_LOG_MAX_BYTES`，**When** 新写入，**Then** 自动滚动到 `-2`、`-3` 等后缀文件。
4. **Given** ES 同步服务运行且 ES 可达，**When** 同步执行，**Then** 新增文档出现在 ES 索引中。
5. **Given** ES bulk 部分项失败，**When** 同步执行，**Then** 不推进断点，下次重试。

---

### User Story 6 — 配置热加载（Priority: P3）

运维人员修改 `proxy-config.json` 后无需重启进程，代理自动在约 300ms 防抖后
加载新配置。

**Why this priority**: 提升运维效率，但可在 MVP 之后补充。

**Independent Test**: 修改配置文件中的上游地址，等待 300ms+ 后发新请求，验证使用
新配置。

**Acceptance Scenarios**:

1. **Given** 代理运行中，**When** 保存合法的新配置文件，**Then** 约 300ms 后新请求使用新配置。
2. **Given** 代理运行中，**When** 保存非法 JSON 配置，**Then** 旧配置保留、进程不退出、端口不变。
3. **Given** 新配置修改了 `port` 字段，**When** 热加载触发，**Then** 监听端口不变（需重启生效）。

---

### User Story 7 — 上游兼容性与有界重试（Priority: P3）

对于不同上游的 API 差异（404 URL、400 参数不兼容等），代理在单请求内自动进行
有界修复重试，不改变业务语义。

**Why this priority**: 增强多上游兼容性，但不影响核心转发能力。

**Independent Test**: 配置一个首选 URL 返回 404 的上游，验证代理自动尝试备选 URL。

**Acceptance Scenarios**:

1. **Given** 上游首选 URL 返回 404 且存在备选 URL，**When** 请求发出，**Then** 代理自动尝试备选 URL。
2. **Given** 上游返回 400 且错误表明 tools 不支持，**When** 请求含 tools，**Then** 代理自动去除 tools 重试。
3. **Given** 上游返回 400 且错误表明 max_tokens 不支持，**When** 请求含 max_tokens，**Then** 代理自动转为 max_completion_tokens 重试。
4. **Given** 所有重试均失败，**When** 最终响应，**Then** 返回 Anthropic 风格错误体。

---

### Edge Cases

- 流式过程中客户端断连：代理检测 `close` 事件，终止上游读取，不无限阻塞。
- 上游返回空流（无任何 chunk）：代理发送 SSE `error` 事件并关闭连接。
- 上游 SSE 超时（90s 无数据）：代理超时关闭，补 `message_stop`（若已开始）。
- 请求 body 超过 20MB：返回 400 `invalid_request_error`，`Request body too large`。
- 多实例部署：进程内缓存（tool extra_content）与 JSONL 按实例独立；ES 同步断点按实例。

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 提供 `POST /v1/messages`，语义对齐 Anthropic Messages API，支持非流式与流式、工具调用与思考内容（在上游能力范围内）。
- **FR-002**: 系统 MUST 完成 Anthropic ↔ OpenAI（Chat Completions / Responses）双向协议转换。
- **FR-003**: 系统 MUST 按 `provider` 字段选择 Chat Completions（非 `openai`）或 Responses API（`openai`），并执行约定的 Provider 清洗链（顺序遵循 DESIGN §9）。
- **FR-004**: 系统 MUST 支持 `upstreamId|modelId` 路由与默认上游回落；无可用上游时返回 403 `permission_error`。
- **FR-005**: 真实模型调用前 MUST 完成外部设备认证（`x-api-key` / `Authorization: Bearer`）；失败返回 401 `authentication_error`。认证成功后的 `username` 写入用量日志。
- **FR-006**: SDK 内部模型请求（`model` 无 `|` 且匹配 `^claude-(haiku|sonnet)-[0-9-]+$`）MUST Stub 短路——不鉴权、不调上游、不记真实用量。
- **FR-007**: 系统 MUST 提供 `GET /healthz`（返回 200 `{ ok: true }`）。`POST /v1/messages/count_tokens` 为 Stub（返回 `{ input_tokens: 0 }`）；`POST /api/event_logging/batch` 为 Stub（返回 204）。其余路径返回 Anthropic 风格 404 `not_found_error`。
- **FR-008**: 每次真实上游调用 MUST 写 JSONL 用量记录；token 以上游 `usage` 为准；无则记 0。
- **FR-009**: 系统 SHOULD 提供可选 ES 增量同步（`sync-usage-to-es`）；bulk 失败不静默推进断点。
- **FR-010**: 配置 MUST 支持 JSON 文件 + 环境变量；支持防抖热加载（~300ms）；解析失败保留旧配置；热加载不改监听端口。
- **FR-011**: 流式 SSE MUST 满足 Anthropic 事件契约（`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`）；`tool_calls` 按 index 聚合。
- **FR-012**: 单请求内 404/400 兼容重试 MUST 有界；最终失败返回 Anthropic 风格错误体。
- **FR-013**: tool `extra_content`/`thought_signature` MUST 进程内有界缓存（≤1024 条 FIFO）并在下轮请求回填。
- **FR-014**: 密钥、完整 token、完整 apiKey 不得出现在非受控日志。示例配置仅使用占位值。

### Implementation Requirements

- **IR-001**: MUST 使用 TypeScript，`strict` 模式，目标运行时 Node.js ≥ 18。构建产物输出 `dist/`，入口 `node dist/index.js`。
- **IR-002**: HTTP 服务 MUST 使用 Node 原生 `http` 模块，禁止 Express/Fastify/Koa 等 Web 框架。
- **IR-003**: 调用上游与认证 MUST 使用全局 `fetch`。
- **IR-004**: 模块划分 MUST 包含：`index.ts`（启动/热加载）、`proxy.ts`（路由/编排/流式）、`config.ts`（配置）、`formatTransform.ts`（协议转换）、`usageLogger.ts`（JSONL）、`logger.ts`（日志）、`scripts/sync-usage-to-es.ts`（ES 同步）。转换层不得依赖编排层。
- **IR-005**: 配置加载顺序 MUST 为：CLI 路径参数 → `WOICLAW_PROXY_CONFIG` 环境变量 → `./proxy-config.json`（工作目录） → 单上游环境变量模式。
- **IR-006**: 认证成功条件 MUST 为：HTTP 200 且 `rc === 0` 且 `data.name` 为非空字符串。
- **IR-007**: `POST /v1/messages` 主链路阶段顺序 MUST 遵循 DESIGN §6：读 body → 解析 JSON → Stub 判定 → 提取 token → 鉴权 → 解析上游与 model → `anthropicToOpenAI` → Provider 管道 → API 类型与 URL → fetch → 转换与 usage。
- **IR-008**: `provider === 'openai'` → Responses API（`/v1/responses`）；其余 → Chat Completions（`/v1/chat/completions`）。
- **IR-009**: 流式 Chat Completions 中 `delta.reasoning_content`/`reasoning` 映射为 Anthropic `thinking`；`delta.content` 映射为 `text`；`tool_calls` 按 index 聚合。
- **IR-010**: 热加载 MUST 使用 `fs.watch` + ~300ms 防抖；失败保留旧运行时上下文。

### Key Entities

- **UpstreamConfig**: 上游配置（`baseURL`、`apiKey`、`model`、`provider` 等）
- **ProxyRuntimeContext**: 运行时上下文（`upstreamsByIdMap`、`defaultUpstream`），热加载时整表替换
- **UsageRecord**: JSONL 单行记录（字段见附录 A）
- **AuthContext**: 认证上下文（`username`、`clientid` 等），来自外部认证服务
- **StreamState**: 流式状态机（`contentIndex`、`currentBlockType`、`toolCalls`、`lastUsage` 等）

---

## 附录 A：JSONL 用量字段

每行一个 JSON 对象（`logs/usage-YYYY-MM-DD.jsonl`，可按大小滚动 `-2`、`-3`…）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `app` | string | 固定值（如 `woicrew`） |
| `clientid` | string | 客户端标识 |
| `username` | string? | 认证成功后的用户名 |
| `modelid` | string | 实际发往上游的模型 id |
| `input_token` / `output_token` | number | 来自上游 usage；无则 0 |
| `input_cached_token` | number | 缓存命中 token；无则 0 |
| `start_time` / `out_time` | string | 东八区 ISO8601 |
| `cost_time` | string | 秒，两位小数，如 `"9.15"` |
| `request_size` / `response_size` | number? | 字节 |
| `stream` | boolean? | 是否流式 |
| `input_content` | string? | 请求摘要 JSON（model / tail_role / tail_preview） |
| `input_fulltext` | string? | 仅 `WOICLAW_USAGE_LOG_INPUT_FULLTEXT` 开启时 |
| `output_content` | string? | 助手输出累积（仅 text + thinking） |
| `session_id` | string \| null | 请求头 `X-WoiCrew-Session-Id`；无则 `null` |
| `routing_key` | string | 上游路由标识；`defaultUpstream` 时为 `__default__` |

---

## 附录 B：须引用的外部规范

- Anthropic Messages API（请求/响应/SSE）：官方文档 Messages 相关章节。
- OpenAI Chat Completions（含流式 SSE）：官方兼容文档。
- OpenAI Responses API（`provider === 'openai'` 时）：官方 Responses 文档。

---

## 附录 C：Provider 管道顺序（DESIGN §9）

在 `anthropicToOpenAI` 之后、发起上游 `fetch` 之前，须按以下顺序执行（禁止重排）：

1. 设置 `openAIRequest.model`
2. 内部 Claude 名重写（非 anthropic/openai provider + claude-* model → 上游默认 model）
3. `resolveUpstreamAPIType`（`openai` → responses，其余 → chat_completions）
4. `filterOpenAIToolsForProvider`（`openai` 时过滤 `skill` tool）
5. `remapMessageRolesForMiniMax`（`minimax` 时 developer → system）
6. `hydrateOpenAIRequestToolCalls`（缓存回填 / Gemini 占位签名）
7. `normalizeMaxTokensFieldForOpenAIProvider`（chat_completions 时）
8. `mergeSystemMessagesForProvider`（chat_completions 时合并多 system）
9. 若 responses：`convertChatCompletionsRequestToResponsesRequest`
10. 若流式 + chat：`stream_options.include_usage = true`

---

## 交付验收标准

1. **构建**: `npm run build` 无错误，存在 `dist/index.js`。
2. **路由**: HTTP 路由（healthz / messages / count_tokens / event_logging / 404）行为正确。
3. **鉴权**: 无 token / 认证失败 → 401 + 零上游调用；认证成功 → `data.name` 规则符合 IR-006。
4. **Stub**: `model` 匹配 `^claude-(haiku|sonnet)-[0-9-]+$` 且无 `|` 时，无上游调用。
5. **主流程**: 至少一条集成测试覆盖「鉴权通过 → 非流式 → JSONL 有一条」；一条覆盖「流式 → SSE 结束 → JSONL」。
6. **热加载**: 合法 JSON 更新后新请求用新配置；非法 JSON 后旧配置仍服务。

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 认证通过且上游可用时，标准单轮对话（非流式 + 流式）Claude Agent SDK 无协议解析错误。
- **SC-002**: 100% 未授权的主路径请求不产生上游 LLM 调用。
- **SC-003**: 100% 真实调用在 JSONL 中可追溯（每次调用至少一条记录）。
- **SC-004**: 热加载失败时服务不中断监听。
- **SC-005**: 交付验收标准第 1–6 项全部通过。

---

## Assumptions

- 外部认证服务 API 契约与详设/README 描述一致（HTTP GET + `deviceId` 参数 + JSON `{ rc, data }` 格式）。
- 上游能力因厂商而异；协议映射以「尽力转换」为原则，不保证所有 Anthropic 特性在所有上游上可用。
- 本期不包含 Code Plan 多密钥池能力（`codePlanCredentials`、`codePlanBaseURL`、冷却等）。
- 部署环境为 Linux 或 Windows，Node.js ≥ 18 已安装。
- 单进程部署；水平扩展通过外部负载均衡实现（代理本身无状态，tool extra_content 缓存为进程级可选）。

## Out of Scope

- 自研 token 计数（用量完全依赖上游 `usage`）。
- 业务库持久化全量会话。
- Code Plan 全族能力（多编程配额密钥池、触限冷却、`codePlanBaseURL`、`codePlanCredentials`、会话粘性选 key、`ordinaryFallbackModelMap` 等）。
- 多租户控制台 UI。
- `count_tokens` / `event_logging` 真实实现。
