# 孤儿 tool_result 与 400 重试分支修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CrewProxy 的 context trim 不再产生孤儿 tool_result,并让非 token 类 400 立即透传而非空转烧光凭据池。

**Architecture:** 缺陷 B 治根 —— 新增 `stripOrphanedToolResults` 块级兜底,接入 `trimToFitBudget` 与 `aggressiveTrimForRetry`。缺陷 A 兜底 —— proxy.ts 重试循环里给非 token 400 加"立即返回、不 cooldown、不换凭据"短路。

**Tech Stack:** TypeScript, Node.js `node:test` + `tsx`(测试),`tsc`(构建)。

## Global Constraints

- 测试框架:`node:test` + `node:assert/strict`,通过 `npm test`(`tsx --test test/**/*.test.ts`)运行。
- 构建:`npm run build`(`tsc`)必须通过。
- 原地修改 `messages` 数组(与 `contextBudget.ts` 现有 `splice` 风格一致)。
- token 类 400 判据统一用现有 `isTokenExceedError(status, bodyText)`。
- 不改动 AmbiCrew 仓库;不改动 429 / 5xx / 网络错误的现有轮换、backoff、cooldown 逻辑。

---

### Task 1: `stripOrphanedToolResults` 函数 + 单测

**Files:**
- Modify: `src/contextBudget.ts`(在 `aggressiveTrimForRetry` 之前新增导出函数,约 411 行前)
- Test: `test/contextBudget.test.ts`(新建)

**Interfaces:**
- Consumes: 无(纯函数)
- Produces: `export function stripOrphanedToolResults(messages: any[]): void` —— 原地修改 messages;删除 `tool_use_id` 无对应 `tool_use` 的 `tool_result` 块;某条消息 content 因此变空则整条删除。

- [ ] **Step 1: 写失败测试**

创建 `test/contextBudget.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOrphanedToolResults } from '../src/contextBudget';

test('strips a mixed orphan tool_result block but keeps sibling text', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'ghost', content: 'orphan' },
      { type: 'text', text: 'hi' },
    ] },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].content, [
    { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
    { type: 'text', text: 'hi' },
  ]);
});

test('removes the whole message when it becomes empty after stripping', () => {
  const messages = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
});

test('leaves valid pairs untouched', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ];
  const before = JSON.parse(JSON.stringify(messages));
  stripOrphanedToolResults(messages);
  assert.deepEqual(messages, before);
});

test('does not remove a tool_use that has no tool_result (allowed mid-turn)', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content[0].type, 'tool_use');
});

test('handles string content and missing content without throwing', () => {
  const messages = [
    { role: 'user', content: 'plain string' },
    { role: 'assistant' },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- test/contextBudget.test.ts`
Expected: FAIL —— `stripOrphanedToolResults` is not exported / not a function。

- [ ] **Step 3: 实现函数**

在 `src/contextBudget.ts` 的 `export function aggressiveTrimForRetry`(当前约 412 行)之前插入:

```ts
/**
 * 原地剥离孤儿 tool_result:删除所有 tool_use_id 找不到对应 tool_use 的
 * tool_result 块。若某条消息的 content 因此变空,整条删除。
 *
 * 覆盖 trimToFitBudget / aggressiveTrimForRetry 的整块级配对删除处理不到的
 * “混合块级孤儿”(一条 user 消息里既有孤儿 tool_result 又有正常内容)。
 * 只处理孤儿 tool_result 一个方向;tool_use 无 result 是 Anthropic 允许的
 * 中间态,不在此处理。
 */
export function stripOrphanedToolResults(messages: any[]): void {
  const validUseIds = new Set<string>();
  for (const msg of messages) {
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_use' && block.id) validUseIds.add(block.id);
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg?.content)) continue;
    const filtered = msg.content.filter(
      (block: any) =>
        !(block?.type === 'tool_result' && !validUseIds.has(block.tool_use_id)),
    );
    if (filtered.length === msg.content.length) continue;
    if (filtered.length === 0) {
      messages.splice(i, 1);
      i--;
    } else {
      msg.content = filtered;
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- test/contextBudget.test.ts`
Expected: PASS(5 个测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/contextBudget.ts test/contextBudget.test.ts
git commit -m "feat(contextBudget): add stripOrphanedToolResults block-level cleanup"
```

---

### Task 2: 接入两处 trim + 集成测试

**Files:**
- Modify: `src/contextBudget.ts`(`trimToFitBudget` Phase 3 循环后,约 317 行后;`aggressiveTrimForRetry` return 前,约 505 行）
- Test: `test/contextBudget.test.ts`(追加)

**Interfaces:**
- Consumes: `stripOrphanedToolResults`(Task 1);`trimToFitBudget(body, inputBudget): TrimResult`;`aggressiveTrimForRetry(body, round): any`
- Produces: 无新导出;保证两处 trim 返回的 body 中无孤儿 tool_result。

- [ ] **Step 1: 写失败测试**

在 `test/contextBudget.test.ts` 追加(顶部 import 补上 `trimToFitBudget, aggressiveTrimForRetry`):

```ts
import { trimToFitBudget, aggressiveTrimForRetry } from '../src/contextBudget';

// 构造:老的 tool_use/tool_result 之间隔着别的消息,逐条 trim 会拆散配对
function makeOrphanProneBody() {
  const messages: any[] = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `u${i}`, name: 't', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: 'x'.repeat(400) }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'latest' }] });
  return { model: 'gpt-5.6', messages, system: 'sys' };
}

