# Feature Specification: Claw Proxy（统一 LLM 代理网关）

**文档类型**：SDD 功能规格 — **Claw Proxy**；与 Constitution + DESIGN 对齐交付（**不含 Code Plan**）。  
**Created**: 2026-03-30  
**Status**: Draft  

## 宗旨与文档真值链

| 层级 | 作用 | 交付时的用法 |
|------|------|----------------|
| **Constitution**（`.specify/memory/constitution.md`） | 原则、可追溯性、目标栈 | 治理与合并审查 |
| **本文件** | 功能需求（FR）+ **实现基线** + **交付验收** + **模块—DESIGN 映射** | 驱动 specify/plan/implement |
| **DESIGN**（`docs/DESIGN-WoiClaw-Proxy.md`） | 主流程顺序、流式状态机、配置语义 | 实现细节与顺序的权威叙述 |
| **PRD**（`docs/PRD-WoiClaw-Proxy.md`） | 产品范围与验收口径 | 与对外承诺对齐 |
| **源码**（可选） | 有则便于 diff；**无则不是交付必要条件** | 不得要求接收方「自己猜源码」 |

**交付定义**：在目标环境按本文件「实现基线」搭建 **Node.js ≥ 18 + TypeScript** 工程，使 **HTTP 路由、主链路顺序（无 Code Plan 阶段）、环境变量语义、JSONL 字段、流式 SSE 形态** 与规格 + DESIGN（跳过 §8）描述对等；**不要求**行号与变量名逐字相同，但 **模块职责与对外行为**须一致。

### 无源码时：仅凭 Constitution + 本 Spec 够不够？

**不够。** 当前 Spec 中的 FR/IR 仍多处写「与参考实现一致」；在**看不到仓库**时，必须把下列材料作为 **SDD 必备交付包** 一并提供，否则无法唯一实现流式状态机、Provider 管道顺序、错误码映射与 JSONL 字段细节：

| # | 必备文档 / 工件 | 用途 |
|---|-----------------|------|
| 1 | **`docs/DESIGN-WoiClaw-Proxy.md`** | 主流程（§6，**忽略其中 Code Plan 阶段**）、`model` 路由（§7）、**Provider 管道（§9，不含 Code Plan 相关步骤）**、404/400（§10–11）、格式转换（§12+）、流式（§15+）。**§8 Code Plan 整章不在本规格范围内，可不读。** |
| 2 | **`docs/PRD-WoiClaw-Proxy.md`（至少范围与非目标）** | 对外承诺与验收口径 |
| 3 | **`README.md`（运维与 env 表）** | 环境变量完整列表与部署说明 |
| 4 | **`proxy-config.example.json` + `.env.example`** | 配置 JSON 形态与占位 |
| 5 | **`docs/es-usage-index.md` 或本文件附录 A** | JSONL/ES 字段一致 |
| 6 | **（强烈建议）Golden / 集成测试用例** | 最小：鉴权失败、Stub、非流式一轮、流式一轮；有则作为**无源码时的行为仲裁** |

**仍可能缺口（即使带上 DESIGN）**：Anthropic / OpenAI **官方协议**的版本与字段以厂商文档为准，须自行引用最新版（见附录 B）；**具体 SSE 样例**建议在交付包中增加 1～2 个脱敏的抓包或 fixture，减少实现歧义。

**本期范围（与 Code Plan 无关）**：本规格**不包含、不验收** Code Plan / 多密钥池 / 冷却 / `codePlanCredentials` / `codePlanBaseURL` 等；实现按**单 `apiKey` 上游**路径即可。若仓库中仍有相关源码或 DESIGN §8，**不作为本 SDD 交付要求**。

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent 经网关完成一次对话（Priority: P1）

基于 Claude Agent SDK 的客户端将 Base URL 指向本代理，使用 Anthropic Messages 语义发起普通或流式对话；代理完成鉴权后将请求转发至配置的 OpenAI 兼容上游，并返回 Anthropic 兼容响应。

**Independent Test**: 配置单上游 + 模拟认证服务通过后，非流式与流式各一次完整对话。

**Acceptance Scenarios**:

