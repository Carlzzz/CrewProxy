import test from 'node:test';
import assert from 'node:assert';
import { isQuotaExceeded } from '../src/proxy';

test('配额关闭不拦截', () => {
  const q = { enabled: false, daily_limit: 100, monthly_limit: null };
  assert.equal(isQuotaExceeded(q, { dailyUsed: 999, monthlyUsed: 0 }), false);
});

test('日额度超限拦截', () => {
  const q = { enabled: true, daily_limit: 100, monthly_limit: null };
  assert.equal(isQuotaExceeded(q, { dailyUsed: 100, monthlyUsed: 0 }), true);
  assert.equal(isQuotaExceeded(q, { dailyUsed: 99, monthlyUsed: 0 }), false);
});

test('月额度超限拦截', () => {
  const q = { enabled: true, daily_limit: null, monthly_limit: 1000 };
  assert.equal(isQuotaExceeded(q, { dailyUsed: 0, monthlyUsed: 1000 }), true);
});

test('limit 为 null 该维度不限', () => {
  const q = { enabled: true, daily_limit: null, monthly_limit: null };
  assert.equal(isQuotaExceeded(q, { dailyUsed: 999999, monthlyUsed: 999999 }), false);
});
