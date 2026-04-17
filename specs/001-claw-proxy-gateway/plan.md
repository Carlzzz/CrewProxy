# Implementation Plan: Claw Proxy（统一 LLM 代理网关）

**Branch**: `001-claw-proxy-gateway` | **Date**: 2026-04-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/001-claw-proxy-gateway/spec.md`
**基线文档**: DESIGN = `docs/DESIGN-WoiClaw-Proxy.md`；SDD = `docs/WoiCrew-Proxy-SDD-Functional-Spec.md`

## Summary

实现一个 HTTP 代理网关：对外暴露 Anthropic Messages API（`POST /v1/messages`），对内将
请求/响应转为 OpenAI 兼容格式并转发多个上游。核心能力包括外部设备鉴权、SDK 内部模型
Stub 短路、Provider 管道式清洗、Chat Completions / Responses 双流式路径、JSONL 用量落盘、
配置防抖热加载、有界兼容重试。实现严格遵循 DESIGN §2–§33 模块划分与主流程顺序。

## Technical Context

**Language/Version**: TypeScript `strict`，目标运行时 Node.js ≥ 18
**Primary Dependencies**: `dotenv`（环境变量）、`@elastic/elasticsearch`（ES 同步脚本，开发依赖）；`typescript`、`@types/node`（开发依赖）
**Storage**: 本地文件系统（JSONL 用量日志 `logs/`，按天+大小滚动）；可选 Elasticsearch（增量同步）
**Testing**: 手动集成测试 + curl/SDK 端到端验证（项目无强制测试框架）
**Target Platform**: Linux / Windows 服务端，Node.js ≥ 18
**Project Type**: HTTP 代理网关（单进程 long-running 服务）
**Performance Goals**: 单请求延迟主要取决于上游；代理自身开销 < 10ms；流式 SSE 首 token 到达后逐 chunk 转发无人为缓冲
**Constraints**: 流式读取超时 90s；请求 body ≤ 20MB；tool extra_content 缓存 ≤ 1024 条
**Scale/Scope**: 单进程；水平扩展靠外部负载均衡；代理本身无状态（进程级缓存为可选）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | 原则 | 检查项 | 状态 |
|---|------|--------|------|
| I | 技术栈与工程约束 | TypeScript strict + Node.js ≥ 18 + 原生 http + 全局 fetch + tsc → dist/ | ✅ 通过 |
| I | 模块划分 | config / formatTransform / proxy / usageLogger / logger / scripts/sync-usage-to-es 分模块；转换层不依赖编排层 | ✅ 通过 |
| I | 禁止 Web 框架 | 不使用 Express/Fastify/Koa | ✅ 通过 |
| II | 核心功能 9 项 | 路由/协议转换/鉴权/Stub/多上游/配置/用量/兼容重试/工具 全覆盖 | ✅ 通过 |
| III | 安全底线 | 密钥不入日志 + 示例配置占位 + 认证异常=失败 | ✅ 通过 |
| IV | 变更与文档先行 | plan 引用 DESIGN 主流程（§6）与流式（§15–§18） | ✅ 通过 |

**结论**: 全部通过，无需 Complexity Tracking。

## Project Structure

### Documentation (this feature)

```text
specs/001-claw-proxy-gateway/
├── plan.md              # 本文件
├── research.md          # Phase 0 研究结论
├── data-model.md        # Phase 1 数据模型
├── contracts/           # Phase 1 接口契约
│   ├── anthropic-api.md
│   └── upstream-api.md
└── quickstart.md        # Phase 1 快速开始
```

### Source Code (repository root)

```text
src/
├── index.ts              # 入口：loadConfig → createProxyServer → fs.watch 热加载
├── proxy.ts              # HTTP 路由、鉴权、上游 fetch、流式状态机、Provider 管道
├── config.ts             # JSON/env 配置解析、resolveUpstreamFromModel、校验
├── formatTransform.ts    # anthropicToOpenAI、openAIToAnthropic、URL 构建、Schema 清洗
├── usageLogger.ts        # JSONL 异步写入、按天/大小滚动
├── logger.ts             # 控制台 + proxy-*.log，VERBOSE 门控
└── scripts/
    └── sync-usage-to-es.ts  # 增量 bulk ES（独立入口）

