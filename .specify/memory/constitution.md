<!--
Sync Impact Report
===================
Version change: N/A → 1.0.0 (initial)
Modified principles: N/A (first version)
Added sections:
  - Core Principles: I. 技术栈与工程约束, II. 核心功能, III. 安全底线, IV. 变更与文档先行
  - Governance
Removed sections: N/A
Templates requiring updates:
  - .specify/templates/plan-template.md        ✅ compatible (generic "Constitution Check" section)
  - .specify/templates/spec-template.md         ✅ compatible (generic requirements structure)
  - .specify/templates/tasks-template.md        ✅ compatible (generic task phases)
Follow-up TODOs: none
-->

# Claw Proxy Constitution

## Core Principles

### I. 技术栈与工程约束

Claw Proxy 是面向 Claude Agent SDK 等客户端的 HTTP 网关，对外暴露 Anthropic Messages API，
对内将请求/响应转为 OpenAI 兼容格式（Chat Completions / Responses）并转发上游。
产品名可随组织调整；环境变量前缀在 README/规格中统一即可（如 `CLAW_PROXY_*`）。

| 项 | 约定 |
|----|------|
| 运行时 | **Node.js ≥ 18** |
| 语言 | **TypeScript**，`strict` 模式 |
| 构建 | `tsc` → 输出 **`dist/`**，入口 **`node dist/index.js`** |
| HTTP 服务 | **原生 `http` 模块**，**不得**使用 Express / Fastify 等 Web 框架承载主服务 |
| 出站请求 | **全局 `fetch`**（上游 LLM、外部认证） |
| 依赖 | 以 `package.json` 为准；典型含 `dotenv`；ES 同步脚本可用 `@elastic/elasticsearch` |
| 模块划分 | **配置**、**协议转换**（Anthropic ↔ OpenAI）、**HTTP 编排**（鉴权、选路、流式状态机、错误与重试）、**用量 JSONL**、**日志** 分模块；**转换层不得依赖编排层**（避免循环依赖） |

细节（主流程顺序、Provider 清洗链、流式状态机、JSONL 字段）以**详设 + 功能规格**为准，
不在本宪章展开。

### II. 核心功能

以下功能 MUST 实现——具体字段、流式协议与 Provider 行为以详设/功能规格为准：

1. **路由**：`POST /v1/messages` 为主入口；`GET /healthz`；`count_tokens` / `event_logging`
   为 **Stub**（不冒充真实计费/遥测）；其余未知路径返回 Anthropic 风格错误。
2. **协议转换**：请求 Anthropic → OpenAI；响应 OpenAI → Anthropic（含流式 SSE）；
   按 `provider` 区分 Chat Completions 与 Responses（仅 `openai` 类走 Responses，以详设为准）。
3. **鉴权**：真实模型调用前完成外部设备认证（`x-api-key` / Bearer）；
   失败 **401**，**不得**请求上游。
4. **内部模型 Stub**：SDK 自检用内部 `model` MUST **先于鉴权与上游**短路（规则见规格/详设），
   **不得**记真实业务用量。
5. **多上游**：通过 `model` 的 `upstreamId|modelId` 等形式选上游与默认上游（规则见详设）。
6. **配置**：JSON 文件 + 环境变量；支持**防抖热加载**；失败**保留旧配置**；
   热加载**不得**改监听端口。
7. **用量**：每次真实调用写 **JSONL**（或等价）；token 数**以上游 `usage` 为准**；
   可选 **ES 增量同步**（失败不静默丢断点）。
8. **上游兼容**：单请求内 **404 候选 URL / 400 自动修复**等**有界**重试，不改变业务语义。
9. **工具**：`tool_calls` 按 index 聚合；必要时 `extra_content`/签名：
   进程内**有界缓存**与回填。

### III. 安全底线

- 密钥、完整 token、完整 apiKey **不得**写入非受控日志。
- 示例配置文件仅使用占位值。
- 认证服务异常 MUST 按**失败**处理（返回 401，不转发上游）。

### IV. 变更与文档先行

- 对外行为与详设/规格冲突时，**先改文档再改代码**（或同时提交）。
- 使用 Speckit 时：**功能规格** + **详设**为实现依据；`/speckit.plan` MUST 引用
  详设中的主流程与流式章节。

## Governance

- 本宪章是 Claw Proxy 项目的最高工程准则；所有 PR / Code Review MUST 验证合规。
- 修订流程：提出变更 → 文档化 → 审批 → 更新宪章版本 → 同步依赖模板。
- 版本策略：MAJOR（不兼容的原则删除/重定义）、MINOR（新增原则或实质扩展）、
  PATCH（措辞、排版等非语义修改）。
- 复杂度 MUST 有合理理由；无法通过宪章检查的设计需在 plan.md 的
  "Complexity Tracking" 中记录违规与理由。

**Version**: 1.0.0 | **Ratified**: 2026-04-13 | **Last Amended**: 2026-04-13
