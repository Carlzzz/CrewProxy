# Research: Claw Proxy

**Feature**: 001-claw-proxy-gateway
**Date**: 2026-04-13

## 概述

本项目技术栈与架构由 Constitution + SDD + DESIGN 文档完全定义，无需外部技术选型研究。
以下记录每项决策及其来源文档依据。

---

## R1: HTTP 服务框架

**Decision**: 使用 Node.js 原生 `http.createServer`，不引入任何 Web 框架。
**Rationale**: Constitution 原则 I 明确禁止 Express/Fastify/Koa。原生 http 模块对代理场景
足够，且减少依赖表面积。
**Alternatives considered**: Express（被 Constitution 禁止）、Fastify（同上）。

## R2: 出站 HTTP 客户端

**Decision**: 使用全局 `fetch`（Node.js ≥ 18 内置）。
**Rationale**: Constitution 原则 I 明确要求全局 fetch；Node 18+ 原生支持，无需 `node-fetch`。
**Alternatives considered**: `node-fetch`（多余依赖）、`axios`（同上）、`undici`（fetch 底层，但直接用 fetch 更简洁）。

## R3: 流式 SSE 解析策略

**Decision**: 手工逐行 buffer + `\n\n` 分包，不使用 EventSource 库。
**Rationale**: DESIGN §15 详细定义了 `readWithTimeout` + `TextDecoder` + buffer 分包逻辑；
代理需要逐 chunk 转换并转发（不能等整流完成），EventSource 库不提供此级别控制。
**Alternatives considered**: `eventsource`（不支持 POST）、`sse.js`（不支持自定义超时与中断检测）。

## R4: 配置热加载机制

**Decision**: `fs.watch` + 300ms 防抖（`setTimeout` + `clearTimeout`）。
**Rationale**: DESIGN §4 明确此实现方式。`fs.watch` 为 Node 内置，无需额外依赖。
防抖避免编辑器连续写入触发多次加载。
**Alternatives considered**: `chokidar`（过重，Constitution 倾向最小依赖）、轮询（延迟高）。

## R5: JSONL 写入策略

**Decision**: 异步写入（`setImmediate` + `fs.appendFileSync` 或 `fs.promises.appendFile`），
按天 + 按大小滚动。
**Rationale**: DESIGN §20 要求不阻塞响应收尾。按天滚动便于按日聚合；按大小滚动避免单文件
过大（默认 100MB）。
**Alternatives considered**: 写入队列 + batch flush（增加复杂度，当前规模不需要）。

## R6: Elasticsearch 同步

**Decision**: 独立入口脚本（`sync-usage-to-es.ts`），使用 `@elastic/elasticsearch` 官方客户端，
断点文件（`usage-sync-state.json`），bulk API，失败不推进。
**Rationale**: DESIGN §24 与 SDD FR-009 定义。独立进程避免影响代理主流程。
**Alternatives considered**: 嵌入代理进程（违反关注点分离）、Logstash（过重）。

## R7: TypeScript 编译配置

**Decision**: `target: ES2022`、`module: commonjs`、`strict: true`、`outDir: dist`、
`rootDir: src`、`esModuleInterop: true`、`resolveJsonModule: true`、`declaration: true`。
**Rationale**: SDD 实现基线明确指定。ES2022 覆盖 top-level await、`Array.at()` 等；
commonjs 与 Node.js 默认模块系统兼容。
**Alternatives considered**: ESM（Node ESM 生态仍有兼容性问题，且 dotenv 等依赖更兼容 CJS）。

## R8: Provider 管道设计模式

**Decision**: 在 `handleRequest` 内按固定顺序调用 10 个转换函数（spec 附录 C），不抽象为
管道/中间件模式。
**Rationale**: DESIGN §9 明确禁止重排顺序，且函数间存在隐式依赖（如 `mergeSystemMessages`
必须在 model 重写之后）。函数式链比 OOP 管道更直观、更不易误排。
**Alternatives considered**: 责任链模式（顺序约束难以在类型系统中表达）。

---

**结论**: 所有技术决策均由规范文档直接定义或强烈暗示，无 NEEDS CLARIFICATION 剩余。
