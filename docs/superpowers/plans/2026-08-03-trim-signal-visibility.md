# trim 信号可见化(梯度 2)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CrewProxy 每次 trim 通过 `x-crew-trimmed-tokens` 响应头回报裁剪量,AmbiCrew 读到后在该 turn 结束时向用户 yield 一条 warning 提示。

**Architecture:** 跨两仓,纯可见化。CrewProxy hoist trim 量并附响应头(流式/非流式两路,组 A)。AmbiCrew 镜像现有 `extractQuotaStatusFromHeaders` 加 `extractTrimStatusFromHeaders`/`consumeProxyTrimTokens`(组 B),在 `claude.ts` 读头、`query.ts` turn 末 yield warning(组 C)。接收端不碰 compact。

**Tech Stack:** TypeScript, Node.js `node:test`+`tsx`(CrewProxy),`bun:test`(AmbiCrew)。

## Global Constraints

- 只做可见化,不触发任何 compact。
- 向后兼容:proxy 不回头 → AmbiCrew 读到 null → 永不提示。旧 AmbiCrew 忽略未知头。两端可独立部署。
- 复用现成范式:CrewProxy `res.writeHead(200,{...})` / `res.setHeader`;AmbiCrew `extractQuotaStatusFromHeaders`(`src/services/claudeAiLimits.ts:454`)、`createSystemMessage(content, 'warning')`(`src/utils/messages.ts:4335`)。
- 头名固定 `x-crew-trimmed-tokens`,值为正整数字符串;每个被裁 turn 提示一次(读后清零)。
- CrewProxy 测试 `npx tsx --test <file>`;AmbiCrew 测试 `bun test <file>`。

---

### Task 1: CrewProxy — hoist trim 量并附响应头

**Files:**
- Modify: `src/proxy.ts`(trim 块 865-879;流式函数 `handleAnthropicStreamResponse` 签名 594 + 内部 writeHead 605;调用点 1330;非流式发送 1360 `sendJSONResponse`)
- Test: `test/trimSignalHeader.test.ts`(新建)

**Interfaces:**
- Consumes: `trimToFitBudget(body, budget): { trimmed: boolean; estimatedTokens: number; ... }`;`estimateRequestTokens(body): number`
- Produces: 一个可测纯函数 `computeTrimmedTokens(estimated: number, estimatedAfter: number): number`(= `Math.max(0, estimated - estimatedAfter)`);响应头 `x-crew-trimmed-tokens` 在 trim 发生时出现于流式与非流式两路。

- [ ] **Step 1: 写失败测试(trim 量计算纯函数)**

创建 `test/trimSignalHeader.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrimmedTokens } from '../src/proxy';

test('computeTrimmedTokens returns positive difference', () => {
  assert.equal(computeTrimmedTokens(10000, 7000), 3000);
});

test('computeTrimmedTokens clamps to zero when not smaller', () => {
  assert.equal(computeTrimmedTokens(5000, 5000), 0);
  assert.equal(computeTrimmedTokens(5000, 6000), 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test test/trimSignalHeader.test.ts`
Expected: FAIL —— `computeTrimmedTokens` is not a function。

- [ ] **Step 3: 实现纯函数**

在 `src/proxy.ts` 模块作用域(靠近其他 helper,如 `resolveModelContextWindow` 附近)新增:

```ts
export function computeTrimmedTokens(estimated: number, estimatedAfter: number): number {
  return Math.max(0, estimated - estimatedAfter);
}
```

- [ ] **Step 4: hoist trim 量到 handler 作用域**

`src/proxy.ts` trim 块(865-879)改为在块外声明并赋值:

```ts
  let trimmedTokens = 0;

  // ─── Context budget: pre-flight trim ───
  {
    const effectiveModelForBudget = modelId || upstream.model;
    const requestedMaxOutput = upstreamRequestBody.max_tokens;
    const inputBudget = computeInputBudget(effectiveModelForBudget, requestedMaxOutput);
    const estimated = estimateRequestTokens(upstreamRequestBody);

    if (estimated > inputBudget) {
      const trimResult = trimToFitBudget(upstreamRequestBody, inputBudget);
      if (trimResult.trimmed) {
        upstreamRequestBody = trimResult.trimmedBody;
        trimmedTokens = computeTrimmedTokens(estimated, trimResult.estimatedTokens);
        logger.verbose(`[${reqId}] Context budget: trimmed from ~${estimated} to ~${trimResult.estimatedTokens} tokens (budget: ${inputBudget}). Actions: ${trimResult.actions.join('; ')}`);
      }
    }
  }
```

