# 网关监控大屏 — Plan 1: CrewProxy `/metrics` 端点 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **本计划是两份计划中的第 1 份。** Plan 2（CrewCentral 后端代理 + 前端大屏）依赖本计划产出的 `/metrics` 端点，待本计划完成、`/metrics` 可 curl 验证后再编写。设计依据：`CrewCentral/docs/superpowers/specs/2026-07-07-gateway-monitoring-dashboard-design.md`。

**Goal:** 在 CrewProxy 新增 `GET /metrics` 端点，一站式返回实时调用统计（成功/失败/token/耗时）、池子冷却状态、GLM/MiniMax 配额，供 CrewCentral 大屏轮询。

**Architecture:** 内存时间桶采集指标（`MetricsCollector`，主路径埋点，成功失败都记）；周期性调 GLM/MiniMax 官方接口查配额并缓存（`QuotaFetcher`，逻辑翻译自 `cc-switch/.../coding_plan.rs`，key 不出网关）；`/metrics` 端点合并三块 + health 计算，鉴权对齐现有 `/models`。

**Tech Stack:** TypeScript 5.7 / Node ≥18 / 原生 `http`（无框架）/ `node:test` + `tsx`（测试）

## Global Constraints

- Node ≥18（`package.json` engines）；测试运行需 Node ≥18.19 或用 `tsx --test`（避开 `--import` 限制）
- TypeScript 5.7，`tsc` 编译到 `dist/`；运行时仅 `dotenv` 一个依赖
- 无 Web 框架，HTTP 路由全部手写在 `src/proxy.ts` 的 `createProxyServer` 内
- `/metrics` 鉴权**必须对齐 `/models`**：用 `extractClientApiKey(req)` + `authenticateRequest(token)`，不学 `/pool-status` 的裸奔
- 配额查询 key **绝不出网关**：`QuotaFetcher` 在网关进程内发起出站请求
- 配额出站请求超时 15s；指标桶大小 10s、保留 1h（360 桶）；配额查询周期 60s
- 健康判定：`down`=全池冷却；`degraded`=部分冷却或 5min 成功率 <0.9；否则 `healthy`
- 所有时间戳：epoch ms（`Date.now()`）；ISO 时间用 `new Date(ms).toISOString()`
- 配额接口鉴权差异：**GLM 裸 key（无 Bearer）**，**MiniMax `Bearer key`**

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `package.json` | 加 `tsx` devDep + `test` script | 修改 |
| `src/codePlanPool.ts` | `markCooldown` 加 reason，`getPoolStatus` 返回 reason | 修改 |
| `src/config.ts` | `UpstreamConfig` 加 `quotaLimits`，`normalizeUpstream` 解析 | 修改 |
| `src/metricsCollector.ts` | 时间桶指标采集 + 窗口聚合 | 新建 |
| `src/quotaFetcher.ts` | GLM/MiniMax 配额查询 + 缓存（翻译自 cc-switch） | 新建 |
| `src/proxy.ts` | 埋点 + `GET /metrics` 路由 + health 计算 | 修改 |
| `src/index.ts` | 启动 `MetricsCollector`/`QuotaFetcher` + 热重载 | 修改 |
| `test/*.test.ts` | 各模块单测 | 新建 |

---

## Task 1: 测试基础设施

**Files:**
- Modify: `package.json`
- Create: `test/sanity.test.ts`

**Interfaces:**
- Produces: `npm test` 可运行；测试用 `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`

- [ ] **Step 1: 安装 tsx 并加 test script**

