# Tasks: Claw Proxy（统一 LLM 代理网关）

**Input**: Design documents from `specs/001-claw-proxy-gateway/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, contracts/, research.md, quickstart.md

**Tests**: 本项目无强制测试框架，不生成自动化测试任务。端到端验证在 Polish 阶段以 curl 手动执行。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/` at repository root
- Entry point: `src/index.ts` → build to `dist/index.js`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 工程脚手架——package.json、tsconfig.json、依赖安装

- [x] T001 创建 `package.json`：name/version/scripts（build=tsc, start=node dist/index.js, sync-usage=node dist/scripts/sync-usage-to-es.js）+ dependencies（dotenv）+ devDependencies（typescript, @types/node, @elastic/elasticsearch）
- [x] T002 创建 `tsconfig.json`：target ES2022, module commonjs, strict true, outDir dist, rootDir src, esModuleInterop true, resolveJsonModule true, declaration true, skipLibCheck true
- [x] T003 运行 `npm install` 安装所有依赖并验证 `npx tsc --version` 正常

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有 User Story 共享的基础模块，MUST 在任何 User Story 之前完成

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 [P] 实现 `src/logger.ts`：导出 logger 对象（info/warn/error/verbose），VERBOSE 由 `WOICLAW_PROXY_VERBOSE` 环境变量门控，格式含时间戳；参考 DESIGN §26
- [x] T005 [P] 实现 `src/config.ts` — 类型定义：导出 `UpstreamConfig`（baseURL/apiKey/model/provider）、`ProxyConfig`（port/host/defaultUpstream/upstreamsById）、`ProxyRuntimeContext`（upstreamsByIdMap: Map/defaultUpstream）接口；参考 data-model.md
- [x] T006 实现 `src/config.ts` — 配置加载：`loadConfig(configPathArg?)`，加载顺序 CLI → WOICLAW_PROXY_CONFIG env → ./proxy-config.json → 单上游 env 模式（UPSTREAM_BASE_URL/API_KEY/MODEL/PROVIDER）；失败抛错；normalizeUpstream 清洗；`buildUpstreamsByIdMap(config)` → ProxyRuntimeContext；参考 DESIGN §4, §7, IR-005
- [x] T007 实现 `src/config.ts` — 上游解析：`resolveUpstreamFromModel(modelStr, upstreamsByIdMap, defaultUpstream)` → `{ upstream, modelId, upstreamRouteId }` 或 null；处理 `upstreamId|modelId` 拆分、未命中回落 defaultUpstream、无 `|` 用 default；参考 DESIGN §7
- [x] T008 [P] 实现 `src/formatTransform.ts` — Anthropic→OpenAI 请求转换：`anthropicToOpenAI(body)` 含 system 展开、`convertMessageToOpenAI`（text/image/tool_use/tool_result 多段展开）、`cleanSchema`（删 $schema/format:uri）、`retainOnlyLastSyntheticImagePair`、tools 过滤 BatchTool + 转 function 形态、stop_sequences→stop；参考 DESIGN §12, §33
- [x] T009 [P] 实现 `src/formatTransform.ts` — OpenAI→Anthropic 响应转换：`openAIToAnthropic(openAIResponse)` 非流式完整响应，reasoning_content→thinking、content→text、tool_calls→tool_use（input JSON.parse 失败={}）、usage 映射（prompt_tokens/input_tokens→input_tokens 等）、`mapStopReason`；参考 DESIGN §13
- [x] T010 [P] 实现 `src/formatTransform.ts` — URL 构建：`buildOpenAIChatCompletionsURL(baseURL)`（处理尾斜杠/v1/Gemini 域名特殊路径）、`buildOpenAIResponsesURL(baseURL)`、`buildUpstreamTargetUrls(baseURL, upstreamAPIType, provider)`（Chat 含 Gemini v1beta/v1 候选，Set 去重）；参考 DESIGN §10
- [x] T011 [P] 实现 `src/usageLogger.ts`：`appendUsageLog(clientid, modelid, start_time, input_token, output_token, extra?)` 异步写入 JSONL（setImmediate）；文件路径 `logs/usage-YYYY-MM-DD.jsonl`（东八区日期）；按大小滚动（WOICLAW_USAGE_LOG_MAX_BYTES，默认 100MB）→ `-2`/`-3` 后缀；`formatUTC8` 时间格式化；参考 DESIGN §20, spec 附录 A
- [x] T012 实现 `src/proxy.ts` — 错误体与辅助：`createAnthropicErrorBody(message, type)` → `{ type: "error", error: { type, message } }`；`formatSSEEvent(event, data)` → `event: ...\ndata: ...\n\n`；参考 DESIGN §22, contracts/anthropic-api.md
- [x] T013 实现 `src/proxy.ts` — HTTP 服务与路由骨架：`createProxyServer(ctx, ...)` 使用原生 `http.createServer`；路由分支 GET /healthz → 200 `{ok:true}`、POST /v1/messages/count_tokens → 消费 body + 200 `{input_tokens:0}`、POST /api/event_logging/batch → 消费 body + 204、POST /v1/messages → handleRequest、其余 → 404 Anthropic not_found_error；参考 DESIGN §5, FR-007

