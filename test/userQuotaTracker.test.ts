import test from 'node:test';
import assert from 'node:assert';
import { UserQuotaTracker } from '../src/userQuotaTracker';

function tsOf(iso: string): number {
  return new Date(iso).getTime();
}

test('record 累计当日/当月', () => {
  const t = new UserQuotaTracker({ now: () => tsOf('2026-08-31T10:00:00Z') });
  t.record('u1', 100, tsOf('2026-08-31T10:00:00Z'));
  t.record('u1', 50, tsOf('2026-08-31T11:00:00Z'));
  const u = t.getUsage('u1', tsOf('2026-08-31T12:00:00Z'));
  assert.equal(u.dailyUsed, 150);
  assert.equal(u.monthlyUsed, 150);
});

test('跨天(同月)清日额度、月保留', () => {
  const t = new UserQuotaTracker();
  t.record('u1', 100, tsOf('2026-08-30T10:00:00Z'));
  const u = t.getUsage('u1', tsOf('2026-08-31T01:00:00Z'));
  assert.equal(u.dailyUsed, 0);
  assert.equal(u.monthlyUsed, 100);
});

test('跨月清零日与月', () => {
  const t = new UserQuotaTracker();
  t.record('u1', 100, tsOf('2026-08-31T10:00:00Z'));
  const u = t.getUsage('u1', tsOf('2026-09-01T01:00:00Z'));
  assert.equal(u.dailyUsed, 0);
  assert.equal(u.monthlyUsed, 0);
});

test('东八区边界：UTC 16:00 即东八区次日', () => {
  const t = new UserQuotaTracker();
  t.record('u1', 100, tsOf('2026-08-31T15:59:00Z')); // 东八区 23:59
  const u = t.getUsage('u1', tsOf('2026-08-31T16:01:00Z')); // 东八区次日 00:01
  assert.equal(u.dailyUsed, 0);
});

test('持久化 dump/restore', () => {
  const t = new UserQuotaTracker();
  t.record('u1', 100, tsOf('2026-08-31T10:00:00Z'));
  const snap = t.dump();
  const t2 = new UserQuotaTracker();
  t2.restore(snap);
  const u = t2.getUsage('u1', tsOf('2026-08-31T11:00:00Z'));
  assert.equal(u.dailyUsed, 100);
});

test('getUsage 对非有限 ts 安全返回 0', () => {
  const t = new UserQuotaTracker();
  const u = t.getUsage('u1', NaN);
  assert.equal(u.dailyUsed, 0);
  assert.equal(u.monthlyUsed, 0);
});