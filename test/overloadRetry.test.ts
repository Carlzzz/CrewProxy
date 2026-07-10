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

// Production backoff is ~60s (aggressive). Shrink it via env so these tests
// run in milliseconds instead of minutes. Restores prior values on completion.
const BACKOFF_ENV = ['WOICLAW_TRANSIENT_MAX_RETRIES', 'WOICLAW_TRANSIENT_BASE_MS', 'WOICLAW_TRANSIENT_CAP_MS'] as const;
function withFastBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const saved = BACKOFF_ENV.map((k) => [k, process.env[k]] as const);
  process.env.WOICLAW_TRANSIENT_MAX_RETRIES = '3';
  process.env.WOICLAW_TRANSIENT_BASE_MS = '5';
  process.env.WOICLAW_TRANSIENT_CAP_MS = '10';
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

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

const OK_BODY = JSON.stringify({
  id: 'msg_t', type: 'message', role: 'assistant', model: 'glm-5.2',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 2 },
});
const REQ_BODY = JSON.stringify({ model: 'glm-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

function buildCtx(port: number, withPool: boolean): ProxyRuntimeContext {
  const up: any = {
    baseURL: `http://127.0.0.1:${port}`, apiKey: withPool ? '' : 'k1', model: 'glm-5.2', provider: 'glm',
    ...(withPool ? { codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true }] } : {}),
  };
  const ctx: ProxyRuntimeContext = {
    upstreamsByIdMap: new Map([['glm', up]]),
    defaultUpstream: undefined,
    modelRoutesMap: new Map([['glm-5.2', { upstream: 'glm' }]]),
    codePlanPool: new CodePlanPoolManager(),
    metrics: new MetricsCollector(() => 10_000_000),
    quotaFetcher: new QuotaFetcher({ now: () => 1 }),
  } as any;
  ctx.codePlanPool!.reconcileFromConfig({ upstreamsById: { glm: up } } as any);
  return ctx;
}

async function startMock(handler: (res: http.ServerResponse, call: number) => void) {
  let calls = 0;
  const mockUpstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { calls += 1; handler(res, calls); });
  });
  await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', r));
  return { mockUpstream, port: (mockUpstream.address() as any).port, getCalls: () => calls };
}

async function withProxy<T>(port: number, withPool: boolean, fn: (proxyPort: number) => Promise<T>): Promise<T> {
  const ctx = buildCtx(port, withPool);
  const server = createProxyServer(ctx);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const proxyPort = (server.address() as any).port;
  try {
    return await fn(proxyPort);
  } finally {
    server.close();
  }
}

