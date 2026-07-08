import fs from 'fs';
import {
  parseProxyConfigObject,
  resolveConfigFilePath,
  type ProxyConfig,
  type UpstreamConfig,
  type CodePlanCredential,
  type ModelRouteTarget,
} from './config';
import { logger } from './logger';
import { redactProxyConfig } from './configRedaction';
import { validateResolvedProxyConfig, type ValidationResult } from './configValidation';

export type ApiKeyMode = 'keep' | 'replace';

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/**
 * Resolve the apiKey for an upstream/credential given a draft value.
 *
 * Semantics:
 *   - Explicit `apiKeyMode: 'keep'` ALWAYS restores the current real key,
 *     ignoring any `apiKey` field present in the draft. This is the security-
 *     critical guarantee: a redacted draft round-tripped back to PUT must not
 *     accidentally clobber the real key with a masked/placeholder value.
 *   - `apiKeyMode: 'replace'` (or no mode but a string `apiKey`) writes the
 *     draft key.
 *   - Otherwise (no mode, no usable apiKey) the current key is preserved.
 */
function resolveSecretField(
  cur: string | undefined,
  draftVal: unknown,
): { key: string; mode: ApiKeyMode } {
  if (!isObject(draftVal)) return { key: cur ?? '', mode: 'keep' };
  const o = draftVal as Record<string, unknown>;
  if (o.apiKeyMode === 'keep') return { key: cur ?? '', mode: 'keep' };
  if (typeof o.apiKey === 'string') return { key: o.apiKey, mode: 'replace' };
  return { key: cur ?? '', mode: 'keep' };
}

/** Merge a draft (with apiKeyMode) onto current real config, restoring real secrets for 'keep'. */
export function mergeSecrets(currentReal: ProxyConfig, draft: unknown): ProxyConfig {
  if (!isObject(draft)) throw new Error('draft must be an object');
  const d = draft as Record<string, unknown>;

  const mergeUpstream = (id: string, cur: UpstreamConfig | undefined, du: unknown): UpstreamConfig => {
    if (!isObject(du)) throw new Error(`upstream ${id} must be an object`);
    const o = du as Record<string, unknown>;
    const baseURL = String(o.baseURL ?? cur?.baseURL ?? '');
    const { key } = resolveSecretField(cur?.apiKey, o);
    const model = String(o.model ?? cur?.model ?? '');
    const out: UpstreamConfig = { baseURL, apiKey: key, model };
    if (o.provider !== undefined) out.provider = String(o.provider);
    if (Array.isArray(o.codePlanCredentials)) {
      out.codePlanCredentials = (o.codePlanCredentials as unknown[]).map((raw, i) => {
        const c = isObject(raw) ? raw as Record<string, unknown> : {};
        const curCred = cur?.codePlanCredentials?.find(x => x.id === String(c.id ?? ''));
        const ck = resolveSecretField(curCred?.apiKey, c);
        const cred: CodePlanCredential = {
          id: String(c.id ?? ''),
          apiKey: ck.key,
          model: c.model !== undefined ? String(c.model) : undefined,
          weight: typeof c.weight === 'number' ? c.weight : (curCred?.weight ?? 1),
          enabled: c.enabled !== undefined ? c.enabled !== false : (curCred?.enabled ?? true),
        };
        return cred;
      });
    } else if (cur?.codePlanCredentials) {
      out.codePlanCredentials = cur.codePlanCredentials;
    }
    if (o.quotaLimits !== undefined && isObject(o.quotaLimits)) {
      const ql = o.quotaLimits as Record<string, unknown>;
      out.quotaLimits = {};
      if (typeof ql.fiveHourTokens === 'number') out.quotaLimits.fiveHourTokens = ql.fiveHourTokens;
      if (typeof ql.weeklyTokens === 'number') out.quotaLimits.weeklyTokens = ql.weeklyTokens;
    } else if (cur?.quotaLimits) {
      out.quotaLimits = cur.quotaLimits;
    }
    if (o.codePlanBaseURL !== undefined) out.codePlanBaseURL = String(o.codePlanBaseURL);
    if (o.codePlanAnthropicBaseURL !== undefined) out.codePlanAnthropicBaseURL = String(o.codePlanAnthropicBaseURL);
    if (o.quotaMode === 'fetch' || o.quotaMode === 'estimated') out.quotaMode = o.quotaMode;
    return out;
  };

  const merged: ProxyConfig = {};
  if (typeof d.port === 'number') merged.port = d.port;
  if (typeof d.host === 'string') merged.host = d.host;

  if (d.defaultUpstream !== undefined) {
    merged.defaultUpstream = mergeUpstream('__default__', currentReal.defaultUpstream, d.defaultUpstream);
  } else if (currentReal.defaultUpstream) {
    merged.defaultUpstream = currentReal.defaultUpstream;
  }

  if (d.upstreamsById !== undefined) {
    if (!isObject(d.upstreamsById)) throw new Error('upstreamsById must be an object');
    const curMap = currentReal.upstreamsById ?? {};
    const out: Record<string, UpstreamConfig> = {};
    for (const [id, du] of Object.entries(d.upstreamsById as Record<string, unknown>)) {
      out[id] = mergeUpstream(id, curMap[id], du);
    }
    merged.upstreamsById = out;
  } else if (currentReal.upstreamsById) {
    merged.upstreamsById = currentReal.upstreamsById;
  }

  if (d.modelRoutes !== undefined) {
    if (!isObject(d.modelRoutes)) throw new Error('modelRoutes must be an object');
    const routes: Record<string, string | ModelRouteTarget> = {};
    for (const [model, target] of Object.entries(d.modelRoutes as Record<string, unknown>)) {
      if (target !== null && typeof target === 'object') {
        const t = target as Record<string, unknown>;
        routes[model] = { upstream: String(t.upstream), model: t.model !== undefined ? String(t.model) : undefined };
      } else {
        routes[model] = String(target);
      }
    }
    merged.modelRoutes = routes;
  } else if (currentReal.modelRoutes) {
    merged.modelRoutes = currentReal.modelRoutes;
  }

  return merged;
}

