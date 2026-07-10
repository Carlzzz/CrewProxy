import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectQuotaProvider, parseGlmTiers, parseMinimaxTiers, QuotaFetcher,
  parseAfpTiers, parseCodingPlanTiers, volcRegion, volcCanonicalQuery, volcSign,
  volcIsAuthErrorCode, volcResponseError, parseDeepseekBalance } from '../src/quotaFetcher';
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

// ── 火山方舟 Agent Plan / Coding Plan（移植自 cc-switch coding_plan.rs 单测）──

test('detect Volcengine by volces.com/api/coding (not /api/v3)', () => {
  assert.equal(detectQuotaProvider('https://ark.cn-beijing.volces.com/api/coding'), 'volcengine');
  assert.equal(detectQuotaProvider('https://ark.cn-beijing.volces.com/api/coding/v3'), 'volcengine');
  // 数据面按量付费入口无套餐额度，不命中
  assert.equal(detectQuotaProvider('https://ark.cn-beijing.volces.com/api/v3'), null);
});

test('volcRegion derivation', () => {
  assert.equal(volcRegion('https://ark.cn-beijing.volces.com/api/coding'), 'cn-beijing');
  assert.equal(volcRegion('https://ark.cn-shanghai.volces.com/api/coding/v3'), 'cn-shanghai');
  assert.equal(volcRegion('https://example.com/api/coding'), 'cn-beijing');
});

test('parseAfpTiers: three windows, daily skipped, Quota<=0 skipped', () => {
  const result = {
    PlanType: 'Large',
    AFPFiveHour: { Quota: 50.0, Used: 12.5, ResetTime: 1778806800000 },
    AFPDaily: { Quota: 100.0, Used: 22.5, ResetTime: 1778803200000 },
    AFPWeekly: { Quota: 500.0, Used: 150.0, ResetTime: 1779062400000 },
    AFPMonthly: { Quota: 2000.0, Used: 850.5, ResetTime: 1780531200000 },
  };
  const t = parseAfpTiers(result);
  assert.ok(Math.abs(t.fiveHour!.usedPct - 25.0) < 1e-9);
  assert.ok(Math.abs(t.weekly!.usedPct - 30.0) < 1e-9);
  assert.ok(Math.abs(t.monthly!.usedPct - 42.525) < 1e-9);
  assert.ok(t.monthly!.resetsAt);
});

test('parseAfpTiers: all Quota=0 → empty (triggers Coding Plan fallback)', () => {
  const t = parseAfpTiers({ AFPFiveHour: { Quota: 0, Used: 0 }, AFPWeekly: { Quota: 0, Used: 0 } });
  assert.deepEqual(t, {});
});

test('parseCodingPlanTiers: real Level response, session -1 reset → null', () => {
  const result = { QuotaUsage: [
    { Level: 'session', Percent: 0.0, ResetTimestamp: -1 },
    { Level: 'weekly', Percent: 1.672568, ResetTimestamp: 1782057600 },
    { Level: 'monthly', Percent: 0.836284, ResetTimestamp: 1784303999 },
  ]};
  const t = parseCodingPlanTiers(result);
  assert.equal(t.fiveHour!.usedPct, 0.0);
  assert.equal(t.fiveHour!.resetsAt, null);
  assert.ok(Math.abs(t.weekly!.usedPct - 1.672568) < 1e-6);
  assert.ok(t.weekly!.resetsAt);
  assert.ok(Math.abs(t.monthly!.usedPct - 0.836284) < 1e-6);
});

test('volcCanonicalQuery is sorted and encoded', () => {
  assert.equal(volcCanonicalQuery('GetAFPUsage', 'cn-beijing'),
    'Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01');
});

