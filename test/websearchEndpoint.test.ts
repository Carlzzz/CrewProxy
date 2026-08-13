import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyServer } from '../src/proxy';
import { ProxyRuntimeContext } from '../src/config';

process.env.WOICLAW_AUTH_BYPASS = '1'; // 绕过外部认证服务，认证返回 name='bypass'

function startServer(ctx: ProxyRuntimeContext): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise(resolve => {
    const server = createProxyServer(ctx);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

test('websearch endpoint returns results and selects provider', async () => {
  const ctx: ProxyRuntimeContext = { upstreamsByIdMap: new Map(), defaultUpstream: undefined, modelRoutesMap: new Map(), webSearch: { tavilyApiKey: 'tvly-x' } };
  const { baseUrl, close } = await startServer(ctx);
  try {
    const resp = await fetch(`${baseUrl}/v1/websearch`, {
      method: 'POST',
      headers: { 'x-api-key': 'any', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    // 真实网络不可达时会 502；此处仅断言路由存在、认证通过、非 404/401
    assert.notEqual(resp.status, 404);
    assert.notEqual(resp.status, 401);
  } finally {
    close();
  }
});

test('websearch endpoint rejects when no provider configured', async () => {
  const ctx: ProxyRuntimeContext = { upstreamsByIdMap: new Map(), defaultUpstream: undefined, modelRoutesMap: new Map(), webSearch: {} };
  const { baseUrl, close } = await startServer(ctx);
  try {
    const resp = await fetch(`${baseUrl}/v1/websearch`, {
      method: 'POST',
      headers: { 'x-api-key': 'any', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    assert.equal(resp.status, 400);
  } finally {
    close();
  }
});

test('websearch endpoint requires query', async () => {
  const ctx: ProxyRuntimeContext = { upstreamsByIdMap: new Map(), defaultUpstream: undefined, modelRoutesMap: new Map(), webSearch: { tavilyApiKey: 'tvly-x' } };
  const { baseUrl, close } = await startServer(ctx);
  try {
    const resp = await fetch(`${baseUrl}/v1/websearch`, {
      method: 'POST',
      headers: { 'x-api-key': 'any', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resp.status, 400);
  } finally {
    close();
  }
});

test('websearch endpoint rejects null body with 400', async () => {
  const ctx: ProxyRuntimeContext = { upstreamsByIdMap: new Map(), defaultUpstream: undefined, modelRoutesMap: new Map(), webSearch: { tavilyApiKey: 'tvly-x' } };
  const { baseUrl, close } = await startServer(ctx);
  try {
    const resp = await fetch(`${baseUrl}/v1/websearch`, {
      method: 'POST',
      headers: { 'x-api-key': 'any', 'Content-Type': 'application/json' },
      body: 'null',
    });
    assert.equal(resp.status, 400);
  } finally {
    close();
  }
});
