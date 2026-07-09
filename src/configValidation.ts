import type { ProxyConfig, UpstreamConfig } from './config';

export interface ValidationIssue { path: string; message: string }
export interface ValidationResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

const UPSTREAM_ID_RE = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_PROVIDERS = new Set(['glm', 'minimax', 'openai', 'deepseek', 'claude', 'gemini', 'ark', 'custom', 'zai', 'ali']);

function isUrl(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateResolvedProxyConfig(config: ProxyConfig): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const upstreamIds = new Set<string>();
  const upstreams = config.upstreamsById ?? {};
  if (Object.keys(upstreams).length === 0 && !config.defaultUpstream) {
    errors.push({ path: 'upstreamsById', message: '至少需要配置一个 upstream' });
  }
  for (const [id, u] of Object.entries(upstreams)) {
    const base = `upstreamsById.${id}`;
    if (!UPSTREAM_ID_RE.test(id)) {
      errors.push({ path: base, message: 'upstreamId 只能含字母、数字、下划线或短横线' });
    }
    upstreamIds.add(id);
    const ur = validateUpstream(base, u);
    errors.push(...ur.errors);
    warnings.push(...ur.warnings);
  }
  if (config.defaultUpstream) {
    const dr = validateUpstream('defaultUpstream', config.defaultUpstream);
    errors.push(...dr.errors);
    warnings.push(...dr.warnings);
  }

  const routes = config.modelRoutes ?? {};
  for (const [model, target] of Object.entries(routes)) {
    const normalized = typeof target === 'string' ? { upstream: target } : target;
    const upstream = normalized?.upstream;
    const path = `modelRoutes.${model}`;
    if (!upstream) {
      errors.push({ path, message: '缺少 upstream' });
    } else if (upstream !== '__default__' && !upstreamIds.has(upstream)) {
      errors.push({ path, message: `引用的 upstream 不存在：${upstream}` });
    }
    if (typeof target === 'object' && (target.model === undefined || target.model === '')) {
      warnings.push({ path, message: '未指定 upstream model，将使用 upstream 默认 model' });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateUpstream(base: string, u: UpstreamConfig): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errs: ValidationIssue[] = [];
  const warns: ValidationIssue[] = [];
  if (!isUrl(u.baseURL)) errs.push({ path: `${base}.baseURL`, message: 'baseURL 必须是合法 http(s) URL' });
  if (!u.model) errs.push({ path: `${base}.model`, message: 'model 必填' });

  // Validate code-plan credentials first so we know whether any pooled key
  // exists. The upstream-level apiKey is only required when there is no
  // usable coding-plan pool: the proxy serves code-plan requests from
  // codePlanCredentials[].apiKey and treats an empty upstream apiKey as
  // "no ordinary fallback" (proxy.ts), so a code-plan-only upstream may
  // legitimately leave apiKey empty.
  const codePlanCreds = u.codePlanCredentials ?? [];
  const hasPooledKey = codePlanCreds.some((c) => c.apiKey);
  if (!u.apiKey) {
    if (hasPooledKey) {
      warns.push({ path: `${base}.apiKey`, message: '上游 apiKey 留空，将仅使用 codePlanCredentials 的凭据（无普通回退）' });
    } else {
      errs.push({ path: `${base}.apiKey`, message: 'apiKey 必填，或至少配置一个 codePlanCredential 的 apiKey' });
    }
  }

  // provider is free-form in the proxy (only affects request transformation;
  // unknown providers are served via the generic Chat Completions path), so an
  // unrecognized value is a warning, not a hard error. This keeps real configs
  // that use provider values like "gpt" validatable.
  if (u.provider !== undefined && u.provider !== '' && !ALLOWED_PROVIDERS.has(u.provider)) {
    warns.push({ path: `${base}.provider`, message: `provider "${u.provider}" 不在已知列表中，将按通用 Chat Completions 模式处理` });
  }
  if (u.codePlanCredentials) {
    const seen = new Set<string>();
    for (const c of u.codePlanCredentials) {
      const cb = `${base}.codePlanCredentials[${c.id}]`;
      if (!c.id) errs.push({ path: cb, message: 'credential id 必填' });
      if (c.id && seen.has(c.id)) errs.push({ path: cb, message: `credential id 重复：${c.id}` });
      if (c.id) seen.add(c.id);
      if (!c.apiKey) errs.push({ path: cb, message: 'credential apiKey 必填' });
      if (!(c.weight > 0)) errs.push({ path: `${cb}.weight`, message: 'weight 必须为正数' });
    }
  }
  if (u.quotaLimits) {
    if (u.quotaLimits.fiveHourTokens !== undefined && (!Number.isInteger(u.quotaLimits.fiveHourTokens) || u.quotaLimits.fiveHourTokens <= 0)) {
      errs.push({ path: `${base}.quotaLimits.fiveHourTokens`, message: 'fiveHourTokens 必须为正整数' });
    }
    if (u.quotaLimits.weeklyTokens !== undefined && (!Number.isInteger(u.quotaLimits.weeklyTokens) || u.quotaLimits.weeklyTokens <= 0)) {
      errs.push({ path: `${base}.quotaLimits.weeklyTokens`, message: 'weeklyTokens 必须为正整数' });
    }
  }
  return { errors: errs, warnings: warns };
}

export function validateProxyConfigDraft(draft: unknown): ValidationResult {
  if (draft === null || typeof draft !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'config 必须是对象' }], warnings: [] };
  }
  const d = draft as Record<string, unknown>;
  const upstreams = d.upstreamsById;
  if (upstreams === undefined && d.defaultUpstream === undefined) {
    return { ok: false, errors: [{ path: 'upstreamsById', message: '至少需要配置一个 upstream' }], warnings: [] };
  }
  // 结构层面交由调用方合并 key 后再用 validateResolvedProxyConfig 做细校验；
  // 这里只做轻量存在性检查。
  return { ok: true, errors: [], warnings: [] };
}
