import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { CodePlanPoolManager } from '../src/codePlanPool';
import type { ProxyConfig } from '../src/config';
import type { CredentialQuota } from '../src/quotaFetcher';
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

// ── Selection (pickOrFallback) ──

test('no-session selection round-robins across keys when in-flight is tied', () => {
  // Regression: previously the lowest-in-flight pick used strict `<` with the
  // first available index as initial min, so when every key read in-flight=0
  // (the common case — in-flight is released at header time), the SAME first
  // credential was selected every time. Round-robin must now spread the load.
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool()); // glm-key1, glm-key2
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const r = pool.pickOrFallback('glm')!;
    assert.ok(r.credentialId);
    seen.add(r.credentialId);
    pool.decInFlight('glm', r.credentialId); // release immediately → next pick sees 0 again
  }
  assert.ok(seen.has('glm-key1'), 'expected glm-key1 to be picked at least once');
  assert.ok(seen.has('glm-key2'), 'expected glm-key2 to be picked at least once');
});

function quotaSnap(entries: Array<[string, number]>): Map<string, CredentialQuota> {
  const m = new Map<string, CredentialQuota>();
  for (const [id, usedPct] of entries) {
    m.set(`glm\0${id}`, {
      status: 'ok',
      fiveHour: { usedPct, resetsAt: null },
      queriedAt: Date.now(),
    });
  }
  return m;
}

test('applyQuotaSnapshot steers traffic away from an exhausted credential', () => {
  // Regression: the dashboard showed minimax-key1 at 100% but traffic kept
  // hitting it, because quota data never reached selection. Now a fresh quota
  // snapshot at 100% proactively cools the credential down.
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.applyQuotaSnapshot(quotaSnap([['glm-key1', 100], ['glm-key2', 40]]));

  const k1 = pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!;
  assert.equal(k1.inCooldown, true);
  assert.equal(k1.cooldownReason, 'quota');

  for (let i = 0; i < 5; i++) {
    const r = pool.pickOrFallback('glm')!;
    assert.equal(r.credentialId, 'glm-key2', 'exhausted key must never be picked while healthy alternatives exist');
    pool.decInFlight('glm', r.credentialId);
  }
});

test('applyQuotaSnapshot clears stale quota cooldown once quota recovers', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  // Exhaust key1, then a later snapshot reports it recovered.
  pool.applyQuotaSnapshot(quotaSnap([['glm-key1', 100], ['glm-key2', 40]]));
  assert.equal(pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, true);
  pool.applyQuotaSnapshot(quotaSnap([['glm-key1', 30], ['glm-key2', 20]]));
  assert.equal(pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, false);
});

test('quota snapshot with resetsAt sets cooldown until the reset time', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString(); // +2h
  const m = new Map<string, CredentialQuota>([
    ['glm\0glm-key1', { status: 'ok', fiveHour: { usedPct: 100, resetsAt }, queriedAt: Date.now() }],
  ]);
  pool.applyQuotaSnapshot(m);
  const k1 = pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!;
  assert.equal(k1.inCooldown, true);
  // Cooldown should be roughly 2h out (within a generous tolerance), not the 30min default.
  assert.ok(k1.cooldownUntil && k1.cooldownUntil > Date.now() + 60 * 60_000, 'cooldown must respect resetsAt');
});

test('quota snapshot does not act on stale/error quota data', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  const m = new Map<string, CredentialQuota>([
    ['glm\0glm-key1', { status: 'error', error: 'boom', queriedAt: Date.now() }],
  ]);
  pool.applyQuotaSnapshot(m);
  assert.equal(pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, false);
});

test('all credentials quota-exhausted falls back to serving (safety valve)', () => {
  // If proactive quota data says everything is dead, we must NOT take the whole
  // pool down — better to serve the least-bad key than hard-fail. This guards
  // against stale / over-estimated quota snapshots causing an outage.
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.applyQuotaSnapshot(quotaSnap([['glm-key1', 100], ['glm-key2', 100]]));
  const r = pool.pickOrFallback('glm');
  assert.ok(r.credentialId, 'must still return a credential when all keys look exhausted');
});

// ── estimated quota must NOT drive proactive cooldowns (Fix 1) ──

test('applyQuotaSnapshot ignores estimated quota (guess) for proactive cooldown', () => {
  // Estimated quota is TokenUsageTracker ÷ an operator-typed limit — a guess.
  // Taking a key out of rotation for 30 min on a guess causes false "both pools
  // cooling" states. Only real fetched quota should steer; estimated relies on
  // the reactive 429 path.
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  const m = new Map<string, CredentialQuota>([
    ['glm\0glm-key1', { status: 'ok', estimated: true, fiveHour: { usedPct: 100, resetsAt: null }, queriedAt: Date.now() }],
    ['glm\0glm-key2', { status: 'ok', estimated: true, fiveHour: { usedPct: 100, resetsAt: null }, queriedAt: Date.now() }],
  ]);
  pool.applyQuotaSnapshot(m);
  for (const c of pool.getPoolStatus('glm')) {
    assert.equal(c.inCooldown, false, `estimated quota must not cool ${c.credentialId}`);
  }
});

