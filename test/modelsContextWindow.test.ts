import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelContextWindow } from '../src/proxy';
import type { ProviderContextWindowsConfig } from '../src/config';

const cfg: ProviderContextWindowsConfig = {
  default: { contextWindow: '1m', maxOutputTokens: 32768 },
};

test('resolves real context_window through alias to real model, using provider default', () => {
  const upstreamsByIdMap = new Map<string, any>();
  upstreamsByIdMap.set('u1', { model: 'claude-opus-4-8', baseURL: '', apiKey: '', provider: 'claude' });
  const modelRoutesMap = new Map<string, any>([
    ['opus', { upstream: 'u1', model: 'claude-opus-4-8' }],
  ]);
  const w = resolveModelContextWindow('opus', upstreamsByIdMap, undefined, modelRoutesMap, cfg);
  assert.equal(w, 1_000_000);
});

test('falls back to 200k when unresolved and no provider config', () => {
  const w = resolveModelContextWindow('unknown-model', new Map(), undefined, new Map());
  assert.equal(w, 200_000);
});
