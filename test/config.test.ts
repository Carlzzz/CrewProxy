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

test('normalizeUpstream parses quotaMode estimated', () => {
  const u = normalizeUpstream({
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
    quotaMode: 'estimated',
  });
  assert.equal(u.quotaMode, 'estimated');
});

test('normalizeUpstream leaves quotaMode undefined when absent (defaults to fetch)', () => {
  const u = normalizeUpstream({ baseURL: 'https://x.com', apiKey: 'x', model: 'm' });
  assert.equal(u.quotaMode, undefined);
});

test('normalizeUpstream ignores invalid quotaMode', () => {
  const u = normalizeUpstream({
    baseURL: 'https://x.com', apiKey: 'x', model: 'm', quotaMode: 'bogus',
  });
  assert.equal(u.quotaMode, undefined);
});