**Checkpoint**: Foundation ready — logger/config/formatTransform/usageLogger/proxy 骨架均可编译通过

---

## Phase 3: User Story 1+2 — 核心对话 + 鉴权 (Priority: P1) 🎯 MVP

**Goal**: Agent 经网关完成一次完整对话（非流式+流式），未授权请求被 401 拦截

**Independent Test**: 配置单上游 + 认证服务，curl 发非流式/流式请求验证 Anthropic 兼容响应 + JSONL 记录；无 token 请求验证 401

### Implementation

- [x] T014 [US1] 实现 `src/proxy.ts` — `readRequestBody(req)`：累积 Buffer[]，超 MAX_REQUEST_BODY_BYTES(20MB) 则 reject + req.destroy；参考 DESIGN §23
- [x] T015 [US2] 实现 `src/proxy.ts` — 认证：`extractClientApiKey(req)` 从 x-api-key 或 Authorization: Bearer 提取 token（空返回 null）；`fetchUserInfo(token)` 调用 `${WOICLAW_AUTH_HOST}${WOICLAW_AUTH_USER_PATH}?deviceId=${encodeURIComponent(token)}`，成功条件 HTTP 200 + rc===0 + data.name 非空字符串，失败返回 null → 401；参考 DESIGN §21, IR-006
- [x] T016 [US1] 实现 `src/proxy.ts` — `handleRequest` 主链路（非流式路径）：readBody → JSON.parse → extractClientApiKey（空→401）→ fetchUserInfo（null→401）→ resolveUpstreamFromModel（null→403）→ `anthropicToOpenAI` → Provider 管道 10 步（见 T017）→ 构建 targetURLs → fetch → openAIToAnthropic → appendUsageLog → 返回 JSON；参考 DESIGN §6, IR-007
- [x] T017 [US1] 实现 `src/proxy.ts` — Provider 管道：在 anthropicToOpenAI 之后 fetch 之前按固定顺序执行（禁止重排）：1.设置 model → 2.内部 Claude 名重写 → 3.`resolveUpstreamAPIType`(openai→responses,其余→chat_completions) → 4.`filterOpenAIToolsForProvider`(openai 过滤 skill) → 5.`remapMessageRolesForMiniMax`(minimax developer→system) → 6.`hydrateOpenAIRequestToolCalls`(缓存回填) → 7.`normalizeMaxTokensFieldForOpenAIProvider`(chat+openai 新模型 max_tokens→max_completion_tokens) → 8.`mergeSystemMessagesForProvider`(chat 合并多 system) → 9.若 responses `convertChatCompletionsRequestToResponsesRequest` → 10.若流式+chat `stream_options.include_usage=true`；参考 DESIGN §9, spec 附录 C
- [x] T018 [US1] 实现 `src/proxy.ts` — Responses 请求/响应转换：`convertChatCompletionsRequestToResponsesRequest(openAIRequest)` 将 Chat 形态 messages/tools/tool_choice 转为 Responses input 结构；`convertResponsesToOpenAIResponse(responsesBody)` 合成伪 Chat 响应再走 openAIToAnthropic 复用逻辑；参考 DESIGN §14
- [x] T019 [US1] 实现 `src/proxy.ts` — Chat Completions 流式路径：`handleChatCompletionsStreamResponse` — writeHead(200, text/event-stream)、getReader+TextDecoder+buffer、按 `\n\n` 切 SSE packet、收集 data: 行拼 payload、[DONE]→flushDone、否则 JSON.parse→processOpenAIChunk；`readWithTimeout(reader, timeoutMs=90000)` + 客户端断连检测（req/res close → abortSignal + setInterval 500ms 轮询）；参考 DESIGN §15
- [x] T020 [US1] 实现 `src/proxy.ts` — `processOpenAIChunk`：ensureMessageStart（首次 id/model→message_start）→ normalizeChunkUsage→mergeUsageIntoState（Math.max 策略）→ delta.reasoning_content/reasoning→ensureThinkingBlock+thinking_delta → delta.content→ensureTextBlock+text_delta → delta.tool_calls[]→按 index 聚合 ensureToolUseBlock+input_json_delta → finish_reason→emitMessageDelta(stop_reason+usage)；参考 DESIGN §16
- [x] T021 [US1] 实现 `src/proxy.ts` — 流式块管理：`ensureThinkingBlock`/`ensureTextBlock`/`ensureToolUseBlock`（切换类型前 closeCurrentBlockIfNeeded→content_block_stop+contentIndex++）、`emitMessageDelta`（message_delta+stop_reason+usage）、`flushDone`（补 content_block_stop+message_stop 若已开始）；参考 DESIGN §32, §15.4
- [x] T022 [US1] 实现 `src/proxy.ts` — 流式 usage 合并：`normalizeChunkUsage(chunk)` 从 chunk 提取 usage（prompt_tokens/input_tokens/completion_tokens/output_tokens）；`mergeUsageIntoState(state, usage)` 用 Math.max 合并 input_tokens/output_tokens/input_cached_token；`extractCachedInputTokensFromUsage(usage)` 依次查 input_token_details/prompt_tokens_details/cached_tokens 等多种字段名；参考 DESIGN §30
- [x] T023 [US1] 实现 `src/proxy.ts` — Responses 流式路径：`handleResponsesStreamResponse` + `processResponsesStreamEvent`；解析 OpenAI Responses SSE（response.output_text.delta / response.completed 等），通过 ResponsesStreamContext 维护 function call outputIndex/callId/argumentsBuffer；参考 DESIGN §18
- [x] T024 [US1] 实现 `src/proxy.ts` — tool extra_content 缓存：模块级 `toolCallExtraContentById: Map<string, unknown>`，MAX_TOOL_CALL_EXTRA_CONTENT_CACHE=1024；`cacheToolCallExtraContent`（FIFO 淘汰：超出删 map.keys().next().value）；`normalizeToolCallExtraContent`；在 `hydrateOpenAIRequestToolCalls` 中回填（已有→跳过 / Map 取缓存 / isGemini→GEMINI_FALLBACK_THOUGHT_SIGNATURE 占位）；参考 DESIGN §19
- [x] T025 [US1] 实现 `src/proxy.ts` — usage 辅助：`buildTrimmedInputContentForUsageLog(upstreamRequest)` → JSON 字符串（model/tail_role/tail_preview 截断 WOICLAW_USAGE_LOG_TAIL_PREVIEW_MAX）；`extractOutputContentFromAnthropicResponse` 非流式提取（仅 text+thinking 无 tool_use）；参考 DESIGN §20.3
- [x] T026 [US1] 实现 `src/index.ts` — 启动入口：`require('dotenv').config()` → `loadConfig(process.argv[2])` → `buildUpstreamsByIdMap` → `createProxyServer(ctx, ...)` → `server.listen(port, host)` → 打印启动信息；参考 DESIGN §4.1
- [x] T027 [US1] 验证 `npm run build` 无错误，`node dist/index.js` 可启动，curl healthz/非流式/流式均正常

