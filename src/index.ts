import * as fs from 'fs';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig, parseProxyConfigObject, buildUpstreamsByIdMap, ProxyConfig } from './config';
import { createProxyServer } from './proxy';
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
const port = currentConfig.port || 3456;
const host = currentConfig.host || '0.0.0.0';

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
        currentConfig = newConfig;

        logger.info('Config reloaded successfully');
      } catch (err) {
        logger.error('Config reload failed (keeping old config):', err);
      }
    }, 300);
  });

  logger.info(`Watching config: ${configFilePath}`);
}
