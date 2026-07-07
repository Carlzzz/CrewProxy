import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../src/metricsCollector';

// now=10_000_000ms fixed. A 60s window covers ts in [9_940_000, 10_000_000].
function rec(c: MetricsCollector, upstreamId: string, ts: number, success: boolean, inTok = 0, outTok = 0, cred?: string) {
  c.record({ upstreamId, credentialId: cred, success, inputTokens: inTok, outputTokens: outTok, costMs: 1000, ts });
}

test('aggregate sums count and computes successRate over window', () => {
  const c = new MetricsCollector(() => 10_000_000);
  rec(c, 'glm', 9_950_000, true);
  rec(c, 'glm', 9_970_000, false);
  const stats = c.aggregate(60).get('glm')!;
  assert.equal(stats.count, 2);
  assert.equal(stats.success, 1);
  assert.equal(stats.fail, 1);
  assert.equal(stats.successRate, 0.5);
});

test('aggregate excludes events outside window', () => {
  const c = new MetricsCollector(() => 10_000_000);
  rec(c, 'glm', 1_000_000, true); // ~9990s ago, outside the 60s window
  assert.equal(c.aggregate(60).get('glm'), undefined);
});

test('aggregate sums tokens and avg cost', () => {
  const c = new MetricsCollector(() => 10_000_000);
  rec(c, 'glm', 9_950_000, true, 100, 200, 'glm-key1');
  rec(c, 'glm', 9_960_000, true, 50, 50, 'glm-key1');
  const stats = c.aggregate(60).get('glm')!;
  assert.equal(stats.inputTokens, 150);
  assert.equal(stats.outputTokens, 250);
  assert.equal(stats.avgCostMs, 1000);
});

test('aggregateByCredential splits by credentialId', () => {
  const c = new MetricsCollector(() => 10_000_000);
  rec(c, 'glm', 9_950_000, true, 0, 0, 'glm-key1');
  rec(c, 'glm', 9_960_000, true, 0, 0, 'glm-key2');
  rec(c, 'glm', 9_970_000, true, 0, 0, 'glm-key1');
  const byCred = c.aggregateByCredential(60);
  assert.equal(byCred.get('glm-key1')!.count, 2);
  assert.equal(byCred.get('glm-key2')!.count, 1);
});

test('empty window returns empty map without throwing', () => {
  const c = new MetricsCollector(() => 10_000_000);
  assert.equal(c.aggregate(60).size, 0);
});