编辑 `package.json`，在 `devDependencies` 加 `"tsx": "^4.19.0"`，在 `scripts` 加 `"test": "tsx --test test/**/*.test.ts"`：

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "sync-usage": "node dist/scripts/sync-usage-to-es.js",
    "test": "tsx --test test/**/*.test.ts"
  },
  "devDependencies": {
    "@elastic/elasticsearch": "^8.17.0",
    "@types/node": "^22.12.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

运行：`npm install`

- [ ] **Step 2: 写 sanity 测试**

`test/sanity.test.ts`：
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test harness works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: 运行测试**

Run: `npm test`
Expected: `✔ test harness works`，退出码 0

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json test/sanity.test.ts
git commit -m "test: add node:test + tsx harness"
```

---

## Task 2: CodePlanPool 记录 cooldownReason

spec §6.4 要求冷却颜色随 reason 区分（quota=红、rate_limit/network=橙）。当前 `markCooldown` 不存 reason。

**Files:**
- Modify: `src/codePlanPool.ts`
- Modify: `src/proxy.ts`（3 处 `markCooldown` 调用传 reason）
- Test: `test/codePlanPool.test.ts`

**Interfaces:**
- Produces:
  - `type CooldownReason = 'quota' | 'rate_limit' | 'network'`
  - `markCooldown(upstreamKey: string, credentialId: string, cooldownMs: number, reason?: CooldownReason): void`
  - `CredentialHeatmap` 新增 `cooldownReason?: CooldownReason`

- [ ] **Step 1: 写失败测试**

`test/codePlanPool.test.ts`：
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodePlanPoolManager } from '../src/codePlanPool';
import type { ProxyConfig } from '../src/config';

function configWithPool(): ProxyConfig {
  return {
    upstreamsById: {
      glm: {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        codePlanCredentials: [
          { id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true },
          { id: 'glm-key2', apiKey: 'k2', weight: 1, enabled: true },
        ],
      },
    },
  };
}

test('markCooldown stores reason and getPoolStatus exposes it', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  const status = pool.getPoolStatus('glm');
  const k1 = status.find(c => c.credentialId === 'glm-key1')!;
  assert.equal(k1.inCooldown, true);
  assert.equal(k1.cooldownReason, 'quota');
  const k2 = status.find(c => c.credentialId === 'glm-key2')!;
  assert.equal(k2.inCooldown, false);
  assert.equal(k2.cooldownReason, undefined);
});

test('markCooldown defaults reason to rate_limit when omitted', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.markCooldown('glm', 'glm-key1', 30_000);
  const k1 = pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!;
  assert.equal(k1.cooldownReason, 'rate_limit');
});

test('all-credentials-in-cooldown detectable via getPoolStatus', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  pool.markCooldown('glm', 'glm-key2', 60_000, 'network');
  const allDown = pool.getPoolStatus('glm').every(c => c.inCooldown);
  assert.equal(allDown, true);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL — `cooldownReason is undefined` / 类型不存在

- [ ] **Step 3: 实现 — 改 `src/codePlanPool.ts`**

在文件顶部 `CODE_PLAN_SHORT_COOLDOWN_MS` 下方加类型导出：
```ts
export type CooldownReason = 'quota' | 'rate_limit' | 'network';
```

在 `CodePlanPoolManager` 类的字段区（`cooldowns` 声明旁）加：
```ts
  private cooldownReasons: Map<string, CooldownReason> = new Map();
```

修改 `markCooldown`（约 131 行）：
```ts
  markCooldown(upstreamKey: string, credentialId: string, cooldownMs: number = CODE_PLAN_COOLDOWN_MS, reason: CooldownReason = 'rate_limit'): void {
    const key = this.cooldownKey(upstreamKey, credentialId);
    this.cooldowns.set(key, Date.now() + cooldownMs);
    this.cooldownReasons.set(key, reason);
    logger.verbose(`[codePlan] cooldown set for ${upstreamKey}/${credentialId}: ${cooldownMs}ms (reason=${reason})`);
  }
```

修改 `getPoolStatus`（约 211 行），在返回对象里加 `cooldownReason`：
```ts
  getPoolStatus(upstreamKey: string): CredentialHeatmap[] {
    const credentials = this.pool.get(upstreamKey) ?? [];
    return credentials.map(c => {
      const key = this.cooldownKey(upstreamKey, c.id);
      const expiry = this.cooldowns.get(key);
      const inCooldown = expiry !== undefined && Date.now() < expiry;
      return {
        credentialId: c.id,
        requestsLast1h: this.countRecent1h(upstreamKey, c.id),
        heatLast1h: 0,
        inCooldown,
        cooldownUntil: inCooldown ? expiry : undefined,
        cooldownReason: inCooldown ? this.cooldownReasons.get(key) : undefined,
      };
    });
  }
```

`cleanupStaleCooldowns`（约 158 行）里清过期 cooldown 时一并清 reason：
```ts
  private cleanupStaleCooldowns(): void {
    const now = Date.now();
    for (const [key, expiry] of this.cooldowns.entries()) {
      if (now > expiry) {
        this.cooldowns.delete(key);
        this.cooldownReasons.delete(key);
      }
    }
  }
```

更新 `CredentialHeatmap` 接口（约 11 行）加字段：
```ts
export interface CredentialHeatmap {
  credentialId: string;
  requestsLast1h: number;
  heatLast1h: number;
  inCooldown: boolean;
  cooldownUntil?: number;
  cooldownReason?: CooldownReason;
}
```

- [ ] **Step 4: 改 `src/proxy.ts` 3 处 markCooldown 调用传 reason**

`src/proxy.ts:876`（网络错误分支）：
```ts
        ctx.codePlanPool?.markCooldown(codePlanPoolKey, pickedCredentialId, CODE_PLAN_SHORT_COOLDOWN_MS, 'network');
```

`src/proxy.ts:941`（失败分类分支，把已算出的 `cls` 映射成 reason）：
```ts
      ctx.codePlanPool?.markCooldown(codePlanPoolKey, pickedCredentialId, cooldownMs, cls === 'quota' ? 'quota' : 'rate_limit');
```
（`cls` 来自 `const cls = classify429(...)`，已是 `'quota'|'rate_limit'|'unknown'`，`unknown` 归 `rate_limit`）

- [ ] **Step 5: 运行测试通过**

Run: `npm test`
Expected: 3 个 pool 测试 PASS

- [ ] **Step 6: 类型检查 + Commit**

Run: `npm run build`（确认 tsc 通过）
```bash
git add src/codePlanPool.ts src/proxy.ts test/codePlanPool.test.ts
git commit -m "feat(codeplan): store cooldownReason in pool status"
```

---

## Task 3: config 支持 quotaLimits

spec §4.4：`UpstreamConfig` 加可选 `quotaLimits`，用于把配额百分比还原成绝对值（如 GLM 1.6亿）。

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `UpstreamConfig.quotaLimits?: { fiveHourTokens?: number; weeklyTokens?: number }`

- [ ] **Step 1: 写失败测试**

`test/config.test.ts`：
```ts
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
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/config.test.ts`
Expected: FAIL — `quottaLimits` 不在类型上 / 解析后 undefined

- [ ] **Step 3: 实现 — 改 `src/config.ts`**

在 `UpstreamConfig` 接口（约 13 行）加字段：
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
}
```

在 `normalizeUpstream`（约 91 行 `ordinaryFallbackModelMap` 解析之后、`return out` 之前）加：
```ts
  if (o.quotaLimits !== undefined && o.quotaLimits !== null && typeof o.quotaLimits === 'object') {
    const ql = o.quotaLimits as Record<string, unknown>;
    const fiveHourTokens = typeof ql.fiveHourTokens === 'number' ? ql.fiveHourTokens : undefined;
    const weeklyTokens = typeof ql.weeklyTokens === 'number' ? ql.weeklyTokens : undefined;
    if (fiveHourTokens !== undefined || weeklyTokens !== undefined) {
      out.quotaLimits = {};
      if (fiveHourTokens !== undefined) out.quotaLimits.fiveHourTokens = fiveHourTokens;
      if (weeklyTokens !== undefined) out.quotaLimits.weeklyTokens = weeklyTokens;
    }
  }
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- --test test/config.test.ts`
Expected: 3 个 config 测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): parse optional quotaLimits per upstream"
```

---

## Task 4: MetricsCollector（时间桶指标采集）

**Files:**
- Create: `src/metricsCollector.ts`
- Test: `test/metrics.test.ts`

**Interfaces:**
- Produces:
  - `interface MetricEvent { upstreamId: string; credentialId?: string; model?: string; success: boolean; inputTokens: number; outputTokens: number; costMs: number; ts: number; }`
  - `interface WindowStats { count: number; success: number; fail: number; successRate: number; inputTokens: number; outputTokens: number; avgCostMs: number; }`
  - `class MetricsCollector { record(event: MetricEvent): void; aggregate(windowSec: number): Map<string, WindowStats>; aggregateByCredential(windowSec: number): Map<string, WindowStats>; }`
  - 导出常量 `METRICS_BUCKET_MS = 10_000`、`METRICS_RETENTION_BUCKETS = 360`

- [ ] **Step 1: 写失败测试**

`test/metrics.test.ts`：
```ts
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
```

> 说明：`MetricsCollector` 构造接收 `now: () => number` 注入，便于测试用固定时间；`ts` 字段以毫秒计；`aggregate(windowSec)` 中 `windowSec` 是秒，内部换算 `ts > now() - windowSec*1000`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/metrics.test.ts`
Expected: FAIL — `Cannot find module '../src/metricsCollector'`