**Checkpoint**: MVP 就绪——单上游非流式+流式对话 + 鉴权 401 + JSONL 用量记录

---

## Phase 4: User Story 3 — 多上游与模型前缀路由 (Priority: P2)

**Goal**: `model` 字段的 `upstreamId|modelId` 前缀路由到不同上游

**Independent Test**: 配置多上游（deepseek/ali），分别以前缀/无前缀/未知前缀发请求验证路由

### Implementation

- [x] T028 [US3] 扩展 `src/config.ts` — 验证 `resolveUpstreamFromModel` 正确处理：`deepseek|deepseek-chat` 命中→用 deepseek 上游 + modelId；`unknown|gpt-4o` 未命中→回落 default + modelId；无 `|`→用 default；无 default 且未命中→返回 null(403)；参考 DESIGN §7
- [x] T029 [US3] 验证 `src/proxy.ts` — handleRequest 中 routing_key 正确写入 JSONL：命中 upstreamsById 写 key 名，defaultUpstream 写 `__default__`

**Checkpoint**: 多上游路由正常，JSONL routing_key 字段正确

---

## Phase 5: User Story 4 — SDK 内部模型 Stub (Priority: P2)

**Goal**: SDK 自检 model（如 claude-haiku-4-5-20251001）被短路返回，不触发鉴权和上游

