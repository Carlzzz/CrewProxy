import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify429, parseQuotaResetEpochMs, isQuotaLimitedResponse } from '../src/codePlanQuota';

// ── GLM balance exhaustion (the regression this guards) ──
//
// GLM returns 429 with JSON `type: "rate_limit_error"` even when the real
// cause is account balance / resource-pack exhaustion. The body must be
// classified as `quota` (long cooldown), NOT `rate_limit` (30s), or the key
// gets retried every 30s forever.
test('GLM 余额不足 429 → quota (not rate_limit)', () => {
  const body = JSON.stringify({
    type: 'rate_limit_error', code: '1113',
    message: '[1113][余额不足或无可用资源包,请充值。][20260709145715d536cdd8df6447dd]',
    request_id: '20260709145715d536cdd8df6447dd',
  });
  assert.equal(classify429(429, body), 'quota');
  assert.equal(isQuotaLimitedResponse(429, body), true);
});

test('GLM 资源包耗尽 429 → quota', () => {
  const body = '{"type":"rate_limit_error","code":"1113","message":"无可用资源包"}';
  assert.equal(classify429(429, body), 'quota');
});

test('GLM insufficient balance (English) → quota', () => {
  const body = '{"type":"rate_limit_error","message":"insufficient balance"}';
  assert.equal(classify429(429, body), 'quota');
});

// ── genuine rate-limit must still classify as rate_limit ──
test('plain "rate limit exceeded" → rate_limit', () => {
  assert.equal(classify429(429, 'Rate limit exceeded'), 'rate_limit');
});

test('"too many requests" → rate_limit', () => {
  assert.equal(classify429(429, 'too many requests'), 'rate_limit');
});

test('QPS burst (请求频率) → rate_limit', () => {
  assert.equal(classify429(429, '请求频率过高'), 'rate_limit');
});

// ── precedence: a quota outage tagged rate_limit_error must win as quota ──
test('quota keyword beats rate_limit_error type tag', () => {
  const body = '{"type":"rate_limit_error","message":"quota_exceeded"}';
  assert.equal(classify429(429, body), 'quota');
});

// ── non-429 → unknown ──
test('400 is unknown', () => {
  assert.equal(classify429(400, 'bad request'), 'unknown');
});

test('empty body 429 → unknown', () => {
  assert.equal(classify429(429, ''), 'unknown');
});

// ── parseQuotaResetEpochMs ──
test('parse "reset at YYYY-MM-DD HH:mm:ss"', () => {
  const ms = parseQuotaResetEpochMs('reset at 2026-07-10 12:00:00');
  assert.equal(ms, new Date('2026-07-10 12:00:00').getTime());
});

test('no reset string → null', () => {
  assert.equal(parseQuotaResetEpochMs('余额不足'), null);
});