- [ ] **Step 3: 实现 `src/metricsCollector.ts`**

```ts
import { logger } from './logger';

export interface MetricEvent {
  upstreamId: string;
  credentialId?: string;
  model?: string;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  costMs: number;
  ts: number;
}

export interface WindowStats {
  count: number;
  success: number;
  fail: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  avgCostMs: number;
}

export const METRICS_BUCKET_MS = 10_000;          // 10s per bucket
export const METRICS_RETENTION_BUCKETS = 360;     // 1h

interface Bucket {
  count: number;
  success: number;
  fail: number;
  inputTokens: number;
  outputTokens: number;
  costMsSum: number;
}

const EMPTY: WindowStats = { count: 0, success: 0, fail: 0, successRate: 0, inputTokens: 0, outputTokens: 0, avgCostMs: 0 };

/**
 * Time-bucketed metrics. Two dimensions are kept independently:
 *  - per-upstreamId buckets  → aggregate()      (provider cards, totals, trends)
 *  - per-credentialId buckets → aggregateByCredential() (pool load bar chart)
 *
 * Memory is bounded: each dimension retains at most METRICS_RETENTION_BUCKETS
 * buckets per key. Stale buckets are pruned on record().
 */
export class MetricsCollector {
  private byUpstream = new Map<string, Map<number, Bucket>>();
  private byCredential = new Map<string, Map<number, Bucket>>();

  constructor(private now: () => number = Date.now) {}

  record(event: MetricEvent): void {
    try {
      const bucketTs = Math.floor(event.ts / METRICS_BUCKET_MS) * METRICS_BUCKET_MS;
      if (event.upstreamId) this.put(this.byUpstream, event.upstreamId, bucketTs, event);
      if (event.credentialId) this.put(this.byCredential, event.credentialId, bucketTs, event);
    } catch (err) {
      // Metrics must NEVER break the proxy hot path.
      logger.error('[metrics] record failed:', err);
    }
  }

  private put(store: Map<string, Map<number, Bucket>>, key: string, bucketTs: number, e: MetricEvent): void {
    let buckets = store.get(key);
    if (!buckets) { buckets = new Map(); store.set(key, buckets); }
    let b = buckets.get(bucketTs);
    if (!b) {
      b = { count: 0, success: 0, fail: 0, inputTokens: 0, outputTokens: 0, costMsSum: 0 };
      buckets.set(bucketTs, b);
    }
    b.count++;
    if (e.success) b.success++; else b.fail++;
    b.inputTokens += e.inputTokens || 0;
    b.outputTokens += e.outputTokens || 0;
    b.costMsSum += e.costMs || 0;
    this.prune(buckets);
  }

  private prune(buckets: Map<number, Bucket>): void {
    if (buckets.size <= METRICS_RETENTION_BUCKETS) return;
    // remove oldest beyond retention
    const sorted = [...buckets.keys()].sort((a, b) => a - b);
    const remove = sorted.length - METRICS_RETENTION_BUCKETS;
    for (let i = 0; i < remove; i++) buckets.delete(sorted[i]);
  }

  /** Aggregate per-upstream stats over the last `windowSec` seconds. */
  aggregate(windowSec: number): Map<string, WindowStats> {
    return this.aggregateFrom(this.byUpstream, windowSec);
  }

  /** Aggregate per-credential stats over the last `windowSec` seconds. */
  aggregateByCredential(windowSec: number): Map<string, WindowStats> {
    return this.aggregateFrom(this.byCredential, windowSec);
  }

  private aggregateFrom(store: Map<string, Map<number, Bucket>>, windowSec: number): Map<string, WindowStats> {
    const cutoff = this.now() - windowSec * 1000;
    const out = new Map<string, WindowStats>();
    for (const [key, buckets] of store) {
      let count = 0, success = 0, fail = 0, inputTokens = 0, outputTokens = 0, costMsSum = 0;
      for (const [bucketTs, b] of buckets) {
        // A bucket contributes if it started within the window.
        if (bucketTs < Math.floor(cutoff / METRICS_BUCKET_MS) * METRICS_BUCKET_MS) continue;
        count += b.count; success += b.success; fail += b.fail;
        inputTokens += b.inputTokens; outputTokens += b.outputTokens; costMsSum += b.costMsSum;
      }
      if (count === 0) continue;
      out.set(key, {
        count, success, fail,
        successRate: count > 0 ? success / count : 0,
        inputTokens, outputTokens,
        avgCostMs: count > 0 ? Math.round(costMsSum / count) : 0,
      });
    }
    return out;
  }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- --test test/metrics.test.ts`
Expected: 5 个 metrics 测试 PASS

- [ ] **Step 5: 类型检查 + Commit**

Run: `npm run build`
```bash
git add src/metricsCollector.ts test/metrics.test.ts
git commit -m "feat(metrics): add time-bucketed MetricsCollector"
```

---

## Task 5: QuotaFetcher（GLM + MiniMax 配额查询）

逻辑翻译自 `cc-switch/src-tauri/src/services/coding_plan.rs` 的 `query_zhipu` / `query_minimax` / `parse_zhipu_token_tiers` / `parse_minimax_tiers` 及其单测。

**Files:**
- Create: `src/quotaFetcher.ts`
- Test: `test/quotaFetcher.test.ts`

