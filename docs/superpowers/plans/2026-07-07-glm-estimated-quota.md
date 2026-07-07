# GLM 团队版配额预估 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **跨两个仓库**：Task 1-7 在 `CrewProxy`（分支 `feat/glm-estimated-quota`，已含 spec commit `a49b899`）；Task 8 在 `CrewCentral`（新开分支 `feat/glm-estimated-quota`）。设计依据：`CrewProxy/docs/superpowers/specs/2026-07-07-glm-estimated-quota-design.md`。

**Goal:** GLM 团队版 coding plan 查不到真实余量时，由网关统计 token 用量，按已知总量（5h 1.6亿、周 8亿）预估已用百分比并展示。

**Architecture:** 新增 `TokenUsageTracker`（per-upstream 5h/7天滚动窗口 token 累加，内存）；`UpstreamConfig` 加 `quotaMode:"estimated"`；`QuotaFetcher` 对 estimated upstream 跳过官方查询、用 tracker + quotaLimits 算 quota（账号共享）；`/metrics` 的 quota 加 `estimated` 标志；前端 QuotaGrid 加「预估」角标。

**Tech Stack:** CrewProxy: TypeScript 5.7 / Node ≥18 / `node:test`+`tsx`。CrewCentral: React 18 + TS + echarts（无前端测试框架）。

## Global Constraints

- CrewProxy: Node ≥18，TS 5.7，`tsc` 编译，无框架。测试 `npm test`（`tsx --test test/**/*.test.ts`）。
- `quotaMode` 默认 `"fetch"`（保持 Plan 1 行为）；`"estimated"` 跳过官方查询。
- `TokenUsageTracker.record()` 必须 try/catch，绝不影响代理主路径（同 `MetricsCollector.record` 原则）。
- 滚动窗口：5h 用 1min 桶 × 300，7 天用 1h 桶 × 168；过期桶清理。
- 重启归零（纯内存，不持久化）。
- per-upstream 统计：estimated 是 upstream 级配置，该 upstream 下所有 credential 共享同一个账号级预估 quota。
- estimated quota 的 `resetsAt` 为 `null`（滚动窗口无明确重置点）。
- CrewProxy `/metrics` 鉴权对齐 `/models`（Plan 1，本计划不动）。
- CrewCentral 前端无测试框架，Task 8 验证靠 `tsc -b && vite build` + 手动。

## File Structure

| 文件 | 责任 | 动作 | 仓库 |
|---|---|---|---|
| `src/config.ts` | `UpstreamConfig.quotaMode` + `normalizeUpstream` 解析 | 修改 | CrewProxy |
| `src/tokenUsageTracker.ts` | per-upstream 5h/周 token 滚动窗口 | 新建 | CrewProxy |
| `src/quotaFetcher.ts` | `estimated` 字段 + reload per-upstream + refreshOnce estimated 分支 | 修改 | CrewProxy |
| `src/proxy.ts` | recordMetric 闭包加 tokenUsage.record | 修改 | CrewProxy |
| `src/metricsPayload.ts` | credential 输出加 `estimated` 透传 | 修改 | CrewProxy |
| `src/index.ts` | 注入 tokenUsage + buildQuotaUpstreams | 修改 | CrewProxy |
| `proxy-config.json` | GLM 加 quotaMode + weeklyTokens | 修改 | CrewProxy |
| `frontend/src/lib/gateway-api.ts` | `CredentialQuota.estimated` | 修改 | CrewCentral |
| `frontend/src/components/gateway/QuotaGrid.tsx` | 预估角标 + resetsAt null 文案 | 修改 | CrewCentral |

---

## Task 1: config 加 quotaMode

**仓库**: CrewProxy  **Files:**
- Modify: `src/config.ts`（`UpstreamConfig` 接口 + `normalizeUpstream`）
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `UpstreamConfig.quotaMode?: 'fetch' | 'estimated'`（默认 undefined = fetch）

- [ ] **Step 1: 写失败测试**

