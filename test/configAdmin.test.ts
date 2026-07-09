import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeSecrets, handleAdminConfigRequest } from '../src/configAdmin';
import type { ProxyConfig } from '../src/config';

function asyncStream(body: string, method: string, url: string) {
  const { Readable } = require('stream');
  // Attach method/url so the handler can route — a bare Readable has neither.
  return Object.assign(Readable.from([Buffer.from(body)]), { method, url });
}

function mockRes(): any {
  return {
    statusCode: 0,
    body: '',
    writeHead(s: number) { this.statusCode = s; },
    end(s: string) { this.body = s; },
  };
}

test('mergeSecrets keeps current key when apiKeyMode=keep', () => {
  const cur: ProxyConfig = {
    upstreamsById: { glm: { baseURL: 'https://x', apiKey: 'REAL-SECRET', model: 'glm-5.2', provider: 'glm' } },
  };
  const draft = {
    upstreamsById: { glm: { baseURL: 'https://x', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm' } },
  };
  const merged = mergeSecrets(cur, draft);
  assert.equal(merged.upstreamsById!.glm.apiKey, 'REAL-SECRET');
});

test('mergeSecrets keeps current key even when a draft apiKey leaks alongside apiKeyMode=keep', () => {
  // Redacted round-trip safety: a masked/placeholder value must not overwrite the real key.
  const cur: ProxyConfig = {
    upstreamsById: { glm: { baseURL: 'https://x', apiKey: 'REAL-SECRET', model: 'glm-5.2', provider: 'glm' } },
  };
  const draft = {
    upstreamsById: { glm: { baseURL: 'https://x', apiKeyMode: 'keep', apiKey: '****2345', model: 'glm-5.2', provider: 'glm' } },
  };
  const merged = mergeSecrets(cur, draft);
  assert.equal(merged.upstreamsById!.glm.apiKey, 'REAL-SECRET');
});

test('mergeSecrets replaces key when apiKey provided', () => {
  const cur: ProxyConfig = {
    upstreamsById: { glm: { baseURL: 'https://x', apiKey: 'OLD', model: 'glm-5.2', provider: 'glm' } },
  };
  const draft = {
    upstreamsById: { glm: { baseURL: 'https://x', apiKeyMode: 'replace', apiKey: 'NEW-SECRET', model: 'glm-5.2', provider: 'glm' } },
  };
  const merged = mergeSecrets(cur, draft);
  assert.equal(merged.upstreamsById!.glm.apiKey, 'NEW-SECRET');
});

test('mergeSecrets preserves codePlanCredentials secrets for keep mode', () => {
  const cur: ProxyConfig = {
    upstreamsById: {
      glm: {
        baseURL: 'https://x', apiKey: 'REAL', model: 'glm-5.2', provider: 'glm',
        codePlanCredentials: [
          { id: 'a', apiKey: 'POOL-REAL', weight: 1, enabled: true },
        ],
      },
    },
  };
  const draft = {
    upstreamsById: {
      glm: {
        baseURL: 'https://x', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm',
        codePlanCredentials: [
          { id: 'a', apiKeyMode: 'keep', weight: 2 },
        ],
      },
    },
  };
  const merged = mergeSecrets(cur, draft);
  const cred = merged.upstreamsById!.glm.codePlanCredentials![0];
  assert.equal(cred.apiKey, 'POOL-REAL');
  assert.equal(cred.weight, 2);
});

test('GET /admin/config returns redacted config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(fp, JSON.stringify({
    upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm' } },
  }));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    const res = mockRes();
    await handleAdminConfigRequest(
      { method: 'GET', url: '/admin/config' } as any,
      res,
      { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
    );
    const json = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    const glm = json.upstreamsById.glm;
    assert.equal(glm.apiKey, undefined);
    assert.equal(glm.hasApiKey, true);
    assert.equal(glm.apiKeyMasked, '****1234');
    // Ensure no full secret appears anywhere in the body.
    assert.ok(!res.body.includes('sk-secret1234'), 'full apiKey must not appear in response');
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /admin/config/effective returns runtime summary, no secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(fp, JSON.stringify({
    upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm' } },
  }));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    const upstreamsByIdMap = new Map([['glm', {
      baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm',
      codePlanCredentials: [{ id: 'a', apiKey: 'pool-real', weight: 1, enabled: true }],
    }]]);
    const modelRoutesMap = new Map([['claude-sonnet-4-5', { upstream: 'glm', model: 'glm-5.2' }]]);
    const res = mockRes();
    await handleAdminConfigRequest(
      { method: 'GET', url: '/admin/config/effective' } as any,
      res,
      { upstreamsByIdMap, defaultUpstream: undefined, modelRoutesMap },
    );
    const json = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(json.upstreams[0].upstreamId, 'glm');
    assert.equal(json.upstreams[0].credentialCount, 1);
    assert.equal(json.models[0].model, 'claude-sonnet-4-5');
    assert.ok(!res.body.includes('sk-secret1234'));
    assert.ok(!res.body.includes('pool-real'));
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /admin/config/validate merges and validates without writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  const original = {
    upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm' } },
  };
  fs.writeFileSync(fp, JSON.stringify(original));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    const reqBody = JSON.stringify({
      upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm' } },
    });
    const res = mockRes();
    await handleAdminConfigRequest(
      asyncStream(reqBody, 'POST', '/admin/config/validate') as any,
      res,
      { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
    );
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, true);
    // File untouched
    const onDisk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.deepEqual(onDisk, original);
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /admin/config writes file when valid and keeps secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(fp, JSON.stringify({
    upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm' } },
  }));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    const reqBody = JSON.stringify({
      upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm' } },
    });
    const res = mockRes();
    await handleAdminConfigRequest(
      asyncStream(reqBody, 'PUT', '/admin/config') as any,
      res,
      { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
    );
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, true);
    assert.ok(json.savedAt);
    assert.equal(json.configPath, fp);
    const written = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(written.upstreamsById.glm.apiKey, 'sk-secret1234'); // kept
    // No .tmp leftover
    assert.ok(!fs.existsSync(fp + '.tmp'));
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /admin/config replaces key when apiKeyMode=replace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(fp, JSON.stringify({
    upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm' } },
  }));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    const reqBody = JSON.stringify({
      upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKeyMode: 'replace', apiKey: 'sk-newkey9999', model: 'glm-5.2', provider: 'glm' } },
    });
    const res = mockRes();
    await handleAdminConfigRequest(
      asyncStream(reqBody, 'PUT', '/admin/config') as any,
      res,
      { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
    );
    assert.equal(res.statusCode, 200);
    const written = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(written.upstreamsById.glm.apiKey, 'sk-newkey9999');
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /admin/config rejects invalid draft without writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  const original = { upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm' } } };
  fs.writeFileSync(fp, JSON.stringify(original));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    const reqBody = JSON.stringify({
      upstreamsById: { glm: { baseURL: 'not-a-url', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm' } },
    });
    const res = mockRes();
    await handleAdminConfigRequest(
      asyncStream(reqBody, 'PUT', '/admin/config') as any,
      res,
      { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
    );
    assert.equal(res.statusCode, 400);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, false);
    assert.ok(json.errors.length > 0);
    const onDisk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.deepEqual(onDisk, original); // unchanged
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handleAdminConfigRequest returns 404 for unknown admin path', async () => {
  const res = mockRes();
  await handleAdminConfigRequest(
    { method: 'GET', url: '/admin/config/unknown' } as any,
    res,
    { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
  );
  assert.equal(res.statusCode, 404);
});

/* ------------------------------------------------------------------ */
/*  Structure preservation (regression: fields not in the draft must   */
/*  survive a save — see root-cause analysis of the provider page bug).*/
/* ------------------------------------------------------------------ */

test('mergeSecrets preserves top-level port and host absent from draft', () => {
  // The frontend buildDraft() only sends upstreamsById/modelRoutes/defaultUpstream.
  // port/host must be carried over from the current config, not dropped.
  const cur = {
    port: 3456,
    host: '0.0.0.0',
    upstreamsById: { glm: { baseURL: 'https://x', apiKey: 'REAL', model: 'glm-5.2', provider: 'glm' } },
  };
  const draft = {
    upstreamsById: { glm: { baseURL: 'https://x', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm' } },
  };
  const merged = mergeSecrets(cur, draft) as any;
  assert.equal(merged.port, 3456, 'port must be preserved');
  assert.equal(merged.host, '0.0.0.0', 'host must be preserved');
});

test('mergeSecrets preserves upstream quotaMode, ordinaryFallbackModelMap, codePlanBaseURL', () => {
  const cur = {
    upstreamsById: {
      glm: {
        baseURL: 'https://x', apiKey: 'REAL', model: 'glm-5.2', provider: 'glm',
        quotaMode: 'estimated',
        ordinaryFallbackModelMap: { 'claude-3-haiku': 'glm-4.5-air' },
        codePlanBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
        quotaLimits: { fiveHourTokens: 160000000, weeklyTokens: 800000000 },
      },
    },
  };
  const draft = {
    upstreamsById: {
      glm: {
        baseURL: 'https://x', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm',
        quotaLimits: { fiveHourTokens: 160000000, weeklyTokens: 800000000 },
      },
    },
  };
  const merged = mergeSecrets(cur, draft) as any;
  const glm = merged.upstreamsById.glm;
  assert.equal(glm.quotaMode, 'estimated');
  assert.deepEqual(glm.ordinaryFallbackModelMap, { 'claude-3-haiku': 'glm-4.5-air' });
  assert.equal(glm.codePlanBaseURL, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(glm.apiKey, 'REAL', 'keep mode must still restore the real key');
});

test('PUT /admin/config preserves port, host, and upstream quotaMode on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(fp, JSON.stringify({
    port: 3456,
    host: '0.0.0.0',
    upstreamsById: {
      glm: {
        baseURL: 'https://open.bigmodel.cn', apiKey: 'sk-secret1234', model: 'glm-5.2', provider: 'glm',
        quotaMode: 'estimated',
      },
    },
  }));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    // Exactly what the provider page sends: no port/host/quotaMode.
    const reqBody = JSON.stringify({
      upstreamsById: { glm: { baseURL: 'https://open.bigmodel.cn', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm' } },
    });
    const res = mockRes();
    await handleAdminConfigRequest(
      asyncStream(reqBody, 'PUT', '/admin/config') as any,
      res,
      { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
    );
    assert.equal(res.statusCode, 200);
    const written = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(written.port, 3456, 'port must be preserved on disk');
    assert.equal(written.host, '0.0.0.0', 'host must be preserved on disk');
    assert.equal(written.upstreamsById.glm.quotaMode, 'estimated', 'quotaMode must be preserved on disk');
    assert.equal(written.upstreamsById.glm.apiKey, 'sk-secret1234');
    assert.ok(!fs.existsSync(fp + '.tmp'));
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /admin/config adding a new upstream preserves unrelated existing fields', async () => {
  // New-provider flow: draft adds "deepseek" while "glm" keeps its extra fields.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewproxy-'));
  const fp = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(fp, JSON.stringify({
    port: 3456,
    upstreamsById: {
      glm: { baseURL: 'https://x', apiKey: 'glm-real', model: 'glm-5.2', provider: 'glm', quotaMode: 'estimated' },
    },
  }));
  process.env.WOICLAW_PROXY_CONFIG = fp;
  try {
    const reqBody = JSON.stringify({
      upstreamsById: {
        glm: { baseURL: 'https://x', apiKeyMode: 'keep', model: 'glm-5.2', provider: 'glm' },
        deepseek: { baseURL: 'https://api.deepseek.com', apiKeyMode: 'replace', apiKey: 'ds-new', model: 'deepseek-v4', provider: 'deepseek' },
      },
    });
    const res = mockRes();
    await handleAdminConfigRequest(
      asyncStream(reqBody, 'PUT', '/admin/config') as any,
      res,
      { upstreamsByIdMap: new Map(), modelRoutesMap: new Map() },
    );
    assert.equal(res.statusCode, 200);
    const written = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(written.port, 3456);
    assert.equal(written.upstreamsById.glm.quotaMode, 'estimated');
    assert.equal(written.upstreamsById.glm.apiKey, 'glm-real');
    assert.equal(written.upstreamsById.deepseek.apiKey, 'ds-new');
  } finally {
    delete process.env.WOICLAW_PROXY_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
