import { test } from 'node:test';
import assert from 'node:assert';
import { maskSecret, redactProxyConfig } from '../src/configRedaction';
import type { ProxyConfig } from '../src/config';

test('maskSecret keeps last 4 chars and masks the rest', () => {
  assert.equal(maskSecret('sk-abcdef1234'), '****1234');
  assert.equal(maskSecret('ab'), '****');
  assert.equal(maskSecret(undefined), '');
  assert.equal(maskSecret(''), '');
});

test('redactProxyConfig masks upstream apiKey and credential apiKeys, drops no real key', () => {
  const cfg: ProxyConfig = {
    upstreamsById: {
      glm: {
        baseURL: 'https://open.bigmodel.cn',
        apiKey: 'sk-secret1234',
        model: 'glm-5.2',
        provider: 'glm',
        codePlanCredentials: [
          { id: 'a', apiKey: 'poolkey5678', weight: 1, enabled: true },
        ],
        quotaLimits: { fiveHourTokens: 160000000 },
      },
    },
  };
  const redacted = redactProxyConfig(cfg) as any;
  const glm = redacted.upstreamsById!.glm;
  assert.equal(glm.apiKey, undefined);
  assert.equal(glm.hasApiKey, true);
  assert.equal(glm.apiKeyMasked, '****1234');
  const cred = glm.codePlanCredentials[0];
  assert.equal(cred.apiKey, undefined);
  assert.equal(cred.hasApiKey, true);
  assert.equal(cred.apiKeyMasked, '****5678');
  assert.equal(glm.quotaLimits.fiveHourTokens, 160000000);
});