1. **Given** 合法设备 token 与可用上游，**When** `POST /v1/messages`（非流式），**Then** Anthropic 兼容 message + 一条 JSONL。
2. **Given** 同上，**When** 流式，**Then** SSE 可被 SDK 解析至结束 + 流结束后一条 JSONL。

---

### User Story 2 - 未授权不得使用算力（Priority: P1）

未通过设备鉴权的请求不得触发任何大模型上游调用。

**Acceptance Scenarios**:

1. 无 `x-api-key` 且无 Bearer → **401**，无上游请求。
2. 认证服务非成功约定 → **401**，无上游请求。

---

### User Story 3 - 多上游与模型前缀路由（Priority: P2）

`model` 为 `upstreamId|modelId` 时路由到对应上游；未知 id 回落 `defaultUpstream`；无可用上游 → 权限类错误且不外发。

---

### User Story 4 - SDK 内部模型 Stub（Priority: P2）

命中 Stub 时：**不鉴权、不调上游**；非流式返回合法 message JSON；流式输出完整 SSE 闭合。**判定须与参考实现一致**（见下文「源码锚点：Stub」）。

---

### User Story 5 - 用量落盘与可选 ES 同步（Priority: P2）

真实调用写 JSONL；可选 `sync-usage-to-es` 增量写 ES，bulk 失败不静默推进断点。

---

### User Story 6 - 配置热加载（Priority: P3）

配置文件变更经 **防抖（参考实现 ~300ms）** 后生效；解析失败保留旧配置、进程不退出、监听端口不变。

---

### Edge Cases

- 流式客户端断连、上游空流、SSE 解析异常：可诊断结束，不无限阻塞。
- 多实例：进程内缓存与 JSONL 按实例；运维知晓聚合策略。

---

## Requirements *(mandatory)*

### Functional Requirements（行为）

- **FR-001**: 系统 MUST 提供 `POST /v1/messages`，语义对齐 Anthropic Messages API，支持非流式/流式、工具与思考内容（在上游能力范围内）。
- **FR-002**: 系统 MUST 完成 Anthropic ↔ OpenAI（Chat / Responses）双向转换。
- **FR-003**: 系统 MUST 按 `provider` 选择 Chat Completions 或 Responses，并执行约定清洗链（**顺序与参考实现一致**）。
- **FR-004**: 系统 MUST 支持 `upstreamId|modelId` 路由与默认上游；无可用上游时权限错误且不外发。
- **FR-005**: 真实调用前 MUST 完成外部设备认证；失败 401；用户名等写入用量。
- **FR-006**: SDK 内部模型请求 MUST Stub 短路（不鉴权、不调上游）；判定见「源码锚点：Stub」。
- **FR-007**: 系统 MUST 提供 `GET /healthz`；`count_tokens` 与 `event_logging` 为 stub，不冒充真实计费/遥测。
- **FR-008**: 每次真实调用 MUST 写 JSONL；token 以上游为准。
- **FR-009**: 系统 SHOULD 提供 ES 增量同步；bulk 失败不静默推进断点。
- **FR-010**: 配置文件 + 环境变量；防抖热加载；失败保留旧配置。
- **FR-011**: 流式 SSE 须满足 Anthropic 契约；`tool_calls` 按 index 聚合。
- **FR-012**: 单请求内 404/400 兼容重试有界；最终 Anthropic 兼容错误。
- **FR-013**: tool `extra_content`/签名：进程内有界缓存与回填；日志不脱敏敏感载荷。
- **FR-014**: 密钥、完整 token、apiKey 不得出现在非受控日志；verbose / 全文类用量字段可配置。

**验收时**：有源码则可用其做 diff；**无源码**时以上每条 MUST 与 **DESIGN 对应章节 + 附录 A/B/C** 可对照验证，并通过 **Golden 集成测试**。

### Implementation Requirements（实现硬约束）

