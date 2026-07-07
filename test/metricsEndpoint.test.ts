import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createProxyServer } from '../src/proxy';
import type { ProxyRuntimeContext } from '../src/config';
import { MetricsCollector } from '../src/metricsCollector';
import { QuotaFetcher } from '../src/quotaFetcher';
import { CodePlanPoolManager } from '../src/codePlanPool';

// Run sequentially: both tests mutate the shared process.env.WOICLAW_AUTH_BYPASS.
describe('/metrics endpoint', { concurrency: 1 }, () => {

// Bypass auth so tests don't need a real introspect backend.
process.env.WOICLAW_AUTH_BYPASS = '1';

function startServer(): { server: http.Server; port: number; ctx: ProxyRuntimeContext } {
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([
      ['glm', { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true }] }],
    ]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map(),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000),
    quotaFetcher: new QuotaFetcher({ now: () => 1 }),
  };
  ctx.codePlanPool!.reconcileFromConfig({ upstreamsById: Object.fromEntries(ctx.upstreamsByIdMap) } as any);
  const server = createProxyServer(ctx);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port, ctx });
    });
  });
}

function get(port: number, path: string, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, { headers }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data || '{}') }));
    });
    req.on('error', err => { throw err; });
  });
}

test('/metrics returns 401 without api key when auth not bypassed', async () => {
  delete process.env.WOICLAW_AUTH_BYPASS;
  const { server, port } = await startServer();
  try {
    const r = await get(port, '/metrics');
    assert.equal(r.status, 401);
  } finally { server.close(); delete process.env.WOICLAW_AUTH_BYPASS; }
});

test('/metrics returns schema with totals and providers', async () => {
  process.env.WOICLAW_AUTH_BYPASS = '1';
  const { server, port, ctx } = await startServer();
  // seed one success record
  ctx.metrics!.record({ upstreamId: 'glm', credentialId: 'glm-key1', model: 'glm-5.2', success: true, inputTokens: 10, outputTokens: 20, costMs: 500, ts: 9_000_000 });
  try {
    const r = await get(port, '/metrics', { 'x-api-key': 'dummy' });
    assert.equal(r.status, 200);
    assert.ok(r.body.ts > 0);
    assert.ok(r.body.totals && r.body.totals.last5m);
    assert.ok(Array.isArray(r.body.providers));
    const glm = r.body.providers.find((p: any) => p.upstreamId === 'glm');
    assert.ok(glm);
    assert.equal(glm.health, 'healthy');
    assert.ok(Array.isArray(glm.credentials));
    assert.equal(glm.credentials[0].id, 'glm-key1');
  } finally { server.close(); }
});

test('/metrics surfaces estimated flag on credentials', async () => {
  process.env.WOICLAW_AUTH_BYPASS = '1';
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([
      ['glm', { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        quotaMode: 'estimated', quotaLimits: { fiveHourTokens: 160_000_000 },
        codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true }] }],
    ]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map(),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000_000),
    quotaFetcher: { getSnapshot: () => new Map([['glm\0glm-key1', { status: 'ok', estimated: true, fiveHour: { usedPct: 10, resetsAt: null }, queriedAt: 1 }]]) } as any,
  };
  ctx.codePlanPool!.reconcileFromConfig({ upstreamsById: Object.fromEntries(ctx.upstreamsByIdMap) } as any);
  const server = createProxyServer(ctx);
  const { port } = await new Promise<{port:number}>(r => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as any).port })));
  try {
    const r = await get(port, '/metrics', { 'x-api-key': 'dummy' });
    const glm = r.body.providers.find((p: any) => p.upstreamId === 'glm');
    const cred = glm.credentials[0];
    assert.equal(cred.quotaStatus, 'ok');
    assert.equal(cred.quota.estimated, true);
    assert.equal(cred.quota.fiveHour.resetsAt, null);
    assert.equal(cred.quota.fiveHour.usedTokens, 16_000_000); // 10% of 1.6亿
  } finally { server.close(); delete process.env.WOICLAW_AUTH_BYPASS; }
});
});
