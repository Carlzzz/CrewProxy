import fs from 'fs';
import {
  parseProxyConfigObject,
  resolveConfigFilePath,
  type UpstreamConfig,
  type ModelRouteTarget,
} from './config';
import { logger } from './logger';
import { maskSecret } from './configRedaction';
import { validateResolvedProxyConfig, type ValidationResult } from './configValidation';

export type ApiKeyMode = 'keep' | 'replace';

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/** Deep clone via JSON — safe here because proxy-config.json is plain JSON. */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
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
  const o = draftVal;
  if (o.apiKeyMode === 'keep') return { key: cur ?? '', mode: 'keep' };
  if (typeof o.apiKey === 'string') return { key: o.apiKey, mode: 'replace' };
  return { key: cur ?? '', mode: 'keep' };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/* ------------------------------------------------------------------ */
/*  Raw-based merge                                                     */
/*                                                                     */
/*  The persisted proxy-config.json is the source of truth. A save      */
/*  request (draft) only carries the fields the provider page edits;    */
/*  everything else on disk (port, host, per-upstream quotaMode,        */
/*  ordinaryFallbackModelMap, codePlanBaseURL, and any future/unknown   */
/*  fields) MUST survive untouched. We therefore clone the current raw  */
/*  object and overlay only the draft fields, instead of rebuilding the */
/*  whole config from a whitelist.                                      */
/* ------------------------------------------------------------------ */

function mergeCredentialRaw(
  curCred: unknown,
  draftCred: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> = isObject(curCred) ? cloneJson(curCred) : {};
  if (!isObject(draftCred)) return base;
  const d = draftCred;
  if (d.id !== undefined) base.id = String(d.id);
  const { key } = resolveSecretField(asString((curCred as Record<string, unknown> | undefined)?.apiKey), d);
  base.apiKey = key;
  if (d.weight !== undefined) base.weight = Number(d.weight);
  if (d.enabled !== undefined) base.enabled = d.enabled !== false;
  if (d.model !== undefined) base.model = String(d.model);
  return base;
}

function mergeUpstreamRaw(
  curUp: unknown,
  draftUp: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> = isObject(curUp) ? cloneJson(curUp) : {};
  if (!isObject(draftUp)) return base;
  const d = draftUp;
  if (d.baseURL !== undefined) base.baseURL = String(d.baseURL);
  const { key } = resolveSecretField(asString((curUp as Record<string, unknown> | undefined)?.apiKey), d);
  base.apiKey = key;
  if (d.model !== undefined) base.model = String(d.model);
  if (d.provider !== undefined) base.provider = String(d.provider);
  if (d.quotaLimits !== undefined && isObject(d.quotaLimits)) {
    base.quotaLimits = cloneJson(d.quotaLimits);
  }
  if (Array.isArray(d.codePlanCredentials)) {
    const curCreds = Array.isArray(base.codePlanCredentials) ? base.codePlanCredentials : [];
    base.codePlanCredentials = d.codePlanCredentials.map((raw) => {
      const dc = isObject(raw) ? raw : {};
      const idStr = String(dc.id ?? '');
      const curCred = curCreds.find((c) => {
        const cc = c as Record<string, unknown>;
        return isObject(cc) && String(cc.id ?? '') === idStr;
      });
      return mergeCredentialRaw(curCred, dc);
    });
  }
  // quotaMode / ordinaryFallbackModelMap / codePlanBaseURL /
  // codePlanAnthropicBaseURL and any unknown field stay in `base` untouched.
  return base;
}

export function mergeConfigDraftRaw(rawCurrent: unknown, draft: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(rawCurrent) ? cloneJson(rawCurrent) : {};
  if (!isObject(draft)) return out;
  const d = draft;
  if (typeof d.port === 'number') out.port = d.port;
  if (typeof d.host === 'string') out.host = d.host;
  if (d.defaultUpstream !== undefined) {
    out.defaultUpstream = mergeUpstreamRaw(out.defaultUpstream, d.defaultUpstream);
  }
  if (d.upstreamsById !== undefined && isObject(d.upstreamsById)) {
    const curMap = isObject(out.upstreamsById)
      ? (out.upstreamsById as Record<string, unknown>)
      : {};
    const result: Record<string, unknown> = {};
    for (const [id, du] of Object.entries(d.upstreamsById)) {
      result[id] = mergeUpstreamRaw(curMap[id], du);
    }
    out.upstreamsById = result;
  }
  if (d.modelRoutes !== undefined && isObject(d.modelRoutes)) {
    out.modelRoutes = cloneJson(d.modelRoutes);
  }
  return out;
}

/**
 * Merge a draft (with apiKeyMode) onto the current raw config, restoring real
 * secrets for 'keep' and preserving every field the draft does not touch.
 * Kept as an export for backwards compatibility with callers/tests; new code
 * should call {@link mergeConfigDraftRaw}.
 */
export function mergeSecrets(currentReal: unknown, draft: unknown): Record<string, unknown> {
  return mergeConfigDraftRaw(currentReal, draft);
}

/* ------------------------------------------------------------------ */
/*  Raw-based redaction (GET)                                           */
/* ------------------------------------------------------------------ */

function redactCredentialRaw(c: Record<string, unknown>): Record<string, unknown> {
  const out = cloneJson(c);
  const apiKey = out.apiKey;
  delete out.apiKey;
  out.hasApiKey = Boolean(apiKey);
  out.apiKeyMasked = maskSecret(asString(apiKey));
  return out;
}

function redactUpstreamRaw(u: Record<string, unknown>): Record<string, unknown> {
  const out = cloneJson(u);
  const apiKey = out.apiKey;
  delete out.apiKey;
  out.hasApiKey = Boolean(apiKey);
  out.apiKeyMasked = maskSecret(asString(apiKey));
  if (Array.isArray(out.codePlanCredentials)) {
    out.codePlanCredentials = out.codePlanCredentials.map((c) =>
      isObject(c) ? redactCredentialRaw(c) : c,
    );
  }
  return out;
}

export function redactRawConfig(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(raw) ? cloneJson(raw) : {};
  if (isObject(out.defaultUpstream)) {
    out.defaultUpstream = redactUpstreamRaw(out.defaultUpstream as Record<string, unknown>);
  }
  if (isObject(out.upstreamsById)) {
    const redacted: Record<string, unknown> = {};
    for (const [id, u] of Object.entries(out.upstreamsById)) {
      redacted[id] = isObject(u) ? redactUpstreamRaw(u as Record<string, unknown>) : u;
    }
    out.upstreamsById = redacted;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Disk I/O                                                            */
/* ------------------------------------------------------------------ */

function readRawConfig(): unknown {
  const fp = resolveConfigFilePath();
  const text = fs.readFileSync(fp, 'utf-8');
  return JSON.parse(text);
}

function atomicWriteConfig(merged: unknown): string {
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
      const raw = readRawConfig();
      const redacted = redactRawConfig(raw);
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
      const raw = readRawConfig();
      const merged = mergeConfigDraftRaw(raw, body);
      // Validate the resolved shape; validation never touches the disk file.
      const parsed = parseProxyConfigObject(merged);
      const result: ValidationResult = validateResolvedProxyConfig(parsed);
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
      const raw = readRawConfig();
      const merged = mergeConfigDraftRaw(raw, body);
      // Validate the resolved shape before writing; on failure the file is
      // left byte-for-byte unchanged.
      const parsed = parseProxyConfigObject(merged);
      const result = validateResolvedProxyConfig(parsed);
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