追加到 `test/config.test.ts`：
```ts
import { normalizeUpstream } from '../src/config';
// ... 既有 import ...

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
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/config.test.ts`
Expected: FAIL（`quottaMode` 不在类型上 / 解析后 undefined）

- [ ] **Step 3: 实现 — 改 `src/config.ts`**

`UpstreamConfig` 接口加字段（在 `quotaLimits?` 旁）：
```ts
export interface UpstreamConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  provider?: string;
  codePlanCredentials?: CodePlanCredential[];
  codePlanBaseURL?: string;
  codePlanAnthropicBaseURL?: string;
  ordinaryFallbackModelMap?: Record<string, string>;
  quotaLimits?: { fiveHourTokens?: number; weeklyTokens?: number };
  quotaMode?: 'fetch' | 'estimated';
}
```

`normalizeUpstream` 里（`quotaLimits` 解析块之后、`return out` 之前）加：
```ts
  if (o.quotaMode === 'fetch' || o.quotaMode === 'estimated') {
    out.quotaMode = o.quotaMode;
  }
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- --test test/config.test.ts`
Expected: 全部 config 测试 PASS（含 3 个新测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `npm run build`
```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): parse optional quotaMode per upstream"
```

---

## Task 2: TokenUsageTracker

**仓库**: CrewProxy  **Files:**
- Create: `src/tokenUsageTracker.ts`
- Test: `test/tokenUsageTracker.test.ts`

**Interfaces:**
- Produces:
  - `class TokenUsageTracker { constructor(opts?: { now?: () => number }); record(upstreamId: string, tokens: number, ts?: number): void; getUsage(upstreamId: string): { fiveHourTokens: number; weeklyTokens: number }; }`
  - 常量 `TOKEN_FIVEHOUR_BUCKET_MS = 60_000`（1min）、`TOKEN_WEEKLY_BUCKET_MS = 3_600_000`（1h）、保留 5h=300 桶 / 周=168 桶

- [ ] **Step 1: 写失败测试**

`test/tokenUsageTracker.test.ts`：
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenUsageTracker } from '../src/tokenUsageTracker';

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
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/tokenUsageTracker.test.ts`
Expected: FAIL（`Cannot find module '../src/tokenUsageTracker'`）

- [ ] **Step 3: 实现 `src/tokenUsageTracker.ts`**

```ts
import { logger } from './logger';

export const TOKEN_FIVEHOUR_BUCKET_MS = 60_000;      // 1 min
export const TOKEN_WEEKLY_BUCKET_MS = 3_600_000;     // 1 hour
const FIVEHOUR_WINDOW_MS = 5 * 3_600_000;            // 5h
const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;         // 7d

interface WindowLog {
  buckets: Map<number, number>;  // bucketStartMs → token sum
}

/**
 * Per-upstream rolling-window token accumulator. Two independent windows:
 *  - 5h, 1-min buckets (300 buckets max)
 *  - 7d, 1-hour buckets (168 buckets max)
 *
 * Pure in-memory; resets on restart. record() is try/catch-guarded so it can
 * never break the proxy hot path (same contract as MetricsCollector).
 */
export class TokenUsageTracker {
  private byUpstream = new Map<string, { fiveHour: WindowLog; weekly: WindowLog }>();
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  record(upstreamId: string, tokens: number, ts?: number): void {
    try {
      if (!upstreamId || !Number.isFinite(tokens) || tokens <= 0) return;
      const t = Number.isFinite(ts as number) ? (ts as number) : this.now();
      if (!Number.isFinite(t)) return;
      let entry = this.byUpstream.get(upstreamId);
      if (!entry) {
        entry = { fiveHour: { buckets: new Map() }, weekly: { buckets: new Map() } };
        this.byUpstream.set(upstreamId, entry);
      }
      this.put(entry.fiveHour, t, tokens, TOKEN_FIVEHOUR_BUCKET_MS, FIVEHOUR_WINDOW_MS);
      this.put(entry.weekly, t, tokens, TOKEN_WEEKLY_BUCKET_MS, WEEKLY_WINDOW_MS);
    } catch (err) {
      logger.error('[tokenUsage] record failed:', err);
    }
  }