// ── Pool provider (GLM/minimax-style): 529 three times then recovers ──
test('529 overload: proxy retries internally → 200, pool not frozen', async () => {
  await withFastBackoff(async () => {
    const mock = await startMock((res, call) => {
      if (call <= 3) {
        res.writeHead(529, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', code: '1305', message: '[1305][该模型当前访问量过大]' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(OK_BODY);
      }
    });
    try {
      await withProxy(mock.port, true, async (p) => {
        const r1 = await post(p, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
        assert.equal(r1.status, 200);
        assert.ok(mock.getCalls() >= 4, `expected >=4 upstream calls, got ${mock.getCalls()}`);
        // pool NOT cooled down: second request succeeds immediately
        const before = mock.getCalls();
        const r2 = await post(p, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
        assert.equal(r2.status, 200);
        assert.ok(mock.getCalls() > before);
      });
    } finally {
      mock.mockUpstream.close();
    }
  });
});

// ── Pool provider: persistent 529 surfaces 529 (not misleading 502) ──
test('529 overload persists: surfaces 529, pool not frozen', async () => {
  await withFastBackoff(async () => {
    const mock = await startMock((res) => {
      res.writeHead(529, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', code: '1305', message: 'busy' } }));
    });
    try {
      await withProxy(mock.port, true, async (p) => {
        const r1 = await post(p, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
        assert.equal(r1.status, 529);
        assert.ok(mock.getCalls() > 1, `expected retries, got ${mock.getCalls()}`);
      });
    } finally {
      mock.mockUpstream.close();
    }
  });
});

// ── Single-key provider (ark/deepseek/gpt/claude): 502 then recover ──
test('502 on single-key provider: proxy backoff-retries → 200', async () => {
  await withFastBackoff(async () => {
    const mock = await startMock((res, call) => {
      if (call <= 2) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Bad Gateway' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(OK_BODY);
      }
    });
    try {
      await withProxy(mock.port, false, async (p) => {
        const r1 = await post(p, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
        assert.equal(r1.status, 200);
        assert.ok(mock.getCalls() >= 3, `expected >=3 upstream calls, got ${mock.getCalls()}`);
      });
    } finally {
      mock.mockUpstream.close();
    }
  });
});

// ── Single-key provider: connection reset (network error) then recover ──
test('network error (connection reset) on single-key provider: proxy backoff-retries → 200', async () => {
  await withFastBackoff(async () => {
    const mock = await startMock((res, call) => {
      if (call <= 2) {
        (res as any).socket?.destroy(); // simulate dropped connection
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(OK_BODY);
      }
    });
    try {
      await withProxy(mock.port, false, async (p) => {
        const r1 = await post(p, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
        assert.equal(r1.status, 200);
        assert.ok(mock.getCalls() >= 3, `expected >=3 upstream calls, got ${mock.getCalls()}`);
      });
    } finally {
      mock.mockUpstream.close();
    }
  });
});

// ── Retry-After header on 529 is honored (proxy still recovers) ──
test('529 with Retry-After header: proxy still retries to 200', async () => {
  await withFastBackoff(async () => {
    const mock = await startMock((res, call) => {
      if (call <= 2) {
        res.writeHead(529, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', code: '1305', message: 'busy' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(OK_BODY);
      }
    });
    try {
      await withProxy(mock.port, false, async (p) => {
        const r1 = await post(p, '/v1/messages', { 'Content-Type': 'application/json', 'x-api-key': 'test' }, REQ_BODY);
        assert.equal(r1.status, 200);
        assert.ok(mock.getCalls() >= 3);
      });
    } finally {
      mock.mockUpstream.close();
    }
  });
});

// ── Stream request, upstream stuck prefilling (never sends header) ──
// This is the AmbiCrew hang: GLM under load accepts the connection but takes
// >60s to emit the first byte. Previously the 60s fetch timeout fired, retried,
// GLM re-prefilled, ... piling up to ~10min. Now: streaming uses a long
// first-byte budget AND does NOT retry on fetch failure — it surfaces fast.
test('stream request, upstream stuck on prefill: surfaces error fast, no 10min hang', async () => {
  const savedFb = process.env.WOICLAW_STREAM_FIRST_BYTE_TIMEOUT_MS;
  process.env.WOICLAW_STREAM_FIRST_BYTE_TIMEOUT_MS = '300'; // 300ms first-byte budget
  try {
    // Mock accepts the connection but never writes a response (simulates GLM
    // stuck prefilling a large context under load).
    const mock = await startMock(() => { /* intentionally never respond */ });
    try {
      await withProxy(mock.port, false, async (p) => {
        const t0 = Date.now();
        const r1 = await post(
          p,
          '/v1/messages',
          { 'Content-Type': 'application/json', 'x-api-key': 'test' },
          JSON.stringify({ model: 'glm-5.2', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        );
        const dt = Date.now() - t0;
        assert.notEqual(r1.status, 200, 'must not succeed when upstream never responds');
        // Fast failure proves we did NOT enter the multi-round backoff (which
        // would take seconds-to-minutes). 300ms timeout → surface → done.
        assert.ok(dt < 5000, `expected fast failure (no hang), took ${dt}ms`);
      });
    } finally {
      mock.mockUpstream.close();
    }
  } finally {
    if (savedFb === undefined) delete process.env.WOICLAW_STREAM_FIRST_BYTE_TIMEOUT_MS;
    else process.env.WOICLAW_STREAM_FIRST_BYTE_TIMEOUT_MS = savedFb;
  }
});