**Interfaces:**
- Produces:
  - `type QuotaStatus = 'ok' | 'expired' | 'not_configured' | 'error'`
  - `interface QuotaTierInfo { usedPct: number; resetsAt: string | null }`
  - `interface CredentialQuota { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo; status: QuotaStatus; error?: string; queriedAt: number }`
  - `interface QuotaCredentialRef { upstreamId: string; credentialId: string; apiKey: string; baseURL: string }`
  - 导出纯函数：`detectQuotaProvider(baseURL: string): 'glm' | 'minimax' | null`、`parseGlmTiers(data: any): { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo }`、`parseMinimaxTiers(body: any): { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo }`
  - `class QuotaFetcher { constructor(opts: { fetchImpl?: typeof fetch; intervalMs?: number; now?: () => number }); reload(refs: QuotaCredentialRef[]): void; start(): void; stop(): void; getSnapshot(): Map<string, CredentialQuota>; }`（snapshot key = `${upstreamId}\0${credentialId}`）

- [ ] **Step 1: 写失败测试（解析纯函数 + 探测，翻译 cc-switch 用例）**

`test/quotaFetcher.test.ts`：
```ts
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
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/quotaFetcher.test.ts`
Expected: FAIL — `Cannot find module '../src/quotaFetcher'`

- [ ] **Step 3: 实现 `src/quotaFetcher.ts`**

```ts
import { logger } from './logger';

export type QuotaStatus = 'ok' | 'expired' | 'not_configured' | 'error';

export interface QuotaTierInfo {
  usedPct: number;       // 已用百分比，0-100（可能略超，透传不裁剪）
  resetsAt: string | null; // ISO 8601，或 null
}

export interface CredentialQuota {
  fiveHour?: QuotaTierInfo;
  weekly?: QuotaTierInfo;
  status: QuotaStatus;
  error?: string;
  queriedAt: number;
}

export interface QuotaCredentialRef {
  upstreamId: string;
  credentialId: string;
  apiKey: string;
  baseURL: string;
}

const DEFAULT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Detect provider from the data-plane baseURL. Only glm/minimax supported in v1. */
export function detectQuotaProvider(baseURL: string): 'glm' | 'minimax' | null {
  const u = baseURL.toLowerCase();
  if (u.includes('bigmodel.cn') || u.includes('z.ai')) return 'glm';
  if (u.includes('minimaxi.com') || u.includes('minimax.io')) return 'minimax';
  return null;
}

function millisToIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms <= 0) return null;
  const m = ms < 1_000_000_000_000 ? ms * 1000 : ms;
  const d = new Date(m);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asF64(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

/** Parse Zhipu GLM /api/monitor/usage/quota/limit `data` payload. */
export function parseGlmTiers(data: any): { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo } {
  const limits: any[] = Array.isArray(data?.limits) ? data.limits : [];
  let fiveHour: QuotaTierInfo | undefined;
  let weekly: QuotaTierInfo | undefined;
  const unclassified: QuotaTierInfo[] = [];
  for (const item of limits) {
    if (String(item?.type ?? '').toLowerCase() !== 'tokens_limit') continue;
    const percentage = asF64(item.percentage) ?? 0;
    const resetsAt = millisToIso(typeof item.nextResetTime === 'number' ? item.nextResetTime : null);
    const tier = { usedPct: percentage, resetsAt };
    const unit = typeof item.unit === 'number' ? item.unit : undefined;
    if (unit === 3 && !fiveHour) fiveHour = tier;
    else if (unit === 6 && !weekly) weekly = tier;
    else unclassified.push(tier);
  }
  // fallback: fill empty slots by unclassified order
  for (const t of unclassified) {
    if (!fiveHour) fiveHour = t;
    else if (!weekly) weekly = t;
  }
  const out: { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo } = {};
  if (fiveHour) out.fiveHour = fiveHour;
  if (weekly) out.weekly = weekly;
  return out;
}

/** Parse MiniMax /v1/api/openplatform/coding_plan/remains body. */
export function parseMinimaxTiers(body: any): { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo } {
  const arr: any[] = Array.isArray(body?.model_remains) ? body.model_remains : [];
  const item = arr.find(it => it?.model_name === 'general');
  if (!item) return {};
  const out: { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo } = {};
  const intervalRemain = asF64(item.current_interval_remaining_percent);
  if (intervalRemain !== undefined) {
    out.fiveHour = { usedPct: 100 - intervalRemain, resetsAt: millisToIso(item.end_time) };
  }
  if (item.current_weekly_status === 1) {
    const weeklyRemain = asF64(item.current_weekly_remaining_percent);
    if (weeklyRemain !== undefined) {
      out.weekly = { usedPct: 100 - weeklyRemain, resetsAt: millisToIso(item.weekly_end_time) };
    }
  }
  return out;
}

function glmQuotaBase(baseURL: string): string {
  return baseURL.toLowerCase().includes('bigmodel.cn') ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
}

async function queryGlm(ref: QuotaCredentialRef, fetchImpl: typeof fetch): Promise<CredentialQuota> {
  const url = `${glmQuotaBase(ref.baseURL)}/api/monitor/usage/quota/limit`;
  const resp = await fetchImpl(url, {
    method: 'GET',
    headers: { 'Authorization': ref.apiKey, 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 401 || resp.status === 403) return { status: 'expired', queriedAt: Date.now() };
  if (!resp.ok) return { status: 'error', error: `GLM HTTP ${resp.status}`, queriedAt: Date.now() };
  const body = await resp.json();
  if (body?.success === false) return { status: 'error', error: `GLM: ${body.msg ?? 'unknown'}`, queriedAt: Date.now() };
  const tiers = parseGlmTiers(body?.data);
  return { ...tiers, status: 'ok', queriedAt: Date.now() };
}

async function queryMinimax(ref: QuotaCredentialRef, fetchImpl: typeof fetch): Promise<CredentialQuota> {
  const host = ref.baseURL.toLowerCase().includes('minimax.io') ? 'api.minimax.io' : 'api.minimaxi.com';
  const url = `https://${host}/v1/api/openplatform/coding_plan/remains`;
  const resp = await fetchImpl(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${ref.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 401 || resp.status === 403) return { status: 'expired', queriedAt: Date.now() };
  if (!resp.ok) return { status: 'error', error: `MiniMax HTTP ${resp.status}`, queriedAt: Date.now() };
  const body = await resp.json();
  if (body?.base_resp?.status_code !== undefined && body.base_resp.status_code !== 0) {
    return { status: 'error', error: `MiniMax code ${body.base_resp.status_code}: ${body.base_resp.status_msg ?? ''}`, queriedAt: Date.now() };
  }
  const tiers = parseMinimaxTiers(body);
  return { ...tiers, status: 'ok', queriedAt: Date.now() };
}

