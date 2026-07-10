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
  if (url.includes('volces.com')) return 'volcengine';
  if (url.includes('api.deepseek.com')) return 'deepseek';
  return upstreamId;
}

/** True if the upstream is Volcengine with account-level AK/SK quota (no key pool). */
function isVolcengineAccountUpstream(u: UpstreamConfig): boolean {
  return !!(u.accessKeyId && u.secretAccessKey && !u.codePlanCredentials?.length);
}

/** True if the upstream is a DeepSeek pay-as-you-go account (balance, no key pool). */
function isDeepseekAccountUpstream(u: UpstreamConfig): boolean {
  return !!(u.apiKey && (u.baseURL || '').toLowerCase().includes('api.deepseek.com') && !u.codePlanCredentials?.length);
}

/** Assemble the dashboard quota object from a snapshot entry (5h / weekly / monthly / balance). */
function buildQuotaObject(q: CredentialQuota | undefined, limits: { fiveHourTokens?: number; weeklyTokens?: number } | undefined): any {
  if (!q || q.status !== 'ok') return null;
  const quota: any = { estimated: q.estimated ?? false };
  const tier = (t: NonNullable<CredentialQuota['fiveHour']>, limit: number | null) => ({
    usedPct: t.usedPct,
    usedTokens: limit !== null ? Math.round(t.usedPct / 100 * limit) : null,
    limitTokens: limit,
    resetsAt: t.resetsAt,
  });
  if (q.fiveHour) quota.fiveHour = tier(q.fiveHour, limits?.fiveHourTokens ?? null);
  if (q.weekly) quota.weekly = tier(q.weekly, limits?.weeklyTokens ?? null);
  // Monthly has no configured token limit (Volcengine reports percent only).
  if (q.monthly) quota.monthly = tier(q.monthly, null);
  // Balance is a monetary amount (DeepSeek pay-as-you-go), not a percentage tier.
  if (q.balance) quota.balance = { remaining: q.balance.remaining, total: q.balance.total ?? null, currency: q.balance.currency, isValid: q.balance.isValid };
  return quota;
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
    let health: 'healthy' | 'degraded' | 'down' = 'healthy';
    if (allDown) health = 'down';
    else if (partialCooldown || (s5m && s5m.count > 0 && s5m.successRate < DEGRADED_SUCCESS_RATE)) health = 'degraded';
    if (health === 'down') downCount++; else activeCount++;

    // Credentials
    let credentials = (upstream.codePlanCredentials ?? []).filter(c => c.enabled).map(c => {
      const heat = poolStatus.find(h => h.credentialId === c.id);
      const q = quotaSnap.get(`${upstreamId}\0${c.id}`);
      return {
        id: c.id,
        inCooldown: heat?.inCooldown ?? false,
        cooldownUntil: heat?.cooldownUntil ?? null,
        cooldownReason: heat?.cooldownReason ?? null,
        inFlight: ctx.codePlanPool?.getInFlight(upstreamId, c.id) ?? 0,
        requestsLast1h: heat?.requestsLast1h ?? 0,
        quota: buildQuotaObject(q, upstream.quotaLimits),
        quotaStatus: q?.status ?? 'not_configured',
        quotaError: q?.error ?? null,
      };
    });

    // Account-level upstreams (Volcengine AK/SK quota, DeepSeek pay-as-you-go
    // balance) have no key pool; surface a single synthetic 'account' credential
    // so the dashboard can render their quota bars / balance.
    if (credentials.length === 0 && (isVolcengineAccountUpstream(upstream) || isDeepseekAccountUpstream(upstream))) {
      const q = quotaSnap.get(`${upstreamId}\0account`);
      credentials = [{
        id: 'account',
        inCooldown: false,
        cooldownUntil: null,
        cooldownReason: null,
        inFlight: 0,
        requestsLast1h: 0,
        quota: buildQuotaObject(q, upstream.quotaLimits),
        quotaStatus: q?.status ?? 'not_configured',
        quotaError: q?.error ?? null,
      }];
    }

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
