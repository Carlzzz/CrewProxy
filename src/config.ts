import fs from "fs";
import path from "path";
import { logger } from "./logger";

export interface CodePlanCredential {
  id: string;
  apiKey: string;
  model?: string;
  weight: number;
  enabled: boolean;
}

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
  // Volcengine (火山方舟) usage query uses control-plane OpenAPI with SigV4
  // signing, which needs the account AccessKey ID + Secret — a separate pair
  // from the data-plane inference apiKey. Only meaningful for volces.com upstreams.
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface WebSearchConfig {
  tavilyApiKey?: string;
  braveApiKey?: string;
  bochaApiKey?: string;
}

export interface ModelRouteTarget {
  upstream: string;
  model?: string;
}

export interface ProxyConfig {
  port?: number;
  host?: string;
  defaultUpstream?: UpstreamConfig;
  upstreamsById?: Record<string, UpstreamConfig>;
  modelRoutes?: Record<string, string | ModelRouteTarget>;
  /** Model keys that route normally but are hidden from the GET /models
   * listing. Used for internal tier aliases (opus/sonnet/haiku) that Claude
   * Code calls under the hood — they must resolve, but should not appear in
   * the user's model picker. */
  hiddenModels?: string[];
  webSearch?: WebSearchConfig;
}

export interface ProxyRuntimeContext {
  upstreamsByIdMap: Map<string, UpstreamConfig>;
  defaultUpstream: UpstreamConfig | undefined;
  modelRoutesMap: Map<string, ModelRouteTarget>;
  /** Model keys hidden from GET /models but still routable (internal aliases). */
  hiddenModels?: Set<string>;
  codePlanPool?: CodePlanPoolManager;
  metrics?: MetricsCollector;
  quotaFetcher?: QuotaFetcher;
  tokenUsage?: TokenUsageTracker;
  webSearch?: WebSearchConfig;
}

import type { CodePlanPoolManager } from './codePlanPool';
import type { MetricsCollector } from './metricsCollector';
import type { QuotaFetcher } from './quotaFetcher';
import type { TokenUsageTracker } from './tokenUsageTracker';

export interface ResolvedUpstream {
  upstream: UpstreamConfig;
  modelId: string;
  upstreamRouteId: string;
}

function ensureString(v: unknown, field: string): string {
  if (v === undefined || v === null) {
    throw new Error(`${field} is required`);
  }
  if (typeof v === "string") {
    return v;
  }
  return String(v);
}

export function normalizeUpstream(u: unknown): UpstreamConfig {
  if (u === null || typeof u !== "object") {
    throw new Error("upstream must be an object");
  }
  const o = u as Record<string, unknown>;
  const baseURL = ensureString(o.baseURL, "baseURL").replace(/\/+$/, "");
  const apiKey = ensureString(o.apiKey, "apiKey");
  const model = ensureString(o.model, "model");
  const out: UpstreamConfig = { baseURL, apiKey, model };
  if (o.provider !== undefined && o.provider !== null) {
    out.provider = ensureString(o.provider, "provider");
  }
  if (Array.isArray(o.codePlanCredentials)) {
    out.codePlanCredentials = o.codePlanCredentials
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
      .map(c => ({
        id: String(c.id ?? ''),
        apiKey: String(c.apiKey ?? ''),
        model: c.model !== undefined ? String(c.model) : undefined,
        weight: typeof c.weight === 'number' ? c.weight : 1,
        enabled: c.enabled !== false,
      }));
  }
  if (typeof o.codePlanBaseURL === 'string' && o.codePlanBaseURL) {
    out.codePlanBaseURL = o.codePlanBaseURL.replace(/\/+$/, '');
  }
  if (typeof o.codePlanAnthropicBaseURL === 'string' && o.codePlanAnthropicBaseURL) {
    out.codePlanAnthropicBaseURL = o.codePlanAnthropicBaseURL.replace(/\/+$/, '');
  }
  if (o.ordinaryFallbackModelMap !== undefined && o.ordinaryFallbackModelMap !== null && typeof o.ordinaryFallbackModelMap === 'object') {
    out.ordinaryFallbackModelMap = Object.fromEntries(
      Object.entries(o.ordinaryFallbackModelMap as Record<string, unknown>)
        .map(([k, v]) => [k, String(v)])
    );
  }
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
  if (o.quotaMode === 'fetch' || o.quotaMode === 'estimated') {
    out.quotaMode = o.quotaMode;
  }
  if (typeof o.accessKeyId === 'string' && o.accessKeyId) {
    out.accessKeyId = o.accessKeyId;
  }
  if (typeof o.secretAccessKey === 'string' && o.secretAccessKey) {
    out.secretAccessKey = o.secretAccessKey;
  }
  return out;
}