export class QuotaFetcher {
  private refs: QuotaCredentialRef[] = [];
  private snapshot = new Map<string, CredentialQuota>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;

  constructor(opts: { fetchImpl?: typeof fetch; intervalMs?: number; now?: () => number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  reload(refs: QuotaCredentialRef[]): void {
    this.refs = refs;
  }

  start(): void {
    if (this.timer) return;
    void this.refreshOnce(); // immediate first fetch
    this.timer = setInterval(() => { void this.refreshOnce(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Refresh once; exposed for tests so they don't need real timers. */
  async refreshOnce(): Promise<void> {
    await Promise.all(this.refs.map(async (ref) => {
      const key = `${ref.upstreamId}\0${ref.credentialId}`;
      const provider = detectQuotaProvider(ref.baseURL);
      if (!provider) { this.snapshot.set(key, { status: 'not_configured', queriedAt: this.now() }); return; }
      try {
        const result = provider === 'glm' ? await queryGlm(ref, this.fetchImpl) : await queryMinimax(ref, this.fetchImpl);
        this.snapshot.set(key, result);
      } catch (err) {
        logger.error(`[quota] query failed for ${key}:`, err);
        this.snapshot.set(key, { status: 'error', error: String((err as Error)?.message ?? err), queriedAt: this.now() });
      }
    }));
  }

  getSnapshot(): Map<string, CredentialQuota> {
    return new Map(this.snapshot);
  }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npm test -- --test test/quotaFetcher.test.ts`
Expected: 12 个 quota 测试 PASS（detect 3 + parseGlmTiers 3 + parseMinimaxTiers 3 + QuotaFetcher 3）

- [ ] **Step 5: 类型检查 + Commit**

Run: `npm run build`
```bash
git add src/quotaFetcher.ts test/quotaFetcher.test.ts
git commit -m "feat(quota): add GLM/MiniMax quota fetcher (ported from cc-switch)"
```

---

## Task 6: 主路径埋点接入

在 `handleRequest` 的所有出口调用 `MetricsCollector.record`（成功/失败都记）。

**Files:**
- Modify: `src/proxy.ts`（`handleRequest` 出口 + `handleAnthropicStreamResponse` 签名）

**Interfaces:**
- Consumes: `MetricsCollector`（Task 4）、`MetricEvent`
- Produces: `handleAnthropicStreamResponse` 增加可选尾参 `recordMetric?: (success: boolean, inputTokens: number, outputTokens: number) => void`

- [ ] **Step 1: 在 `handleRequest` 内定义 recordMetric 闭包并接入出口**

在 `src/proxy.ts` 的 `handleRequest` 函数体开头（解析出 `effectiveModel`、`upstreamRouteId` 之后；`startTime` 附近）插入（`startTime` 是 ISO 字符串，转 ms 缓存）：

```ts
  const startMs = new Date(startTime).getTime();
  const recordMetric = (success: boolean, inTok: number, outTok: number): void => {
    ctx.metrics?.record({
      upstreamId: upstreamRouteId ?? '__default__',
      credentialId: usageExtra.routing_key ?? undefined,
      model: effectiveModel,
      success, inputTokens: inTok, outputTokens: outTok,
      costMs: Date.now() - startMs, ts: Date.now(),
    });
  };
```

> `upstreamRouteId`、`effectiveModel`、`usageExtra` 均为 `handleRequest` 内已有变量。`usageExtra.routing_key` 在原 `proxy.ts:982` 赋值；闭包在调用时读取，届时已赋值。

在 `src/proxy.ts:986`（无响应 502 出口，`sendErrorResponse(res, 502, ...)` 之前）加：
```ts
    recordMetric(false, 0, 0);
```

在 `src/proxy.ts:993`（非 ok 出口，`sendErrorResponse(res, upstreamResponse.status, ...)` 之前）加：
```ts
    recordMetric(false, 0, 0);
```

在 `src/proxy.ts:997`（stream 分支调用）传入闭包：
```ts
    await handleAnthropicStreamResponse(upstreamResponse, req, res, clientId, effectiveModel, startTime, upstreamRequestBody, usageExtra, recordMetric);
    return;
```

在 `src/proxy.ts:1023`（非 stream 成功，`appendUsageLog(...)` 之后、`sendJSONResponse(res, 200, anthropicResp)` 之前）加：
```ts
  recordMetric(true, inputTokens, outputTokens);
```

- [ ] **Step 2: 给 `handleAnthropicStreamResponse` 加可选 `recordMetric` 参数并在其出口调用**

修改 `src/proxy.ts:451` 函数签名末尾加参数：
```ts
async function handleAnthropicStreamResponse(
  upstreamResponse: Response,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientId: string,
  modelId: string,
  startTime: string,
  upstreamReq: any,
  extra: Partial<UsageLogExtra>,
  recordMetric?: (success: boolean, inputTokens: number, outputTokens: number) => void,
): Promise<void> {
```

在 `src/proxy.ts:479`（空 body 出口的 `appendUsageLog(...)` 之后）加：
```ts
    recordMetric?.(false, 0, 0);
```

在 `src/proxy.ts:580`（finally 块里 `appendUsageLog(...)` 之后，`res.end()` 之前）加：
```ts
    recordMetric?.(state.sawMessageStop, state.inputTokens, state.outputTokens);
```

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: tsc 通过（`ctx.metrics` 字段在 Task 8 加到 `ProxyRuntimeContext`；若 Task 6 先于 Task 8 编译会报 `metrics` 不存在——此时先执行 Task 8 Step 1 给 `ProxyRuntimeContext` 加 `metrics?` 字段再回来编译。建议把 Task 8 Step 1 的接口扩展提前到此步）。

- [ ] **Step 4: 把 ProxyRuntimeContext 扩展提前（避免编译断裂）**

在 `src/config.ts` 的 `ProxyRuntimeContext` 接口（约 37 行）加可选字段（Task 8 会注入实例）：
```ts
import type { MetricsCollector } from './metricsCollector';
import type { QuotaFetcher } from './quotaFetcher';
// ...
export interface ProxyRuntimeContext {
  upstreamsByIdMap: Map<string, UpstreamConfig>;
  defaultUpstream: UpstreamConfig | undefined;
  modelRoutesMap: Map<string, ModelRouteTarget>;
  codePlanPool?: CodePlanPoolManager;
  metrics?: MetricsCollector;
  quotaFetcher?: QuotaFetcher;
}
```

Run: `npm run build` → 通过

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/config.ts
git commit -m "feat(metrics): instrument request handler with MetricsCollector"
```

> 埋点的正确性由 Task 4 的 `MetricsCollector` 单测覆盖（聚合逻辑）；端到端计数验证放在 Task 9。

---

## Task 7: `GET /metrics` 端点 + health 计算

**Files:**
- Modify: `src/proxy.ts`（在 `/pool-status` 路由之后加 `/metrics` 路由）
- Test: `test/metricsEndpoint.test.ts`

**Interfaces:**
- Consumes: `ctx.metrics`、`ctx.quotaFetcher`、`ctx.codePlanPool`、`ctx.upstreamsByIdMap`、`ctx.defaultUpstream`、`extractClientApiKey`、`authenticateRequest`
- Produces: `GET /metrics` 返回 §7 schema 的 JSON

- [ ] **Step 1: 写失败测试（起真实 server）**

`test/metricsEndpoint.test.ts`：
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createProxyServer } from '../src/proxy';
import type { ProxyRuntimeContext } from '../src/config';
import { MetricsCollector } from '../src/metricsCollector';
import { QuotaFetcher } from '../src/quotaFetcher';
import { CodePlanPoolManager } from '../src/codePlanPool';

// Bypass auth so tests don't need a real introspect backend.
process.env.WOICLAW_AUTH_BYPASS = '1';

function startServer(): { server: http.Server; port: number; ctx: ProxyRuntimeContext } {
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([
      ['glm', { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true }] }],
    ]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map(),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000),
    quotaFetcher: new QuotaFetcher({ now: () => 1 }),
  };
  ctx.codePlanPool!.reconcileFromConfig({ upstreamsById: Object.fromEntries(ctx.upstreamsByIdMap) } as any);
  const server = createProxyServer(ctx);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port, ctx });
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data || '{}') }));
    });
  });
}