  private put(log: WindowLog, ts: number, tokens: number, bucketMs: number, _windowMs: number): void {
    const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    log.buckets.set(bucketTs, (log.buckets.get(bucketTs) ?? 0) + tokens);
    this.prune(log, bucketMs);
  }

  private prune(log: WindowLog, bucketMs: number): void {
    const windowBuckets = bucketMs === TOKEN_FIVEHOUR_BUCKET_MS ? 300 : 168;
    if (log.buckets.size <= windowBuckets) return;
    const sorted = [...log.buckets.keys()].sort((a, b) => a - b);
    const remove = sorted.length - windowBuckets;
    for (let i = 0; i < remove; i++) log.buckets.delete(sorted[i]);
  }

  getUsage(upstreamId: string): { fiveHourTokens: number; weeklyTokens: number } {
    const entry = this.byUpstream.get(upstreamId);
    if (!entry) return { fiveHourTokens: 0, weeklyTokens: 0 };
    return {
      fiveHourTokens: this.sumSince(entry.fiveHour, FIVEHOUR_WINDOW_MS, TOKEN_FIVEHOUR_BUCKET_MS),
      weeklyTokens: this.sumSince(entry.weekly, WEEKLY_WINDOW_MS, TOKEN_WEEKLY_BUCKET_MS),
    };
  }

  private sumSince(log: WindowLog, windowMs: number, bucketMs: number): number {
    const cutoff = this.now() - windowMs;
    const cutoffBucket = Math.floor(cutoff / bucketMs) * bucketMs;
    let sum = 0;
    for (const [bucketTs, tokens] of log.buckets) {
      if (bucketTs >= cutoffBucket) sum += tokens;
    }
    return sum;
  }
}
```

> 说明：`ts` 缺省时取 `this.now()`；`record` 对空 upstreamId / NaN / 非正 tokens 静默忽略（第 7 个测试期望 NaN 不贡献有效值）。

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- --test test/tokenUsageTracker.test.ts`
Expected: 7 个测试 PASS

- [ ] **Step 5: 类型检查 + Commit**

Run: `npm run build`
```bash
git add src/tokenUsageTracker.ts test/tokenUsageTracker.test.ts
git commit -m "feat(metrics): add TokenUsageTracker for 5h/weekly rolling token windows"
```

---

## Task 3: QuotaFetcher estimated 模式

**仓库**: CrewProxy  **Files:**
- Modify: `src/quotaFetcher.ts`
- Test: `test/quotaFetcher.test.ts`

**Interfaces:**
- Consumes: `TokenUsageTracker`（Task 2）、`quotaMode`/`quotaLimits`（config）
- Produces:
  - `CredentialQuota.estimated?: boolean`
  - `interface QuotaUpstreamRef { upstreamId: string; quotaMode: 'fetch' | 'estimated'; quotaLimits?: { fiveHourTokens?: number; weeklyTokens?: number }; credentials: QuotaCredentialRef[]; }`
  - `QuotaFetcher` 构造新增 `tokenUsageTracker?: TokenUsageTracker`；`reload(upstreams: QuotaUpstreamRef[])`；`refreshOnce` 对 estimated upstream 写账号共享 quota

- [ ] **Step 1: 写失败测试**

追加到 `test/quotaFetcher.test.ts`：
```ts
import { QuotaFetcher } from '../src/quotaFetcher';
import { TokenUsageTracker } from '../src/tokenUsageTracker';

test('estimated mode: skips fetch, computes usedPct from tracker + quotaLimits', async () => {
  const tracker = new TokenUsageTracker({ now: () => 10_000_000_000 });
  tracker.record('glm', 16_000_000, 9_990_000_000);   // 5h 窗口内 1600万 = 10% of 1.6亿
  tracker.record('glm', 80_000_000, 9_500_000_000);   // 周窗口内 8000万 = 10% of 8亿

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
```

