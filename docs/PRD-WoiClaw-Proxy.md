# WoiClaw Proxy 产品需求说明书（PRD）

**文档版本**：1.0  
**编制依据**：仓库 `woiClaw-proxy` 当前 TypeScript 实现（`src/proxy.ts`、`src/config.ts`、`src/formatTransform.ts`、`src/codePlanPool.ts`、`src/codePlanQuota.ts`、`src/usageLogger.ts`、`src/logger.ts`、`src/index.ts`、`src/scripts/sync-usage-to-es.ts` 等）及 `README.md`、`proxy-config.example.json`、`docker-compose.yml`、`scripts/es-usage-index.mapping.json`。  
**适用范围**：WoiClaw / LobsterAI 等以 Anthropic Messages API 协议对接本代理、由代理转发至 OpenAI 兼容或类 OpenAI 上游大模型服务的部署与演进。  
**读者对象**：产品经理、架构师、后端开发、运维、安全与合规、数据工程（Usage/ES）。

---

## 0. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-03-25 | 初版：与当前代码行为对齐的 PRD |

---

## 1. 引言

### 1.1 背景

企业内部或产品化场景下，客户端（如基于 Claude Agent SDK 的 LobsterAI / WoiClaw）普遍采用 **Anthropic Messages API** 语义（`POST /v1/messages`、SSE 事件形态、tool_use / thinking 等）。与此同时，实际可调用的算力往往来自多家云厂商或兼容层，其对外暴露的接口多为 **OpenAI Chat Completions** 或 **OpenAI Responses** 形态。直接在客户端维护多套协议适配成本高、易出错。

**WoiClaw Proxy**（下称「本代理」）定位为独立部署的 **协议转换与路由代理**：在边界处统一承接 Anthropic 格式请求，按配置选择上游、完成格式转换与流式双向映射，并在企业要求的维度上完成 **设备鉴权、用量落盘、可选 ES 同步、Code Plan 多密钥池与限流冷却** 等横切能力。

### 1.2 文档目的

本 PRD 将 **已实现行为** 表述为可验收的需求与规格，便于：

- 新成员理解系统边界与数据流；
- 评审后续迭代是否破坏既有契约；
- 运维与数据侧配置索引、监控与审计策略；
- 与安全团队对齐认证、密钥与日志敏感级别。

### 1.3 非目标（当前实现明确不包含）

- 不在代理内实现自研 token 计数取代上游 `usage`（用量以 **上游返回为准**）。
- 不把完整对话持久化为业务数据库（仅 **JSONL 用量日志** 与可选 **ES**；代理进程内仅有小容量 **tool extra_content 缓存**）。
- 不提供多租户控制台 UI（配置以 **JSON 文件 + 环境变量** 为主）。
- `count_tokens` 与 `event_logging` 仅为 **Stub**，不实现真实计费或遥测管道。

---

## 2. 产品愿景与目标

### 2.1 愿景

让任意「只会说 Anthropic 协议」的客户端，在 **单一 Base URL** 下安全、可观测地使用多家 OpenAI 兼容上游，并在出账、审计、排障时能得到 **一致结构的用量记录**。

### 2.2 核心目标（可度量）

| 目标 | 说明 | 实现对应 |
|------|------|----------|
| G1 协议透明 | 客户端仅配置 Anthropic 风格端点；工具调用、流式、思考字段在支持的上游上尽量透传 | `formatTransform.ts` + `proxy.ts` 流式状态机 |
| G2 可配置多上游 | 通过 `model` 字符串前缀选择不同 `baseURL` / 密钥 / provider | `config.resolveUpstreamFromModel` |
| G3 身份绑定 | 每次真实模型调用前完成外部鉴权，失败不转发 | `fetchUserInfo` + 401 |
| G4 可观测 | 按请求写 usage JSONL；可选同步 ES；代理日志可按 verbose 开关 | `usageLogger.ts`、`sync-usage-to-es.ts`、`logger.ts` |
| G5 弹性密钥池 | Code Plan 场景多 key 轮询，触限冷却，全池冷却回落普通 key | `codePlanPool.ts`、`codePlanQuota.ts` |

### 2.3 成功标准（验收视角）

- 客户端在 Base URL 指向本代理时，**主路径** `POST /v1/messages` 流式/非流式均可完成一次完整对话（含 tool loop，受上游能力限制）。
- 无 `x-api-key` / Bearer 或鉴权服务失败时，**绝不**向大模型上游发起请求。
- 每次完成的模型调用在 `logs/usage-*.jsonl` 中**至少一条**记录（流式结束必写；用量可为 0）。
- 配置变更在约 **300ms** 防抖后热加载，无需重启（`index.ts` `fs.watch`）。

---

## 3. 术语与缩写

| 术语 | 含义 |
|------|------|
| Anthropic Messages API | 客户端使用的请求/响应/SSE 事件约定（本代理对外契约） |
| Chat Completions | OpenAI 兼容的 `/v1/chat/completions` 及 SSE `choices[].delta` 形态 |
| Responses API | OpenAI 的 `/v1/responses` 及 `response.*` 系列 SSE 事件 |
| upstream | 配置中的大模型 HTTP 服务入口（`baseURL` + `apiKey` 等） |
| provider | 配置字段，决定走 Chat 还是 Responses、以及部分厂商特化清洗逻辑 |
| Code Plan | 云厂商「编程/编码」专用配额或端点；本代理用 **多 `apiKey` 池** 与 **独立 `codePlanBaseURL`** 支持 |
| 冷却（cooldown） | 某池内凭证触限后 **30 分钟**内不再被选入轮询（`CODE_PLAN_COOLDOWN_MS`） |
| JSONL | 每行一个完整 JSON 对象，便于流式追加与日志分析 |
| deviceId | 客户端传入的 token，映射为外部认证服务中的设备标识 |

---

## 4. 干系人与用户角色

| 角色 | 诉求 |
|------|------|
| 终端用户 | 通过已绑定设备使用 IDE/Agent，无感经过代理 |
| 平台运维 | 配置上游、滚动密钥、看日志与用量、处理 429/5xx |
| 安全审计 | 确认未鉴权请求不外发；密钥不落日志；可追溯用户维度用量 |
| 数据分析师 | 从 JSONL 或 ES 统计 token、模型、用户、时间 |
| 开发 | 扩展 provider 行为、修格式转换 bug、对齐新上游 |

---

## 5. 系统范围与上下文

### 5.1 上下文图（逻辑）

