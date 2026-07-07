import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodePlanPoolManager } from '../src/codePlanPool';
import type { ProxyConfig } from '../src/config';

function configWithPool(): ProxyConfig {
  return {
    upstreamsById: {
      glm: {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        codePlanCredentials: [
          { id: 'glm-key1', apiKey: 'k1', weight: 1, enabled: true },
          { id: 'glm-key2', apiKey: 'k2', weight: 1, enabled: true },
        ],
      },
    },
  };
}

test('markCooldown stores reason and getPoolStatus exposes it', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  const status = pool.getPoolStatus('glm');
  const k1 = status.find(c => c.credentialId === 'glm-key1')!;
  assert.equal(k1.inCooldown, true);
  assert.equal(k1.cooldownReason, 'quota');
  const k2 = status.find(c => c.credentialId === 'glm-key2')!;
  assert.equal(k2.inCooldown, false);
  assert.equal(k2.cooldownReason, undefined);
});

test('markCooldown defaults reason to rate_limit when omitted', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.markCooldown('glm', 'glm-key1', 30_000);
  const k1 = pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!;
  assert.equal(k1.cooldownReason, 'rate_limit');
});

test('all-credentials-in-cooldown detectable via getPoolStatus', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  pool.markCooldown('glm', 'glm-key2', 60_000, 'network');
  const allDown = pool.getPoolStatus('glm').every(c => c.inCooldown);
  assert.equal(allDown, true);
});