> 既有 `test/quotaFetcher.test.ts`（Plan 1 Task 5）的测试用的是旧的 `reload(refs: QuotaCredentialRef[])` 签名。本 task 改了 reload 签名为 `reload(upstreams: QuotaUpstreamRef[])`，**既有测试需要相应迁移**：把每个旧测试的 `qf.reload([{upstreamId, credentialId, apiKey, baseURL}])` 改为 `qf.reload([{ upstreamId, quotaMode: 'fetch', credentials: [{upstreamId, credentialId, apiKey, baseURL}] }])`。实现 Step 3 时一并迁移。

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/quotaFetcher.test.ts`
Expected: FAIL（新测试：estimated 不存在 / reload 签名不匹配）

- [ ] **Step 3: 实现 — 改 `src/quotaFetcher.ts`**

(a) `CredentialQuota` 接口加字段（在 `error?` 旁）：
```ts
export interface CredentialQuota {
  fiveHour?: QuotaTierInfo;
  weekly?: QuotaTierInfo;
  status: QuotaStatus;
  error?: string;
  estimated?: boolean;
  queriedAt: number;
}
```

(b) 新增 `QuotaUpstreamRef` 接口（在 `QuotaCredentialRef` 之后）：
```ts
export interface QuotaUpstreamRef {
  upstreamId: string;
  quotaMode: 'fetch' | 'estimated';
  quotaLimits?: { fiveHourTokens?: number; weeklyTokens?: number };
  credentials: QuotaCredentialRef[];
}
```

(c) `QuotaFetcher` 类：构造加 `tokenUsageTracker`，`refs` 改为 `upstreams`，`reload` 改签名：
```ts
import type { TokenUsageTracker } from './tokenUsageTracker';

export class QuotaFetcher {
  private upstreams: QuotaUpstreamRef[] = [];
  private snapshot = new Map<string, CredentialQuota>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private tokenUsageTracker?: TokenUsageTracker;

  constructor(opts: { fetchImpl?: typeof fetch; intervalMs?: number; now?: () => number; tokenUsageTracker?: TokenUsageTracker } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.tokenUsageTracker = opts.tokenUsageTracker;
  }

  reload(upstreams: QuotaUpstreamRef[]): void {
    this.upstreams = upstreams;
  }
```

(d) `refreshOnce` 改造为遍历 upstreams，estimated 分支 + fetch 分支：
```ts
  async refreshOnce(): Promise<void> {
    await Promise.all(this.upstreams.map(async (u) => {
      if (u.quotaMode === 'estimated') {
        const quota = this.buildEstimatedQuota(u);
        for (const cred of u.credentials) {
          this.snapshot.set(`${u.upstreamId}\0${cred.credentialId}`, { ...quota });
        }
        return;
      }
      // fetch 模式：对每个 credential 调官方查询（Plan 1 既有逻辑）
      await Promise.all(u.credentials.map(async (ref) => {
        const key = `${u.upstreamId}\0${ref.credentialId}`;
        const provider = detectQuotaProvider(ref.baseURL);
        if (!provider) { this.snapshot.set(key, { status: 'not_configured', queriedAt: this.now() }); return; }
        try {
          const result = provider === 'glm' ? await queryGlm(ref, this.fetchImpl) : await queryMinimax(ref, this.fetchImpl);
          if (result.status === 'error') {
            const prior = this.snapshot.get(key);
            if (prior) {
              if (prior.fiveHour && !result.fiveHour) result.fiveHour = prior.fiveHour;
              if (prior.weekly && !result.weekly) result.weekly = prior.weekly;
            }
          }
          this.snapshot.set(key, result);
        } catch (err) {
          logger.error(`[quota] query failed for ${key}:`, err);
          const result: CredentialQuota = { status: 'error', error: String((err as Error)?.message ?? err), queriedAt: this.now() };
          const prior = this.snapshot.get(key);
          if (prior) {
            if (prior.fiveHour && !result.fiveHour) result.fiveHour = prior.fiveHour;
            if (prior.weekly && !result.weekly) result.weekly = prior.weekly;
          }
          this.snapshot.set(key, result);
        }
      }));
    }));
  }