```
[LobsterAI / WoiClaw 客户端] --Anthropic HTTPS--> [WoiClaw Proxy]
                                                      |
                    +----------------+----------------+----------------+
                    |                |                |
              [外部认证服务]    [大模型上游 A]    [大模型上游 B...]
                    |
            GET user-by-device
```

### 5.2 部署单元

- **woiclaw-proxy**：主 HTTP 服务，默认监听配置端口（如 3456）。
- **usage-sync**（可选）：同镜像、独立进程，读 JSONL 增量写 Elasticsearch。

### 5.3 与外部系统的接口依赖

- **认证服务**：可配置 `WOICLAW_AUTH_HOST` + `WOICLAW_AUTH_USER_PATH`，成功响应需 `rc === 0` 且 `data.name` 为字符串。
- **上游 LLM**：HTTPS（由 Node `fetch`），须兼容所选 API 形态（Chat 或 Responses）。

---

## 6. 用户场景与用户故事

### 6.1 场景 S1：单上游环境变量模式快速起服

**角色**：运维  
**故事**：作为运维，我希望仅通过环境变量指定一个 `UPSTREAM_BASE_URL` 与 `UPSTREAM_MODEL`，即可在无 `proxy-config.json` 时启动代理，以便容器 PoC。  
**实现**：`config.loadConfig` 在配置文件不存在时读取 `UPSTREAM_*` 与 `PORT`/`HOST`。  
**验收**：无 json 文件时设置合法 env 可监听成功；缺省时进程退出并打印明确错误信息。

### 6.2 场景 S2：多上游按 model 前缀路由

**角色**：开发  
**故事**：作为开发，我希望在请求体 `model` 使用 `deepseek|deepseek-chat` 时走 DeepSeek 的 `baseURL`，使用 `ark|xxx` 时走方舟，以便同一客户端切换模型即切换线路。  
**实现**：`resolveUpstreamFromModel`：`|` 左侧为 `upstreamsById` 键；未知 id 时若存在 `defaultUpstream` 则回落并使用右侧 `modelId`。  
**验收**：抓包可见上游 URL 主机与配置一致；发往上游的 `model` 字段为 `|` 右侧（或上游默认 model）。

### 6.3 场景 S3：流式对话 + 工具调用

**角色**：终端用户  
**故事**：作为用户，我希望在 Agent 调用工具时，代理仍能流式返回 Anthropic 事件，且工具参数逐步增量下发。  
**实现**：`proxy.ts` 中 `StreamState` / `processOpenAIChunk`、Responses 路径下 `ResponsesStreamContext` 等维护块索引与 tool 状态；`formatTransform` 负责 Anthropic ↔ OpenAI 结构映射。  
**验收**：与兼容上游联调时，客户端无协议错误；Gemini 路径下缺 `extra_content` 时自动补 `thought_signature` 占位（常量 `GEMINI_FALLBACK_THOUGHT_SIGNATURE`）。

### 6.4 场景 S4：设备鉴权失败

**角色**：安全  
**故事**：作为安全人员，我希望伪造或过期设备 token 时返回 401，且后端无上游请求。  
**实现**：读完 body 并排除 SDK 内部模型 stub 后，校验 header token，调用 `fetchUserInfo`；失败则 `authentication_error`。  
**验收**：认证失败与无 key 均 401；verbose 日志可看到 reqId 与脱敏 token。

### 6.5 场景 S5：Code Plan 池触限

**角色**：运维  
**故事**：作为运维，我希望某一 Code Plan key 返回 429 或配额类错误时，该 key **单独冷却 30 分钟**，由其他 key 承接后续请求；仅当**全部**在冷却时才用普通 `apiKey` 走 `baseURL`。  
**实现**：`CodePlanPoolManager.pickOrFallback` 轮询可用凭证；`isQuotaLimitedResponse` 判定；`pool.markCooldown` 在对应响应后调用。  
**验收**：模拟 429 后，同一进程内后续请求不再使用该 id 直至冷却结束；日志仅打印 credential **id**，不打印 apiKey。

### 6.6 场景 S6：用量审计与 ES 看板

**角色**：数据分析师  
**故事**：作为分析师，我希望每日 JSONL 能同步到 ES，并在 Kibana 按用户、模型、时间聚合 token。  
**实现**：`appendUsageLog` 写盘；`sync-usage-to-es.ts` 按文件+行号断点增量 bulk；文档 `_id` 哈希幂等。  
**验收**：`RUN_ONCE=1` 跑同步后 ES 可检索；bulk 失败不推进断点。

### 6.7 场景 S7：配置热更新

**角色**：运维  
**故事**：作为运维，我希望修改 `proxy-config.json` 后约秒内生效，无需 kill 进程。  
**实现**：`fs.watch` + 300ms debounce + `parseProxyConfigObject` + 替换 `ctx` 与 `pool.reconcileFromConfig`。  
**验收**：改端口以外的上游映射后，新请求走新配置；非法 json 打错误日志并保留旧配置。

---

## 7. 功能需求（详细）

### 7.1 服务入口与路由

**FR-7.1.1 监听**  
系统 SHALL 自 `ProxyConfig.port` / `host` 启动 HTTP 服务（默认 `0.0.0.0:3456` 可由配置覆盖）。

**FR-7.1.2 健康检查**  
`GET /healthz` SHALL 返回 JSON `{ ok: true }` 与 HTTP 200，用于负载均衡探活。

**FR-7.1.3 主代理端点**  
`POST /v1/messages` SHALL 作为唯一完整代理业务入口（Anthropic 请求体）。

**FR-7.1.4 未匹配路径**  
非上述路径 SHALL 返回 404，`type` 为 Anthropic 风格错误体（`not_found_error`）。

**FR-7.1.5 Stub 端点**  
- `POST /v1/messages/count_tokens` SHALL 返回 `{ input_tokens: 0 }`（200），消费 body 避免挂起。  
- `POST /api/event_logging/batch` SHALL 返回 204，无 body。

### 7.2 请求体限制与解析

**FR-7.2.1 体积上限**  
请求体 SHALL 不超过 `MAX_REQUEST_BODY_BYTES`（实现为 20MB），超限应拒绝并返回 400 类 Anthropic 错误。

**FR-7.2.2 JSON 校验**  
非法 JSON SHALL 返回 `invalid_request_error`。

### 7.3 SDK 内部模型短路

**FR-7.3.1**  
当请求 `model` 被识别为 Claude Agent SDK 内部占位模型时，系统 SHALL **直接 stub 响应**，不进行外部鉴权、不调用上游。  
**目的**：避免 SDK 自检请求误打真实模型与认证系统。