test('/metrics returns 401 without api key when auth not bypassed', async () => {
  delete process.env.WOICLAW_AUTH_BYPASS;
  const { server, port } = await startServer();
  try {
    const r = await get(port, '/metrics');
    assert.equal(r.status, 401);
  } finally { server.close(); delete process.env.WOICLAW_AUTH_BYPASS; }
});

test('/metrics returns schema with totals and providers', async () => {
  process.env.WOICLAW_AUTH_BYPASS = '1';
  const { server, port, ctx } = await startServer();
  // seed one success record
  ctx.metrics!.record({ upstreamId: 'glm', credentialId: 'glm-key1', model: 'glm-5.2', success: true, inputTokens: 10, outputTokens: 20, costMs: 500, ts: 9_000_000 });
  try {
    const r = await get(port, '/metrics');
    assert.equal(r.status, 200);
    assert.ok(r.body.ts > 0);
    assert.ok(r.body.totals && r.body.totals.last5m);
    assert.ok(Array.isArray(r.body.providers));
    const glm = r.body.providers.find((p: any) => p.upstreamId === 'glm');
    assert.ok(glm);
    assert.equal(glm.health, 'healthy');
    assert.ok(Array.isArray(glm.credentials));
    assert.equal(glm.credentials[0].id, 'glm-key1');
  } finally { server.close(); }
});
```

> `WOICLAW_AUTH_BYPASS`：确认 `isAuthBypassed()` 读取该 env（见 `proxy.ts` auth 区，`authenticateRequest` 里 `if (isAuthBypassed()) return { name: 'bypass', ... }`）。若 env 名不同，实现 Step 2 时以 `proxy.ts` 中实际 env 名为准。

- [ ] **Step 2: 运行验证失败**

Run: `npm test -- --test test/metricsEndpoint.test.ts`
Expected: FAIL — `/metrics` 返回 404（路由未实现）

- [ ] **Step 3: 实现 `/metrics` 路由**

在 `src/proxy.ts` 的 `createProxyServer` 内、`/pool-status` 路由块（约 1117-1148 行）之后、`sendErrorResponse(res, 404, ...)` 之前插入：

```ts
      if (method === 'GET' && pathname === '/metrics') {
        // Auth aligned with /models (NOT the unauthenticated /pool-status).
        const clientApiKey = extractClientApiKey(req);
        if (!clientApiKey) {
          sendErrorResponse(res, 401, 'Missing API key. Provide x-api-key header or Authorization: Bearer token.', 'authentication_error');
          return;
        }
        const authResult = await authenticateRequest(clientApiKey);
        if (!authResult) {
          sendErrorResponse(res, 401, 'Invalid API key', 'authentication_error');
          return;
        }

        sendJSONResponse(res, 200, buildMetricsPayload(ctx));
        return;
      }
```

并在 `proxy.ts` 顶部 import 区加：
```ts
import { buildMetricsPayload } from './metricsPayload';
```

- [ ] **Step 4: 新建 `src/metricsPayload.ts`（组装响应 + health 计算）**

```ts
import type { ProxyRuntimeContext, UpstreamConfig } from './config';
import type { WindowStats } from './metricsCollector';
import type { CredentialQuota } from './quotaFetcher';

const WINDOW_SET = { last1m: 60, last5m: 300, last1h: 3600 } as const;
const DEGRADED_SUCCESS_RATE = 0.9;

function statsObj(s: WindowStats | undefined) {
  const z: WindowStats = s ?? { count: 0, success: 0, fail: 0, successRate: 0, inputTokens: 0, outputTokens: 0, avgCostMs: 0 };
  return { count: z.count, success: z.success, fail: z.fail, successRate: z.successRate, inputTokens: z.inputTokens, outputTokens: z.outputTokens, avgCostMs: z.avgCostMs };
}

function mergeTotals(parts: WindowStats[]): WindowStats {
  let count = 0, success = 0, fail = 0, inputTokens = 0, outputTokens = 0, costMsSum = 0;
  for (const p of parts) {
    count += p.count; success += p.success; fail += p.fail;
    inputTokens += p.inputTokens; outputTokens += p.outputTokens;
    costMsSum += p.avgCostMs * p.count;
  }
  return { count, success, fail, successRate: count > 0 ? success / count : 0, inputTokens, outputTokens, avgCostMs: count > 0 ? Math.round(costMsSum / count) : 0 };
}