- [ ] **Step 5: 非流式路径附头**

`src/proxy.ts` 非流式成功发送处(当前 1360 `sendJSONResponse(res, 200, anthropicResp);`)之前插入:

```ts
    if (trimmedTokens > 0) res.setHeader('x-crew-trimmed-tokens', String(trimmedTokens));
    sendJSONResponse(res, 200, anthropicResp);
```

> `sendJSONResponse` 内部用 `res.writeHead(200, {'Content-Type':'application/json'})`;Node 会把提前 `setHeader` 的值一并发出,不冲突。

- [ ] **Step 6: 流式路径穿透 trim 量**

`handleAnthropicStreamResponse` 签名(594)末尾加参数 `trimmedTokens: number = 0`;其内部 `res.writeHead(200, {...})`(605)的 header 对象加:

```ts
    ...(trimmedTokens > 0 && { 'x-crew-trimmed-tokens': String(trimmedTokens) }),
```

调用点(1330)传入:

```ts
      await handleAnthropicStreamResponse(upstreamResponse, req, res, clientId, effectiveModel, startTime, upstreamRequestBody, usageExtra, recordMetric, trimmedTokens);
```

- [ ] **Step 7: 运行测试 + 构建**

Run: `npx tsx --test test/trimSignalHeader.test.ts` → PASS;`npm test` → 全绿;`npm run build` → 无 TS 报错。

- [ ] **Step 8: 提交**

```bash
git add src/proxy.ts test/trimSignalHeader.test.ts
git commit -m "feat(proxy): report trim amount via x-crew-trimmed-tokens header"
```

---

### Task 2: AmbiCrew — 读取 trim 信号头

**Files:**
- Modify: `src/services/claudeAiLimits.ts`(新增两个导出函数)
- Modify: `src/services/api/claude.ts`(import + 在 2477 旁调用)
- Test: `src/services/claudeAiLimits.trim.test.ts`(新建)

**Interfaces:**
- Consumes: `globalThis.Headers`
- Produces:
  - `extractTrimStatusFromHeaders(headers: globalThis.Headers): void` —— 读 `x-crew-trimmed-tokens`,正整数则存模块级 `lastProxyTrimTokens`。
  - `consumeProxyTrimTokens(): number` —— 返回 `lastProxyTrimTokens` 并清零。

- [ ] **Step 1: 写失败测试**

创建 `src/services/claudeAiLimits.trim.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { extractTrimStatusFromHeaders, consumeProxyTrimTokens } from './claudeAiLimits.js'

describe('proxy trim signal', () => {
  test('extracts positive integer and consume clears it', () => {
    extractTrimStatusFromHeaders(new Headers({ 'x-crew-trimmed-tokens': '3200' }))
    expect(consumeProxyTrimTokens()).toBe(3200)
    expect(consumeProxyTrimTokens()).toBe(0) // cleared after read
  })

  test('ignores missing / non-positive / non-numeric', () => {
    consumeProxyTrimTokens() // reset
    extractTrimStatusFromHeaders(new Headers({}))
    expect(consumeProxyTrimTokens()).toBe(0)
    extractTrimStatusFromHeaders(new Headers({ 'x-crew-trimmed-tokens': '0' }))
    expect(consumeProxyTrimTokens()).toBe(0)
    extractTrimStatusFromHeaders(new Headers({ 'x-crew-trimmed-tokens': 'abc' }))
    expect(consumeProxyTrimTokens()).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/services/claudeAiLimits.trim.test.ts`
Expected: FAIL —— 两个函数未导出。

- [ ] **Step 3: 实现两个函数**

在 `src/services/claudeAiLimits.ts` 末尾(或 `extractQuotaStatusFromHeaders` 附近)新增:

```ts
// ─── Proxy trim signal (梯度 2) ───
// CrewProxy sets x-crew-trimmed-tokens when it mechanically trimmed the
// request to fit the context window. Surfaced to the user once per turn.
let lastProxyTrimTokens = 0

export function extractTrimStatusFromHeaders(headers: globalThis.Headers): void {
  const raw = headers.get('x-crew-trimmed-tokens')
  if (!raw) return
  const n = Number(raw)
  if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
    lastProxyTrimTokens = n
  }
}

export function consumeProxyTrimTokens(): number {
  const v = lastProxyTrimTokens
  lastProxyTrimTokens = 0
  return v
}
```

