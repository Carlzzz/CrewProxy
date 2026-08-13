import * as fs from 'fs';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig, parseProxyConfigObject, buildUpstreamsByIdMap, ProxyConfig, UpstreamConfig, resolveConfigFilePath } from './config';
import { createProxyServer } from './proxy';
import { CodePlanPoolManager } from './codePlanPool';
import { MetricsCollector } from './metricsCollector';
import { QuotaFetcher, detectQuotaProvider } from './quotaFetcher';
import type { QuotaUpstreamRef } from './quotaFetcher';
import { TokenUsageTracker } from './tokenUsageTracker';
import { JsonStateStore } from './stateStore';
import { logger } from './logger';

dotenvConfig();

const configPathArg = process.argv[2];
let currentConfig: ProxyConfig;

try {
  currentConfig = loadConfig(configPathArg);
} catch (err) {
  logger.error('Failed to load config:', err);
  process.exit(1);
}

const ctx = buildUpstreamsByIdMap(currentConfig);

// Persisted runtime state (token-usage windows + credential cooldowns) survives restarts
const STATE_DIR = process.env.WOICLAW_STATE_DIR || './data';

// Initialize Code Plan credential pool (cooldowns restored before reconcile)
const cooldownStore = new JsonStateStore(`${STATE_DIR}/cooldowns.json`);
const codePlanPool = new CodePlanPoolManager({ store: cooldownStore });
codePlanPool.reconcileFromConfig(currentConfig);
ctx.codePlanPool = codePlanPool;

// Initialize metrics + quota fetcher
const metrics = new MetricsCollector();
ctx.metrics = metrics;

const tokenUsageStore = new JsonStateStore(`${STATE_DIR}/token-usage.json`);
const tokenUsage = new TokenUsageTracker({ store: tokenUsageStore });
ctx.tokenUsage = tokenUsage;

function buildQuotaUpstreams(cfg: ProxyConfig): QuotaUpstreamRef[] {
  const out: QuotaUpstreamRef[] = [];
  const collect = (upstreamId: string, u: UpstreamConfig | undefined) => {
    if (!u) return;
    // Volcengine (火山方舟) quota is account-level (one AK/SK), queried via
    // control-plane OpenAPI rather than a per-key data-plane balance endpoint.
    // Such upstreams have no codePlanCredentials pool, so synthesize a single
    // 'account' credential carrying the AK/SK when they're configured.
    if (u.accessKeyId && u.secretAccessKey && !u.codePlanCredentials?.length) {
      out.push({
        upstreamId,
        quotaMode: 'fetch',
        quotaLimits: u.quotaLimits,
        credentials: [{ upstreamId, credentialId: 'account', apiKey: u.apiKey, baseURL: u.baseURL, accessKeyId: u.accessKeyId, secretAccessKey: u.secretAccessKey }],
      });
      return;
    }
    if (!u.codePlanCredentials?.length) {
      // Account-level balance providers (e.g. DeepSeek pay-as-you-go) have no
      // credential pool — just a single upstream apiKey. Synthesize an 'account'
      // credential so their balance still shows on the dashboard. Gated to
      // balance providers so quota-type upstreams (GLM/MiniMax) configured only
      // via a bare default apiKey aren't silently pulled into official-API polling.
      if (u.apiKey && detectQuotaProvider(u.baseURL) === 'deepseek') {
        out.push({
          upstreamId,
          quotaMode: 'fetch',
          quotaLimits: u.quotaLimits,
          credentials: [{ upstreamId, credentialId: 'account', apiKey: u.apiKey, baseURL: u.baseURL }],
        });
      }
      return;
    }
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

const quotaFetcher = new QuotaFetcher({
  tokenUsageTracker: tokenUsage,
  // Feed every fresh quota snapshot into the pool so an exhausted credential
  // is proactively cooled down (and recovered ones released) without waiting
  // for a reactive 429. This closes the gap where the dashboard showed a key
  // at 100% but traffic kept hitting it.
  onRefresh: (snap) => codePlanPool.applyQuotaSnapshot(snap),
});
quotaFetcher.reload(buildQuotaUpstreams(currentConfig));
quotaFetcher.start();
ctx.quotaFetcher = quotaFetcher;

const port = currentConfig.port || 3456;
const host = currentConfig.host || '0.0.0.0';

// 防止 undici 内部 Fetch 因 socket 错误（ECONNRESET 等）抛出 TypeError: terminated
// 导致未处理的 Promise rejection 使进程崩溃
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.message === 'terminated') {
    logger.warn('Suppressed unhandled rejection: terminated (upstream connection lost)');
    return;
  }
  logger.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  if (err instanceof Error && err.message === 'terminated') {
    logger.warn('Suppressed uncaught exception: terminated (upstream connection lost)');
    return;
  }
  logger.error('Uncaught exception:', err);
  process.exit(1);
});

const server = createProxyServer(ctx);

server.listen(port, host, () => {
  logger.info(`Claw Proxy listening on ${host}:${port}`);
  const upstreamCount = ctx.upstreamsByIdMap.size;
  const hasDefault = !!ctx.defaultUpstream;
  const routeCount = ctx.modelRoutesMap.size;
  logger.info(`Upstreams: ${upstreamCount} named${hasDefault ? ' + default' : ''}${routeCount > 0 ? `, ${routeCount} model routes` : ''}`);
});

const configFilePath = resolveConfigFilePath(configPathArg);

if (fs.existsSync(configFilePath)) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  fs.watch(configFilePath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        const raw = fs.readFileSync(configFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const newConfig = parseProxyConfigObject(parsed);
        const newCtx = buildUpstreamsByIdMap(newConfig);

        ctx.upstreamsByIdMap = newCtx.upstreamsByIdMap;
        ctx.defaultUpstream = newCtx.defaultUpstream;
        ctx.modelRoutesMap = newCtx.modelRoutesMap;
        ctx.webSearch = newCtx.webSearch;
        codePlanPool.reconcileFromConfig(newConfig);
        currentConfig = newConfig;
        quotaFetcher.reload(buildQuotaUpstreams(newConfig));

        logger.info('Config reloaded successfully');
      } catch (err) {
        logger.error('Config reload failed (keeping old config):', err);
      }
    }, 300);
  });

  logger.info(`Watching config: ${configFilePath}`);
}

function shutdown(): void {
  quotaFetcher.stop();
  tokenUsageStore.flushSync();
  cooldownStore.flushSync();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
