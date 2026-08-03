# 梯度 2:trim 信号可见化 — 设计文档

日期:2026-08-03
仓库:CrewProxy(改动起点)+ AmbiCrew(消费端)
系列:两层裁剪衔接优化梯度 2 / 4

## 背景与问题

CrewProxy 的机械 trim(`trimToFitBudget`,`src/proxy.ts:865-879`)在上下文超预算时删老消息/图片/截断文本,保证请求不硬 400。但这一步对客户端完全**静默**:AmbiCrew 不知道自己发的历史被代理裁掉了一部分,下一轮又发一个大上下文让代理再裁,用户也感知不到"较早对话已丢失"。

梯度 1 已让 trim 变罕见(真实窗口对齐后 compact 阈值更准),但 trim 仍可能触发(compact 失效、真实窗口小于预期等)。**当它触发时应当可见**,而不是无声吞掉上下文。

## 目标

CrewProxy 每次 trim 后通过响应头把"本轮裁剪量"回报给客户端;AmbiCrew 读到后在该 turn 结束时向用户显示一条 warning 提示。**只做可见化**,不触发任何 compact。

### 为什么不做"主动 compact 闭环"

探索确认:AmbiCrew 的 `reactiveCompact.ts` 是 stub(`__stubMissing = true`),不存在"收到信号→主动 compact"的入口。现有反应式路径是被动的、错误驱动的(413/400 "Prompt is too long" → `errors.ts` 解析 token gap → compact 重试)。新建主动 compact 接收端改动大、回归风险高,超出本梯度价值。故本梯度止于可见化;主动闭环若未来需要,另立项目。

## 架构

```
CrewProxy trim → 响应头 x-crew-trimmed-tokens: N (流式/非流式两路)
  → AmbiCrew claude.ts 读头(镜像现有 extractQuotaStatusFromHeaders 范式)
  → 存会话级 lastProxyTrimTokens
  → query.ts turn 末 consumeProxyTrimTokens() → yield warning → 读后清零(一轮一次)
```

复用两个现成范式:CrewProxy 已用 `res.writeHead(200,{...})` 构造两路响应;AmbiCrew 已在 `claude.ts:2479` 用 `extractQuotaStatusFromHeaders(resp.headers)` 从代理响应头抽状态。接收端不碰 compact 逻辑。

## 详细设计

### 组件 1:CrewProxy hoist trim 量并附响应头

文件:`src/proxy.ts`。

- trim 块(865-879)外声明 `let trimmedTokens = 0`;trim 成功时 `trimmedTokens = Math.max(0, estimated - trimResult.estimatedTokens)`。
- 两条响应路径的 `res.writeHead(200, {...})` header 对象加:
  `...(trimmedTokens > 0 && { 'x-crew-trimmed-tokens': String(trimmedTokens) })`
- 流式响应构造函数(签名在 595 一带)当前不接收 `trimmedTokens`,需作为新参数传入 —— 本组件唯一的管线改动。
- 老客户端忽略未知头,无影响。

### 组件 2:AmbiCrew 读取 trim 信号头

文件:AmbiCrew,与 `extractQuotaStatusFromHeaders` 同文件(实现时定位)。

- 新增 `extractTrimStatusFromHeaders(headers)`:读 `x-crew-trimmed-tokens`,正整数则存入模块/会话级 `lastProxyTrimTokens`;否则不动。
- 新增 `consumeProxyTrimTokens(): number`:返回 `lastProxyTrimTokens` 并清零(保证读后不重复)。
- 在 `claude.ts:2479`(现有 `extractQuotaStatusFromHeaders(resp.headers)` 旁)加一行 `extractTrimStatusFromHeaders(resp.headers)`。

### 组件 3:AmbiCrew turn 末提示

文件:`src/query.ts`。

- 在 turn 收尾处(callModel 的 for-await 结束后)调 `consumeProxyTrimTokens()`;若 >0,`yield createSystemMessage(content, 'warning')`(复用 550/954 范式)。
- 文案(中文):
  `⚠️ 本轮上下文被模型代理裁剪了约 N tokens 以适配上下文窗口。较早的对话内容可能已被裁掉。建议使用 /compact 压缩上下文,或新建会话。`
- 读后清零 → 每个发生 trim 的 turn 提示一次,不重复(方案 A:每轮被裁即提示)。

## 测试计划

- CrewProxy:trim 量计算 `estimated − estimatedTokens`(正数);不 trim 时不带头;流式/非流式两路都带头。
- AmbiCrew:`extractTrimStatusFromHeaders` 解析正整数、忽略缺失/非正/非数字;`consumeProxyTrimTokens` 读后清零(二次读为 0)。

## 兼容性

- 旧 proxy 不回头 → AmbiCrew 读到 null → 永不提示,现状行为。
- 旧 AmbiCrew 不读头 → 忽略未知头,现状行为。
- 两端可独立部署,无顺序要求。

## 不在范围

- 不触发任何 compact(接收端主动路径不存在;本梯度只做可见化)。
- 去重/阈值提示(方案 B/C)—— 显式否决:目标是可见化,连续被裁本身是"梯度 1 没兜住"的有用信号。
- 梯度 3(输入/输出额度协商)、梯度 4(配对共享契约)各自独立 spec。
- 服务器部署由用户手动完成。
