import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TokenUsageTracker } from '../src/tokenUsageTracker';
import { JsonStateStore } from '../src/stateStore';

// now=10_000_000_000 固定。5h 窗口 cutoff = now - 5*3600*1000 = 9_982_000_000。
// 事件 ts 在 [9_982_000_000, 10_000_000_000] 内算 5h 窗口内。
function rec(t: TokenUsageTracker, upstreamId: string, tokens: number, ts: number) {
  t.record(upstreamId, tokens, ts);
}

test('5h window sums tokens within window', () => {
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  rec(t, 'glm', 1000, 9_990_000_000);
  rec(t, 'glm', 500, 9_995_000_000);
  assert.equal(t.getUsage('glm').fiveHourTokens, 1500);
});

test('5h window excludes events older than 5h', () => {
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  rec(t, 'glm', 1000, 9_000_000_000); // 远超 5h 前
  rec(t, 'glm', 200, 9_990_000_000);
  assert.equal(t.getUsage('glm').fiveHourTokens, 200);
});

test('weekly window (7d) retains tokens beyond 5h but within 7d', () => {
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  rec(t, 'glm', 1000, 9_500_000_000); // ~13.9h 前：5h 外（cutoff 9_982_000_000）、7天内（cutoff 9_395_200_000）
  assert.equal(t.getUsage('glm').fiveHourTokens, 0);
  assert.equal(t.getUsage('glm').weeklyTokens, 1000);
});

test('weekly window excludes events older than 7d', () => {
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  rec(t, 'glm', 1000, 1_000_000_000); // 远超 7 天
  assert.equal(t.getUsage('glm').weeklyTokens, 0);
});

test('per-upstream isolation', () => {
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  rec(t, 'glm', 1000, 9_990_000_000);
  rec(t, 'minimax', 500, 9_990_000_000);
  assert.equal(t.getUsage('glm').fiveHourTokens, 1000);
  assert.equal(t.getUsage('minimax').fiveHourTokens, 500);
});

test('unknown upstream returns zeros', () => {
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  assert.deepEqual(t.getUsage('nope'), { fiveHourTokens: 0, weeklyTokens: 0 });
});

test('record never throws on bad input', () => {
  const t = new TokenUsageTracker();
  t.record('', 100);               // empty upstreamId
  t.record('glm', NaN);            // NaN tokens
  t.record('glm', 100, NaN);       // NaN ts
  assert.equal(t.getUsage('glm').fiveHourTokens, 0); // NaN 桶不贡献有效值
});

// ── Persistence ──

test('dump/restore round-trip preserves usage', () => {
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  rec(t, 'glm', 1000, 9_990_000_000);
  rec(t, 'glm', 500, 9_995_000_000);
  const snap = t.dump();
  const t2 = new TokenUsageTracker({ now: () => 10_000_000_000 });
  t2.restore(snap);
  assert.equal(t2.getUsage('glm').fiveHourTokens, 1500);
});

test('restored stale buckets are filtered out by the window', () => {
  // Event >5h old: weekly retains it, but 5h window must read 0.
  const t = new TokenUsageTracker({ now: () => 10_000_000_000 });
  rec(t, 'glm', 1000, 9_000_000_000);
  const snap = t.dump();
  const t2 = new TokenUsageTracker({ now: () => 10_000_000_000 });
  t2.restore(snap);
  assert.equal(t2.getUsage('glm').fiveHourTokens, 0);
});

test('store-backed tracker restores usage across instances', () => {
  const f = path.join(os.tmpdir(), `tu-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const now = () => 10_000_000_000;
  const store1 = new JsonStateStore(f);
  const t1 = new TokenUsageTracker({ now, store: store1 });
  rec(t1, 'glm', 1234, 9_990_000_000);
  store1.flushSync();
  // New tracker + new store on the same file → state restored.
  const store2 = new JsonStateStore(f);
  const t2 = new TokenUsageTracker({ now, store: store2 });
  assert.equal(t2.getUsage('glm').fiveHourTokens, 1234);
});

test('store-backed tracker ignores corrupt file and starts empty', () => {
  const f = path.join(os.tmpdir(), `tu-bad-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, '{broken', 'utf-8'); // require fs below
  const store = new JsonStateStore(f);
  const t = new TokenUsageTracker({ now: () => 10_000_000_000, store });
  assert.equal(t.getUsage('glm').fiveHourTokens, 0);
});