- **IR-001**: 实现 **MUST** 使用 **TypeScript**，目标运行时 **Node.js ≥ 18**，构建产物写入 **`dist/`**，启动入口 **`node dist/index.js`**（与 `package.json` 一致）。
- **IR-002**: HTTP **MUST** 使用 Node **原生 `http`**，**禁止**引入 Express/Koa 等作为服务端框架（与参考实现一致）。
- **IR-003**: 调用上游与认证 **MUST** 使用 **全局 `fetch`**。
- **IR-004**: 模块划分 **MUST** 包含且职责等价于：`index.ts`（启动、热加载）、`proxy.ts`（路由与编排）、`config.ts`、`formatTransform.ts`、`usageLogger.ts`、`logger.ts`、`scripts/sync-usage-to-es.ts`。**不要求** `codePlanPool` / `codePlanQuota` 等 Code Plan 模块。
- **IR-005**: 配置加载顺序 **MUST** 与 `config.ts` 一致：CLI 路径 → `WOICLAW_PROXY_CONFIG` → `./proxy-config.json` → 单上游 env 模式。
- **IR-006**: 环境变量前缀 **MUST** 以参考实现为准（`WOICLAW_*`），认证成功条件：**HTTP 200、`rc === 0`、`data.name` 为非空字符串**。
- **IR-007**: `POST /v1/messages` 主链路阶段顺序 **MUST** 遵循 DESIGN §6（**跳过 Code Plan 选路阶段**）：**读 body → 解析 JSON → Stub 判定 → token → 鉴权 → 解析上游与 model → `anthropicToOpenAI` → provider 链 → API 类型与 URL → fetch → 转换与 usage**。
- **IR-008**: `provider === 'openai'` → Responses API；否则 Chat Completions（与 `resolveUpstreamAPIType` 一致）。
- **IR-009**: 流式 Chat：`delta.reasoning`/`reasoning_content` → Anthropic thinking；`delta.content` → text；`tool_calls` **按 index 聚合**。
- **IR-010**: 热加载 **MUST** 使用 `fs.watch` + **约 300ms 防抖**；失败保留旧 `ProxyRuntimeContext`（或等价快照）。

### Key Entities

- **UpstreamConfig**、**UsageRecord**、**AuthContext**、**StreamState**（逻辑实体；字段级定义见 **附录 A** 与 DESIGN）。

---

## 逻辑模块—DESIGN 章节映射（无源码时的主索引）

| 关注点 | DESIGN 章节（优先阅读） | 有源码时的同名参考 |
|--------|-------------------------|---------------------|
| 主 HTTP、流式状态机 | §5 路由、§6 主路径、**§15–§18**（Chat/Responses 流式） | `proxy.ts` |
| 协议转换 | §12、§13、§14 | `formatTransform.ts` |
| 配置与 `model` 路由 | §4 热加载、§7 | `config.ts` |
| Stub 判定 | §6 阶段 C、**§31**；**精确规则见下表** | `isClaudeAgentSdkInternalModel` |
| 用量落盘 | **§20**；**字段见附录 A** | `usageLogger.ts` |
| Provider 管道顺序 | **§9（禁止重排）**；摘要见附录 C（不含 Code Plan 项） | `handleRequest` 内链 |
| 错误与 HTTP 状态 | §22 | — |
| Body 上限与读 body | §23 | — |

**Stub 判定（须与实现一致）**：`model` 字符串 **不含** `|`；且满足正则 **`/^claude-(haiku|sonnet)-[0-9-]+$/`**。

---

## 实现基线（工程形态摘要）

| 项 | 约定 |
|----|------|
| 依赖 | `dotenv`、`@elastic/elasticsearch`（ES 脚本）；`typescript`、`@types/node` 开发依赖 |
| 脚本 | `npm run build` → `tsc`；`npm start` → `node dist/index.js`；`npm run sync-usage` → ES 同步 |
| HTTP 路由 | `GET /healthz`；`POST /v1/messages`、`/v1/messages/count_tokens`、`/api/event_logging/batch`；其余 **Anthropic 风格 404** |

**TypeScript 编译基线**（须写入仓库 `tsconfig.json`）：`target`/`lib` **ES2022**，`module` **commonjs**，`strict` **true**，`outDir` **dist**，`rootDir` **src**，`esModuleInterop` **true**，`resolveJsonModule` **true**，`declaration` **true**。

