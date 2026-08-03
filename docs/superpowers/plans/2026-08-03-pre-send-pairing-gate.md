# 发送前配对闸门(梯度 4)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CrewProxy 在转发前无条件剥离孤儿 tool_result,堵住"不 trim 时孤儿透传给上游触发 400"的剩余入口。

**Architecture:** 单仓单点改动。在 `src/proxy.ts` 的 trim 块之后、`pristineRequestBody` 快照之前,无条件调用已有的 `stripOrphanedToolResults(upstreamRequestBody.messages)`。位置使初始发送与所有凭据重试(从 pristine reset)都继承干净 body。

**Tech Stack:** TypeScript, Node.js `node:test`+`tsx`。

## Global Constraints

- 无条件执行(不在 `if (estimated > inputBudget)` 内)。
- 幂等,复用已测的 `stripOrphanedToolResults`(`src/contextBudget.ts:423`);与 trim 内清理重复无害。
- 单仓;不改任何 trim / 重试 / 400 逻辑;无协议改动。
- 位置:trim 块结束(约 885)之后、`const pristineRequestBody = structuredClone(...)`(约 892)之前。
- 测试命令 `npx tsx --test <file>`。

---

### Task 1: 发送前配对闸门

**Files:**
- Modify: `src/proxy.ts:8`(import 加 `stripOrphanedToolResults`)
- Modify: `src/proxy.ts`(trim 块后 / pristine 快照前 插入闸门)
- Test: `test/preSendPairingGate.test.ts`(新建)

**Interfaces:**
- Consumes: `stripOrphanedToolResults(messages: any[]): void`(原地剥离 `tool_use_id` 无对应 `tool_use` 的 `tool_result` 块;空消息整条删除)。已在 `src/contextBudget.ts` 导出且有单测。
- Produces: 无新导出;行为契约 = 转发前 body 的 messages 无孤儿 tool_result,无论是否 trim。

- [ ] **Step 1: 写失败测试(闸门契约:不 trim 也剥离孤儿)**

新建 `test/preSendPairingGate.test.ts`。梯度 4 的新保证是"无条件执行",而闸门直接复用 `stripOrphanedToolResults`。为验证契约且不做端到端 handler(ctx 过重),测试直接断言:一个"带孤儿但未超预算"的 body,其 messages 经 `stripOrphanedToolResults` 后无孤儿(闸门就是这一调用,无条件跑)。同时断言正常配对不受影响。

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOrphanedToolResults } from '../src/contextBudget';

// 该测试锁定梯度 4 闸门的行为契约:proxy 转发前对 body.messages 无条件调用
// stripOrphanedToolResults(见 src/proxy.ts trim 块后)。这里直接验证该调用
// 对"带孤儿、未触发 trim"的请求也能清干净,并保留合法配对。
test('gate strips a client-sent orphan even when no trim happened', () => {
  const messages: any[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    // 孤儿:父 tool_use 从不存在
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'ghost', content: 'orphan' },
      { type: 'text', text: 'hi' },
    ] },
  ];
  stripOrphanedToolResults(messages);
  // 合法配对保留
  assert.deepEqual(messages[1].content, [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]);
  // 孤儿块被剥离,同消息内正常块保留
  assert.deepEqual(messages[2].content, [{ type: 'text', text: 'hi' }]);
});

test('gate is a no-op on a fully-paired body', () => {
  const messages: any[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ];
  const before = JSON.parse(JSON.stringify(messages));
  stripOrphanedToolResults(messages);
  assert.deepEqual(messages, before);
});
```

- [ ] **Step 2: 运行测试确认通过(基线)**

Run: `npx tsx --test test/preSendPairingGate.test.ts`
Expected: PASS —— `stripOrphanedToolResults` 已存在且行为正确。

> 说明:本任务的实现改动是"在 proxy handler 里新增无条件调用",而被调函数已实现且已测。故此测试从一开始即 PASS,锁定闸门依赖的函数契约。实现步骤(Step 3-4)的正确性由构建(tsc)+ 全量测试保证,而非此单测的红→绿翻转。这是对"复用已测函数的接线型改动"的合理测试策略,非占位。

- [ ] **Step 3: 加 import**

`src/proxy.ts:8` 当前:

```ts
import { estimateRequestTokens, computeInputBudget, trimToFitBudget, isTokenExceedError, aggressiveTrimForRetry, getModelContextWindow } from './contextBudget';
```

改为(追加 `stripOrphanedToolResults`):

```ts
import { estimateRequestTokens, computeInputBudget, trimToFitBudget, isTokenExceedError, aggressiveTrimForRetry, getModelContextWindow, stripOrphanedToolResults } from './contextBudget';
```

- [ ] **Step 4: 插入发送前闸门**

`src/proxy.ts` 定位 trim 块结束的 `}`(约 885)与其后的 `const pristineRequestBody = structuredClone(upstreamRequestBody);`(约 892)。在两者之间插入:

```ts

  // 发送前配对闸门(梯度 4):无条件剥离孤儿 tool_result(无论上面是否 trim)。
  // 孤儿可能来自 trim,也可能本就存在于客户端请求里;二者都在此统一堵住,避免
  // 原样透传给上游触发 400 "tool id not found"。幂等,与 trim 内清理重复无害。
  // 放在 pristine 快照之前,使所有凭据重试(从 pristine reset)都继承干净 body。
  if (Array.isArray(upstreamRequestBody.messages)) {
    stripOrphanedToolResults(upstreamRequestBody.messages);
  }
```

> 确认插入点在 pristine 快照**之前**:快照行是 `const pristineRequestBody = structuredClone(upstreamRequestBody);`。闸门必须在它上面,快照才会是清理后的干净副本。

- [ ] **Step 5: 全量测试 + 构建**

Run: `npx tsx --test test/preSendPairingGate.test.ts` → PASS
Run: `npm test` → 全绿
Run: `npm run build` → 无 TS 报错(验证 import 正确、闸门语法正确)

- [ ] **Step 6: 提交**

```bash
git add src/proxy.ts test/preSendPairingGate.test.ts
git commit -m "fix(proxy): unconditionally strip orphan tool_results before forwarding"
```

---

## Self-Review

**Spec coverage:**
- 组件 1(import)→ Task 1 Step 3。✓
- 组件 2(发送前闸门,trim 后/快照前/无条件)→ Task 1 Step 4。✓
- 测试计划(带孤儿未 trim 也剥离 + 正常配对不受影响)→ Task 1 Step 1 两个测试。✓
- 兼容性(纯削孤儿、幂等、单仓、不改 trim/重试/400)→ 改动仅新增一个无条件调用,不触碰其他逻辑。✓

**Placeholder scan:** 无 TBD/TODO;代码步骤含完整代码。Step 2 说明"此测试从 PASS 开始"的测试策略取舍(接线型改动复用已测函数),有依据非占位。

**Type consistency:** `stripOrphanedToolResults(messages: any[]): void` 在 Step 1 测试、Step 3 import、Step 4 调用三处一致;插入点行 `const pristineRequestBody = structuredClone(upstreamRequestBody);` 与 spec 一致。一致。
