import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstream, parseProxyConfigObject } from '../src/config';

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

test('parseProxyConfigObject parses webSearch keys', () => {
  const cfg = parseProxyConfigObject({
    webSearch: { tavilyApiKey: 'tvly-x', braveApiKey: 'BSA-y' },
  });
  assert.deepEqual(cfg.webSearch, { tavilyApiKey: 'tvly-x', braveApiKey: 'BSA-y' });
});

test('parseProxyConfigObject leaves webSearch undefined when absent', () => {
  const cfg = parseProxyConfigObject({ port: 3456 });
  assert.equal(cfg.webSearch, undefined);
});

test('parseProxyConfigObject ignores non-string webSearch keys', () => {
  const cfg = parseProxyConfigObject({ webSearch: { tavilyApiKey: 123, braveApiKey: '' } });
  assert.deepEqual(cfg.webSearch, {});
});

test('parseProxyConfigObject parses bochaApiKey', () => {
  const cfg = parseProxyConfigObject({ webSearch: { bochaApiKey: 'sk-bocha' } });
  assert.deepEqual(cfg.webSearch, { bochaApiKey: 'sk-bocha' });
});

test('parseProxyConfigObject parses providerContextWindows with default and overrides', () => {
  const parsed = parseProxyConfigObject({
    providerContextWindows: {
      default: { contextWindow: '1m', maxOutputTokens: 32768 },
      overrides: { ark: { contextWindow: '200k' } },
    },
  });
  assert.deepEqual(parsed.providerContextWindows, {
    default: { contextWindow: '1m', maxOutputTokens: 32768 },
    overrides: { ark: { contextWindow: '200k' } },
  });
});

test('parseProxyConfigObject throws when providerContextWindows.default is missing', () => {
  assert.throws(() => parseProxyConfigObject({ providerContextWindows: {} }), /default is required/);
});