function readRealConfig(): ProxyConfig {
  const fp = resolveConfigFilePath();
  const text = fs.readFileSync(fp, 'utf-8');
  return parseProxyConfigObject(JSON.parse(text));
}

function atomicWriteConfig(merged: ProxyConfig): string {
  const fp = resolveConfigFilePath();
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, fp); // atomic on same filesystem
  return fp;
}

function sendJson(res: any, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface AdminCtx {
  upstreamsByIdMap: Map<string, UpstreamConfig>;
  defaultUpstream?: UpstreamConfig;
  modelRoutesMap: Map<string, ModelRouteTarget>;
}

/**
 * Dispatch an already-authenticated /admin/config* request.
 * Auth is enforced by the caller (proxy.ts) — this handler assumes the request
 * is trusted and only performs business logic.
 */
export async function handleAdminConfigRequest(
  req: any,
  res: any,
  ctx: AdminCtx,
  _configPathArg?: string,
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const url = (req.url || '/').split('?')[0];

  if (method === 'GET' && url === '/admin/config') {
    try {
      const real = readRealConfig();
      const redacted = redactProxyConfig(real);
      sendJson(res, 200, {
        configPath: resolveConfigFilePath(),
        defaultUpstream: redacted.defaultUpstream,
        upstreamsById: redacted.upstreamsById,
        modelRoutes: redacted.modelRoutes,
        updatedAt: Date.now(),
      });
    } catch (e) {
      logger.error('admin/config GET failed:', e);
      sendJson(res, 500, { error: '读取配置失败' });
    }
    return;
  }

  if (method === 'POST' && url === '/admin/config/validate') {
    try {
      const body = await readJsonBody(req);
      const real = readRealConfig();
      const merged = mergeSecrets(real, body);
      const result: ValidationResult = validateResolvedProxyConfig(merged);
      sendJson(res, 200, result);
    } catch (e) {
      logger.error('admin/config/validate failed:', e);
      sendJson(res, 200, { ok: false, errors: [{ path: '', message: '校验异常' }], warnings: [] });
    }
    return;
  }

  if (method === 'PUT' && url === '/admin/config') {
    try {
      const body = await readJsonBody(req);
      const real = readRealConfig();
      const merged = mergeSecrets(real, body);
      const result = validateResolvedProxyConfig(merged);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, errors: result.errors, warnings: result.warnings });
        return;
      }
      const fp = atomicWriteConfig(merged);
      sendJson(res, 200, {
        ok: true,
        savedAt: Date.now(),
        configPath: fp,
        reload: { mode: 'file-watch', expectedWithinMs: 300 },
      });
    } catch (e) {
      logger.error('admin/config PUT failed:', e);
      sendJson(res, 500, { ok: false, error: '保存配置失败' });
    }
    return;
  }

  if (method === 'GET' && url === '/admin/config/effective') {
    const upstreams: any[] = [];
    for (const [id, u] of ctx.upstreamsByIdMap) {
      const creds = u.codePlanCredentials ?? [];
      upstreams.push({
        upstreamId: id,
        provider: u.provider ?? id,
        model: u.model,
        baseURL: u.baseURL,
        credentialCount: creds.length,
        enabledCredentialCount: creds.filter(c => c.enabled).length,
      });
    }
    const models: any[] = [];
    for (const [model, target] of ctx.modelRoutesMap) {
      models.push({ model, upstream: target.upstream, upstreamModel: target.model ?? null });
    }
    sendJson(res, 200, {
      ok: true,
      defaultUpstream: ctx.defaultUpstream ? '(default)' : null,
      upstreams,
      models,
      loadedAt: Date.now(),
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function readJsonBody(req: any): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
