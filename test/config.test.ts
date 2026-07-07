import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstream } from '../src/config';

test('normalizeUpstream parses quotaLimits', () => {
  const u = normalizeUpstream({
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
    quotaLimits: { fiveHourTokens: 160000000, weeklyTokens: 800000000 },
  });
  assert.deepEqual(u.quotaLimits, { fiveHourTokens: 160000000, weeklyTokens: 800000000 });
});

test('normalizeUpstream leaves quotaLimits undefined when absent', () => {
  const u = normalizeUpstream({ baseURL: 'https://x.com', apiKey: 'x', model: 'm' });
  assert.equal(u.quotaLimits, undefined);
});

test('normalizeUpstream ignores non-numeric quotaLimits values', () => {
  const u = normalizeUpstream({
    baseURL: 'https://x.com', apiKey: 'x', model: 'm',
    quotaLimits: { fiveHourTokens: 'oops' },
  });
  assert.equal(u.quotaLimits, undefined);
});