function providerLabel(upstreamId: string, u: UpstreamConfig): string {
  const url = (u.baseURL || '').toLowerCase();
  if (url.includes('bigmodel.cn') || url.includes('z.ai')) return 'glm';
  if (url.includes('minimaxi.com') || url.includes('minimax.io')) return 'minimax';
  return upstreamId;
}

export function buildMetricsPayload(ctx: ProxyRuntimeContext): unknown {
  const metrics = ctx.metrics;
  const agg1m = metrics?.aggregate(WINDOW_SET.last1m) ?? new Map();
  const agg5m = metrics?.aggregate(WINDOW_SET.last5m) ?? new Map();
  const agg1h = metrics?.aggregate(WINDOW_SET.last1h) ?? new Map();
  const quotaSnap = ctx.quotaFetcher?.getSnapshot() ?? new Map<string, CredentialQuota>();

  const entries: Array<[string, UpstreamConfig]> = [];
  for (const [id, u] of ctx.upstreamsByIdMap) entries.push([id, u]);
  if (ctx.defaultUpstream) entries.push(['__default__', ctx.defaultUpstream]);

  const providers: any[] = [];
  const totalsParts1m: WindowStats[] = [];
  const totalsParts5m: WindowStats[] = [];
  const totalsParts1h: WindowStats[] = [];
  let activeCount = 0;
  let downCount = 0;

  for (const [upstreamId, upstream] of entries) {
    const s1m = agg1m.get(upstreamId);
    const s5m = agg5m.get(upstreamId);
    const s1h = agg1h.get(upstreamId);
    if (s1m) totalsParts1m.push(s1m);
    if (s5m) totalsParts5m.push(s5m);
    if (s1h) totalsParts1h.push(s1h);

    // Health
    let allDown = false;
    let partialCooldown = false;
    const poolStatus = ctx.codePlanPool?.getPoolStatus(upstreamId) ?? [];
    if (poolStatus.length > 0) {
      allDown = poolStatus.every(c => c.inCooldown);
      partialCooldown = poolStatus.some(c => c.inCooldown);
    }
    const successRate5m = s5m?.successRate ?? 1;
    let health: 'healthy' | 'degraded' | 'down' = 'healthy';
    if (allDown) health = 'down';
    else if (partialCooldown || (s5m && s5m.count > 0 && successRate5m < DEGRADED_SUCCESS_RATE)) health = 'degraded';
    if (health === 'down') downCount++; else activeCount++;

    // Credentials
    const credentials = (upstream.codePlanCredentials ?? []).filter(c => c.enabled).map(c => {
      const heat = poolStatus.find(h => h.credentialId === c.id);
      const q = quotaSnap.get(`${upstreamId}\0${c.id}`);
      let quota: any = null;
      if (q && q.status === 'ok') {
        quota = {};
        if (q.fiveHour) {
          const limit = upstream.quotaLimits?.fiveHourTokens ?? null;
          quota.fiveHour = {
            usedPct: q.fiveHour.usedPct,
            usedTokens: limit !== null ? Math.round(q.fiveHour.usedPct / 100 * limit) : null,
            limitTokens: limit,
            resetsAt: q.fiveHour.resetsAt,
          };
        }
        if (q.weekly) {
          const limit = upstream.quotaLimits?.weeklyTokens ?? null;
          quota.weekly = {
            usedPct: q.weekly.usedPct,
            usedTokens: limit !== null ? Math.round(q.weekly.usedPct / 100 * limit) : null,
            limitTokens: limit,
            resetsAt: q.weekly.resetsAt,
          };
        }
      }
      return {
        id: c.id,
        inCooldown: heat?.inCooldown ?? false,
        cooldownUntil: heat?.cooldownUntil,
        cooldownReason: heat?.cooldownReason,
        inFlight: ctx.codePlanPool?.getInFlight(upstreamId, c.id) ?? 0,
        requestsLast1h: heat?.requestsLast1h ?? 0,
        quota,
        quotaStatus: q?.status ?? 'not_configured',
      };
    });

    providers.push({
      upstreamId,
      provider: providerLabel(upstreamId, upstream),
      model: upstream.model,
      health,
      stats: { last1m: statsObj(s1m), last5m: statsObj(s5m), last1h: statsObj(s1h) },
      credentials,
    });
  }

  return {
    ts: Date.now(),
    gatewayOnline: true,
    totals: {
      last1m: statsObj(mergeTotals(totalsParts1m)),
      last5m: statsObj(mergeTotals(totalsParts5m)),
      last1h: statsObj(mergeTotals(totalsParts1h)),
    },
    activeProviders: activeCount,
    downProviders: downCount,
    providers,
  };
}
```

- [ ] **Step 5: 运行测试通过**

Run: `npm test -- --test test/metricsEndpoint.test.ts`
Expected: 2 个 endpoint 测试 PASS

- [ ] **Step 6: 全量测试 + 类型检查 + Commit**

Run: `npm test && npm run build`
```bash
git add src/proxy.ts src/metricsPayload.ts test/metricsEndpoint.test.ts
git commit -m "feat(metrics): add GET /metrics endpoint with health + quota"
```

---

## Task 8: index.ts 启动 MetricsCollector + QuotaFetcher + 热重载

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `MetricsCollector`、`QuotaFetcher`、`ProxyRuntimeContext.metrics/quotaFetcher`（Task 6 Step 4 已加字段）
- Produces: 启动的网关进程内 `ctx.metrics` / `ctx.quotaFetcher` 已注入并运行

- [ ] **Step 1: 注入并启动**

在 `src/index.ts` 的 `const ctx = buildUpstreamsByIdMap(currentConfig);`（约 21 行）之后、`server.listen` 之前插入：

```ts
import { MetricsCollector } from './metricsCollector';
import { QuotaFetcher } from './quotaFetcher';
import type { QuotaCredentialRef } from './quotaFetcher';
```
（把这三行 import 放到文件顶部 `./config` import 下方）

在 `ctx` 构建之后：
```ts
// Initialize metrics + quota fetcher
const metrics = new MetricsCollector();
ctx.metrics = metrics;

