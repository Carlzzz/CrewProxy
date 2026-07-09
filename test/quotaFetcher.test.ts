import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectQuotaProvider, parseGlmTiers, parseMinimaxTiers, QuotaFetcher } from '../src/quotaFetcher';
import { TokenUsageTracker } from '../src/tokenUsageTracker';

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
  qf.reload([{ upstreamId: 'glm', quotaMode: 'fetch', credentials: [{ upstreamId: 'glm', credentialId: 'glm-key1', apiKey: 'KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }] }]);
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
  qf.reload([{ upstreamId: 'minimax', quotaMode: 'fetch', credentials: [{ upstreamId: 'minimax', credentialId: 'mm1', apiKey: 'K', baseURL: 'https://api.minimaxi.com/v1' }] }]);
  await qf.refreshOnce();
  assert.equal(qf.getSnapshot().get('minimax\0mm1')!.status, 'expired');
});

test('QuotaFetcher not_configured for unknown provider', async () => {
  const qf = new QuotaFetcher({ now: () => 1 });
  qf.reload([{ upstreamId: 'ark', quotaMode: 'fetch', credentials: [{ upstreamId: 'ark', credentialId: 'ark1', apiKey: 'K', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' }] }]);
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
  qf.reload([{ upstreamId: 'glm', quotaMode: 'fetch', credentials: [{ upstreamId: 'glm', credentialId: 'glm-key1', apiKey: 'KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }] }]);

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

// ── estimated mode: skip API, compute usedPct from TokenUsageTracker + quotaLimits ──
test('estimated mode: skips fetch, computes usedPct from tracker + quotaLimits', async () => {
  const tracker = new TokenUsageTracker({ now: () => 10_000_000_000 });
  tracker.record('glm', 16_000_000, 9_990_000_000);   // 5h 窗口内 1600万 = 10% of 1.6亿（也在周窗口内）
  tracker.record('glm', 64_000_000, 9_500_000_000);   // 周窗口内累计 8000万（16+64）= 10% of 8亿

  // estimated 模式不应发起任何 HTTP —— 用一个会失败的 fetchImpl 验证它没被调用
  let calls = 0;
  const failFetch = (async () => { calls++; return new Response('x', { status: 500 }); }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: failFetch, now: () => 1, tokenUsageTracker: tracker });
  qf.reload([{
    upstreamId: 'glm', quotaMode: 'estimated',
    quotaLimits: { fiveHourTokens: 160_000_000, weeklyTokens: 800_000_000 },
    credentials: [{ upstreamId: 'glm', credentialId: 'glm-key1', apiKey: 'K', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }],
  }]);
  await qf.refreshOnce();

  assert.equal(calls, 0, 'estimated mode must not call fetch');
  const entry = qf.getSnapshot().get('glm\0glm-key1')!;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.estimated, true);
  assert.ok(Math.abs(entry.fiveHour!.usedPct - 10) < 0.001);
  assert.ok(Math.abs(entry.weekly!.usedPct - 10) < 0.001);
  assert.equal(entry.fiveHour!.resetsAt, null);
});

test('estimated mode: shares one account-level quota across all credentials', async () => {
  const tracker = new TokenUsageTracker({ now: () => 10_000_000_000 });
  tracker.record('glm', 32_000_000, 9_990_000_000);  // 20% of 1.6亿
  const qf = new QuotaFetcher({ now: () => 1, tokenUsageTracker: tracker });
  qf.reload([{
    upstreamId: 'glm', quotaMode: 'estimated',
    quotaLimits: { fiveHourTokens: 160_000_000 },
    credentials: [
      { upstreamId: 'glm', credentialId: 'glm-key1', apiKey: 'K1', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
      { upstreamId: 'glm', credentialId: 'glm-key2', apiKey: 'K2', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
    ],
  }]);
  await qf.refreshOnce();
  const snap = qf.getSnapshot();
  assert.equal(snap.get('glm\0glm-key1')!.fiveHour!.usedPct, 20);
  assert.equal(snap.get('glm\0glm-key2')!.fiveHour!.usedPct, 20);
});

test('estimated mode without quotaLimits yields undefined tiers but status ok', async () => {
  const tracker = new TokenUsageTracker({ now: () => 10_000_000_000 });
  tracker.record('glm', 1000, 9_990_000_000);
  const qf = new QuotaFetcher({ now: () => 1, tokenUsageTracker: tracker });
  qf.reload([{ upstreamId: 'glm', quotaMode: 'estimated', credentials: [{ upstreamId: 'glm', credentialId: 'k1', apiKey: 'K', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('glm\0k1')!;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.estimated, true);
  assert.equal(entry.fiveHour, undefined);
});

test('fetch mode (default) still calls the API — unaffected by estimated work', async () => {
  // 用既有测试范式：注入返回 ok GLM payload 的 fetchImpl，确认 fetch 模式照常
  const fakeFetch = (async (url: string) => {
    if (String(url).includes('bigmodel.cn')) {
      return new Response(JSON.stringify({ success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 5, nextResetTime: 1_800_000_000_000 }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('x', { status: 404 });
  }) as unknown as typeof fetch;
  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1, tokenUsageTracker: new TokenUsageTracker() });
  qf.reload([{ upstreamId: 'glm', quotaMode: 'fetch', credentials: [{ upstreamId: 'glm', credentialId: 'k1', apiKey: 'K', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('glm\0k1')!;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.estimated, undefined);   // fetch 模式不带 estimated 标志
  assert.equal(entry.fiveHour!.usedPct, 5);
});

// ── GLM team-plan fallback: 官方团队套餐没有余量查询接口 ──
// 接口返回 success=false / "当前用户不存在coding plan"。此时若配了 quotaLimits，
// 应回退到 estimated 模式（用 TokenUsageTracker 估算），而不是把面板钉死在 error。
test('GLM fetch: 团队套餐 "不存在coding plan" + quotaLimits → 回退 estimated', async () => {
  const fakeFetch = (async (url: string) => {
    if (String(url).includes('bigmodel.cn')) {
      return new Response(JSON.stringify({ code: 500, success: false, msg: '当前用户不存在coding plan' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('x', { status: 404 });
  }) as unknown as typeof fetch;

  const tracker = new TokenUsageTracker({ now: () => 10_000_000_000 });
  tracker.record('glm', 16_000_000, 9_990_000_000); // 5h 内 1600万 = 10% of 1.6亿

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 10_000_000_000, tokenUsageTracker: tracker });
  qf.reload([{
    upstreamId: 'glm', quotaMode: 'fetch',
    quotaLimits: { fiveHourTokens: 160_000_000, weeklyTokens: 800_000_000 },
    credentials: [{ upstreamId: 'glm', credentialId: 'glm-key1', apiKey: 'K', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }],
  }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('glm\0glm-key1')!;
  assert.equal(entry.status, 'ok', '应回退为 ok 而非 error/not_configured');
  assert.equal(entry.estimated, true, '回退后必须标记为 estimated');
  assert.ok(Math.abs(entry.fiveHour!.usedPct - 10) < 0.001, '应使用 TokenUsageTracker 估算的 usedPct');
});

test('GLM fetch: 团队套餐无 quotaLimits → 保持 not_configured（无法估算）', async () => {
  const fakeFetch = (async (url: string) => {
    if (String(url).includes('bigmodel.cn')) {
      return new Response(JSON.stringify({ success: false, msg: '当前用户不存在coding plan' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('x', { status: 404 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1, tokenUsageTracker: new TokenUsageTracker() });
  qf.reload([{ upstreamId: 'glm', quotaMode: 'fetch', credentials: [{ upstreamId: 'glm', credentialId: 'k1', apiKey: 'K', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('glm\0k1')!;
  assert.equal(entry.status, 'not_configured');
  assert.equal(entry.estimated, undefined);
});

test('GLM fetch: 其它 success=false 错误不触发回退（仍为 error）', async () => {
  const fakeFetch = (async (url: string) => {
    if (String(url).includes('bigmodel.cn')) {
      return new Response(JSON.stringify({ success: false, msg: '内部错误' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('x', { status: 404 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1, tokenUsageTracker: new TokenUsageTracker() });
  qf.reload([{ upstreamId: 'glm', quotaMode: 'fetch', quotaLimits: { fiveHourTokens: 160_000_000 }, credentials: [{ upstreamId: 'glm', credentialId: 'k1', apiKey: 'K', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('glm\0k1')!;
  assert.equal(entry.status, 'error', '非"不存在coding plan"错误不应回退');
  assert.equal(entry.estimated, undefined);
});

test('MiniMax fetch: error 不受 GLM 回退逻辑影响', async () => {
  const fakeFetch = (async (url: string) => {
    if (String(url).includes('minimaxi.com')) {
      return new Response(JSON.stringify({ base_resp: { status_code: 1001, status_msg: '不存在coding plan' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('x', { status: 404 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1, tokenUsageTracker: new TokenUsageTracker() });
  qf.reload([{ upstreamId: 'minimax', quotaMode: 'fetch', quotaLimits: { fiveHourTokens: 160_000_000 }, credentials: [{ upstreamId: 'minimax', credentialId: 'mm1', apiKey: 'K', baseURL: 'https://api.minimaxi.com/v1' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('minimax\0mm1')!;
  assert.equal(entry.status, 'error', 'MiniMax 错误不应触发 GLM 专属回退');
});