  private buildEstimatedQuota(u: QuotaUpstreamRef): CredentialQuota {
    const out: CredentialQuota = { status: 'ok', estimated: true, queriedAt: this.now() };
    const usage = this.tokenUsageTracker?.getUsage(u.upstreamId) ?? { fiveHourTokens: 0, weeklyTokens: 0 };
    const fhLimit = u.quotaLimits?.fiveHourTokens;
    const wLimit = u.quotaLimits?.weeklyTokens;
    if (typeof fhLimit === 'number' && fhLimit > 0) {
      out.fiveHour = { usedPct: usage.fiveHourTokens / fhLimit * 100, resetsAt: null };
    }
    if (typeof wLimit === 'number' && wLimit > 0) {
      out.weekly = { usedPct: usage.weeklyTokens / wLimit * 100, resetsAt: null };
    }
    return out;
  }
```

(e) 迁移既有测试的 `reload(...)` 调用为新签名（见 Step 1 注记）。

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- --test test/quotaFetcher.test.ts`
Expected: 全部 quota 测试 PASS（含 4 个新测试 + 迁移后的既有测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `npm run build`
```bash
git add src/quotaFetcher.ts test/quotaFetcher.test.ts
git commit -m "feat(quota): estimated mode — skip API, compute usedPct from TokenUsageTracker"
```

---

## Task 4: 主路径埋点接入 tokenUsage

**仓库**: CrewProxy  **Files:**
- Modify: `src/proxy.ts`（`recordMetric` 闭包）、`src/config.ts`（`ProxyRuntimeContext.tokenUsage?`）

**Interfaces:**
- Consumes: `TokenUsageTracker`（Task 2）
- Produces: `ProxyRuntimeContext.tokenUsage?: TokenUsageTracker`；主路径每个出口的 `recordMetric` 闭包同步 `ctx.tokenUsage?.record(...)`

- [ ] **Step 1: 扩 `ProxyRuntimeContext`**

`src/config.ts` 的 `ProxyRuntimeContext` 接口加字段（在 `metrics?`/`quotaFetcher?` 旁）：
```ts
import type { TokenUsageTracker } from './tokenUsageTracker';
export interface ProxyRuntimeContext {
  // ... 既有字段 ...
  metrics?: MetricsCollector;
  quotaFetcher?: QuotaFetcher;
  tokenUsage?: TokenUsageTracker;
}
```

- [ ] **Step 2: 在 `recordMetric` 闭包里同步 record**

`src/proxy.ts` 的 `recordMetric` 闭包（Plan 1 Task 6 加的，在 `handleRequest` 内 `effectiveModel`/`upstreamRouteId`/`startMs` 之后）——在 `ctx.metrics?.record({...})` 旁加一行。改后的闭包形如：
```ts
  const recordMetric = (success: boolean, inTok: number, outTok: number): void => {
    const tokens = (inTok || 0) + (outTok || 0);
    ctx.tokenUsage?.record(upstreamRouteId ?? '__default__', tokens);
    ctx.metrics?.record({
      upstreamId: upstreamRouteId ?? '__default__',
      credentialId: usageExtra.routing_key ?? undefined,
      model: effectiveModel,
      success, inputTokens: inTok, outputTokens: outTok,
      costMs: Date.now() - startMs, ts: Date.now(),
    });
  };
```
> 定位：grep `const recordMetric =` 在 `src/proxy.ts`。在现有 `ctx.metrics?.record(...)` 调用**之前**插入 `ctx.tokenUsage?.record(...)` 一行。所有 5 个 `recordMetric(...)` 出口（Plan 1 Task 6）和 stream 函数的 2 个 `recordMetric?.(...)` 出口都因此自动同步 token 统计——无需改出口。

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: 通过（`ctx.tokenUsage` 此时还是 undefined 运行时，Task 6 注入；可选链安全）

- [ ] **Step 4: Commit**

```bash
git add src/proxy.ts src/config.ts
git commit -m "feat(metrics): record token usage per upstream in recordMetric closure"
```

> 埋点正确性靠 Task 2 的 TokenUsageTracker 单测 + Task 7 端到端验证（GLM 预估累积）。

---

## Task 5: /metrics 输出 estimated 标志

**仓库**: CrewProxy  **Files:**
- Modify: `src/metricsPayload.ts`
- Test: `test/metricsEndpoint.test.ts`

**Interfaces:**
- Consumes: `CredentialQuota.estimated`（Task 3）
- Produces: `/metrics` 的 credential 对象新增 `estimated?: boolean`

- [ ] **Step 1: 写失败测试**

追加到 `test/metricsEndpoint.test.ts` 一个测试（沿用 Plan 1 Task 7 的 server 启动范式）：构造一个 ctx，注入一个返回 `estimated:true` quota 的假 `quotaFetcher`（或直接 seed snapshot），断言 `/metrics` 的 credential 输出含 `estimated:true`。
```ts
test('/metrics surfaces estimated flag on credentials', async () => {
  process.env.WOICLAW_AUTH_BYPASS = '1';
  // 复用 Plan 1 Task 7 的 startServer 范式，但给 ctx.quotaFetcher 一个返回 estimated 的 snapshot
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([
      ['glm', { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        quotaMode: 'estimated', quotaLimits: { fiveHourTokens: 160_000_000 },
        codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true }] }],
    ]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map(),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000_000),
    quotaFetcher: { getSnapshot: () => new Map([['glm\0glm-key1', { status: 'ok', estimated: true, fiveHour: { usedPct: 10, resetsAt: null }, queriedAt: 1 }]]) } as any,
  };
  ctx.codePlanPool!.reconcileFromConfig({ upstreamsById: Object.fromEntries(ctx.upstreamsByIdMap) } as any);
  const server = createProxyServer(ctx);
  const { port } = await new Promise<{port:number}>(r => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as any).port })));
  try {
    const r = await get(port, '/metrics');
    const glm = r.body.providers.find((p: any) => p.upstreamId === 'glm');
    const cred = glm.credentials[0];
    assert.equal(cred.quotaStatus, 'ok');
    assert.equal(cred.quota.estimated, true);
    assert.equal(cred.quota.fiveHour.resetsAt, null);
    assert.equal(cred.quota.fiveHour.usedTokens, 16_000_000); // 10% of 1.6亿
  } finally { server.close(); delete process.env.WOICLAW_AUTH_BYPASS; }
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/metricsEndpoint.test.ts`
Expected: FAIL（`cred.quota.estimated` 为 undefined —— metricsPayload 没透传）

- [ ] **Step 3: 实现 — 改 `src/metricsPayload.ts`**

在 `credentials.map` 返回对象里加 `estimated`（在 `quotaError` 之后）：
```ts
      return {
        id: c.id,
        inCooldown: heat?.inCooldown ?? false,
        cooldownUntil: heat?.cooldownUntil ?? null,
        cooldownReason: heat?.cooldownReason ?? null,
        inFlight: ctx.codePlanPool?.getInFlight(upstreamId, c.id) ?? 0,
        requestsLast1h: heat?.requestsLast1h ?? 0,
        quota,
        quotaStatus: q?.status ?? 'not_configured',
        quotaError: q?.error ?? null,
        estimated: q?.estimated ?? false,
      };
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- --test test/metricsEndpoint.test.ts`
Expected: 全部 endpoint 测试 PASS

- [ ] **Step 5: 类型检查 + Commit**

Run: `npm run build`
```bash
git add src/metricsPayload.ts test/metricsEndpoint.test.ts
git commit -m "feat(metrics): surface estimated flag on credentials in /metrics"
```

---

## Task 6: index.ts 注入 TokenUsageTracker + buildQuotaUpstreams

**仓库**: CrewProxy  **Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `TokenUsageTracker`、`QuotaUpstreamRef`（Task 2/3）
- Produces: 启动的网关进程 `ctx.tokenUsage` 已注入；`QuotaFetcher.reload(buildQuotaUpstreams(config))`

- [ ] **Step 1: import + 实例化 TokenUsageTracker**

`src/index.ts` 顶部 import 区加（Plan 1 已有 MetricsCollector/QuotaFetcher import）：
```ts
import { TokenUsageTracker } from './tokenUsageTracker';
import type { QuotaUpstreamRef } from './quotaFetcher';
```

在 `const metrics = new MetricsCollector(); ctx.metrics = metrics;`（Plan 1 Task 8 加的）之后加：
```ts
const tokenUsage = new TokenUsageTracker();
ctx.tokenUsage = tokenUsage;
```

并把 `QuotaFetcher` 实例化改为传入 tokenUsageTracker：
```ts
const quotaFetcher = new QuotaFetcher({ tokenUsageTracker: tokenUsage });
```

- [ ] **Step 2: buildQuotaRefs → buildQuotaUpstreams**

把 Plan 1 Task 8 的 `buildQuotaRefs(cfg)` 改为 `buildQuotaUpstreams(cfg)`（返回 `QuotaUpstreamRef[]`），每个 upstream 含 quotaMode/quotaLimits/credentials：
```ts
function buildQuotaUpstreams(cfg: ProxyConfig): QuotaUpstreamRef[] {
  const out: QuotaUpstreamRef[] = [];
  const collect = (upstreamId: string, u: UpstreamConfig | undefined) => {
    if (!u || !u.codePlanCredentials) return;
    const credentials = u.codePlanCredentials
      .filter(c => c.enabled && c.apiKey)
      .map(c => ({ upstreamId, credentialId: c.id, apiKey: c.apiKey, baseURL: u.baseURL }));
    if (credentials.length === 0) return;
    out.push({
      upstreamId,
      quotaMode: u.quotaMode ?? 'fetch',
      quotaLimits: u.quotaLimits,
      credentials,
    });
  };
  if (cfg.upstreamsById) for (const [id, u] of Object.entries(cfg.upstreamsById)) collect(id, u);
  if (cfg.defaultUpstream) collect('__default__', cfg.defaultUpstream);
  return out;
}
```

启动处改为 `quotaFetcher.reload(buildQuotaUpstreams(currentConfig));`

- [ ] **Step 3: 热重载也用新函数**

`fs.watch` 回调里（Plan 1 Task 8 的 `quotaFetcher.reload(buildQuotaRefs(newConfig));`）改为 `quotaFetcher.reload(buildQuotaUpstreams(newConfig));`

- [ ] **Step 4: 类型检查 + 启动冒烟（仅验证 build + 不崩）**

Run: `npm run build`
```bash
WOICLAW_AUTH_BYPASS=1 node dist/index.js > /tmp/glm-est.log 2>&1 &
PID=$!; sleep 4; echo "started PID=$PID"
curl -s -H "x-api-key: dummy" http://127.0.0.1:3456/metrics > /dev/null && echo "metrics reachable"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
```
Expected: build 通过；启动不崩；`metrics reachable`（estimated 字段是否生效留 Task 7 改完 proxy-config 后验证）。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(metrics): inject TokenUsageTracker + buildQuotaUpstreams into startup"
```

---

## Task 7: proxy-config GLM estimated 配置 + 端到端冒烟

**仓库**: CrewProxy  **Files:**
- Modify: `proxy-config.json`（GLM upstream）

- [ ] **Step 1: 改 proxy-config.json 的 GLM**

在 GLM upstream 对象里加 `quotaMode` 和 `weeklyTokens`（保留既有 `fiveHourTokens` 和所有字段/keys 不动）：
```jsonc
"glm": {
  // ... baseURL/apiKey/model/codePlanCredentials ...
  "quotaMode": "estimated",
  "quotaLimits": { "fiveHourTokens": 160000000, "weeklyTokens": 800000000 }
}
```

- [ ] **Step 2: 端到端冒烟**

```bash
npm run build
WOICLAW_AUTH_BYPASS=1 node dist/index.js > /tmp/glm-est.log 2>&1 &
PID=$!; sleep 5
curl -s -H "x-api-key: dummy" http://127.0.0.1:3456/metrics | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const m=JSON.parse(d);const g=m.providers.find(p=>p.upstreamId==='glm');const c=g&&g.credentials[0];console.log(JSON.stringify({status:c.quotaStatus, estimated:c.quota&&c.quota.estimated, fiveHour:c.quota&&c.quota.fiveHour}));})"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
```
Expected: `{"status":"ok","estimated":true,"fiveHour":{"usedPct":0,"usedTokens":0,"limitTokens":160000000,"resetsAt":null}}`（刚启动 token 统计为 0，usedPct=0）。发几个 GLM 请求后 usedPct 会涨（需真实 key；可选验证）。

- [ ] **Step 3: 验证 GLM 不再发起官方查询**

`grep -c "quota.*GLM" /tmp/glm-est.log`（或看日志无 `[quota]` GLM 查询记录）—— estimated 模式应无 GLM 官方查询日志。

- [ ] **Step 4: Commit**

```bash
git add proxy-config.json
git commit -m "feat(config): GLM team-plan estimated quota mode (5h 1.6亿, weekly 8亿)"
```

---

## Task 8: 前端 QuotaGrid 预估角标（CrewCentral）

**仓库**: CrewCentral（新分支 `feat/glm-estimated-quota`）  **Files:**
- Modify: `frontend/src/lib/gateway-api.ts`（`CredentialQuota.estimated`）
- Modify: `frontend/src/components/gateway/QuotaGrid.tsx`

**Interfaces:**
- Consumes: `/metrics` 的 `quota.estimated`（Task 5）

- [ ] **Step 1: 开 CrewCentral 分支**

```bash
cd /c/Users/zhaocao/Documents/GitHub/CrewCentral
git checkout -b feat/glm-estimated-quota
```

- [ ] **Step 2: gateway-api.ts 加 estimated**

`frontend/src/lib/gateway-api.ts` 的 `CredentialQuota` 类型加字段：
```ts
export type CredentialQuota = {
  fiveHour?: QuotaTier;
  weekly?: QuotaTier;
  estimated?: boolean;
} | null;
```

- [ ] **Step 3: QuotaGrid 加「预估」角标 + resetsAt null 文案**

`frontend/src/components/gateway/QuotaGrid.tsx`：在配额卡标题旁，当 `cred.quota?.estimated === true` 时渲染一个角标：
```tsx
{cred.quota?.estimated && (
  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">预估</span>
)}
```
重置倒计时处：当 `tier.resetsAt == null` 时（estimated 模式）显示「滚动窗口」灰色小字，而非倒计时：
```tsx
{tier.resetsAt == null
  ? <span className="text-[10px] text-slate-400">滚动窗口</span>
  : <span className="text-[10px] text-slate-400">{formatCountdown(tier.resetsAt)}</span>}
```
（具体定位：grep `formatCountdown` / `resetsAt` 在 QuotaGrid.tsx，在 fiveHour 倒计时的渲染处加 null 分支。）

- [ ] **Step 4: 验证构建**

```bash
cd frontend && npx tsc -b && npx vite build
```
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/zhaocao/Documents/GitHub/CrewCentral
git add frontend/src/lib/gateway-api.ts frontend/src/components/gateway/QuotaGrid.tsx
git commit -m "feat(frontend): estimated-quota badge + rolling-window label"
```

---

## 完成判据

- CrewProxy: `npm test` 全绿（含 TokenUsageTracker + estimated quota + endpoint estimated 测试）；`npm run build` 通过。
- `/metrics` 的 GLM credential：`quotaStatus:"ok"`, `estimated:true`, `fiveHour.resetsAt:null`，启动后 usedPct 随 GLM 请求累积。
- GLM 不再每 60s 发起官方查询（estimated 跳过）。
- MiniMax 等仍正常 fetch 真实配额（不受影响）。
- CrewCentral 前端：GLM 配额卡显示「预估」角标 + 「滚动窗口」；`tsc -b && vite build` 通过。
- 所有改动按 task 分 commit。CrewProxy 推到 `feat/glm-estimated-quota`，CrewCentral 推到 `feat/glm-estimated-quota`。