无源码时：**环境变量完整表以 `README.md` 为准**；主链路顺序以 **DESIGN §6** 为准；**歧义以 Golden 测试 + DESIGN 为准**。

---

## 附录 A：JSONL 单行字段（与 `appendUsageLog` 一致）

每行一个 JSON 对象（`usage-YYYY-MM-DD.jsonl`，可按大小滚动 `-2`、`-3`…）。字段名与类型约定：

| 字段 | 类型 | 说明 |
|------|------|------|
| `app` | string | 固定 **`woicrew`**（与当前实现一致） |
| `clientid` | string | 客户端标识 |
| `username` | string? | 认证成功后的用户名 |
| `modelid` | string | 模型 id |
| `input_token` / `output_token` | number | 来自上游 usage |
| `input_cached_token` | number | 无则 `0` |
| `start_time` / `out_time` | string | 东八区 ISO8601 格式（与实现 `formatUTC8` 一致） |
| `cost_time` | string | 秒，两位小数字符串，如 `"9.15"` |
| `request_size` / `response_size` | number? | 字节 |
| `stream` | boolean? | 是否流式 |
| `input_content` | string? | 请求摘要 JSON |
| `input_fulltext` | string? | 仅当 `WOICLAW_USAGE_LOG_INPUT_FULLTEXT` 开启 |
| `output_content` | string? | 助手输出累积摘要 |
| `session_id` | string \| null | 请求头 `X-WoiCrew-Session-Id`；无则 JSON **`null`** |
| `routing_key` | string | 上游路由标识：命中 `upstreamsById` 某 key 则写该 key，默认上游写 **`__default__`**（本规格不涉及多密钥池 id） |

---

## 附录 B：须引用的外部规范（实现时自备最新版）

- Anthropic Messages API（请求/响应/SSE）：官方文档 **Messages** 相关章节。  
- OpenAI Chat Completions（含流式 SSE）：官方兼容文档。  
- OpenAI Responses API（若走 `provider === 'openai'`）：官方 Responses 文档。  

本仓库不内嵌上述全文；**无源码交付时**接收方须自行拉取对应版本以免字段漂移。

---

## 附录 C：Provider 管道顺序（摘自 DESIGN §9，禁止随意重排）

在 `anthropicToOpenAI` 之后、发起上游 `fetch` 之前，须按 DESIGN **§9** 所列顺序执行**中与单密钥上游相关的步骤**（如内部 Claude 名重写、`resolveUpstreamAPIType`、`filterOpenAIToolsForProvider`、`remapMessageRolesForMiniMax`、`hydrateOpenAIRequestToolCalls`、max_tokens / mergeSystem、必要时转 Responses、`stream_options.include_usage` 等）。**不包含**：`ordinaryFallbackModelMap`、Ark Code Plan 固定 model、池内凭证选路等 Code Plan 专用步骤。**权威**：`docs/DESIGN-WoiClaw-Proxy.md`（阅读时跳过 §8；§9 中跳过上述 Code Plan 项）§6–§18、§20–§24、§31–§33。

---

## 附录 D：SDD 对外交付检查清单（组织内部发包用）

- [ ] `constitution.md`（本仓库 `.specify/memory/`）  
- [ ] `WoiCrew-Proxy-SDD-Functional-Spec.md`（本文件）  
- [ ] `DESIGN-WoiClaw-Proxy.md`  
- [ ] `PRD-WoiClaw-Proxy.md`  
- [ ] `README.md`  
- [ ] `proxy-config.example.json`、`.env.example`  
- [ ] `es-usage-index.md`（可选，与附录 A 二选一详略）  
- [ ] Golden / 集成测试（**强烈建议**，无源码时作仲裁）  

---

## 交付验收标准（SDD Acceptance）

满足以下条件视为 **达到本 SDD 交付目标**（可在 CI 或人工验收清单中勾选）：