proxy-config.example.json   # 配置示例（已有）
.env.example                # 环境变量示例（已有）
tsconfig.json               # TypeScript 编译配置（待创建）
package.json                # 依赖与脚本（待创建）
Dockerfile                  # 多阶段构建（可选，后补）
```

**Structure Decision**: 单项目平铺结构，与 DESIGN §2 仓库结构完全对齐。所有业务模块在
`src/` 下，ES 同步作为独立入口在 `src/scripts/`。无 frontend/backend 分离。

## 实现阶段与模块依赖（严格对齐 DESIGN）

### Phase 1: 工程脚手架

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| 初始化 package.json（scripts: build/start/sync-usage） | `package.json` | — | §34 |
| 创建 tsconfig.json（target ES2022, module commonjs, strict, outDir dist） | `tsconfig.json` | — | SDD 实现基线 |
| 安装依赖（dotenv, @elastic/elasticsearch, typescript, @types/node） | — | package.json | — |

### Phase 2: 基础设施模块（无业务依赖）

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| logger — VERBOSE 门控 + 控制台输出 | `src/logger.ts` | — | §26 |
| config — JSON/env 加载 + resolveUpstreamFromModel + 校验 | `src/config.ts` | logger | §4, §7 |

### Phase 3: 协议转换（独立于编排层）

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| anthropicToOpenAI（含 convertMessageToOpenAI, cleanSchema, retainOnlyLastSyntheticImagePair） | `src/formatTransform.ts` | — | §12, §33 |
| openAIToAnthropic（非流式完整响应转换） | `src/formatTransform.ts` | — | §13 |
| URL 构建（buildOpenAIChatCompletionsURL, buildOpenAIResponsesURL, buildUpstreamTargetUrls） | `src/formatTransform.ts` | — | §10 |
| Responses 请求构造（convertChatCompletionsRequestToResponsesRequest） | 可放 `proxy.ts` 或 `formatTransform.ts` | — | §14 |
| Responses 响应逆转（convertResponsesToOpenAIResponse） | 同上 | — | §14 |

### Phase 4: 用量日志

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| appendUsageLog — 异步 JSONL 写入 + 按天/大小滚动 | `src/usageLogger.ts` | logger | §20 |
| buildTrimmedInputContentForUsageLog + extractOutputContent + extractCachedInputTokensFromUsage | `src/usageLogger.ts` 或 `proxy.ts` | — | §20.3, §30.2 |

### Phase 5: HTTP 编排与主流程（核心）

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| createProxyServer + HTTP 路由分支（healthz / count_tokens / event_logging / messages / 404） | `src/proxy.ts` | config, logger | §5 |
| readRequestBody（20MB 上限） | `src/proxy.ts` | — | §23 |
| isClaudeAgentSdkInternalModel + sendSdkInternalStubResponse（流式 + 非流式） | `src/proxy.ts` | — | §31 |
| extractClientApiKey + fetchUserInfo（外部认证） | `src/proxy.ts` | config, logger | §21 |
| handleRequest 主链路：body → JSON → Stub → token → auth → resolve → convert → pipeline → fetch → response | `src/proxy.ts` | formatTransform, config, usageLogger, logger | §6 |
| Provider 管道（10 步，顺序禁止重排，见 spec 附录 C） | `src/proxy.ts` | formatTransform | §9 |
| createAnthropicErrorBody + 错误状态码映射 | `src/proxy.ts` | — | §22 |
| 404 链式重试（targetURLs > 1 时） | `src/proxy.ts` | — | §10.4 |
| 400 自动修复重试（stripTools / convertMaxTokens / clamp） | `src/proxy.ts` | — | §11 |

### Phase 6: 流式路径

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| handleChatCompletionsStreamResponse — SSE 读取循环 + readWithTimeout + 客户端断连检测 | `src/proxy.ts` | usageLogger | §15 |
| processOpenAIChunk — 流式核心（thinking/text/tool_calls 按 index 聚合 + usage 合并） | `src/proxy.ts` | — | §16 |
| ensureThinkingBlock / ensureTextBlock / ensureToolUseBlock / emitMessageDelta | `src/proxy.ts` | — | §32 |
| normalizeChunkUsage + mergeUsageIntoState（Math.max 策略） | `src/proxy.ts` | — | §30.1 |
| flushDone — 补 content_block_stop + message_stop | `src/proxy.ts` | — | §15.4 |
| handleResponsesStreamResponse + processResponsesStreamEvent（Responses 流式路径） | `src/proxy.ts` | usageLogger | §18 |
| tool extra_content 缓存与回填（toolCallExtraContentById, FIFO ≤ 1024） | `src/proxy.ts` | — | §19 |

### Phase 7: 启动与热加载

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| index.ts — loadConfig → buildUpstreamsByIdMap → createProxyServer → listen | `src/index.ts` | config, proxy, logger | §4.1 |
| fs.watch + 300ms 防抖 + 热加载失败保留旧 ctx | `src/index.ts` | config | §4.2 |

### Phase 8: ES 同步（独立入口，可后置）

| Task | 文件 | 依赖 | 对应 DESIGN |
|------|------|------|-------------|
| sync-usage-to-es — JSONL 增量读取 + bulk + 断点 + RUN_ONCE 模式 | `src/scripts/sync-usage-to-es.ts` | @elastic/elasticsearch | §24 |

### Phase 9: 收尾

| Task | 文件 | 依赖 |
|------|------|------|
| 端到端验证：非流式对话 + 流式对话 + 鉴权失败 + Stub | — | 全部 |
| 交付验收标准 6 项逐条检查 | — | — |

## 模块依赖图

```text
index.ts
├── config.ts
├── proxy.ts
│   ├── formatTransform.ts   ← 转换层（不得反向依赖 proxy）
│   ├── config.ts            ← 仅 resolveUpstreamFromModel + 类型
│   ├── usageLogger.ts
│   └── logger.ts
└── logger.ts

scripts/sync-usage-to-es.ts  ← 独立入口，仅依赖 dotenv + @elastic/elasticsearch
```

## Complexity Tracking

> 无违反宪章之设计，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| （无） | — | — |
