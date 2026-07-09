import { test } from 'node:test';
import assert from 'node:assert';
import { validateResolvedProxyConfig, validateProxyConfigDraft } from '../src/configValidation';
import type { ProxyConfig } from '../src/config';

function baseUpstream(over: Record<string, unknown> = {}) {
  return {
    baseURL: 'https://open.bigmodel.cn',
    apiKey: 'sk-xxxx',
    model: 'glm-5.2',
    provider: 'glm',
    ...over,
  } as any;
}

test('valid config returns ok', () => {
  const cfg = { upstreamsById: { glm: baseUpstream() } } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('rejects invalid baseURL', () => {
  const cfg = { upstreamsById: { glm: baseUpstream({ baseURL: 'not-a-url' }) } } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.path === 'upstreamsById.glm.baseURL'));
});

test('rejects modelRoutes referencing missing upstream', () => {
  const cfg = {
    upstreamsById: { glm: baseUpstream() },
    modelRoutes: { 'glm-5.2': { upstream: 'nope' } },
  } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.path.startsWith('modelRoutes.glm-5.2')));
});

test('rejects duplicate codePlanCredentials id', () => {
  const cfg = {
    upstreamsById: { glm: baseUpstream({ codePlanCredentials: [
      { id: 'a', apiKey: 'k1', weight: 1, enabled: true },
      { id: 'a', apiKey: 'k2', weight: 1, enabled: true },
    ] }) },
  } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.path.includes('codePlanCredentials') && /a/.test(e.message)));
});

test('rejects non-positive weight', () => {
  const cfg = {
    upstreamsById: { glm: baseUpstream({ codePlanCredentials: [
      { id: 'a', apiKey: 'k1', weight: 0, enabled: true },
    ] }) },
  } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.path.includes('weight')));
});

test('rejects invalid quotaLimits', () => {
  const cfg = {
    upstreamsById: { glm: baseUpstream({ quotaLimits: { fiveHourTokens: -1 } }) },
  } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.path.includes('quotaLimits')));
});

test('rejects empty upstreamsById', () => {
  const cfg = { upstreamsById: {} } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, false);
});

test('unknown provider is a warning, not an error (proxy is free-form)', () => {
  const cfg = { upstreamsById: { gpt: baseUpstream({ provider: 'gpt' }) } } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.path === 'upstreamsById.gpt.provider'));
  assert.equal(r.errors.length, 0);
});

test('accepts zai and ali providers', () => {
  const cfg = { upstreamsById: {
    zai: baseUpstream({ provider: 'zai' }),
    ali: baseUpstream({ provider: 'ali' }),
  } } as ProxyConfig;
  const r = validateResolvedProxyConfig(cfg);
  assert.equal(r.ok, true);
});

test('validateProxyConfigDraft rejects non-object', () => {
  const r = validateProxyConfigDraft('hello');
  assert.equal(r.ok, false);
});

test('validateProxyConfigDraft rejects empty draft', () => {
  const r = validateProxyConfigDraft({});
  assert.equal(r.ok, false);
});

test('validateProxyConfigDraft accepts with defaultUpstream', () => {
  const r = validateProxyConfigDraft({ defaultUpstream: { baseURL: 'https://x' } });
  assert.equal(r.ok, true);
});