**Independent Test**: curl 发 `model: claude-haiku-4-5-20251001`（无 token），验证成功返回 stub JSON 且无上游调用

### Implementation

- [x] T030 [US4] 实现 `src/proxy.ts` — `isClaudeAgentSdkInternalModel(model)`: model 不含 `|` 且匹配正则 `^claude-(haiku|sonnet)-[0-9-]+$`；参考 DESIGN §31
- [x] T031 [US4] 实现 `src/proxy.ts` — `sendSdkInternalStubResponse(req, res, parsedBody)`: 非流式→返回合法 Anthropic JSON message（固定 model/id/content）；流式→SSE 头 + message_start + content_block_start + text_delta(空或占位) + content_block_stop + message_delta + message_stop；参考 DESIGN §31
- [x] T032 [US4] 在 `handleRequest` 中阶段 C（JSON.parse 之后、auth 之前）插入 Stub 判定：`isClaudeAgentSdkInternalModel(model)` 为 true 则调用 sendSdkInternalStubResponse 并 return（不鉴权、不调上游、不记用量）

**Checkpoint**: SDK 内部 model stub 正常返回，无鉴权/上游/用量

---

## Phase 6: User Story 5 — 用量落盘细节与 ES 同步 (Priority: P2)

**Goal**: JSONL 字段完整符合 spec 附录 A；可选 ES 增量同步

**Independent Test**: 检查 JSONL 每行字段完整；运行 `RUN_ONCE=1 npm run sync-usage` 验证 ES 写入

### Implementation

- [x] T033 [US5] 完善 `src/usageLogger.ts` — 确保 JSONL 字段完整：app(固定 woicrew)、clientid、username、modelid、input_token/output_token/input_cached_token、start_time/out_time(formatUTC8)、cost_time(两位小数字符串)、request_size/response_size(字节)、stream(boolean)、input_content/output_content/input_fulltext(可选)、session_id(X-WoiCrew-Session-Id 或 null)、routing_key；参考 spec 附录 A
- [x] T034 [US5] 实现 `src/scripts/sync-usage-to-es.ts`：require dotenv、读 WOICLAW_LOG_DIR 下所有 usage-*.jsonl 排序；断点 `USAGE_SYNC_STATE_DIR/usage-sync-state.json`（lastFile + lastLineNumber）；逐行 JSON.parse + bulk 写 ES；_id = sha256(app+clientid+start_time+modelid) 前 32 位；任一项失败不保存断点；打印 ES 节点/索引/每批结果；RUN_ONCE 模式跑一次退出，否则每 10 分钟循环；参考 DESIGN §24
- [x] T035 [US5] 验证 JSONL 文件滚动：手动或脚本将 WOICLAW_USAGE_LOG_MAX_BYTES 设为小值，确认超限后自动切到 `-2` 后缀

**Checkpoint**: JSONL 字段完整 + 按天/大小滚动 + ES 同步可用

---

## Phase 7: User Story 6 — 配置热加载 (Priority: P3)

**Goal**: 修改 proxy-config.json 后 ~300ms 自动生效，解析失败保留旧配置

**Independent Test**: 运行中修改配置文件上游地址，等待后发新请求验证走新上游

### Implementation

- [x] T036 [US6] 实现 `src/index.ts` — fs.watch 热加载：监视 configFilePath；300ms setTimeout 防抖（clearTimeout+重设）；回调中 loadConfig → buildUpstreamsByIdMap → 替换 ctx.upstreamsByIdMap 和 ctx.defaultUpstream；解析失败 logger.error 保留旧 ctx 不退出；热加载不改 server.listen 的端口；参考 DESIGN §4.2, IR-010
- [x] T037 [US6] 验证热加载：启动后修改 JSON（合法→新配置生效、非法→旧配置保留、改 port→端口不变）

**Checkpoint**: 热加载正常——合法更新生效，非法保持旧配，端口不变

---

## Phase 8: User Story 7 — 上游兼容性与有界重试 (Priority: P3)

**Goal**: 单请求内自动处理上游 404/400，有界重试不改变业务语义

**Independent Test**: 配置 Gemini 上游（可产生 404 URL），验证自动尝试备选 URL

### Implementation