- [ ] **Step 4: 在 claude.ts 调用**

`src/services/api/claude.ts` import 处(现有从 `claudeAiLimits` import `extractQuotaStatusFromHeaders`,约 100 行)补上 `extractTrimStatusFromHeaders`。在 2477 现有调用旁加一行:

```ts
        extractQuotaStatusFromHeaders(resp.headers);
        extractTrimStatusFromHeaders(resp.headers);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test src/services/claudeAiLimits.trim.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/services/claudeAiLimits.ts src/services/claudeAiLimits.trim.test.ts src/services/api/claude.ts
git commit -m "feat(claude): read x-crew-trimmed-tokens proxy signal"
```

---

### Task 3: AmbiCrew — turn 末 yield warning

**Files:**
- Modify: `src/query.ts`(`query_api_streaming_end` 处,875 之后;import `consumeProxyTrimTokens`)
- Test: 手动/集成验证(见 Step 说明)

**Interfaces:**
- Consumes: `consumeProxyTrimTokens(): number`(Task 2);`createSystemMessage(content: string, level, toolUseID?, preventContinuation?)`(`src/utils/messages.ts:4335`)
- Produces: 被裁 turn 末 yield 一条 `'warning'` system message。

- [ ] **Step 1: import**

`src/query.ts` 顶部 import 区,从 `claudeAiLimits` 引入 `consumeProxyTrimTokens`(若无该文件的现有 import 则新增一行 `import { consumeProxyTrimTokens } from './services/claudeAiLimits.js'`,路径按 query.ts 现有相对习惯)。

- [ ] **Step 2: 在 streaming 结束后 yield 提示**

`src/query.ts` 的 `queryCheckpoint('query_api_streaming_end')`(875)之后插入:

```ts
          const proxyTrimmed = consumeProxyTrimTokens()
          if (proxyTrimmed > 0) {
            yield createSystemMessage(
              `⚠️ 本轮上下文被模型代理裁剪了约 ${proxyTrimmed} tokens 以适配上下文窗口。较早的对话内容可能已被裁掉。建议使用 /compact 压缩上下文,或新建会话。`,
              'warning',
            )
          }
```

> `createSystemMessage` 已在 query.ts import(550/954 已用);无需新增该 import。

- [ ] **Step 3: 类型检查 + 相关测试面**

Run: `bunx tsc --noEmit -p tsconfig.json`(过滤 `desktop/src-tauri/target` 噪声后,`src/query.ts` 无 error TS)
Run: `bun test src/services/claudeAiLimits.trim.test.ts` → 仍 PASS
Expected: 无类型错误。

> query.ts 是生成器主循环,端到端单测成本高;此步靠类型检查 + Task 2 单测保证接线正确。yield 位置紧邻现有 "deferred microcompact boundary message" 的同类 yield,范式一致。

- [ ] **Step 4: 提交**

```bash
git add src/query.ts
git commit -m "feat(query): surface proxy trim as a per-turn warning to the user"
```

---

## Self-Review

**Spec coverage:**
- 组件 1(hoist + 两路附头)→ Task 1(Step 4 hoist / Step 5 非流式 / Step 6 流式)。✓
- 组件 2(extractTrimStatusFromHeaders + consumeProxyTrimTokens + claude.ts 调用)→ Task 2。✓
- 组件 3(query.ts turn 末 yield warning)→ Task 3。✓
- 兼容性(不回头→null→不提示;正整数校验)→ Task 2 Step 3 校验 + Task 3 `>0` 判断。✓
- 只做可见化,不碰 compact → 三个任务均无 compact 调用。✓

**Placeholder scan:** 无 TBD/TODO;代码步骤均含完整代码。Task 3 Step 3 说明为何不做 query.ts 端到端单测(生成器主循环成本),以类型检查+Task2 单测替代,是有依据的取舍非占位。

**Type consistency:** `extractTrimStatusFromHeaders(headers): void`、`consumeProxyTrimTokens(): number` 在 Task 2 定义,Task 3 按此调用;`computeTrimmedTokens(estimated, estimatedAfter)` Task 1 定义并自用;头名 `x-crew-trimmed-tokens` 两仓一致。一致。
