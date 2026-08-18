import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripOrphanedToolResults,
  trimToFitBudget,
  aggressiveTrimForRetry,
  parseWindowToken,
  getModelContextWindow,
  computeInputBudget,
  DEFAULT_CONTEXT_WINDOW,
} from '../src/contextBudget';
import type { ProviderContextWindowsConfig } from '../src/config';

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
  const messages: any[] = [
    { role: 'user', content: 'plain string' },
    { role: 'assistant' },
  ];
  stripOrphanedToolResults(messages);
  assert.equal(messages.length, 2);
});

// body 本身已含一个孤儿 tool_result(其父 tool_use 不在任何消息里),且放在
// 受保护尾部 —— trim 自身的相邻整块删除逻辑碰不到它。只有 stripOrphanedToolResults
// 能清掉。未接入时 trim 输出仍含孤儿,断言失败;接入后无孤儿。
function makeOrphanProneBody() {
  const messages: any[] = [];
  // padding 提供可删体积,触发 Phase 3
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `p${i}`, name: 't', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `p${i}`, content: 'x'.repeat(400) }] });
  }
  // 受保护尾部:一条 user 消息含孤儿 tool_result(父 tool_use 从不存在)+ 正常文本
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'thinking' }] });
  messages.push({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'ghost', content: 'orphan' },
    { type: 'text', text: 'latest' },
  ] });
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

// ─── Provider-level context window (Task 2) ───

test('parseWindowToken parses unit suffixes and numbers', () => {
  assert.equal(parseWindowToken('1m'), 1_000_000);
  assert.equal(parseWindowToken('200k'), 200_000);
  assert.equal(parseWindowToken('128k'), 128_000);
  assert.equal(parseWindowToken('1.5m'), 1_500_000);
  assert.equal(parseWindowToken(400_000), 400_000);
});

test('parseWindowToken throws on invalid token', () => {
  assert.throws(() => parseWindowToken('abc'), /invalid context window token/);
});

const cfg: ProviderContextWindowsConfig = {
  default: { contextWindow: '1m', maxOutputTokens: 32768 },
  overrides: { ark: { contextWindow: '200k' } },
};

test('getModelContextWindow: provider override wins over default', () => {
  assert.equal(getModelContextWindow('ark', 'doubao-seed-2.1', cfg).contextWindow, 200_000);
  assert.equal(getModelContextWindow('glm', 'glm-5.3', cfg).contextWindow, 1_000_000);
});

test('getModelContextWindow: model override wins over provider, keeps provider maxOutput', () => {
  process.env.WOICLAW_CONTEXT_OVERRIDES = JSON.stringify({ 'glm-4.5': 128_000 });
  const r = getModelContextWindow('glm', 'glm-4.5', cfg);
  assert.equal(r.contextWindow, 128_000);
  assert.equal(r.maxOutputTokens, 32768);
  delete process.env.WOICLAW_CONTEXT_OVERRIDES;
});

test('getModelContextWindow: falls back to 200k when no config and no override', () => {
  const r = getModelContextWindow(undefined, 'unknown-model', undefined);
  assert.equal(r.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(DEFAULT_CONTEXT_WINDOW, 200_000);
});

test('computeInputBudget uses provider-aware window', () => {
  const budget = computeInputBudget('glm', 'glm-5.3', undefined, cfg);
  assert.equal(budget, Math.floor((1_000_000 - 32768) * 0.85));
});