function buildQuotaRefs(): QuotaCredentialRef[] {
  const refs: QuotaCredentialRef[] = [];
  const collect = (upstreamId: string, u: typeof currentConfig.defaultUpstream) => {
    if (!u || !u.codePlanCredentials) return;
    for (const c of u.codePlanCredentials) {
      if (c.enabled && c.apiKey) refs.push({ upstreamId, credentialId: c.id, apiKey: c.apiKey, baseURL: u.baseURL });
    }
  };
  if (currentConfig.upstreamsById) for (const [id, u] of Object.entries(currentConfig.upstreamsById)) collect(id, u);
  if (currentConfig.defaultUpstream) collect('__default__', currentConfig.defaultUpstream);
  return refs;
}

const quotaFetcher = new QuotaFetcher();
quotaFetcher.reload(buildQuotaRefs());
quotaFetcher.start();
ctx.quotaFetcher = quotaFetcher;
```

- [ ] **Step 2: 配置热重载时刷新 refs**

在 `src/index.ts` 的 `fs.watch` 回调里、`codePlanPool.reconcileFromConfig(newConfig);`（约 82 行）之后加：
```ts
        quotaFetcher.reload(buildQuotaRefsRef());
```

由于 `buildQuotaRefs` 闭包捕获 `currentConfig`，而热重载里 `currentConfig = newConfig` 在下一行才赋值，需把 refs 构建基于 `newConfig`。改为：在 reload 块内直接基于 `newConfig` 构建 refs。把 `buildQuotaRefs` 改成接收 config 参数：

```ts
function buildQuotaRefs(cfg: ProxyConfig): QuotaCredentialRef[] {
  const refs: QuotaCredentialRef[] = [];
  const collect = (upstreamId: string, u: UpstreamConfig | undefined) => {
    if (!u || !u.codePlanCredentials) return;
    for (const c of u.codePlanCredentials) {
      if (c.enabled && c.apiKey) refs.push({ upstreamId, credentialId: c.id, apiKey: c.apiKey, baseURL: u.baseURL });
    }
  };
  if (cfg.upstreamsById) for (const [id, u] of Object.entries(cfg.upstreamsById)) collect(id, u);
  if (cfg.defaultUpstream) collect('__default__', cfg.defaultUpstream);
  return refs;
}
```
（顶部 import 加 `UpstreamConfig`：`import { ..., UpstreamConfig, ProxyConfig } from './config';`）

启动处改为 `quotaFetcher.reload(buildQuotaRefs(currentConfig));`

热重载块内（`currentConfig = newConfig;` 之后）加：
```ts
        quotaFetcher.reload(buildQuotaRefs(newConfig));
```

- [ ] **Step 3: 进程退出时停止 fetcher（可选清理）**

在 `index.ts` 末尾加：
```ts
process.on('SIGTERM', () => { quotaFetcher.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { quotaFetcher.stop(); server.close(() => process.exit(0)); });
```

- [ ] **Step 4: 类型检查**

Run: `npm run build`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(metrics): wire MetricsCollector + QuotaFetcher into startup and reload"
```

---

## Task 9: 端到端验证 + proxy-config 示例

**Files:**
- Modify: `proxy-config.json`（给 glm 加 `quotaLimits` 示例）
- Modify: `README.md`（加 `/metrics` 说明）

- [ ] **Step 1: 给 proxy-config.json 的 glm upstream 加 quotaLimits**

在 `proxy-config.json` 的 `upstreamsById.glm` 对象里加（保留现有字段）：
```json
      "quotaLimits": { "fiveHourTokens": 160000000 }
```

- [ ] **Step 2: 编译并启动**

```bash
npm run build
WOICLAW_AUTH_BYPASS=1 npm start
```
Expected 日志含 `Claw Proxy listening on 0.0.0.0:3456` 且无 crash。

- [ ] **Step 3: curl /metrics 验证结构**

另开终端：
```bash
curl -s http://127.0.0.1:3456/metrics | head -c 800
```
Expected: JSON 含 `ts`、`totals`、`providers`（每个 provider 有 `health`、`stats`、`credentials`），glm provider 的 credential 有 `quota.fiveHour.limitTokens: 160000000`。

- [ ] **Step 4: 发一个真实请求验证计数**

用任一已配置的模型发一个最小 `/v1/messages` 请求（如通过 AmbiCrew 或 curl，带正确鉴权），等响应后再次 `curl /metrics`：
Expected: 对应 provider 的 `stats.last1m.count` ≥ 1，`stats.last1m.inputTokens/outputTokens` > 0，`successRate` 为 1（成功）。

- [ ] **Step 5: 验证配额查询实际命中**

启动 60s 后 `curl /metrics`，看 glm/minimax 的 credential `quotaStatus`：
- `ok`：配额接口通了，`quota.fiveHour.usedPct` 有值
- `expired`：key 无效（检查 key）
- `error`：网络/接口问题（看 `proxy` 日志 `[quota] query failed`）

- [ ] **Step 6: README 加 /metrics 说明**

在 `README.md` 末尾加一节：
```markdown
## Monitoring: GET /metrics

Returns real-time gateway metrics (call stats, pool cooldowns, GLM/MiniMax quota) as JSON.
Auth: same as `/models` (x-api-key or Authorization: Bearer). Intended for the CrewCentral
monitoring dashboard. Optional per-upstream `quotaLimits` in proxy-config.json renders
absolute token usage (e.g. GLM 1.6亿/5h).
```

- [ ] **Step 7: Commit**

```bash
git add proxy-config.json README.md
git commit -m "docs: document /metrics endpoint and add glm quotaLimits example"
```

---

## 完成判据（Plan 1 Done Definition）

- `npm test` 全绿（sanity + codePlanPool + config + metrics + quotaFetcher + metricsEndpoint）
- `npm run build` 通过
- `GET /metrics` 鉴权有效（无 key 401），返回完整 schema
- 发真实 `/v1/messages` 后 `/metrics` 计数更新
- GLM/MiniMax 配额 `quotaStatus=ok`（在 key 有效的前提下）
- 所有改动按 task 粒度分多次 commit 到 `feat/gateway-monitoring-dashboard`（或同名）分支

Plan 1 完成后，编写 Plan 2（CrewCentral 后端代理路由 + 前端大屏页面）。