function normalizeWebSearch(v: unknown): WebSearchConfig {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object') throw new Error('webSearch must be an object');
  const o = v as Record<string, unknown>;
  const out: WebSearchConfig = {};
  if (typeof o.tavilyApiKey === 'string' && o.tavilyApiKey) out.tavilyApiKey = o.tavilyApiKey;
  if (typeof o.braveApiKey === 'string' && o.braveApiKey) out.braveApiKey = o.braveApiKey;
  if (typeof o.bochaApiKey === 'string' && o.bochaApiKey) out.bochaApiKey = o.bochaApiKey;
  return out;
}

function readConfigFile(filePath: string): ProxyConfig {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const raw: unknown = JSON.parse(text);
    return parseProxyConfigObject(raw);
  } catch (e) {
    logger.error("Failed to load config file", filePath, e);
    throw e;
  }
}

function loadFromEnvUpstream(): ProxyConfig | null {
  const baseURL = process.env.UPSTREAM_BASE_URL;
  const apiKey = process.env.UPSTREAM_API_KEY;
  const model = process.env.UPSTREAM_MODEL;
  if (baseURL === undefined || apiKey === undefined || model === undefined) {
    return null;
  }
  const config: ProxyConfig = {
    defaultUpstream: normalizeUpstream({
      baseURL,
      apiKey,
      model,
      provider: process.env.UPSTREAM_PROVIDER,
    }),
  };
  const portRaw = process.env.PORT;
  if (portRaw !== undefined) {
    const p = Number(portRaw);
    if (!Number.isNaN(p)) {
      config.port = p;
    }
  }
  return config;
}

export function loadConfig(configPathArg?: string): ProxyConfig {
  if (configPathArg !== undefined && configPathArg !== "") {
    const resolved = path.isAbsolute(configPathArg)
      ? configPathArg
      : path.resolve(process.cwd(), configPathArg);
    return readConfigFile(resolved);
  }

  const envPath = process.env.WOICLAW_PROXY_CONFIG;
  if (envPath !== undefined && envPath !== "") {
    const resolved = path.isAbsolute(envPath)
      ? envPath
      : path.resolve(process.cwd(), envPath);
    return readConfigFile(resolved);
  }

  const defaultFile = path.join(process.cwd(), "proxy-config.json");
  if (fs.existsSync(defaultFile)) {
    return readConfigFile(defaultFile);
  }

  const fromEnv = loadFromEnvUpstream();
  if (fromEnv !== null) {
    return fromEnv;
  }

  throw new Error(
    "No proxy configuration found: set config path, WOICLAW_PROXY_CONFIG, proxy-config.json, or UPSTREAM_* env vars",
  );
}

export function parseProxyConfigObject(raw: unknown): ProxyConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error("config must be an object");
  }
  const r = raw as Record<string, unknown>;
  const out: ProxyConfig = {};
  if (typeof r.port === "number") {
    out.port = r.port;
  }
  if (typeof r.host === "string") {
    out.host = r.host;
  }
  if (r.defaultUpstream !== undefined) {
    out.defaultUpstream = normalizeUpstream(r.defaultUpstream);
  }
  if (r.upstreamsById !== undefined) {
    if (r.upstreamsById === null || typeof r.upstreamsById !== "object") {
      throw new Error("upstreamsById must be an object");
    }
    const rec: Record<string, UpstreamConfig> = {};
    for (const [id, u] of Object.entries(
      r.upstreamsById as Record<string, unknown>,
    )) {
      rec[id] = normalizeUpstream(u);
    }
    out.upstreamsById = rec;
  }
  if (r.modelRoutes !== undefined) {
    if (r.modelRoutes === null || typeof r.modelRoutes !== "object") {
      throw new Error("modelRoutes must be an object");
    }
    const routes: Record<string, string | ModelRouteTarget> = {};
    for (const [model, target] of Object.entries(
      r.modelRoutes as Record<string, unknown>,
    )) {
      if (target !== null && typeof target === "object") {
        const t = target as Record<string, unknown>;
        routes[model] = {
          upstream: String(t.upstream),
          model: t.model !== undefined ? String(t.model) : undefined,
        };
      } else {
        routes[model] = String(target);
      }
    }
    out.modelRoutes = routes;
  }
  if (r.hiddenModels !== undefined) {
    if (!Array.isArray(r.hiddenModels)) {
      throw new Error("hiddenModels must be an array of strings");
    }
    out.hiddenModels = r.hiddenModels.map((m) => String(m).trim()).filter((m) => m !== "");
  }
  if (r.webSearch !== undefined) {
    out.webSearch = normalizeWebSearch(r.webSearch);
  }
  return out;
}