test('volcSign structure + determinism (empty body sha, scope, header order)', () => {
  const now = new Date('2024-06-21T00:00:00Z');
  const query = volcCanonicalQuery('GetAFPUsage', 'cn-beijing');
  const { authorization, xDate, xContentSha256 } = volcSign('AKLTtest', 'secretkey', 'cn-beijing', query, Buffer.alloc(0), now);
  // 空 body 的 SHA-256 固定值
  assert.equal(xContentSha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(xDate, '20240621T000000Z');
  assert.ok(authorization.startsWith('HMAC-SHA256 Credential=AKLTtest/20240621/cn-beijing/ark/request,'), authorization);
  assert.ok(authorization.includes('SignedHeaders=host;x-date;x-content-sha256;content-type,'), authorization);
  const sig = authorization.split('Signature=').pop()!;
  assert.equal(sig.length, 64);
  assert.ok(/^[0-9a-f]+$/.test(sig));
  // 确定性
  const again = volcSign('AKLTtest', 'secretkey', 'cn-beijing', query, Buffer.alloc(0), now);
  assert.equal(authorization, again.authorization);
});

test('volcIsAuthErrorCode + volcResponseError extraction', () => {
  assert.ok(volcIsAuthErrorCode('AccessDenied'));
  assert.ok(volcIsAuthErrorCode('SignatureDoesNotMatch'));
  assert.ok(!volcIsAuthErrorCode('InvalidParameter.Action'));
  const err = volcResponseError({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'no permission' } } });
  assert.deepEqual(err, { code: 'AccessDenied', message: 'no permission' });
  assert.equal(volcResponseError({ ResponseMetadata: { RequestId: 'x' }, Result: {} }), null);
});