### 7.4 客户端身份与外部认证

**FR-7.4.1 Token 提取**  
系统 SHALL 自 `x-api-key` 或 `Authorization: Bearer <token>` 提取设备 token；两者皆无 SHALL 401。

**FR-7.4.2 认证请求**  
系统 SHALL 使用 `GET {AUTH_HOST}{AUTH_USER_PATH}?deviceId=<URL编码 token>`，**不带**客户端 Authorization 转发。

**FR-7.4.3 成功条件**  
HTTP 200 且 JSON `rc === 0` 且 `data.name` 为字符串 SHALL 视为成功，`name` 作为 `username` 写入 usage。

**FR-7.4.4 失败条件**  
任意网络错误、非 200、`rc !== 0`、缺字段 SHALL 视为失败，返回 401 `Authentication failed.`，且 **不得** 发起上游模型请求。

**FR-7.4.5 日志脱敏**  
verbose 日志中 token SHALL 以首尾各 4 字符 + 掩码形式出现。

### 7.5 上游解析与 Provider 语义

**FR-7.5.1 provider=openai**  
SHALL 使用 **Responses API**（`/v1/responses`）及对应 SSE 解析分支。

**FR-7.5.2 provider≠openai（含空）**  
SHALL 使用 **Chat Completions**（`/v1/chat/completions`）及 `choices[0].delta` 解析分支。

**FR-7.5.3 OpenAI 专有工具过滤**  
仅当 `provider === 'openai'`（大小写不敏感比较以实现为准）时，SHALL 过滤名为 `skill` 的 tool，并将对 `skill` 的强制 `tool_choice` 改为 `auto`。

**FR-7.5.4 MiniMax 角色**  
`provider === 'minimax'` 时 SHALL 将 `developer` 消息重写为 `system`。

**FR-7.5.5 新模型 max 字段**  
`provider === 'openai'` 且 model 匹配 gpt-5/o 系列等时 SHALL 将 `max_tokens` 映射为 `max_completion_tokens` 并删除 `max_tokens`。

**FR-7.5.6 多 system 合并**  
使用 Chat Completions 路径时 SHALL 合并多条 system 消息为单条，以兼容部分上游。

**FR-7.5.7 Gemini tool 补全**  
`provider === 'gemini'` 或 `baseURL` 含 `generativelanguage.googleapis.com` 时 SHALL 为缺省 `extra_content` 的 tool_calls 补占位签名。

### 7.6 Code Plan 密钥池

**FR-7.6.1 配置约束**  
若 `codePlanCredentials` 非空，则同一 `UpstreamConfig` 上 **必须** 配置非空普通 `apiKey`；否则启动/热加载 SHALL `validateCodePlanUpstreams` 抛错。

**FR-7.6.2 选取策略**  
对有池的上游，SHALL 在「未冷却」的凭证间 **轮询**；若全部冷却，SHALL 使用普通 `apiKey` 并记录 `fallback_ordinary` 类 verbose 日志。

**FR-7.6.3 Base URL 选择**  
当本次选中池内凭证且配置了 `codePlanBaseURL` 时，上游 HTTP SHALL 使用 `codePlanBaseURL`；回落普通 key 时 SHALL 使用 `baseURL`。

**FR-7.6.4 模型名映射（仅回落）**  
回落普通模式且请求 model id 命中 `ordinaryFallbackModelMap` 的 key 时，SHALL 替换为 value 再请求上游；**走池内凭证时不做此映射**。

**FR-7.6.5 Ark Code Plan 固定模型**  
实现中对方舟 Code Plan 路径使用常量 `ARK_CODE_PLAN_UPSTREAM_MODEL = 'ark-code-latest'` 作为上游 model（与客户端请求 model 解耦），以满足 coding 端点约定。

**FR-7.6.6 冷却触发**  
上游响应若 HTTP 429 或 `isQuotaLimitedResponse` 对 body 判定为配额/限流，且本次使用了池内 `credentialId`，SHALL `markCooldown` 刷新该 id 的 30 分钟窗口。

**FR-7.6.7 单次请求不重试换 key**  
同一客户端请求内 SHALL **不会**在遇限后自动换另一池 key 重试；后续**新请求**再参与选取。

**FR-7.6.8 热加载与状态**  
`reconcileFromConfig` SHALL 删除已移除 credential id 的冷却项；保留仍存在的 id 的冷却截止时间。

### 7.7 流式与非流式转发

**FR-7.7.1 SSE 响应头**  
流式响应 SHALL `Content-Type: text/event-stream`，并维持连接直至上游结束或客户端断开。

**FR-7.7.2 客户端断开**  
客户端关闭 SHALL 中止上游读取（abort 标志），避免泄漏 goroutine/句柄（Node 侧为 reader cancel 逻辑）。

**FR-7.7.3 读超时**  
上游流 SHALL 受 `STREAM_READ_TIMEOUT_MS`（90s）约束，超时 SHALL 以错误事件通知客户端并结束。

**FR-7.7.4 非流式**  
`stream: false` SHALL 读取完整上游 JSON，转换为 Anthropic 响应体一次性返回。

### 7.8 格式转换与多模态

**FR-7.8.1 图像工具结果**  
`formatTransform` SHALL 支持将 tool 返回中的图片（data URL、base64、对象结构等）转为 OpenAI `image_url` 用户消息路径所需形态；对合成占位文案与 `isSyntheticImageToolResultPair` 成对识别 SHALL 避免重复破坏上下文。

**FR-7.8.2 Schema 清洗**  
发往上游的 JSON Schema SHALL 经 `cleanSchema` 去除 `$schema`、部分 `format: uri` 等易引发兼容问题的字段。

**FR-7.8.3 stop_reason 映射**  
`mapStopReason` SHALL 将 `tool_calls` → `tool_use`，`stop` → `end_turn`，`length` → `max_tokens`。

### 7.9 用量记录（Usage）

**FR-7.9.1 写盘时机**  
流式：流结束 SHALL **总是** `appendUsageLog` 一行；若有合并后的 `lastUsage` 则用其 token，否则 input/output 为 0。  
非流式：每次响应 SHALL 写一行。

**FR-7.9.2 字段集合**  
记录 SHALL 包含：`app`（如 `woicrew`）、`clientid`、`username`、`modelid`、`input_token`、`output_token`、`input_cached_token`（无则 0）、`start_time`、`out_time`、`cost_time`、`request_size`、`response_size`、`stream`、`input_content`、`output_content`、`input_fulltext`（仅 env 开启时）。