test('applyQuotaSnapshot still steers on real (non-estimated) quota at 100%', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  pool.applyQuotaSnapshot(quotaSnap([['glm-key1', 100]])); // no estimated flag → real
  assert.equal(pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, true);
});

// ── key rotation clears stale cooldown (Fix 2) ──

test('hot-reload: rotating a credential apiKey clears its stale cooldown', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool()); // glm-key1.apiKey = 'k1'
  pool.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  assert.equal(pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, true);

  // Operator swaps the exhausted key for a fresh one (same credentialId).
  const rotated: ProxyConfig = {
    upstreamsById: {
      glm: {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        codePlanCredentials: [
          { id: 'glm-key1', apiKey: 'k1-rotated', weight: 1, enabled: true },
          { id: 'glm-key2', apiKey: 'k2', weight: 1, enabled: true },
        ],
      },
    },
  };
  pool.reconcileFromConfig(rotated);
  assert.equal(pool.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, false,
    'rotated key must not inherit the old key\'s cooldown');
});

test('restart: persisted cooldown of an old key is cleared after rotation', () => {
  const f = path.join(os.tmpdir(), `cd-rot-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const store1 = new JsonStateStore(f);
  const a = new CodePlanPoolManager({ store: store1 });
  a.reconcileFromConfig(configWithPool()); // glm-key1.apiKey = 'k1'
  a.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  store1.flushSync();

  // Restart with a rotated key on the same credentialId.
  const rotated: ProxyConfig = {
    upstreamsById: {
      glm: {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'x', model: 'glm-5.2',
        codePlanCredentials: [{ id: 'glm-key1', apiKey: 'k1-rotated', weight: 1, enabled: true }],
      },
    },
  };
  const store2 = new JsonStateStore(f);
  const b = new CodePlanPoolManager({ store: store2 });
  b.reconcileFromConfig(rotated);
  assert.equal(b.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, false,
    'persisted cooldown of the old key must be cleared on restart after rotation');
});

test('restart: same apiKey keeps its cooldown (no false clear)', () => {
  const f = path.join(os.tmpdir(), `cd-keep-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const store1 = new JsonStateStore(f);
  const a = new CodePlanPoolManager({ store: store1 });
  a.reconcileFromConfig(configWithPool());
  a.markCooldown('glm', 'glm-key1', 60_000, 'quota');
  store1.flushSync();
  const store2 = new JsonStateStore(f);
  const b = new CodePlanPoolManager({ store: store2 });
  b.reconcileFromConfig(configWithPool()); // same apiKey 'k1'
  assert.equal(b.getPoolStatus('glm').find(c => c.credentialId === 'glm-key1')!.inCooldown, true);
});

// ── session-sticky load awareness (Fix 4) ──

test('session-sticky keeps the hashed slot when load is balanced', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  // Same session always hashes to the same slot; with no load imbalance it must
  // stay sticky (for prompt-cache locality).
  const sid = 'sess-sticky-1';
  const first = pool.pickOrFallback('glm', sid)!;
  pool.decInFlight('glm', first.credentialId);
  for (let i = 0; i < 5; i++) {
    const r = pool.pickOrFallback('glm', sid)!;
    assert.equal(r.credentialId, first.credentialId, 'same session must stick to the same key when load is balanced');
    pool.decInFlight('glm', r.credentialId);
  }
});

test('session-sticky yields to the idlest key when its slot is overloaded', () => {
  const pool = new CodePlanPoolManager();
  pool.reconcileFromConfig(configWithPool());
  const sid = 'sess-load-1';
  // Two picks from the same session pile onto the sticky slot (in-flight 2);
  // both stay sticky because slack=1 keeps stickiness at 0-vs-0 and 1-vs-0.
  const a = pool.pickOrFallback('glm', sid)!;
  const b = pool.pickOrFallback('glm', sid)!;
  assert.equal(a.credentialId, b.credentialId, 'first two picks must stay sticky (load within slack)');
  // Third pick: sticky in-flight=2, peer=0 → 2 > 0+1 → yield to the idle peer.
  const c = pool.pickOrFallback('glm', sid)!;
  assert.notEqual(c.credentialId, a.credentialId, 'overloaded sticky slot must yield to the idle peer');
  pool.decInFlight('glm', a.credentialId);
  pool.decInFlight('glm', a.credentialId);
  pool.decInFlight('glm', c.credentialId);
});