test('QuotaFetcher: Volcengine account credential, AFP success', async () => {
  const fakeFetch = (async (url: string) => {
    const u = String(url);
    if (u.includes('open.volcengineapi.com') && u.includes('GetAFPUsage')) {
      return new Response(JSON.stringify({ Result: {
        PlanType: 'Large',
        AFPFiveHour: { Quota: 100, Used: 20, ResetTime: 1778806800000 },
        AFPWeekly: { Quota: 500, Used: 150 },
        AFPMonthly: { Quota: 2000, Used: 400 },
      }}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1_700_000_000_000 });
  qf.reload([{ upstreamId: 'ark', quotaMode: 'fetch', credentials: [{ upstreamId: 'ark', credentialId: 'account', apiKey: 'BEARER', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', accessKeyId: 'AKLTx', secretAccessKey: 'sk' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('ark\0account')!;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.fiveHour!.usedPct, 20);
  assert.equal(entry.weekly!.usedPct, 30);
  assert.equal(entry.monthly!.usedPct, 20);
});

test('QuotaFetcher: Volcengine falls back to Coding Plan when AFP empty', async () => {
  const fakeFetch = (async (url: string) => {
    const u = String(url);
    if (u.includes('GetAFPUsage')) {
      return new Response(JSON.stringify({ Result: { AFPFiveHour: { Quota: 0, Used: 0 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('GetCodingPlanUsage')) {
      return new Response(JSON.stringify({ Result: { QuotaUsage: [
        { Level: 'session', Percent: 5.0, ResetTimestamp: -1 },
        { Level: 'weekly', Percent: 12.0, ResetTimestamp: 1782057600 },
      ]}}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('x', { status: 404 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1 });
  qf.reload([{ upstreamId: 'ark', quotaMode: 'fetch', credentials: [{ upstreamId: 'ark', credentialId: 'account', apiKey: '', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', accessKeyId: 'AKLTx', secretAccessKey: 'sk' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('ark\0account')!;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.fiveHour!.usedPct, 5.0);
  assert.equal(entry.weekly!.usedPct, 12.0);
});

test('QuotaFetcher: Volcengine auth error → expired', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({
    ResponseMetadata: { Error: { Code: 'InvalidAuthorization', Message: 'bad sig' } },
  }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1 });
  qf.reload([{ upstreamId: 'ark', quotaMode: 'fetch', credentials: [{ upstreamId: 'ark', credentialId: 'account', apiKey: '', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', accessKeyId: 'AKLTx', secretAccessKey: 'sk' }] }]);
  await qf.refreshOnce();
  assert.equal(qf.getSnapshot().get('ark\0account')!.status, 'expired');
});

test('QuotaFetcher: Volcengine missing AK/SK → not_configured', async () => {
  const qf = new QuotaFetcher({ now: () => 1 });
  qf.reload([{ upstreamId: 'ark', quotaMode: 'fetch', credentials: [{ upstreamId: 'ark', credentialId: 'account', apiKey: '', baseURL: 'https://ark.cn-beijing.volces.com/api/coding' }] }]);
  await qf.refreshOnce();
  assert.equal(qf.getSnapshot().get('ark\0account')!.status, 'not_configured');
});

// ── DeepSeek 账户余额（移植自 cc-switch services/balance.rs）──

test('detect DeepSeek by api.deepseek.com', () => {
  assert.equal(detectQuotaProvider('https://api.deepseek.com/anthropic'), 'deepseek');
});

test('parseDeepseekBalance: picks currency with balance, carries is_available', () => {
  const b = parseDeepseekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '0', granted_balance: '0', topped_up_balance: '0' },
      { currency: 'CNY', total_balance: '42.68', granted_balance: '0', topped_up_balance: '42.68' },
    ],
  })!;
  assert.equal(b.remaining, 42.68);
  assert.equal(b.currency, 'CNY');
  assert.equal(b.isValid, true);
});

test('parseDeepseekBalance: falls back to first info, propagates is_available=false', () => {
  const b = parseDeepseekBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: 0 }] })!;
  assert.equal(b.remaining, 0);
  assert.equal(b.currency, 'CNY');
  assert.equal(b.isValid, false);
});

test('parseDeepseekBalance: empty balance_infos → undefined', () => {
  assert.equal(parseDeepseekBalance({ is_available: true, balance_infos: [] }), undefined);
  assert.equal(parseDeepseekBalance({}), undefined);
});

test('QuotaFetcher: DeepSeek balance success', async () => {
  const fakeFetch = (async (url: string, init: any) => {
    assert.ok(String(url).includes('api.deepseek.com/user/balance'));
    assert.equal(init.headers['Authorization'], 'Bearer DS-KEY');
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '88.5', granted_balance: '0', topped_up_balance: '88.5' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1 });
  qf.reload([{ upstreamId: 'deepseek', quotaMode: 'fetch', credentials: [{ upstreamId: 'deepseek', credentialId: 'account', apiKey: 'DS-KEY', baseURL: 'https://api.deepseek.com/anthropic' }] }]);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('deepseek\0account')!;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.balance!.remaining, 88.5);
  assert.equal(entry.balance!.currency, 'CNY');
  assert.equal(entry.balance!.isValid, true);
});

test('QuotaFetcher: DeepSeek 401 → expired', async () => {
  const fakeFetch = (async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1 });
  qf.reload([{ upstreamId: 'deepseek', quotaMode: 'fetch', credentials: [{ upstreamId: 'deepseek', credentialId: 'account', apiKey: 'K', baseURL: 'https://api.deepseek.com/anthropic' }] }]);
  await qf.refreshOnce();
  assert.equal(qf.getSnapshot().get('deepseek\0account')!.status, 'expired');
});

test('QuotaFetcher: DeepSeek retains prior balance on transient error', async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('boom', { status: 500 });
  }) as unknown as typeof fetch;

  const qf = new QuotaFetcher({ fetchImpl: fakeFetch, now: () => 1 });
  qf.reload([{ upstreamId: 'deepseek', quotaMode: 'fetch', credentials: [{ upstreamId: 'deepseek', credentialId: 'account', apiKey: 'K', baseURL: 'https://api.deepseek.com/anthropic' }] }]);
  await qf.refreshOnce();
  assert.equal(qf.getSnapshot().get('deepseek\0account')!.balance!.remaining, 10);
  await qf.refreshOnce();
  const entry = qf.getSnapshot().get('deepseek\0account')!;
  assert.equal(entry.status, 'error');
  assert.equal(entry.balance!.remaining, 10, 'prior balance retained through transient error');
});