**FR-7.9.3 input_content 语义**  
SHALL 为 JSON 字符串，内含 `model`、`tail_role`、`tail_preview`：对应**转换后上游请求** `messages` 数组**最后一条**的角色与预览（非仅 user），以便 tool/assistant 链尾部可辨；预览长度受 `WOICLAW_USAGE_LOG_TAIL_PREVIEW_MAX` 与下限 4096 逻辑约束。

**FR-7.9.4 output_content 语义**  
SHALL 仅为助手**文本与思考**的累积（`outputAccumulator`）；**纯工具调用轮无正文时可为空**，不拼接工具摘要（与当前产品决策一致）。

**FR-7.9.5 input_fulltext**  
仅当 `WOICLAW_USAGE_LOG_INPUT_FULLTEXT` 为真 SHALL 写入完整上游请求 JSON（高磁盘占用，默认关）。

**FR-7.9.6 异步写盘**  
`appendUsageLog` SHALL 使用 `setImmediate` 延迟构建与写入，避免阻塞请求收尾关键路径。

**FR-7.9.7 文件滚动**  
按东八区日期文件名 `usage-YYYY-MM-DD.jsonl`；超过 `WOICLAW_USAGE_LOG_MAX_BYTES` SHALL 切分 `-2`、`-3` 后缀文件。

### 7.10 代理文件日志

**FR-7.10.1**  
`logger.log/warn/error` SHALL 同时写控制台与 `logs/proxy-YYYY-MM-DD.log`（东八区）。

**FR-7.10.2**  
`verbose` SHALL 仅当 `WOICLAW_PROXY_VERBOSE=1/true` 时输出，用于降噪与磁盘节约。

### 7.11 Elasticsearch 增量同步

**FR-7.11.1**  
同步脚本 SHALL 从 `WOICLAW_LOG_DIR` 下列出 `usage-*.jsonl`，按字典序处理文件。

**FR-7.11.2 断点**  
状态 SHALL 持久化 `lastFile` + `lastLineNumber`；仅当 bulk **全部成功**才更新断点。

**FR-7.11.3 幂等**  
文档 `_id` SHALL 由 `app+clientid+start_time+modelid` 哈希前 32 位生成，重复同步覆盖同 id。

**FR-7.11.4 认证**  
支持 `ES_API_KEY` 或 Basic（`ELASTIC_USER`/`ELASTIC_PASSWORD` 等别名以代码为准）。

**FR-7.11.5 定时**  
非 `RUN_ONCE` 时 SHALL 每 10 分钟执行一轮同步。

**FR-7.11.6 可选 refresh**  
`USAGE_SYNC_BULK_REFRESH` 为真时 SHALL bulk 带 `refresh` 便于即时检索。

---

## 8. 非功能需求

### 8.1 性能与可扩展性

**NFR-8.1.1**  
单进程事件驱动模型；水平扩展时 SHALL 视为无会话粘性（除每实例 tool extra_content 缓存外无强状态）。

**NFR-8.1.2**  
Code Plan 冷却 **不跨进程**；多副本部署时各实例独立轮询与冷却。

### 8.2 可用性与容错

**NFR-8.2.1**  
配置热加载失败 SHALL 保留旧配置并打 error 日志。

**NFR-8.2.2**  
认证服务短时不可用 SHALL 导致 401（ fail-closed ），避免匿名刷上游。

### 8.3 安全

**NFR-8.3.1**  
完整 `apiKey` SHALL 不得出现在 info 级日志；Code Plan 仅打印 `id`。

**NFR-8.3.2**  
建议生产环境通过 TLS 终止与网络策略限制仅内网访问认证服务与上游。

### 8.4 可维护性

**NFR-8.4.1**  
核心类型与配置解析与 `proxy` 解耦（`config.ts` 可单测）。

**NFR-8.4.2**  
TypeScript 构建产物在 `dist/`，容器镜像多阶段构建减小体积。

---

## 9. 数据模型

### 9.1 Usage JSONL 单条逻辑模型

| 字段 | 类型 | 说明 |
|------|------|------|
| app | string | 固定应用标识 |
| clientid | string | 客户端 token 标识 |
| username | string | 认证服务返回 |
| modelid | string | 记录用模型 id（与实现一致） |
| input_token / output_token | number | 来自上游 usage |
| input_cached_token | number | 缓存命中 prompt tokens |
| start_time / out_time | string | 东八区 ISO8601 |
| cost_time | string | 秒，两位小数字符串 |
| request_size / response_size | number | 可选 |
| stream | boolean | 是否流式 |
| input_content | string | JSON 字符串摘要 |
| output_content | string | 文本+思考摘要 |
| input_fulltext | string | 可选，全量请求 |

### 9.2 Elasticsearch

建议 mapping 见 `scripts/es-usage-index.mapping.json`；含 `input_cached_token` integer。已有索引需 `PUT _mapping` 补字段方可检索列完整。

---

## 10. 接口规格摘要

### 10.1 POST /v1/messages

- **Request**：Anthropic Messages JSON（含 `model`、`messages`、`stream`、可选 `tools` 等）。
- **Response**：流式为 SSE Anthropic 事件；非流式为 JSON。
- **Errors**：400/401/404/上游错误映射（以 `createAnthropicErrorBody` 为准）。

### 10.2 认证 API（外部，非本仓库实现）

- `GET {AUTH_HOST}{AUTH_USER_PATH}?deviceId=...`
- 成功：`{ rc: 0, data: { name: string, ... } }`

---

## 11. 配置项汇总

### 11.1 proxy-config.json

| 键 | 说明 |
|----|------|
| port / host | 监听 |
| defaultUpstream | 无前缀或未知 id 时默认 |
| upstreamsById | 多上游表 |
| UpstreamConfig.baseURL / apiKey / model / provider | 基本 |
| codePlanCredentials | `{id, apiKey}[]` |
| codePlanBaseURL | 池选中时的专用 host path |
| ordinaryFallbackModelMap | 回落时 model 替换表 |

### 11.2 环境变量（节选）