- [x] T038 [US7] 实现 `src/proxy.ts` — 404 链式重试：handleRequest 中 `targetURLs.length > 1` 且首响应 404 时，依次换 URL 重发同一 payload；参考 DESIGN §10.4
- [x] T039 [US7] 实现 `src/proxy.ts` — 400 自动修复重试（仅 Chat + 400）：1.`isToolsUnsupportedError`→`stripToolsFromRequest`→重发 2.`isMaxTokensUnsupportedError`→`convertMaxTokensToMaxCompletionTokens`→重发 3.`clampMaxTokensFromError`→重发；若最终仍失败返回 Anthropic 错误体（createAnthropicErrorBody + 透传 upstream status）；参考 DESIGN §11
- [x] T040 [US7] 验证重试：curl 发含 tools 的请求到不支持 tools 的上游，确认自动去除 tools 后成功

**Checkpoint**: 有界重试正常——404 换 URL、400 自动修复、最终失败返回 Anthropic 错误

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: 端到端验证、安全审查、文档收尾

- [x] T041 端到端验证：按 quickstart.md 步骤完整执行一遍（healthz → stub → 非流式 → 流式 → 多上游路由）
- [x] T042 安全审查：grep 全部 logger 调用确认无密钥/完整 token/apiKey 泄露；确认 proxy-config.example.json 仅占位值；确认认证异常一律 401
- [x] T043 [P] 验证交付验收标准 6 项：1.构建无错 2.路由正确 3.鉴权拦截 4.Stub 正常 5.主流程+JSONL 6.热加载
- [x] T044 [P] 确认 `npm run build` 在 clean 状态（删 dist/）下无错误无警告

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1+US2 (Phase 3)**: Depends on Foundational — delivers MVP
- **US3 (Phase 4)**: Depends on Phase 3（handleRequest 已实现）
- **US4 (Phase 5)**: Depends on Phase 3（插入 handleRequest 阶段 C）
- **US5 (Phase 6)**: Depends on Phase 3（usageLogger 在 Phase 2 已有骨架，此处完善字段 + ES 脚本）
- **US6 (Phase 7)**: Depends on Phase 3（index.ts 在 T026 已有骨架，此处增加 fs.watch）
- **US7 (Phase 8)**: Depends on Phase 3（扩展 handleRequest 的 fetch 后逻辑）
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1+US2 (P1)**: Foundational 完成后即可开始 — MVP 核心
- **US3 (P2)**: 可在 Phase 3 完成后开始 — 扩展 resolveUpstreamFromModel 验证
- **US4 (P2)**: 可在 Phase 3 完成后开始 — 在 handleRequest 中插入 Stub 判定
- **US5 (P2)**: 可在 Phase 3 完成后开始 — 完善 JSONL 字段 + ES 脚本
- **US6 (P3)**: 可在 Phase 3 完成后开始 — 在 index.ts 增加 fs.watch
- **US7 (P3)**: 可在 Phase 3 完成后开始 — 扩展 handleRequest 的错误处理

### Within Each User Story

- 同一文件的任务按顺序执行
- 不同文件的 [P] 任务可并行

### Parallel Opportunities

- Phase 2 中 T004/T005/T008/T009/T010/T011 可并行（不同文件）
- Phase 3 完成后，US3/US4/US5/US6/US7 可并行（改不同逻辑区域，但都涉及 proxy.ts 需注意合并）
- Phase 9 中 T043/T044 可并行

---

## Parallel Example: Foundational Phase

```bash
# 不同文件，可同时开工：
Task: "T004 实现 src/logger.ts"
Task: "T005 实现 src/config.ts — 类型定义"
Task: "T008 实现 src/formatTransform.ts — Anthropic→OpenAI"
Task: "T009 实现 src/formatTransform.ts — OpenAI→Anthropic"
Task: "T010 实现 src/formatTransform.ts — URL 构建"
Task: "T011 实现 src/usageLogger.ts"
```

---

## Implementation Strategy

### MVP First (US1+US2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: US1+US2
4. **STOP and VALIDATE**: curl 非流式 + 流式 + 401 + JSONL 检查
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1+US2 → Test → **MVP 可交付**
3. US4 (Stub) → SDK 可正常初始化
4. US3 (多上游) → 运维可配置多厂商
5. US5 (用量完善+ES) → 可观测性就位
6. US6 (热加载) → 运维免重启
7. US7 (兼容重试) → 多厂商稳定性
8. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1 和 US2 合并为 Phase 3 因为鉴权是 handleRequest 主链路的内置步骤，无法独立交付
- proxy.ts 是最大文件（路由+编排+流式），多个 US 都在此文件增量扩展
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
