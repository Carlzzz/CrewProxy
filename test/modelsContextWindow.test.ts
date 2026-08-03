import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelContextWindow } from '../src/proxy';

test('resolves real context_window through alias to real model', () => {
  const upstreamsByIdMap = new Map<string, any>();
  upstreamsByIdMap.set('u1', { model: 'claude-opus-4-8', baseURL: '', apiKey: '' });
  const modelRoutesMap = new Map<string, any>([
    ['opus', { upstreamId: 'u1', model: 'claude-opus-4-8' }],
  ]);
  const w = resolveModelContextWindow('opus', upstreamsByIdMap, undefined, modelRoutesMap);
  assert.equal(typeof w, 'number');
  assert.ok(w > 0);
});

test('falls back to the model id itself when unresolved', () => {
  const w = resolveModelContextWindow('gpt-5.6', new Map(), undefined, new Map());
  assert.equal(w, 272_000); // MODEL_CONTEXT_SPECS: /^gpt-5\.6/ → 272000
});