| 变量 | 用途 |
|------|------|
| WOICLAW_PROXY_CONFIG | 配置文件路径 |
| WOICLAW_AUTH_HOST / WOICLAW_AUTH_USER_PATH | 认证 |
| WOICLAW_LOG_DIR | 日志目录 |
| WOICLAW_USAGE_LOG_MAX_BYTES | usage 单文件上限 |
| WOICLAW_USAGE_LOG_TAIL_PREVIEW_MAX | tail 预览上限（与代码下限配合） |
| WOICLAW_USAGE_LOG_INPUT_FULLTEXT | 全量请求落盘 |
| WOICLAW_PROXY_VERBOSE | 详细代理日志 |
| WOICLAW_LOG_STREAM_USAGE_DEBUG | 流式 usage 调试 |
| UPSTREAM_* / PORT / HOST | 无文件模式 |

（ES 同步变量见 `sync-usage-to-es.ts` 头部常量。）

---

## 12. 部署说明（与实现一致）

- **Docker**：多阶段构建，运行时 `node dist/index.js`；Compose 挂载 `proxy-config.json` 与 `logs`，`env_file: .env`。
- **usage-sync 容器**：只读挂载 logs，读写 `data` 存断点；环境变量注入 ES 地址与索引名。

---

## 13. 风险、假设与依赖

| 项 | 说明 |
|----|------|
| R1 | 上游不返回 usage 时记录为 0，账单需上游侧或对账 |
| R2 | 多实例 Code Plan 池不共享，可能重复打同一 key，需上游配额足够或侧旁协调 |
| R3 | provider 配错（如 DashScope 配成 openai）会导致解析失败 |
| R4 | ES strict mapping 未含新字段时 bulk 可能失败，需更新 mapping |

---

## 14. 验收检查清单（抽样）

1. 无 key → 401，无上游连接。  
2. 鉴权 rc≠0 → 401。  
3. 合法请求 → 上游 200 且客户端收齐流或非流式 body。  
4. usage 文件新增一行，含 username 与 input_content JSON。  
5. 改 upstreamsById 后热加载生效。  
6. 429 + 池 key → 该 id 冷却，verbose 可见。  
7. `RUN_ONCE=1 npm run sync-usage` → ES 文档数增加且 state 更新。

---

## 15. 附录 A：请求生命周期（叙述）

客户端发起 `POST /v1/messages` 后，代理首先按长度限制读取 body 并解析 JSON。若 model 属于 SDK 内部占位，则立即生成 stub SSE 或 JSON 并结束——此路径不触碰认证与上游。否则从 header 取 token；若缺失则 401。随后生成 `reqId`，调用认证服务；失败则 401。成功后解析 `model` 字符串，结合 `upstreamsById` 与 `defaultUpstream` 得到目标 `UpstreamConfig` 与实际上游 `modelId`。若该上游启用 Code Plan 池，则 `pickOrFallback` 选出 apiKey 与可选 credentialId，并决定使用 `codePlanBaseURL` 或 `baseURL`。接着 `anthropicToOpenAI` 将消息、工具、参数转换为 OpenAI 请求体，并应用 provider 清洗（system 合并、skill 过滤、MiniMax 角色、Gemini 签名等）。根据 provider 选择 Chat 或 Responses URL，使用 Node `fetch` 发起请求并携带流式 Accept。上游返回后，若是流，则进入 SSE 解析循环：不断读取 chunk，更新 `StreamState`、合并 usage、向客户端写入 Anthropic SSE 事件；若客户端断开则中止。流结束后，无论 usage 是否完整，均异步写 usage 一行，其中 `input_content` 来自对**已转换上游请求**的尾消息摘要，`output_content` 来自文本与思考累积。若为非流式，则一次性转换响应体并写 usage。任何池凭证触限则在关闭响应体后标记冷却。至此单请求结束。

---

## 16. 附录 B：与 LobsterAI 对接要点

- Base URL 指向 `http(s)://<proxy-host>:<port>`。  
- API Key 位置填设备 token（与认证服务 deviceId 一致）。  
- model 使用 `upstreamId|modelId` 或依赖 defaultUpstream。

---

## 17. 附录 C：后续迭代建议（非当前承诺）

- 可配置冷却时长与轮询策略（加权、随机）。  
- 同请求内有限次换 key 重试（需严格上限防放大）。  
- OpenTelemetry 指标导出。  
- count_tokens 与真实 tokenizer 对齐（若获授权）。

---

**文档结束**


## 18. 附录 D：实现细化与运维补充说明（扩展）

以下各小节为对前述需求的展开叙述，用于满足文档深度与体量要求；与当前 TypeScript 实现一致。

### D.1 流式转发

在本代理的实现中，与「流式转发」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「流式转发」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「流式转发」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.2 非流式转发

在本代理的实现中，与「非流式转发」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「非流式转发」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「非流式转发」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.3 Responses API 分支

在本代理的实现中，与「Responses API 分支」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Responses API 分支」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Responses API 分支」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.4 Chat Completions 分支

在本代理的实现中，与「Chat Completions 分支」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Chat Completions 分支」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Chat Completions 分支」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.5 外部设备鉴权

在本代理的实现中，与「外部设备鉴权」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「外部设备鉴权」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「外部设备鉴权」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.6 Usage JSONL 落盘

在本代理的实现中，与「Usage JSONL 落盘」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Usage JSONL 落盘」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Usage JSONL 落盘」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.7 Elasticsearch 增量同步

在本代理的实现中，与「Elasticsearch 增量同步」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Elasticsearch 增量同步」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Elasticsearch 增量同步」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.8 Code Plan 多密钥池

在本代理的实现中，与「Code Plan 多密钥池」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Code Plan 多密钥池」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Code Plan 多密钥池」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.9 冷却与回落

在本代理的实现中，与「冷却与回落」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「冷却与回落」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「冷却与回落」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.10 配置热加载

在本代理的实现中，与「配置热加载」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「配置热加载」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「配置热加载」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.11 provider 语义矩阵

在本代理的实现中，与「provider 语义矩阵」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「provider 语义矩阵」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「provider 语义矩阵」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.12 Gemini 工具签名

在本代理的实现中，与「Gemini 工具签名」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Gemini 工具签名」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Gemini 工具签名」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.13 MiniMax 角色重写

在本代理的实现中，与「MiniMax 角色重写」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「MiniMax 角色重写」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「MiniMax 角色重写」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.14 多 system 合并

在本代理的实现中，与「多 system 合并」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「多 system 合并」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「多 system 合并」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.15 skill 工具过滤

在本代理的实现中，与「skill 工具过滤」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「skill 工具过滤」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「skill 工具过滤」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.16 max_tokens 字段迁移

在本代理的实现中，与「max_tokens 字段迁移」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「max_tokens 字段迁移」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「max_tokens 字段迁移」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.17 请求体大小限制

在本代理的实现中，与「请求体大小限制」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「请求体大小限制」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「请求体大小限制」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.18 SSE 读超时

