import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createProxyServer } from '../src/proxy';
import type { ProxyRuntimeContext } from '../src/config';
import { MetricsCollector } from '../src/metricsCollector';
import { QuotaFetcher } from '../src/quotaFetcher';
import { CodePlanPoolManager } from '../src/codePlanPool';

// Bypass auth so we don't need a real introspect backend (same trick as
// metricsEndpoint.test.ts). auth failure would short-circuit before upstream.
process.env.WOICLAW_AUTH_BYPASS = '1';

function post(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// End-to-end test of the overload backoff path: GLM returns 529 (code 1305
// "该模型当前访问量过大") a few times then recovers. The proxy must retry
// internally on the SAME credential and return 200 to the client, and must NOT
// cool down the key (so the next request isn't frozen for 30s).
test('529 overload: proxy retries internally → 200 to client, pool not frozen', async () => {
  let upstreamCalls = 0;
  const mockUpstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      upstreamCalls += 1;
      if (upstreamCalls <= 3) {
        res.writeHead(529, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', code: '1305', message: '[1305][该模型当前访问量过大]' },
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'glm-5.2',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        }));
      }
    });
  });
  await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', r));
  const mockPort = (mockUpstream.address() as any).port;

  const glmUpstream: any = {
    baseURL: `http://127.0.0.1:${mockPort}`, apiKey: '', model: 'glm-5.2', provider: 'glm',
    codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true }],
  };
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([['glm', glmUpstream]]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map([['glm-5.2', { upstream: 'glm' }]]),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000),
    quotaFetcher: new QuotaFetcher({ now: () => 1 }),
  } as any;
  ctx.codePlanPool!.reconcileFromConfig({ upstreamsById: { glm: glmUpstream } } as any);

  const server = createProxyServer(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;

  try {
    const body = JSON.stringify({ model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    const r1 = await post(port, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, body);
    // Client must see 200 even though upstream returned 529 three times.
    assert.equal(r1.status, 200);
    assert.ok(upstreamCalls >= 4, `expected >=4 upstream calls after internal retry, got ${upstreamCalls}`);

    // Pool must NOT be cooled down: a second request immediately succeeds.
    // (If the 529 had cooled the key for 30s, this would surface 529 instantly.)
    const before = upstreamCalls;
    const r2 = await post(port, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, body);
    assert.equal(r2.status, 200);
    assert.ok(upstreamCalls > before, 'second request should hit upstream, proving pool was not frozen');
  } finally {
    server.close();
    mockUpstream.close();
  }
});

// Negative case: if overload persists through all backoffs, the proxy surfaces
// the 529 to the client but still does NOT cool down the key.
test('529 overload persists: surfaces 529, pool still not frozen', async () => {
  let upstreamCalls = 0;
  const mockUpstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      upstreamCalls += 1;
      res.writeHead(529, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', code: '1305', message: 'busy' } }));
    });
  });
  await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', r));
  const mockPort = (mockUpstream.address() as any).port;

  const glmUpstream: any = {
    baseURL: `http://127.0.0.1:${mockPort}`, apiKey: '', model: 'glm-5.2', provider: 'glm',
    codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true }],
  };
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([['glm', glmUpstream]]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map([['glm-5.2', { upstream: 'glm' }]]),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000),
    quotaFetcher: new QuotaFetcher({ now: () => 1 }),
  } as any;
  ctx.codePlanPool!.reconcileFromConfig({ upstreamsById: { glm: glmUpstream } } as any);

  const server = createProxyServer(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;

  try {
    const body = JSON.stringify({ model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    const r1 = await post(port, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, body);
    // Persisted overload is surfaced (529, not a misleading 502).
    assert.equal(r1.status, 529);
    // Backoff made several attempts beyond the first.
    assert.ok(upstreamCalls > 1, `expected retries, got ${upstreamCalls}`);
  } finally {
    server.close();
    mockUpstream.close();
  }
});

// 502 gateway error is also transient: backoff-retry on a SINGLE-KEY provider
// (no codePlanCredentials) proves non-pool providers get the retry too.
async function startSingleKeyMock(handler: (req: http.IncomingMessage, res: http.ServerResponse, call: number) => void) {
  let calls = 0;
  const mockUpstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { calls += 1; handler(req, res, calls); });
  });
  await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', r));
  return { mockUpstream, port: (mockUpstream.address() as any).port, getCalls: () => calls };
}

function ctxFor(port: number): ProxyRuntimeContext {
  const up: any = {
    baseURL: `http://127.0.0.1:${port}`, apiKey: 'k1', model: 'glm-5.2', provider: 'glm',
    // NOTE: no codePlanCredentials → hasCodePlan=false (single-key provider path)
  };
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([['glm', up]]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map([['glm-5.2', { upstream: 'glm' }]]),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000),
    quotaFetcher: new QuotaFetcher({ now: () => 1 }),
  } as any;
  return ctx;
}

const OK_BODY = JSON.stringify({
  id: 'msg_t', type: 'message', role: 'assistant', model: 'glm-5.2',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 2 },
});
const REQ_BODY = JSON.stringify({ model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

test('502 on single-key provider: proxy backoff-retries → 200', async () => {
  const mock = await startSingleKeyMock((_req, res, call) => {
    if (call <= 2) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Bad Gateway' } }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(OK_BODY);
    }
  });
  const ctx = ctxFor(mock.port);
  const server = createProxyServer(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  try {
    const r1 = await post(port, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
    assert.equal(r1.status, 200);
    assert.ok(mock.getCalls() >= 3, `expected >=3 upstream calls after backoff, got ${mock.getCalls()}`);
  } finally {
    server.close();
    mock.mockUpstream.close();
  }
});

test('network error (connection reset) on single-key provider: proxy backoff-retries → 200', async () => {
  const mock = await startSingleKeyMock((_req, res, call) => {
    if (call <= 2) {
      // Simulate the upstream dropping the connection mid-request.
      (res as any).socket?.destroy();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(OK_BODY);
    }
  });
  const ctx = ctxFor(mock.port);
  const server = createProxyServer(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  try {
    const r1 = await post(port, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
    assert.equal(r1.status, 200);
    assert.ok(mock.getCalls() >= 3, `expected >=3 upstream calls after network backoff, got ${mock.getCalls()}`);
  } finally {
    server.close();
    mock.mockUpstream.close();
  }
});
