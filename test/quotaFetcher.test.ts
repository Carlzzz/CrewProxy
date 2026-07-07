import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectQuotaProvider, parseGlmTiers, parseMinimaxTiers, QuotaFetcher } from '../src/quotaFetcher';

// ── detectQuotaProvider ──
test('detect GLM by bigmodel.cn', () => {
  assert.equal(detectQuotaProvider('https://open.bigmodel.cn/api/paas/v4'), 'glm');
});
test('detect MiniMax by minimaxi.com', () => {
  assert.equal(detectQuotaProvider('https://api.minimaxi.com/v1'), 'minimax');
});
test('unknown provider returns null (ark)', () => {
  assert.equal(detectQuotaProvider('https://ark.cn-beijing.volces.com/api/v3'), null);
});

// ── parseGlmTiers (translate cc-switch zhipu tests) ──
test('GLM: unit==3 → five_hour, unit==6 → weekly', () => {
  const data = { limits: [
    { type: 'TOKENS_LIMIT', unit: 6, number: 7, percentage: 42.0, nextResetTime: 1_000_003_600_000 },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1.0,  nextResetTime: 1_000_018_000_000 },
    { type: 'TIME_LIMIT', percentage: 7 },
  ]};
  const tiers = parseGlmTiers(data);
  assert.equal(tiers.fiveHour!.usedPct, 1.0);
  assert.equal(tiers.weekly!.usedPct, 42.0);
});

test('GLM: only one TOKENS_LIMIT falls back to five_hour', () => {
  const data = { limits: [{ type: 'TOKENS_LIMIT', percentage: 12.0, nextResetTime: 1_774_967_594_803 }] };
  const tiers = parseGlmTiers(data);
  assert.equal(tiers.fiveHour!.usedPct, 12.0);
  assert.equal(tiers.weekly, undefined);
});

test('GLM: no TOKENS_LIMIT returns empty', () => {
  assert.deepEqual(parseGlmTiers({ limits: [{ type: 'TIME_LIMIT', percentage: 5 }] }), {});
});

// ── parseMinimaxTiers (translate cc-switch minimax tests) ──
test('MiniMax: general 5h + weekly from remaining percent', () => {
  const body = { model_remains: [
    { model_name: 'general', current_interval_remaining_percent: 98.0, current_weekly_remaining_percent: 95.0,
      current_weekly_status: 1, end_time: 1_780_329_600_000, weekly_end_time: 1_780_848_000_000 },
    { model_name: 'video', current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
  ], base_resp: { status_code: 0 } };
  const tiers = parseMinimaxTiers(body);
  assert.equal(tiers.fiveHour!.usedPct, 2.0);   // 100 - 98
  assert.equal(tiers.weekly!.usedPct, 5.0);     // 100 - 95
});

test('MiniMax: weekly_status != 1 skips weekly tier', () => {
  const body = { model_remains: [{
    model_name: 'general', current_interval_remaining_percent: 99,
    current_weekly_remaining_percent: 100, current_weekly_status: 3,
  }]};
  const tiers = parseMinimaxTiers(body);
  assert.equal(tiers.fiveHour!.usedPct, 1.0);
  assert.equal(tiers.weekly, undefined);
});

test('MiniMax: missing general returns empty', () => {
  assert.deepEqual(parseMinimaxTiers({ model_remains: [{ model_name: 'video', current_interval_remaining_percent: 100 }] }), {});
});

// ── QuotaFetcher snapshot lifecycle (injected fetch) ──
test('QuotaFetcher stores snapshot after refresh with injected fetch', async () => {
  let calls = 0;
  const fakeFetch = (async (url: string, init: any) => {
    calls++;
    const u = String(url);
    if (u.includes('bigmodel.cn')) {
      return new Response(JSON.stringify({ success: true, data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 30.0, nextResetTime: 1_800_000_000_000 },
      ]}}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1_700_000_000_000 });
  qf.reload([{ upstreamId: 'glm', credentialId: 'glm-key1', apiKey: 'KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }]);
  await qf.refreshOnce();
  const snap = qf.getSnapshot();
  const entry = snap.get('glm\0glm-key1')!;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.fiveHour!.usedPct, 30.0);
  assert.ok(calls >= 1);
});

test('QuotaFetcher marks expired on 401', async () => {
  const fakeFetch = (async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1 });
  qf.reload([{ upstreamId: 'minimax', credentialId: 'mm1', apiKey: 'K', baseURL: 'https://api.minimaxi.com/v1' }]);
  await qf.refreshOnce();
  assert.equal(qf.getSnapshot().get('minimax\0mm1')!.status, 'expired');
});

test('QuotaFetcher not_configured for unknown provider', async () => {
  const qf = new QuotaFetcher({ now: () => 1 });
  qf.reload([{ upstreamId: 'ark', credentialId: 'ark1', apiKey: 'K', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' }]);
  await qf.refreshOnce();
  assert.equal(qf.getSnapshot().get('ark\0ark1')!.status, 'not_configured');
});

// ── Fix 1b: retain last successful tiers across a transient error ──
test('QuotaFetcher retains prior tiers when a refresh returns HTTP error', async () => {
  let calls = 0;
  const fakeFetch = (async (url: string) => {
    calls++;
    const u = String(url);
    if (!u.includes('bigmodel.cn')) return new Response('not found', { status: 404 });
    if (calls === 1) {
      return new Response(JSON.stringify({ success: true, data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 27.5, nextResetTime: 1_800_000_000_000 },
      ]}}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // second call: transient server error
    return new Response('server error', { status: 500 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1_700_000_000_000 });
  qf.reload([{ upstreamId: 'glm', credentialId: 'glm-key1', apiKey: 'KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }]);

  await qf.refreshOnce();
  const afterFirst = qf.getSnapshot().get('glm\0glm-key1')!;
  assert.equal(afterFirst.status, 'ok');
  assert.equal(afterFirst.fiveHour!.usedPct, 27.5);

  await qf.refreshOnce();
  const afterSecond = qf.getSnapshot().get('glm\0glm-key1')!;
  assert.equal(afterSecond.status, 'error');
  assert.equal(afterSecond.error, 'GLM HTTP 500');
  // prior tiers must survive the transient error (Fix 1b)
  assert.ok(afterSecond.fiveHour, 'fiveHour must be retained from prior success');
  assert.equal(afterSecond.fiveHour!.usedPct, 27.5);
});