在本代理的实现中，与「SSE 读超时」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「SSE 读超时」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「SSE 读超时」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.19 客户端断开中止

在本代理的实现中，与「客户端断开中止」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「客户端断开中止」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「客户端断开中止」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.20 Anthropic 错误体封装

在本代理的实现中，与「Anthropic 错误体封装」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Anthropic 错误体封装」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Anthropic 错误体封装」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.21 tool_calls 分片合并

在本代理的实现中，与「tool_calls 分片合并」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「tool_calls 分片合并」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「tool_calls 分片合并」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.22 thinking 与 reasoning 映射

在本代理的实现中，与「thinking 与 reasoning 映射」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「thinking 与 reasoning 映射」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「thinking 与 reasoning 映射」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.23 图片工具结果管线

在本代理的实现中，与「图片工具结果管线」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「图片工具结果管线」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「图片工具结果管线」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.24 JSON Schema 清洗

在本代理的实现中，与「JSON Schema 清洗」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「JSON Schema 清洗」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「JSON Schema 清洗」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.25 stop_reason 映射

在本代理的实现中，与「stop_reason 映射」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「stop_reason 映射」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「stop_reason 映射」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.26 上游 usage 解析

在本代理的实现中，与「上游 usage 解析」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「上游 usage 解析」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「上游 usage 解析」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.27 input_cached_token 提取

在本代理的实现中，与「input_cached_token 提取」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「input_cached_token 提取」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「input_cached_token 提取」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.28 tail_preview 截断

在本代理的实现中，与「tail_preview 截断」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「tail_preview 截断」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「tail_preview 截断」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.29 input_fulltext 开关

在本代理的实现中，与「input_fulltext 开关」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「input_fulltext 开关」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「input_fulltext 开关」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.30 代理 verbose 日志

在本代理的实现中，与「代理 verbose 日志」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「代理 verbose 日志」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「代理 verbose 日志」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.31 Docker Compose 部署

在本代理的实现中，与「Docker Compose 部署」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Docker Compose 部署」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Docker Compose 部署」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.32 单进程无状态扩展

在本代理的实现中，与「单进程无状态扩展」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「单进程无状态扩展」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「单进程无状态扩展」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.33 幂等文档 _id

在本代理的实现中，与「幂等文档 _id」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「幂等文档 _id」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「幂等文档 _id」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.34 sync 断点一致性

在本代理的实现中，与「sync 断点一致性」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「sync 断点一致性」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「sync 断点一致性」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.35 健康检查

在本代理的实现中，与「健康检查」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「健康检查」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「健康检查」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.36 SDK 内部模型 stub

在本代理的实现中，与「SDK 内部模型 stub」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「SDK 内部模型 stub」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「SDK 内部模型 stub」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.37 count_tokens stub

在本代理的实现中，与「count_tokens stub」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「count_tokens stub」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「count_tokens stub」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.38 event_logging stub

在本代理的实现中，与「event_logging stub」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「event_logging stub」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「event_logging stub」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.39 未知路径 404

在本代理的实现中，与「未知路径 404」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「未知路径 404」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「未知路径 404」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.40 环境变量单上游模式

在本代理的实现中，与「环境变量单上游模式」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「环境变量单上游模式」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「环境变量单上游模式」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.41 WOICLAW_PROXY_CONFIG 路径

在本代理的实现中，与「WOICLAW_PROXY_CONFIG 路径」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「WOICLAW_PROXY_CONFIG 路径」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「WOICLAW_PROXY_CONFIG 路径」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.42 认证 URL 拼接

在本代理的实现中，与「认证 URL 拼接」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「认证 URL 拼接」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「认证 URL 拼接」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.43 token 日志脱敏

在本代理的实现中，与「token 日志脱敏」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「token 日志脱敏」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「token 日志脱敏」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.44 Ark coding 固定模型

在本代理的实现中，与「Ark coding 固定模型」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Ark coding 固定模型」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Ark coding 固定模型」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.45 ordinaryFallbackModelMap

在本代理的实现中，与「ordinaryFallbackModelMap」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「ordinaryFallbackModelMap」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「ordinaryFallbackModelMap」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.46 codePlanBaseURL 选择

在本代理的实现中，与「codePlanBaseURL 选择」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「codePlanBaseURL 选择」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「codePlanBaseURL 选择」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.47 东八区日志切分

在本代理的实现中，与「东八区日志切分」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「东八区日志切分」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「东八区日志切分」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.48 usage 按大小滚动

在本代理的实现中，与「usage 按大小滚动」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「usage 按大小滚动」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「usage 按大小滚动」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.49 setImmediate 写盘

在本代理的实现中，与「setImmediate 写盘」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「setImmediate 写盘」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「setImmediate 写盘」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.50 bulk refresh 选项

在本代理的实现中，与「bulk refresh 选项」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「bulk refresh 选项」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「bulk refresh 选项」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.51 ES API Key 认证

在本代理的实现中，与「ES API Key 认证」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「ES API Key 认证」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「ES API Key 认证」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.52 Basic 认证别名

在本代理的实现中，与「Basic 认证别名」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Basic 认证别名」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Basic 认证别名」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.53 流式转发

在本代理的实现中，与「流式转发」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「流式转发」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「流式转发」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.54 非流式转发

在本代理的实现中，与「非流式转发」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「非流式转发」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「非流式转发」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.55 Responses API 分支

在本代理的实现中，与「Responses API 分支」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Responses API 分支」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Responses API 分支」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.56 Chat Completions 分支

在本代理的实现中，与「Chat Completions 分支」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Chat Completions 分支」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Chat Completions 分支」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.57 外部设备鉴权

在本代理的实现中，与「外部设备鉴权」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「外部设备鉴权」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「外部设备鉴权」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.58 Usage JSONL 落盘

在本代理的实现中，与「Usage JSONL 落盘」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Usage JSONL 落盘」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Usage JSONL 落盘」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.59 Elasticsearch 增量同步

在本代理的实现中，与「Elasticsearch 增量同步」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Elasticsearch 增量同步」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Elasticsearch 增量同步」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.60 Code Plan 多密钥池

在本代理的实现中，与「Code Plan 多密钥池」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Code Plan 多密钥池」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Code Plan 多密钥池」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.61 冷却与回落

在本代理的实现中，与「冷却与回落」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「冷却与回落」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「冷却与回落」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.62 配置热加载

在本代理的实现中，与「配置热加载」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「配置热加载」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「配置热加载」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.63 provider 语义矩阵

