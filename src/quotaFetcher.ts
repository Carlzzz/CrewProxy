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
  const body: any = await resp.json();
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
  const body: any = await resp.json();
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