function assertNoOrphans(body: any) {
  const useIds = new Set<string>();
  for (const m of body.messages) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') useIds.add(b.id);
  }
  for (const m of body.messages) {
    if (Array.isArray(m.content)) for (const b of m.content) {
      if (b.type === 'tool_result') assert.ok(useIds.has(b.tool_use_id), `orphan tool_result ${b.tool_use_id}`);
    }
  }
}

test('trimToFitBudget leaves no orphan tool_results', () => {
  const body = makeOrphanProneBody();
  const { trimmedBody } = trimToFitBudget(body, 500);
  assertNoOrphans(trimmedBody);
});

test('aggressiveTrimForRetry leaves no orphan tool_results', () => {
  const body = makeOrphanProneBody();
  const out = aggressiveTrimForRetry(body, 0);
  assertNoOrphans(out);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- test/contextBudget.test.ts`
Expected: 新增两测 FAIL(`orphan tool_result u..` 断言触发),Task 1 的测试仍 PASS。

- [ ] **Step 3: 接入 trimToFitBudget**

在 `src/contextBudget.ts` Phase 3 的 `while` 循环结束(当前 317 行 `}`)之后、`if (removedCount > 0)`(318 行)之前插入一行:

```ts
  stripOrphanedToolResults(messages);
```

> 该位置在所有整条消息删除之后、Phase 4 文本截断之前,一次调用即覆盖 320 与 388 两个 return(Phase 4 只截断文本不删消息,不会再产生孤儿)。图片阶段的早返回(252/280)在 Phase 3 之前,不会产生孤儿,无需处理。

- [ ] **Step 4: 接入 aggressiveTrimForRetry**

在 `src/contextBudget.ts` `aggressiveTrimForRetry` 的 `return trimmed;`(当前 505 行)之前插入一行:

```ts
  stripOrphanedToolResults(messages);
```

> `messages` 是 `trimmed.messages` 的同一引用,原地剥离后 `trimmed` 即为干净结果。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- test/contextBudget.test.ts`
Expected: PASS(全部 7 个测试）。

- [ ] **Step 6: 提交**

```bash
git add src/contextBudget.ts test/contextBudget.test.ts
git commit -m "fix(contextBudget): strip orphan tool_results after trimming"
```

---

### Task 3: proxy.ts 非 token 400 立即透传 + 测试

**Files:**
- Modify: `src/proxy.ts`(400 token-trim 块之后、cooldown 之前,约 1208–1210 之间;1226–1228 注释更新)
- Test: `test/upstreamError.test.ts`(追加纯函数判据测试)

**Interfaces:**
- Consumes: `isTokenExceedError(status, bodyText)`(已 import 于 proxy.ts:8)
- Produces: 非 token 类 400 走"立即 break、不 cooldown、不换凭据"路径,由循环外 `if (!upstreamResponse.ok)`(约 1294）原样返回上游 400。

- [ ] **Step 1: 写失败测试(判据回归)**

在 `test/upstreamError.test.ts` 追加(import 补 `isTokenExceedError`,它来自 `../src/contextBudget`):

```ts
import { isTokenExceedError } from '../src/contextBudget';

test('tool-id-not-found 400 is NOT classified as token-exceed (must surface, not retry)', () => {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: "invalid params, tool result's tool id(call_x) not found (2013)" },
  });
  assert.equal(isTokenExceedError(400, body), false);
});

test('a real token-exceed 400 is still classified as token-exceed (keeps trim path)', () => {
  // 用当前 TOKEN_EXCEED_PATTERNS 认得的措辞
  assert.equal(isTokenExceedError(400, 'prompt is too long: 300000 tokens > 272000 maximum'), true);
});
```

> 若第二个断言因措辞不匹配 FAIL,先 `grep -n "TOKEN_EXCEED_PATTERNS" src/contextBudget.ts` 读取实际正则,改用其中一个能匹配的字符串;不要修改正则。

- [ ] **Step 2: 运行测试确认状态**

Run: `npm test -- test/upstreamError.test.ts`
Expected: 第一个断言应已 PASS(说明判据正确);第二个用于锁定 token 路径不被误伤。两者均应 PASS —— 若第二个 FAIL,按 Step 1 备注调整字符串后再跑。此步目的是确立"非 token 400 判据可靠"这一前提。

- [ ] **Step 3: 加入非 token 400 短路**

在 `src/proxy.ts`,token-trim 块结尾(当前 1204–1207 的 `if (upstreamResponse && upstreamResponse.ok) { ... break; }`)之后、`// ── Mark credential cooldown on failure ──`(当前 1210 行)之前,插入:

```ts
    // 非 token 类 400 是请求本身畸形(孤儿 tool_result → "tool id not found"、
    // schema 错误等)。换凭据只会得到同样的 400,还白烧整池并误报
    // "credentials exhausted"。立即透传真实 400,不 cooldown、不换凭据,
    // 让客户端看到根因。token 类 400 已在上面的 trim 循环处理,不会到这里。
    if (upstreamResponse.status === 400 && !isTokenExceedError(upstreamResponse.status, errText)) {
      logger.verbose(`[${reqId}] Non-token 400 (client request error), surfacing immediately without cooldown/switch`);
      break;
    }
```

- [ ] **Step 4: 更新 1226–1228 注释(逻辑不变)**

将当前:

```ts
    // ── Decide whether to retry with next credential ──
    // 4xx client errors (non-429, non-400) are not retryable
    if (upstreamResponse.status >= 400 && upstreamResponse.status < 500 &&
        upstreamResponse.status !== 429 && upstreamResponse.status !== 400) {
```

的注释行改为:

```ts
    // ── Decide whether to retry with next credential ──
    // 4xx client errors (non-429) are not retryable. Non-token 400 已在上方
    // 提前 break;这里保留 !== 400 是为了让 token 类 400 走完 trim 后不被
    // 当作可重试客户端错误在此处二次拦截(它由 trim 成功或耗尽自然收口)。
    if (upstreamResponse.status >= 400 && upstreamResponse.status < 500 &&
        upstreamResponse.status !== 429 && upstreamResponse.status !== 400) {
```

> 仅改注释,`if` 条件不变。

- [ ] **Step 5: 运行全量测试 + 构建**

Run: `npm test`
Expected: 全绿(含新增 contextBudget、upstreamError 测试)。

Run: `npm run build`
Expected: 无 TypeScript 报错。

- [ ] **Step 6: 提交**

```bash
git add src/proxy.ts test/upstreamError.test.ts
git commit -m "fix(proxy): surface non-token 400 immediately instead of burning credential pool"
```

---

## Self-Review

**Spec coverage:**
- 缺陷 B 新增 `stripOrphanedToolResults` → Task 1;接入两处 trim → Task 2。✓
- 缺陷 A 非 token 400 短路 → Task 3。✓
- 测试计划(contextBudget 单测/集成、upstreamError 判据、npm test/build)→ Task 1/2/3 覆盖。✓
- 不改 AmbiCrew、不动 429/5xx/网络逻辑 → Global Constraints + Task 3 注释明确。✓

**Placeholder scan:** 无 TBD/TODO;所有代码步骤含完整代码块。Step 1(Task3)对 token 措辞留了明确的 grep 回退指令(非占位符,是可执行的应急路径)。

**Type consistency:** `stripOrphanedToolResults(messages: any[]): void` 在 Task 1 定义,Task 2 两处按此签名调用;`isTokenExceedError(status, bodyText)` 沿用现有签名。一致。