在本代理的实现中，与「provider 语义矩阵」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「provider 语义矩阵」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「provider 语义矩阵」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.64 Gemini 工具签名

在本代理的实现中，与「Gemini 工具签名」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Gemini 工具签名」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Gemini 工具签名」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.65 MiniMax 角色重写

在本代理的实现中，与「MiniMax 角色重写」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「MiniMax 角色重写」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「MiniMax 角色重写」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.66 多 system 合并

在本代理的实现中，与「多 system 合并」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「多 system 合并」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「多 system 合并」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.67 skill 工具过滤

在本代理的实现中，与「skill 工具过滤」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「skill 工具过滤」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「skill 工具过滤」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.68 max_tokens 字段迁移

在本代理的实现中，与「max_tokens 字段迁移」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「max_tokens 字段迁移」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「max_tokens 字段迁移」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.69 请求体大小限制

在本代理的实现中，与「请求体大小限制」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「请求体大小限制」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「请求体大小限制」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.70 SSE 读超时

在本代理的实现中，与「SSE 读超时」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「SSE 读超时」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「SSE 读超时」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.71 客户端断开中止

在本代理的实现中，与「客户端断开中止」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「客户端断开中止」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「客户端断开中止」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.72 Anthropic 错误体封装

在本代理的实现中，与「Anthropic 错误体封装」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Anthropic 错误体封装」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Anthropic 错误体封装」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.73 tool_calls 分片合并

在本代理的实现中，与「tool_calls 分片合并」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「tool_calls 分片合并」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「tool_calls 分片合并」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.74 thinking 与 reasoning 映射

在本代理的实现中，与「thinking 与 reasoning 映射」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「thinking 与 reasoning 映射」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「thinking 与 reasoning 映射」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.75 图片工具结果管线

在本代理的实现中，与「图片工具结果管线」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「图片工具结果管线」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「图片工具结果管线」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.76 JSON Schema 清洗

在本代理的实现中，与「JSON Schema 清洗」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「JSON Schema 清洗」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「JSON Schema 清洗」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.77 stop_reason 映射

在本代理的实现中，与「stop_reason 映射」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「stop_reason 映射」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「stop_reason 映射」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.78 上游 usage 解析

在本代理的实现中，与「上游 usage 解析」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「上游 usage 解析」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「上游 usage 解析」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.79 input_cached_token 提取

在本代理的实现中，与「input_cached_token 提取」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「input_cached_token 提取」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「input_cached_token 提取」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.80 tail_preview 截断

在本代理的实现中，与「tail_preview 截断」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「tail_preview 截断」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「tail_preview 截断」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.81 input_fulltext 开关

在本代理的实现中，与「input_fulltext 开关」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「input_fulltext 开关」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「input_fulltext 开关」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.82 代理 verbose 日志

在本代理的实现中，与「代理 verbose 日志」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「代理 verbose 日志」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「代理 verbose 日志」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.83 Docker Compose 部署

在本代理的实现中，与「Docker Compose 部署」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Docker Compose 部署」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Docker Compose 部署」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.84 单进程无状态扩展

在本代理的实现中，与「单进程无状态扩展」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「单进程无状态扩展」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「单进程无状态扩展」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.85 幂等文档 _id

在本代理的实现中，与「幂等文档 _id」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「幂等文档 _id」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「幂等文档 _id」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.86 sync 断点一致性

在本代理的实现中，与「sync 断点一致性」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「sync 断点一致性」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「sync 断点一致性」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.87 健康检查

在本代理的实现中，与「健康检查」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「健康检查」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「健康检查」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.88 SDK 内部模型 stub

在本代理的实现中，与「SDK 内部模型 stub」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「SDK 内部模型 stub」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「SDK 内部模型 stub」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.89 count_tokens stub

在本代理的实现中，与「count_tokens stub」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「count_tokens stub」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「count_tokens stub」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.90 event_logging stub

在本代理的实现中，与「event_logging stub」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「event_logging stub」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「event_logging stub」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.91 未知路径 404

在本代理的实现中，与「未知路径 404」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「未知路径 404」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「未知路径 404」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.92 环境变量单上游模式

在本代理的实现中，与「环境变量单上游模式」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「环境变量单上游模式」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「环境变量单上游模式」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.93 WOICLAW_PROXY_CONFIG 路径

在本代理的实现中，与「WOICLAW_PROXY_CONFIG 路径」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「WOICLAW_PROXY_CONFIG 路径」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「WOICLAW_PROXY_CONFIG 路径」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.94 认证 URL 拼接

在本代理的实现中，与「认证 URL 拼接」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「认证 URL 拼接」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「认证 URL 拼接」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.95 token 日志脱敏

在本代理的实现中，与「token 日志脱敏」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「token 日志脱敏」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「token 日志脱敏」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.96 Ark coding 固定模型

在本代理的实现中，与「Ark coding 固定模型」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Ark coding 固定模型」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Ark coding 固定模型」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.97 ordinaryFallbackModelMap

在本代理的实现中，与「ordinaryFallbackModelMap」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「ordinaryFallbackModelMap」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「ordinaryFallbackModelMap」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.98 codePlanBaseURL 选择

在本代理的实现中，与「codePlanBaseURL 选择」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「codePlanBaseURL 选择」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「codePlanBaseURL 选择」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.99 东八区日志切分

在本代理的实现中，与「东八区日志切分」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「东八区日志切分」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「东八区日志切分」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.100 usage 按大小滚动

在本代理的实现中，与「usage 按大小滚动」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「usage 按大小滚动」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「usage 按大小滚动」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.101 setImmediate 写盘

在本代理的实现中，与「setImmediate 写盘」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「setImmediate 写盘」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「setImmediate 写盘」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.102 bulk refresh 选项

在本代理的实现中，与「bulk refresh 选项」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「bulk refresh 选项」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「bulk refresh 选项」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.103 ES API Key 认证

在本代理的实现中，与「ES API Key 认证」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「ES API Key 认证」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「ES API Key 认证」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.104 Basic 认证别名

在本代理的实现中，与「Basic 认证别名」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Basic 认证别名」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Basic 认证别名」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.105 流式转发

在本代理的实现中，与「流式转发」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「流式转发」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「流式转发」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.106 非流式转发

在本代理的实现中，与「非流式转发」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「非流式转发」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「非流式转发」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.107 Responses API 分支

在本代理的实现中，与「Responses API 分支」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Responses API 分支」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Responses API 分支」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.108 Chat Completions 分支