1. **构建**：`npm run build` 无错误，存在 `dist/index.js`。
2. **路由**：上表 HTTP 路由与 stub 行为一致（含 404 形态）。
3. **鉴权**：无 token / 失败认证 **401** 上游零调用；成功 **200** 且 `data.name` 规则与 IR-006 一致。
4. **Stub**：`model` 匹配 `isClaudeAgentSdkInternalModel` 时无上游调用（用网络桩或 mock 验证）。
5. **主流程**：至少一条集成测试覆盖「鉴权通过 → 非流式 → JSONL 有一条」；一条覆盖「流式 → SSE 结束 → JSONL」。
6. **热加载**：合法 JSON 更新后新请求用新配置；非法 JSON 后**旧配置仍服务**。

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 认证通过且上游可用时，标准单轮对话（非流式 + 流式）Claude Agent SDK **无协议解析错误**。
- **SC-002**: **100%** 未授权主路径请求不产生上游 LLM 调用。
- **SC-003**: **100%** 真实调用在 JSONL 可追溯。
- **SC-004**: 热加载失败时服务不中断监听。
- **SC-005（交付）**: **交付验收标准** 第 1–6 项全部通过。

---

## Assumptions

- 外部认证服务契约与参考实现一致；若部署方不同，须单独补丁 spec。
- 上游能力因厂商而异；映射以参考实现尽力为准。

## Out of Scope

- 自研 token 计数取代上游 `usage`。
- 业务库持久化全量会话。
- **Code Plan 全族能力**：多编程配额密钥池、触限冷却、`codePlanBaseURL`、`codePlanCredentials`、会话粘性选 key、`ordinaryFallbackModelMap` 等与「多 key 调度」相关的能力（**本期明确不做**）。

---

## 在 Speckit 里用：除 Constitution + 本文件外还要什么？

Speckit **不会自动**把 `docs/` 下的本文件当作「当前 feature 的 spec」；它认的是 **`.specify/scripts/.../create-new-feature` 生成的** `specs/<分支号-短名>/spec.md`。因此你要二选一：

| 做法 | 说明 |
|------|------|
| **A（推荐）** | 跑 `/speckit.specify` 时，把 **本文件全文或路径**写进用户描述，让生成的 **`specs/.../spec.md`** 与本文对齐（或生成后再把本文核心段落合并进该 `spec.md`）。 |
| **B** | 手工维护 `specs/.../spec.md`，内容与本文一致；后续 `/speckit.plan` 读的是**该路径**里的 spec。 |

各命令**实际加载**关系如下：

| 步骤 | 命令 | 除 Constitution 外，你还需要准备什么 |
|------|------|--------------------------------------|
| 0 | 仓库里已有 | `.specify/templates/*`、`.cursor/commands/speckit.*`（Speckit 脚手架） |
| 1 | `/speckit.specify`（若新建 feature） | **自然语言描述**；脚本会建分支并生成 **`specs/.../spec.md`**。若「直接用本文当规格」，请把本文当输入或拷进生成的 `spec.md`。 |
| 2 | `/speckit.plan` | **`specs/.../spec.md`（FEATURE_SPEC）** + **Constitution**。要做代理级技术方案，**还必须给模型读**：**`docs/DESIGN-WoiClaw-Proxy.md`**（否则 plan 只能写空话）。可选：**`docs/PRD-WoiClaw-Proxy.md`**、`README.md`（env 表）。 |
| 3 | `/speckit.tasks` | 上一步生成的 **`plan.md`**（在同 feature 目录下）。 |
| 4 | `/speckit.implement` | **tasks** + spec + plan；实现时仍要经常对照 **DESIGN**。 |

**一句话**：在 Speckit 里「只用 Constitution + 这份 Specify 文档」——若 Specify **只以 `docs/` 里这份 md 存在、没有同步进 `specs/.../spec.md`**，**plan/tasks 会读错文件或缺 spec**。请保证 **feature 的 `spec.md` 与本文一致**，且 **plan 阶段打开 DESIGN（+ 可选 PRD/README）**。

**无源码团队额外必带**：与本文 **附录 D** 同级的交付包（**DESIGN**，阅读时**跳过 §8 Code Plan** 以与本规格一致）；否则 `/speckit.plan` 产出的实现计划易与本期范围冲突。

---

*本文件与 **Claw Proxy** Constitution（≥2.2.0）配套；`/speckit.specify` 时可将「无源码交付包」「交付验收」一并作为约束输入。*
