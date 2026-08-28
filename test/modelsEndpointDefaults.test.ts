import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createProxyServer } from '../src/proxy';
import type { ProxyRuntimeContext } from '../src/config';

describe('/models endpoint — defaultClientModels', { concurrency: 1 }, () => {
  process.env.WOICLAW_AUTH_BYPASS = '1';

  function baseCtx(extra: Partial<ProxyRuntimeContext> = {}): ProxyRuntimeContext {
    return {
      upstreamsByIdMap: new Map([
        ['glm', { baseURL: 'https://x', apiKey: 'x', model: 'glm-5.2', provider: 'zai' }],
      ]),
      defaultUpstream: undefined,
      modelRoutesMap: new Map(),
      hiddenModels: new Set(),
      ...extra,
    };
  }

  function get(port: number, path: string, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${path}`, { headers }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data || '{}') }));
      });
      req.on('error', reject);
    });
  }

  async function start(ctx: ProxyRuntimeContext): Promise<{ server: http.Server; port: number }> {
    const server = createProxyServer(ctx);
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: (server.address() as any).port });
      });
    });
  }

  test('/models omits defaults when config has no defaultClientModels', async () => {
    const { server, port } = await start(baseCtx());
    try {
      const r = await get(port, '/models', { 'x-api-key': 'dummy' });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.items));
      assert.equal(r.body.defaults, undefined);
    } finally { server.close(); }
  });

  test('/models emits defaults verbatim when configured', async () => {
    const defaults = { main: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro' };
    const { server, port } = await start(baseCtx({ defaultClientModels: defaults }));
    try {
      const r = await get(port, '/models', { 'x-api-key': 'dummy' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.defaults, defaults);
    } finally { server.close(); }
  });
});
