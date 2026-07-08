"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const dotenv_1 = require("dotenv");
const config_1 = require("./config");
const proxy_1 = require("./proxy");
const codePlanPool_1 = require("./codePlanPool");
const metricsCollector_1 = require("./metricsCollector");
const quotaFetcher_1 = require("./quotaFetcher");
const tokenUsageTracker_1 = require("./tokenUsageTracker");
const logger_1 = require("./logger");
(0, dotenv_1.config)();
const configPathArg = process.argv[2];
let currentConfig;
try {
    currentConfig = (0, config_1.loadConfig)(configPathArg);
}
catch (err) {
    logger_1.logger.error('Failed to load config:', err);
    process.exit(1);
}
const ctx = (0, config_1.buildUpstreamsByIdMap)(currentConfig);
// Initialize Code Plan credential pool
const codePlanPool = new codePlanPool_1.CodePlanPoolManager();
codePlanPool.reconcileFromConfig(currentConfig);
ctx.codePlanPool = codePlanPool;
// Initialize metrics + quota fetcher
const metrics = new metricsCollector_1.MetricsCollector();
ctx.metrics = metrics;
const tokenUsage = new tokenUsageTracker_1.TokenUsageTracker();
ctx.tokenUsage = tokenUsage;
function buildQuotaUpstreams(cfg) {
    const out = [];
    const collect = (upstreamId, u) => {
        if (!u || !u.codePlanCredentials)
            return;
        const credentials = u.codePlanCredentials
            .filter(c => c.enabled && c.apiKey)
            .map(c => ({ upstreamId, credentialId: c.id, apiKey: c.apiKey, baseURL: u.baseURL }));
        if (credentials.length === 0)
            return;
        out.push({
            upstreamId,
            quotaMode: u.quotaMode ?? 'fetch',
            quotaLimits: u.quotaLimits,
            credentials,
        });
    };
    if (cfg.upstreamsById)
        for (const [id, u] of Object.entries(cfg.upstreamsById))
            collect(id, u);
    if (cfg.defaultUpstream)
        collect('__default__', cfg.defaultUpstream);
    return out;
}
const quotaFetcher = new quotaFetcher_1.QuotaFetcher({ tokenUsageTracker: tokenUsage });
quotaFetcher.reload(buildQuotaUpstreams(currentConfig));
quotaFetcher.start();
ctx.quotaFetcher = quotaFetcher;
const port = currentConfig.port || 3456;
const host = currentConfig.host || '0.0.0.0';
// 防止 undici 内部 Fetch 因 socket 错误（ECONNRESET 等）抛出 TypeError: terminated
// 导致未处理的 Promise rejection 使进程崩溃
process.on('unhandledRejection', (reason) => {
    if (reason instanceof Error && reason.message === 'terminated') {
        logger_1.logger.warn('Suppressed unhandled rejection: terminated (upstream connection lost)');
        return;
    }
    logger_1.logger.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
    if (err instanceof Error && err.message === 'terminated') {
        logger_1.logger.warn('Suppressed uncaught exception: terminated (upstream connection lost)');
        return;
    }
    logger_1.logger.error('Uncaught exception:', err);
    process.exit(1);
});
const server = (0, proxy_1.createProxyServer)(ctx);
server.listen(port, host, () => {
    logger_1.logger.info(`Claw Proxy listening on ${host}:${port}`);
    const upstreamCount = ctx.upstreamsByIdMap.size;
    const hasDefault = !!ctx.defaultUpstream;
    const routeCount = ctx.modelRoutesMap.size;
    logger_1.logger.info(`Upstreams: ${upstreamCount} named${hasDefault ? ' + default' : ''}${routeCount > 0 ? `, ${routeCount} model routes` : ''}`);
});
const configFilePath = (0, config_1.resolveConfigFilePath)(configPathArg);
if (fs.existsSync(configFilePath)) {
    let debounceTimer = null;
    fs.watch(configFilePath, () => {
        if (debounceTimer)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            try {
                const raw = fs.readFileSync(configFilePath, 'utf-8');
                const parsed = JSON.parse(raw);
                const newConfig = (0, config_1.parseProxyConfigObject)(parsed);
                const newCtx = (0, config_1.buildUpstreamsByIdMap)(newConfig);
                ctx.upstreamsByIdMap = newCtx.upstreamsByIdMap;
                ctx.defaultUpstream = newCtx.defaultUpstream;
                ctx.modelRoutesMap = newCtx.modelRoutesMap;
                codePlanPool.reconcileFromConfig(newConfig);
                currentConfig = newConfig;
                quotaFetcher.reload(buildQuotaUpstreams(newConfig));
                logger_1.logger.info('Config reloaded successfully');
            }
            catch (err) {
                logger_1.logger.error('Config reload failed (keeping old config):', err);
            }
        }, 300);
    });
    logger_1.logger.info(`Watching config: ${configFilePath}`);
}
process.on('SIGTERM', () => { quotaFetcher.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { quotaFetcher.stop(); server.close(() => process.exit(0)); });
