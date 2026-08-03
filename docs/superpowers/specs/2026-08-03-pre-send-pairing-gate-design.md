# 梯度 4:CrewProxy 发送前配对闸门(收窄版)— 设计文档

日期:2026-08-03
仓库:CrewProxy(单仓)
系列:两层裁剪衔接优化梯度 4 / 4(收官)

## 背景与问题

本次 bug(`tool id(call_x) not found`)的根因之一:CrewProxy 的 tool 配对清理**只在 trim 触发时才跑**。

- `trimToFitBudget` / `aggressiveTrimForRetry` 内部各自清理孤儿;梯度里新增的 `stripOrphanedToolResults`(`src/contextBudget.ts:423`)也只挂在这两条 trim 路径上。
- **不 trim 就完全不校验配对**。若一个孤儿 `tool_result`(其父 `tool_use` 不在请求里)由客户端传来、且请求未超预算(不触发 trim),CrewProxy 会**原样转发给上游 → 上游 400 "tool id not found"**。

前面的梯度修复(trim 路径加 stripOrphaned、非 token 400 立即透传)缓解了 trim 场景,但没堵住"不 trim 时孤儿直接透传"这个剩余入口。

## 为什么不做"共享配对契约"

原梯度 4 设想是把配对逻辑抽成两仓共享的权威实现。探索否决了这条路:

- **AmbiCrew `ensureToolResultPairing`**(`src/utils/messages.ts:5133`,300+ 行):修复导向 —— 插合成占位符、处理跨消息重复 tool_use id(CC-1212)、strict 模式抛错、resume mid-turn 等 AmbiCrew 特有场景。
- **CrewProxy `stripOrphanedToolResults`**(~20 行):丢弃导向,极简。
- 两者跑在不同 runtime、不同仓、不同抽象层(SDK 消息 vs wire payload)。共享代码要么引入跨仓依赖(两个独立手动部署的服务 → 部署耦合),要么复制 300 行(维护双份)。

结论:两层**约定等价**(各自保证出口无孤儿 tool_result),但**各自实现、不共享代码、不耦合部署**。

## 目标

CrewProxy 在转发前**无条件**跑一次孤儿剥离,作为独立、幂等、总是执行的"发送前配对闸门"。堵住"不 trim 时孤儿透传"的剩余入口。

## 架构

在转发前、`pristineRequestBody` 快照之前调用 `stripOrphanedToolResults(upstreamRequestBody.messages)`。位置选择使一处调用覆盖全部路径:

- **在 trim 块之后**(`src/proxy.ts:885` 后)→ 覆盖 trim 产生的孤儿(与 trim 内清理重复但幂等,无害)。
- **在 pristine 快照之前**(`src/proxy.ts:892` 前)→ 快照本身干净 → 所有凭据重试(`1284` 从 pristine reset)自动继承,无需在每个 fetch 点重复。
- **无条件**(不在 `if (estimated > inputBudget)` 内)→ 堵住不 trim 场景。

## 详细设计

### 组件 1:import

`src/proxy.ts:8` 的 `from './contextBudget'` import 加上 `stripOrphanedToolResults`(当前未 import,该函数只在 contextBudget 内部使用)。

### 组件 2:发送前闸门

`src/proxy.ts`,trim 块结束(885)之后、`const pristineRequestBody = structuredClone(upstreamRequestBody);`(892)之前,插入:

```ts
// 发送前配对闸门:无条件剥离孤儿 tool_result(无论上面是否 trim)。
// 孤儿可能来自 trim,也可能本就存在于客户端请求里;二者都在此统一堵住,
// 避免原样透传给上游触发 400 "tool id not found"。幂等,与 trim 内清理重复无害。
if (Array.isArray(upstreamRequestBody.messages)) {
  stripOrphanedToolResults(upstreamRequestBody.messages);
}
```

## 测试计划

- 构造一个带孤儿 `tool_result`(父 `tool_use` 不存在)但**不超预算**(不触发 trim)的请求 body,断言经闸门处理后 `messages` 无孤儿 —— 证明不依赖 trim 也生效。
- 由于闸门直接复用已测的 `stripOrphanedToolResults`(梯度里已有单测),proxy 侧新增测试聚焦"无条件执行"这一行为语义即可。handler 端到端依赖 ctx 较重,测可抽的闸门逻辑而非整条 handler。

## 兼容性 / 风险

- 纯削孤儿,正常配对不受影响;幂等(跑一次与多次结果相同)。
- 单仓;不改任何 trim / 重试 / 400 逻辑。
- 无协议改动,无跨仓依赖。

## 不在范围

- 共享配对契约(已否决,理由见上)。
- AmbiCrew 侧任何改动(其 `ensureToolResultPairing` 已保证发送前无孤儿)。
- 服务器部署由用户手动完成。
