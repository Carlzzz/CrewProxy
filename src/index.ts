import * as fs from 'fs';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig, parseProxyConfigObject, buildUpstreamsByIdMap, ProxyConfig, UpstreamConfig } from './config';
import { createProxyServer } from './proxy';
import { CodePlanPoolManager } from './codePlanPool';
import { MetricsCollector } from './metricsCollector';
import { QuotaFetcher } from './quotaFetcher';
import type { QuotaCredentialRef } from './quotaFetcher';
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

// Initialize Code Plan credential pool
const codePlanPool = new CodePlanPoolManager();
codePlanPool.reconcileFromConfig(currentConfig);
ctx.codePlanPool = codePlanPool;

// Initialize metrics + quota fetcher
const metrics = new MetricsCollector();
ctx.metrics = metrics;

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

const quotaFetcher = new QuotaFetcher();
quotaFetcher.reload(buildQuotaRefs(currentConfig));
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

const configFilePath = configPathArg
  ? path.resolve(configPathArg)
  : process.env.WOICLAW_PROXY_CONFIG
    ? path.resolve(process.env.WOICLAW_PROXY_CONFIG)
    : path.resolve('proxy-config.json');

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
        codePlanPool.reconcileFromConfig(newConfig);
        currentConfig = newConfig;
        quotaFetcher.reload(buildQuotaRefs(newConfig));

        logger.info('Config reloaded successfully');
      } catch (err) {
        logger.error('Config reload failed (keeping old config):', err);
      }
    }, 300);
  });

  logger.info(`Watching config: ${configFilePath}`);
}

process.on('SIGTERM', () => { quotaFetcher.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { quotaFetcher.stop(); server.close(() => process.exit(0)); });
