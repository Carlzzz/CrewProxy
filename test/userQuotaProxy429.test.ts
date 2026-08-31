import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createProxyServer } from '../src/proxy';
import { UserQuotaTracker } from '../src/userQuotaTracker';
import type { ProxyRuntimeContext } from '../src/config';

// HTTP 级集成测试: mock auth 返回超限 quota → POST /v1/messages 返回
// 429 + quota_exceeded + [账户额度] 前缀（验收清单 MUST「错误响应类型」）。
// 走真实 auth 流程（WOICLAW_AUTH_HOST 指向本地 stub），预填 tracker 到超限，
// 在配额检查点短路，绝不打到上游。
describe('/v1/messages user quota 429', { concurrency: 1 }, () => {
  // 测试修改 process.env 的 auth 配置, 顺序执行避免相互干扰。
  delete process.env.WOICLAW_AUTH_BYPASS;
  delete process.env.WOICLAW_AUTH_HOST;

  function startAuthStub(quota: { enabled: boolean; daily_limit: number | null; monthly_limit: number | null }): Promise<{ server: http.Server; baseUrl: string }> {
    return new Promise(resolve => {
      const server = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          rc: '0',
          data: {
            name: 'testuser',
            user_id: 'test-uid-1',
            permission_rules: null,
            quota,
          },
        }));
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as any).port;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
  }

  function startServer(ctx: ProxyRuntimeContext): Promise<{ baseUrl: string; close: () => void }> {
    return new Promise(resolve => {
      const server = createProxyServer(ctx);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
      });
    });
  }

  function makeCtx(userQuota: UserQuotaTracker): ProxyRuntimeContext {
    return {
      upstreamsByIdMap: new Map(),
      defaultUpstream: { baseURL: 'http://upstream.invalid', apiKey: 'k', model: 'claude-opus-4-5', provider: 'anthropic' },
      modelRoutesMap: new Map(),
      userQuota,
    };
  }

  async function postMessages(baseUrl: string, token: string): Promise<{ status: number; body: any }> {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: resp.status, body: await resp.json() };
  }

  test('每日额度超限 → 429 + quota_exceeded + [账户额度] + 「每日」维度 + 重置说明', async () => {
    const auth = await startAuthStub({ enabled: true, daily_limit: 10, monthly_limit: null });
    process.env.WOICLAW_AUTH_HOST = auth.baseUrl;
    const userQuota = new UserQuotaTracker();
    userQuota.record('test-uid-1', 100); // 已用 100 ≥ 每日限额 10
    const { baseUrl, close } = await startServer(makeCtx(userQuota));
    try {
      const { status, body } = await postMessages(baseUrl, 'test-token-daily');
      assert.equal(status, 429);
      assert.equal(body.error?.type, 'quota_exceeded');
      assert.ok(body.error?.message.startsWith('[账户额度]'));
      assert.match(body.error?.message, /每日/);
      assert.match(body.error?.message, /已用 100 \/ 限额 10/);
      assert.match(body.error?.message, /次日零点（东八区）重置/);
    } finally {
      close();
      auth.server.close();
      delete process.env.WOICLAW_AUTH_HOST;
    }
  });

  test('本月额度超限（每日不限）→ 429 + quota_exceeded + 「本月」维度 + 重置说明', async () => {
    const auth = await startAuthStub({ enabled: true, daily_limit: null, monthly_limit: 1000 });
    process.env.WOICLAW_AUTH_HOST = auth.baseUrl;
    const userQuota = new UserQuotaTracker();
    userQuota.record('test-uid-1', 2000); // 已用 2000 ≥ 每月限额 1000
    const { baseUrl, close } = await startServer(makeCtx(userQuota));
    try {
      const { status, body } = await postMessages(baseUrl, 'test-token-monthly');
      assert.equal(status, 429);
      assert.equal(body.error?.type, 'quota_exceeded');
      assert.ok(body.error?.message.startsWith('[账户额度]'));
      assert.match(body.error?.message, /本月/);
      assert.match(body.error?.message, /已用 2000 \/ 限额 1000/);
      assert.match(body.error?.message, /次月 1 日零点（东八区）重置/);
    } finally {
      close();
      auth.server.close();
      delete process.env.WOICLAW_AUTH_HOST;
    }
  });
});
