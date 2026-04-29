import * as fs from 'fs';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig, parseProxyConfigObject, buildUpstreamsByIdMap, ProxyConfig } from './config';
import { createProxyServer } from './proxy';
import { CodePlanPoolManager } from './codePlanPool';
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

        logger.info('Config reloaded successfully');
      } catch (err) {
        logger.error('Config reload failed (keeping old config):', err);
      }
    }, 300);
  });

  logger.info(`Watching config: ${configFilePath}`);
}
