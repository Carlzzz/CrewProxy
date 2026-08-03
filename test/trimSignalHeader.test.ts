import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrimmedTokens } from '../src/proxy';

test('computeTrimmedTokens returns positive difference', () => {
  assert.equal(computeTrimmedTokens(10000, 7000), 3000);
});

test('computeTrimmedTokens clamps to zero when not smaller', () => {
  assert.equal(computeTrimmedTokens(5000, 5000), 0);
  assert.equal(computeTrimmedTokens(5000, 6000), 0);
});