在本代理的实现中，与「Chat Completions 分支」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Chat Completions 分支」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Chat Completions 分支」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.109 外部设备鉴权

在本代理的实现中，与「外部设备鉴权」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「外部设备鉴权」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「外部设备鉴权」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.110 Usage JSONL 落盘

在本代理的实现中，与「Usage JSONL 落盘」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Usage JSONL 落盘」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Usage JSONL 落盘」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.111 Elasticsearch 增量同步

在本代理的实现中，与「Elasticsearch 增量同步」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Elasticsearch 增量同步」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Elasticsearch 增量同步」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.112 Code Plan 多密钥池

在本代理的实现中，与「Code Plan 多密钥池」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Code Plan 多密钥池」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Code Plan 多密钥池」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.113 冷却与回落

在本代理的实现中，与「冷却与回落」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「冷却与回落」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「冷却与回落」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.114 配置热加载

在本代理的实现中，与「配置热加载」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「配置热加载」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「配置热加载」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.115 provider 语义矩阵

在本代理的实现中，与「provider 语义矩阵」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「provider 语义矩阵」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「provider 语义矩阵」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.116 Gemini 工具签名

在本代理的实现中，与「Gemini 工具签名」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Gemini 工具签名」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Gemini 工具签名」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.117 MiniMax 角色重写

在本代理的实现中，与「MiniMax 角色重写」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「MiniMax 角色重写」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「MiniMax 角色重写」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.118 多 system 合并

在本代理的实现中，与「多 system 合并」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「多 system 合并」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「多 system 合并」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.119 skill 工具过滤

在本代理的实现中，与「skill 工具过滤」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「skill 工具过滤」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「skill 工具过滤」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.120 max_tokens 字段迁移

在本代理的实现中，与「max_tokens 字段迁移」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「max_tokens 字段迁移」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「max_tokens 字段迁移」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.121 请求体大小限制

在本代理的实现中，与「请求体大小限制」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「请求体大小限制」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「请求体大小限制」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.122 SSE 读超时

在本代理的实现中，与「SSE 读超时」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「SSE 读超时」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「SSE 读超时」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.123 客户端断开中止

在本代理的实现中，与「客户端断开中止」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「客户端断开中止」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「客户端断开中止」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.124 Anthropic 错误体封装

在本代理的实现中，与「Anthropic 错误体封装」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Anthropic 错误体封装」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Anthropic 错误体封装」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.125 tool_calls 分片合并

在本代理的实现中，与「tool_calls 分片合并」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「tool_calls 分片合并」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「tool_calls 分片合并」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.126 thinking 与 reasoning 映射

在本代理的实现中，与「thinking 与 reasoning 映射」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「thinking 与 reasoning 映射」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「thinking 与 reasoning 映射」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.127 图片工具结果管线

在本代理的实现中，与「图片工具结果管线」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「图片工具结果管线」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「图片工具结果管线」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.128 JSON Schema 清洗

在本代理的实现中，与「JSON Schema 清洗」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「JSON Schema 清洗」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「JSON Schema 清洗」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.129 stop_reason 映射

在本代理的实现中，与「stop_reason 映射」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「stop_reason 映射」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「stop_reason 映射」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.130 上游 usage 解析

在本代理的实现中，与「上游 usage 解析」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「上游 usage 解析」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「上游 usage 解析」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.131 input_cached_token 提取

在本代理的实现中，与「input_cached_token 提取」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「input_cached_token 提取」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「input_cached_token 提取」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.132 tail_preview 截断

在本代理的实现中，与「tail_preview 截断」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「tail_preview 截断」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「tail_preview 截断」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.133 input_fulltext 开关

在本代理的实现中，与「input_fulltext 开关」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「input_fulltext 开关」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「input_fulltext 开关」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.134 代理 verbose 日志

在本代理的实现中，与「代理 verbose 日志」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「代理 verbose 日志」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「代理 verbose 日志」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.135 Docker Compose 部署

在本代理的实现中，与「Docker Compose 部署」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「Docker Compose 部署」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「Docker Compose 部署」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.136 单进程无状态扩展

在本代理的实现中，与「单进程无状态扩展」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「单进程无状态扩展」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「单进程无状态扩展」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.137 幂等文档 _id

在本代理的实现中，与「幂等文档 _id」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「幂等文档 _id」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「幂等文档 _id」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.138 sync 断点一致性

在本代理的实现中，与「sync 断点一致性」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「sync 断点一致性」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「sync 断点一致性」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.139 健康检查

在本代理的实现中，与「健康检查」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「健康检查」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「健康检查」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.140 SDK 内部模型 stub

在本代理的实现中，与「SDK 内部模型 stub」相关的行为主要由 src/proxy.ts、src/formatTransform.ts、src/config.ts、src/codePlanPool.ts、src/codePlanQuota.ts、src/usageLogger.ts、src/logger.ts 等模块协同完成。产品侧要求：部署拓扑或副本数变化时，不改变对客户端可见的 Anthropic API 契约；上游厂商升级 OpenAI 兼容层时，优先通过调整 provider 与请求清洗逻辑适配，而非要求客户端改协议。运维侧应保存 proxy-config.json 的变更记录，热加载失败时依据 ERROR 日志回滚文件。针对「SDK 内部模型 stub」，测试应覆盖正常路径、上游 4xx/5xx、网络中断、超大 body、鉴权服务不可达等组合；对启用 Code Plan 池的上游，应覆盖单 key 429、多 key 轮流可用、全池冷却后回落普通 apiKey、回落时 ordinaryFallbackModelMap 生效等场景。数据侧须知 usage 中 token 数值来自上游自报，成本核算需与财务规则及上游账单对齐。安全侧应限制日志目录与配置文件的访问权限，避免 apiKey 泄露；容器内配置挂载建议使用只读。

从可观测性角度，建议仅在排障窗口期开启 WOICLAW_PROXY_VERBOSE，避免 proxy 日志磁盘快速增长。与「SDK 内部模型 stub」相关的运维告警可结合：/healthz 失败率、401 突增、上游 429 计数、usage 文件长时间零增长（可能写盘失败）、sync 进程日志中出现 bulk item failures 等。使用 Elasticsearch 时，应在索引模板或 mapping 中显式包含 input_cached_token 等字段，避免 strict mapping 拒绝新字段导致同步断点停滞。

### D.末 编制说明

本扩展章节采用结构化重复叙述，强调横切关注点在生产中的联合约束；默认值以源码与环境变量为准，部署时勿仅凭记忆。