export function normalizeModelRouteTarget(v: string | ModelRouteTarget): ModelRouteTarget {
  if (typeof v === "string") {
    return { upstream: v };
  }
  return v;
}

export function buildUpstreamsByIdMap(config: ProxyConfig): ProxyRuntimeContext {
  const upstreamsByIdMap = new Map<string, UpstreamConfig>();
  if (config.upstreamsById !== undefined) {
    for (const [id, u] of Object.entries(config.upstreamsById)) {
      upstreamsByIdMap.set(id, u);
    }
  }
  const modelRoutesMap = new Map<string, ModelRouteTarget>();
  if (config.modelRoutes !== undefined) {
    for (const [model, target] of Object.entries(config.modelRoutes)) {
      modelRoutesMap.set(model, normalizeModelRouteTarget(target));
    }
  }
  const hiddenModels = new Set<string>(config.hiddenModels ?? []);
  return {
    upstreamsByIdMap,
    defaultUpstream: config.defaultUpstream,
    modelRoutesMap,
    hiddenModels,
    webSearch: config.webSearch,
  };
}

export function resolveUpstreamFromModel(
  modelStr: string,
  upstreamsByIdMap: Map<string, UpstreamConfig>,
  defaultUpstream: UpstreamConfig | undefined,
  modelRoutesMap?: Map<string, ModelRouteTarget>,
): ResolvedUpstream | null {
  const pipe = modelStr.indexOf("|");
  if (pipe !== -1) {
    const upstreamId = modelStr.slice(0, pipe);
    const modelIdPart = modelStr.slice(pipe + 1);
    const named = upstreamsByIdMap.get(upstreamId);
    if (named !== undefined) {
      const modelId =
        modelIdPart === "" ? named.model : modelIdPart;
      return {
        upstream: named,
        modelId,
        upstreamRouteId: upstreamId,
      };
    }
    if (defaultUpstream !== undefined) {
      const modelId =
        modelIdPart === ""
          ? defaultUpstream.model
          : modelIdPart;
      return {
        upstream: defaultUpstream,
        modelId,
        upstreamRouteId: "__default__",
      };
    }
    return null;
  }

  if (modelRoutesMap && modelStr !== "") {
    const routeTarget = modelRoutesMap.get(modelStr);
    if (routeTarget !== undefined) {
      const routed = upstreamsByIdMap.get(routeTarget.upstream);
      if (routed !== undefined) {
        const modelId = routeTarget.model ?? modelStr;
        return {
          upstream: routed,
          modelId,
          upstreamRouteId: routeTarget.upstream,
        };
      }
      logger.error(`modelRoutes maps "${modelStr}" to upstream "${routeTarget.upstream}" but that upstream is not in upstreamsById`);
    }
  }

  if (defaultUpstream === undefined) {
    return null;
  }
  const modelId =
    modelStr === "" ? defaultUpstream.model : modelStr;
  return {
    upstream: defaultUpstream,
    modelId,
    upstreamRouteId: "__default__",
  };
}

export function resolveConfigFilePath(configPathArg?: string): string {
  if (configPathArg !== undefined && configPathArg !== "") {
    return path.isAbsolute(configPathArg)
      ? configPathArg
      : path.resolve(process.cwd(), configPathArg);
  }
  if (process.env.WOICLAW_PROXY_CONFIG !== undefined && process.env.WOICLAW_PROXY_CONFIG !== "") {
    const envPath = process.env.WOICLAW_PROXY_CONFIG;
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  return path.join(process.cwd(), "proxy-config.json");
}
