import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { CodePlanPoolManager } from '../src/codePlanPool';
import type { ProxyConfig } from '../src/config';
import { JsonStateStore } from '../src/stateStore';

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

// ── Cooldown persistence ──

test('dump/restore cooldowns round-trip', () => {
  const a = new CodePlanPoolManager();
  a.reconcileFromConfig(configWithPool());
  a.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  const snap = a.dumpCooldowns();
  const b = new CodePlanPoolManager();
  b.restoreCooldowns(snap);
  const restoredKeys = Object.keys(b.dumpCooldowns());
  assert.equal(restoredKeys.length, 1);
  assert.ok(restoredKeys[0].includes('glm-key1'));
});

test('restore drops already-expired cooldowns', () => {
  const a = new CodePlanPoolManager();
  const now = Date.now();
  a.restoreCooldowns({
    'glm\x00glm-key1': { until: now - 1000, reason: 'quota' },     // expired
    'glm\x00glm-key2': { until: now + 60_000, reason: 'rate_limit' }, // active
  });
  const restored = Object.keys(a.dumpCooldowns());
  assert.equal(restored.length, 1);
  assert.ok(restored[0].includes('glm-key2'));
});

test('reconcileFromConfig does NOT clear restored cooldowns', () => {
  const a = new CodePlanPoolManager();
  a.restoreCooldowns({ 'glm\x00glm-key1': { until: Date.now() + 60_000, reason: 'quota' } });
  a.reconcileFromConfig(configWithPool());
  const restored = Object.keys(a.dumpCooldowns());
  assert.ok(restored.some(k => k.includes('glm-key1')));
});

test('store-backed pool restores cooldowns across instances', () => {
  const f = path.join(os.tmpdir(), `cd-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const store1 = new JsonStateStore(f);
  const a = new CodePlanPoolManager({ store: store1 });
  a.reconcileFromConfig(configWithPool());
  a.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  store1.flushSync();
  // New pool + store on the same file → cooldown survived.
  const store2 = new JsonStateStore(f);
  const b = new CodePlanPoolManager({ store: store2 });
  b.reconcileFromConfig(configWithPool());
  const k1 = b.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!;
  assert.equal(k1.inCooldown, true);
  assert.equal(k1.cooldownReason, 'quota');
});
