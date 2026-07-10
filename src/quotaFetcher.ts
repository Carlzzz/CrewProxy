import { createHash, createHmac } from 'crypto';
import { logger } from './logger';
import type { TokenUsageTracker } from './tokenUsageTracker';

export type QuotaStatus = 'ok' | 'expired' | 'not_configured' | 'error';

export interface QuotaTierInfo {
  usedPct: number;       // 已用百分比，0-100（可能略超，透传不裁剪）
  resetsAt: string | null; // ISO 8601，或 null
}

export interface BalanceInfo {
  remaining: number;       // 剩余金额（原生货币单位）
  total?: number;          // 授信/充值总额（部分供应商无此字段）
  currency: string;        // 货币单位，如 CNY / USD
  isValid: boolean;        // 账户是否可用（余额充足）
}

export interface CredentialQuota {
  fiveHour?: QuotaTierInfo;
  weekly?: QuotaTierInfo;
  monthly?: QuotaTierInfo;  // 火山方舟按月窗口（GLM/MiniMax 不产出）
  balance?: BalanceInfo;    // DeepSeek 等按量付费供应商的账户余额（非套餐配额）
  status: QuotaStatus;
  error?: string;
  estimated?: boolean;
  queriedAt: number;
}

export interface QuotaCredentialRef {
  upstreamId: string;
  credentialId: string;
  apiKey: string;
  baseURL: string;
  // 火山方舟控制面 OpenAPI 用量查询走 AK/SK 签名，与数据面 apiKey 分离。
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface QuotaUpstreamRef {
  upstreamId: string;
  quotaMode: 'fetch' | 'estimated';
  quotaLimits?: { fiveHourTokens?: number; weeklyTokens?: number };
  credentials: QuotaCredentialRef[];
}

const DEFAULT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type QuotaProvider = 'glm' | 'minimax' | 'volcengine' | 'deepseek';

/** Detect provider from the data-plane baseURL. */
export function detectQuotaProvider(baseURL: string): QuotaProvider | null {
  const u = baseURL.toLowerCase();
  if (u.includes('bigmodel.cn') || u.includes('z.ai')) return 'glm';
  if (u.includes('minimaxi.com') || u.includes('minimax.io')) return 'minimax';
  // 仅匹配火山方舟 Coding/Agent Plan 入口（/api/coding）；DouBaoSeed 按量付费走
  // /api/v3、/api/compatible，无套餐额度，不在此命中。
  if (u.includes('volces.com/api/coding')) return 'volcengine';
  // DeepSeek 是按量付费（账户余额），非套餐配额。
  if (u.includes('api.deepseek.com')) return 'deepseek';
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

// ── DeepSeek 账户余额 ───────────────────────────────────────
// GET https://api.deepseek.com/user/balance  (Bearer)
// Response: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
// 与 GLM/MiniMax/火山的“套餐配额百分比”不同，DeepSeek 是按量付费的**账户余额**（原生货币）。
// 移植自 cc-switch services/balance.rs。

/** 解析 DeepSeek /user/balance 响应为 BalanceInfo（取首个 balance_info）。 */
export function parseDeepseekBalance(body: any): BalanceInfo | undefined {
  const infos: any[] = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  if (infos.length === 0) return undefined;
  const isValid = typeof body?.is_available === 'boolean' ? body.is_available : true;
  // 优先取有余额的币种（多币种时 CNY/USD 可能并存），否则取第一条。
  const pick = infos.find(i => (asF64(i?.total_balance) ?? 0) > 0) ?? infos[0];
  const currency = typeof pick?.currency === 'string' ? pick.currency : 'CNY';
  return {
    remaining: asF64(pick?.total_balance) ?? 0,
    currency,
    isValid,
  };
}

async function queryDeepseek(ref: QuotaCredentialRef, fetchImpl: typeof fetch): Promise<CredentialQuota> {
  if (!ref.apiKey.trim()) return { status: 'not_configured', error: 'API key is empty', queriedAt: Date.now() };
  const resp = await fetchImpl('https://api.deepseek.com/user/balance', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${ref.apiKey}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 401 || resp.status === 403) return { status: 'expired', queriedAt: Date.now() };
  if (!resp.ok) { logger.verbose(`[quota] DeepSeek non-2xx ${resp.status} for ${ref.upstreamId}`); return { status: 'error', error: `DeepSeek HTTP ${resp.status}`, queriedAt: Date.now() }; }
  const body: any = await resp.json();
  const balance = parseDeepseekBalance(body);
  if (!balance) return { status: 'error', error: 'DeepSeek: missing balance_infos', queriedAt: Date.now() };
  return { balance, status: 'ok', queriedAt: Date.now() };
}

// ── 火山方舟 Agent Plan / Coding Plan ───────────────────────
//
// 与 GLM/MiniMax（数据面 Bearer 接口）不同，火山用量接口是**控制面 OpenAPI**：
// 统一网关 `open.volcengineapi.com`（不是数据面推理域名 ark.cn-beijing.volces.com），
// 形如 `POST https://open.volcengineapi.com/?Action=...&Version=2024-01-01&Region=cn-beijing`，
// 强制火山引擎签名 V4（AK/SK）。复用推理 Bearer Key 会被网关以 400 InvalidAuthorization
// 拒绝，故需另填账号 AccessKey ID + Secret。两个 plan 共用同一份 AK/SK。
//
// 自动探测：先调 GetAFPUsage（Agent Plan，回绝对额度 Quota/Used），未订阅再调
// GetCodingPlanUsage（Coding Plan，回百分比）。移植自 cc-switch coding_plan.rs。

const VOLC_OPENAPI_HOST = 'open.volcengineapi.com';
const VOLC_API_VERSION = '2024-01-01';
const VOLC_DEFAULT_REGION = 'cn-beijing';
const VOLC_SERVICE = 'ark';
const VOLC_CONTENT_TYPE = 'application/json; charset=utf-8';
// 火山特有：canonical headers 与 SignedHeaders 用固定顺序（不按字母序）。
const VOLC_SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';
const VOLC_AKSK_HINT = 'Check the AccessKey ID / Secret and that the account has Ark usage-query (OpenAPI) permission.';

/** 从数据面 base_url 提取控制面 OpenAPI 所需的 Region；无法识别时回落 cn-beijing。 */
export function volcRegion(baseURL: string): string {
  const host = baseURL.split('://').pop()?.split('/')[0] ?? '';
  const seg = host.split('.').find(p => p.startsWith('cn-') || p.startsWith('ap-'));
  return seg ?? VOLC_DEFAULT_REGION;
}

/** 从 JSON 值提取重置时间：字符串直返；数字自动判断秒/毫秒；<=0 视为无重置时间。 */
function volcExtractReset(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return millisToIso(v);
  return null;
}

/** 判断 OpenAPI 错误码是否属于鉴权类（需硬停并提示换 AK/SK）。 */
export function volcIsAuthErrorCode(code: string): boolean {
  const c = code.toLowerCase();
  return ['auth', 'signature', 'accessdenied', 'denied', 'unauthorized', 'forbidden', 'credential', 'token']
    .some(k => c.includes(k));
}

/** 提取火山 OpenAPI 响应里的 ResponseMetadata.Error（或顶层 Error）。 */
export function volcResponseError(body: any): { code: string; message: string } | null {
  const err = body?.ResponseMetadata?.Error ?? body?.Error;
  if (!err) return null;
  const code = String(err.Code ?? '');
  const message = String(err.Message ?? '');
  if (!code && !message) return null;
  return { code, message };
}

/** 构造按 key 字母序排序、逐段 URL 编码的 canonical query string。签名与实际 URL 共用。 */
export function volcCanonicalQuery(action: string, region: string): string {
  const pairs: Array<[string, string]> = [
    ['Action', action], ['Region', region], ['Version', VOLC_API_VERSION],
  ];
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/**
 * 生成火山引擎签名 V4 头，返回 (authorization, xDate, xContentSha256)。三者都要塞进请求头。
 * 与标准 SigV4 的两处致命差异：固定 header 顺序（不排序）、algorithm 无 AWS4 前缀且
 * scope 结尾 `request`、签名密钥 kDate=HMAC(SK, date)（SK 不加 AWS4 前缀）。`now` 作参数便于确定性单测。
 */
export function volcSign(
  accessKeyId: string, secretAccessKey: string, region: string,
  canonicalQuery: string, body: Buffer, now: Date,
): { authorization: string; xDate: string; xContentSha256: string } {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const y = now.getUTCFullYear(), mo = pad(now.getUTCMonth() + 1), d = pad(now.getUTCDate());
  const h = pad(now.getUTCHours()), mi = pad(now.getUTCMinutes()), s = pad(now.getUTCSeconds());
  const xDate = `${y}${mo}${d}T${h}${mi}${s}Z`;
  const shortDate = `${y}${mo}${d}`;
  const sha256hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const xContentSha256 = sha256hex(body);

  // 固定顺序 canonical headers（火山特有，不排序）。
  const canonicalHeaders =
    `host:${VOLC_OPENAPI_HOST}\nx-date:${xDate}\nx-content-sha256:${xContentSha256}\ncontent-type:${VOLC_CONTENT_TYPE}\n`;
  const canonicalRequest =
    `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${VOLC_SIGNED_HEADERS}\n${xContentSha256}`;

  const credentialScope = `${shortDate}/${region}/${VOLC_SERVICE}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256hex(canonicalRequest)}`;

  const kDate = hmac(secretAccessKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, VOLC_SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization =
    `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${VOLC_SIGNED_HEADERS}, Signature=${signature}`;
  return { authorization, xDate, xContentSha256 };
}

type VolcCall =
  | { kind: 'body'; body: any }
  | { kind: 'auth'; detail: string }
  | { kind: 'soft'; detail: string };

async function volcCall(
  region: string, accessKeyId: string, secretAccessKey: string, action: string, fetchImpl: typeof fetch,
): Promise<VolcCall> {
  const canonicalQuery = volcCanonicalQuery(action, region);
  const url = `https://${VOLC_OPENAPI_HOST}/?${canonicalQuery}`;
  const body = Buffer.alloc(0);
  const { authorization, xDate, xContentSha256 } = volcSign(accessKeyId, secretAccessKey, region, canonicalQuery, body, new Date());

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Date': xDate,
        'X-Content-Sha256': xContentSha256,
        'Content-Type': VOLC_CONTENT_TYPE,
        'Authorization': authorization,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: 'soft', detail: `Network error: ${String((e as Error)?.message ?? e)}` };
  }

  if (resp.status === 401 || resp.status === 403) {
    return { kind: 'auth', detail: `Authentication failed (HTTP ${resp.status}). ${VOLC_AKSK_HINT}` };
  }
  if (!resp.ok) {
    // 火山网关对签名/凭据类错误常返 4xx（多为 400）并携带与 200 相同的 Error 信封，
    // 而非 401/403。解析信封让 Bearer 被拒时也能给出 AK/SK 引导。
    const raw = await resp.text().catch(() => '');
    try {
      const parsed = JSON.parse(raw);
      const err = volcResponseError(parsed);
      if (err) {
        if (volcIsAuthErrorCode(err.code)) return { kind: 'auth', detail: `Authentication failed (HTTP ${resp.status}, ${err.code}): ${err.message}. ${VOLC_AKSK_HINT}` };
        return { kind: 'soft', detail: `API error (HTTP ${resp.status}, ${err.code}): ${err.message}` };
      }
    } catch { /* not JSON */ }
    return { kind: 'soft', detail: `API error (HTTP ${resp.status}): ${raw}` };
  }

  let parsed: any;
  try { parsed = await resp.json(); }
  catch (e) { return { kind: 'soft', detail: `Failed to parse response: ${String((e as Error)?.message ?? e)}` }; }

  // 火山业务错误常以 200 + ResponseMetadata.Error 返回。
  const err = volcResponseError(parsed);
  if (err) {
    if (volcIsAuthErrorCode(err.code)) return { kind: 'auth', detail: `Authentication failed (${err.code}): ${err.message}. ${VOLC_AKSK_HINT}` };
    return { kind: 'soft', detail: `API error (${err.code}): ${err.message}` };
  }
  return { kind: 'body', body: parsed };
}

/**
 * 解析 GetAFPUsage 的 Result 为 tier 列表。展示 5h/周/月三个窗口（与控制台一致）；
 * AFPDaily 被官方控制台隐藏，跳过。Quota<=0 视为该窗口未订阅，跳过——也用于把
 * “已鉴权但无 Agent Plan”识别为空结果，回落 Coding Plan。
 */
export function parseAfpTiers(result: any): { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo; monthly?: QuotaTierInfo } {
  const out: { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo; monthly?: QuotaTierInfo } = {};
  const map: Array<['fiveHour' | 'weekly' | 'monthly', string]> = [
    ['fiveHour', 'AFPFiveHour'], ['weekly', 'AFPWeekly'], ['monthly', 'AFPMonthly'],
  ];
  for (const [slot, key] of map) {
    const win = result?.[key];
    if (!win) continue;
    const quota = asF64(win.Quota) ?? 0;
    if (quota <= 0) continue;
    const used = asF64(win.Used) ?? 0;
    out[slot] = { usedPct: used / quota * 100, resetsAt: volcExtractReset(win.ResetTime) };
  }
  return out;
}

/** 把 GetCodingPlanUsage 的 window 标签归一到 tier 槽位。 */
function volcCodingWindow(label: string): 'fiveHour' | 'weekly' | 'monthly' | null {
  switch (label.toLowerCase()) {
    case 'session': case '5h': case 'fivehour': case 'five_hour': case 'rolling_5h': return 'fiveHour';
    case 'weekly': case 'week': case '7d': return 'weekly';
    case 'monthly': case 'month': return 'monthly';
    default: return null;
  }
}

/**
 * 解析 GetCodingPlanUsage 的 Result 为 tier 列表（防御式）。该接口回 session/weekly/
 * monthly 窗口、只给百分比，重置时间是秒级。真实字段 `Level`（session/weekly/monthly），
 * 其余作 fallback。宽松匹配 QuotaUsage/Usages/Details 数组。
 */
export function parseCodingPlanTiers(result: any): { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo; monthly?: QuotaTierInfo } {
  const out: { fiveHour?: QuotaTierInfo; weekly?: QuotaTierInfo; monthly?: QuotaTierInfo } = {};
  const arr: any[] = Array.isArray(result?.QuotaUsage) ? result.QuotaUsage
    : Array.isArray(result?.Usages) ? result.Usages
    : Array.isArray(result?.Details) ? result.Details
    : [];
  for (const item of arr) {
    const label = String(item?.Level ?? item?.Type ?? item?.Period ?? item?.Label ?? item?.Window ?? '');
    const slot = volcCodingWindow(label);
    if (!slot || out[slot]) continue;
    const usedPct = asF64(item.Percent) ?? asF64(item.UsedPercent) ?? asF64(item.UsagePercent) ?? 0;
    const resetsAt = volcExtractReset(item.ResetTime ?? item.ResetTimestamp);
    out[slot] = { usedPct, resetsAt };
  }
  return out;
}

async function queryVolcengine(ref: QuotaCredentialRef, fetchImpl: typeof fetch): Promise<CredentialQuota> {
  const ak = (ref.accessKeyId ?? '').trim();
  const sk = (ref.secretAccessKey ?? '').trim();
  if (!ak || !sk) {
    return { status: 'not_configured', error: 'Volcengine usage query needs the account AccessKey ID + Secret (not the inference API key)', queriedAt: Date.now() };
  }
  const region = volcRegion(ref.baseURL);
  const softErrors: string[] = [];

  // 1) Agent Plan：GetAFPUsage
  const afp = await volcCall(region, ak, sk, 'GetAFPUsage', fetchImpl);
  if (afp.kind === 'auth') return { status: 'expired', error: afp.detail, queriedAt: Date.now() };
  if (afp.kind === 'soft') softErrors.push(`GetAFPUsage: ${afp.detail}`);
  else {
    const result = afp.body?.Result ?? afp.body;
    const tiers = parseAfpTiers(result);
    if (tiers.fiveHour || tiers.weekly || tiers.monthly) return { ...tiers, status: 'ok', queriedAt: Date.now() };
  }

  // 2) Coding Plan：GetCodingPlanUsage
  const cp = await volcCall(region, ak, sk, 'GetCodingPlanUsage', fetchImpl);
  if (cp.kind === 'auth') return { status: 'expired', error: cp.detail, queriedAt: Date.now() };
  if (cp.kind === 'soft') softErrors.push(`GetCodingPlanUsage: ${cp.detail}`);
  else {
    const result = cp.body?.Result ?? cp.body;
    const tiers = parseCodingPlanTiers(result);
    if (tiers.fiveHour || tiers.weekly || tiers.monthly) return { ...tiers, status: 'ok', queriedAt: Date.now() };
  }

  if (softErrors.length > 0) return { status: 'error', error: softErrors.join('; '), queriedAt: Date.now() };
  return { status: 'error', error: 'No active Agent Plan or Coding Plan subscription found for this credential', queriedAt: Date.now() };
}

/** True if at least one quota limit is configured — i.e. estimated mode can
 *  produce a meaningful usedPct. Without limits, falling back to estimated
 *  would yield an empty (tier-less) snapshot, so we stay not_configured. */
function hasQuotaLimits(limits?: { fiveHourTokens?: number; weeklyTokens?: number }): boolean {
  return typeof limits?.fiveHourTokens === 'number' && limits.fiveHourTokens > 0
    || typeof limits?.weeklyTokens === 'number' && limits.weeklyTokens > 0;
}

async function queryGlm(ref: QuotaCredentialRef, fetchImpl: typeof fetch): Promise<CredentialQuota> {
  const url = `${glmQuotaBase(ref.baseURL)}/api/monitor/usage/quota/limit`;
  const resp = await fetchImpl(url, {
    method: 'GET',
    headers: { 'Authorization': ref.apiKey, 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (resp.status === 401 || resp.status === 403) return { status: 'expired', queriedAt: Date.now() };
  if (!resp.ok) { logger.verbose(`[quota] GLM non-2xx ${resp.status} for ${ref.upstreamId}`); return { status: 'error', error: `GLM HTTP ${resp.status}`, queriedAt: Date.now() }; }
  const body: any = await resp.json();
  if (body?.success === false) {
    const msg = String(body?.msg ?? '');
    // Team-plan (团队套餐) accounts have no official coding-plan quota query
    // interface — the endpoint replies success=false with "当前用户不存在
    // coding plan". Signal not_configured so refreshOnce can fall back to
    // estimated mode (computed from TokenUsageTracker + quotaLimits) instead
    // of surfacing a permanent error on the dashboard.
    if (/coding plan|不存在/i.test(msg)) {
      return { status: 'not_configured', error: msg, queriedAt: Date.now() };
    }
    return { status: 'error', error: `GLM: ${msg || 'unknown'}`, queriedAt: Date.now() };
  }
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
  if (!resp.ok) { logger.verbose(`[quota] MiniMax non-2xx ${resp.status} for ${ref.upstreamId}`); return { status: 'error', error: `MiniMax HTTP ${resp.status}`, queriedAt: Date.now() }; }
  const body: any = await resp.json();
  if (body?.base_resp?.status_code !== undefined && body.base_resp.status_code !== 0) {
    return { status: 'error', error: `MiniMax code ${body.base_resp.status_code}: ${body.base_resp.status_msg ?? ''}`, queriedAt: Date.now() };
  }
  const tiers = parseMinimaxTiers(body);
  return { ...tiers, status: 'ok', queriedAt: Date.now() };
}

export class QuotaFetcher {
  private upstreams: QuotaUpstreamRef[] = [];
  private snapshot = new Map<string, CredentialQuota>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private tokenUsageTracker?: TokenUsageTracker;
  private onRefresh?: (snapshot: Map<string, CredentialQuota>) => void;

  constructor(opts: { fetchImpl?: typeof fetch; intervalMs?: number; now?: () => number; tokenUsageTracker?: TokenUsageTracker; onRefresh?: (snapshot: Map<string, CredentialQuota>) => void } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.tokenUsageTracker = opts.tokenUsageTracker;
    this.onRefresh = opts.onRefresh;
  }

  reload(upstreams: QuotaUpstreamRef[]): void {
    this.upstreams = upstreams;
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
          let result = provider === 'glm' ? await queryGlm(ref, this.fetchImpl)
            : provider === 'minimax' ? await queryMinimax(ref, this.fetchImpl)
            : provider === 'deepseek' ? await queryDeepseek(ref, this.fetchImpl)
            : await queryVolcengine(ref, this.fetchImpl);
          // GLM team-plan accounts expose no official quota query interface
          // (queryGlm returns not_configured with "当前用户不存在coding plan").
          // Fall back to estimated mode from TokenUsageTracker + quotaLimits so
          // the dashboard and proactive cooldown still have usable numbers.
          if (provider === 'glm' && result.status === 'not_configured' && hasQuotaLimits(u.quotaLimits)) {
            result = this.buildEstimatedQuota(u);
          }
          if (result.status === 'error') {
            const prior = this.snapshot.get(key);
            if (prior) {
              if (prior.fiveHour && !result.fiveHour) result.fiveHour = prior.fiveHour;
              if (prior.weekly && !result.weekly) result.weekly = prior.weekly;
              if (prior.monthly && !result.monthly) result.monthly = prior.monthly;
              if (prior.balance && !result.balance) result.balance = prior.balance;
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
            if (prior.monthly && !result.monthly) result.monthly = prior.monthly;
            if (prior.balance && !result.balance) result.balance = prior.balance;
          }
          this.snapshot.set(key, result);
        }
      }));
    }));
    // Notify the credential pool so proactive quota data can steer traffic
    // (mark/clear cooldowns) — this is what connects "dashboard says exhausted"
    // to "selection actually skips the key".
    this.onRefresh?.(this.getSnapshot());
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

  getSnapshot(): Map<string, CredentialQuota> {
    return new Map(this.snapshot);
  }
}
