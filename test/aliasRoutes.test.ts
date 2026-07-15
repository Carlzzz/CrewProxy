import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import {
  loadConfig,
  buildUpstreamsByIdMap,
  resolveUpstreamFromModel,
} from '../src/config';

// Load the real proxy-config.json so this test guards the actual deployed
// alias routing (opus/sonnet/haiku -> real model ids).
const config = loadConfig(path.join(__dirname, '..', 'proxy-config.json'));
const ctx = buildUpstreamsByIdMap(config);

function resolve(model: string) {
  return resolveUpstreamFromModel(
    model,
    ctx.upstreamsByIdMap,
    ctx.defaultUpstream,
    ctx.modelRoutesMap,
  );
}

test('opus alias routes to glm upstream and rewrites to glm-5.2', () => {
  const r = resolve('opus');
  assert.ok(r, 'opus should resolve');
  assert.strictEqual(r!.upstreamRouteId, 'glm');
  assert.strictEqual(r!.modelId, 'glm-5.2');
});

test('sonnet alias routes to deepseek upstream and rewrites to deepseek-v4-pro', () => {
  const r = resolve('sonnet');
  assert.ok(r, 'sonnet should resolve');
  assert.strictEqual(r!.upstreamRouteId, 'deepseek');
  assert.strictEqual(r!.modelId, 'deepseek-v4-pro');
});

test('haiku alias routes to minimax upstream and rewrites to MiniMax-M3', () => {
  const r = resolve('haiku');
  assert.ok(r, 'haiku should resolve');
  assert.strictEqual(r!.upstreamRouteId, 'minimax');
  assert.strictEqual(r!.modelId, 'MiniMax-M3');
});

test('real model ids still route unchanged after adding aliases', () => {
  const r = resolve('claude-opus-4-8');
  assert.ok(r);
  assert.strictEqual(r!.upstreamRouteId, 'claude');
  assert.strictEqual(r!.modelId, 'claude-opus-4-8');
});

// ─── Authorization is enforced on the RESOLVED real model, not the alias ───
// These mirror the permission logic in proxy.ts: resolve first, then check
// allowedModels against resolved.modelId. Granting an alias must NOT bypass a
// restriction on the real model it maps to.

function isAllowed(model: string, allowedModels: string[] | null): boolean {
  if (allowedModels === null) return true;
  const r = resolve(model);
  const realModel = r?.modelId ?? model;
  return allowedModels.includes(realModel);
}

test('granting opus alias alone does NOT authorize when real model not allowed', () => {
  // allowed_models has the alias but not the real model → resolved to
  // glm-5.2, which is absent → denied.
  assert.strictEqual(isAllowed('opus', ['opus']), false);
});

test('granting the real model authorizes the alias that maps to it', () => {
  assert.strictEqual(isAllowed('opus', ['glm-5.2']), true);
  assert.strictEqual(isAllowed('sonnet', ['deepseek-v4-pro']), true);
  assert.strictEqual(isAllowed('haiku', ['MiniMax-M3']), true);
});

test('real model request is authorized by the real model in allowlist', () => {
  assert.strictEqual(isAllowed('claude-opus-4-8', ['claude-opus-4-8']), true);
});

test('unrelated allowlist denies both alias and real model', () => {
  assert.strictEqual(isAllowed('opus', ['MiniMax-M3']), false);
  assert.strictEqual(isAllowed('claude-opus-4-8', ['MiniMax-M3']), false);
});

test('null allowlist (super_admin / bypass) permits everything', () => {
  assert.strictEqual(isAllowed('opus', null), true);
  assert.strictEqual(isAllowed('claude-opus-4-8', null), true);
});

// ─── Hidden aliases: routable but excluded from GET /models listing ───
// Mirrors the /models list-building loop in proxy.ts: modelRoutes entries in
// ctx.hiddenModels are skipped, everything else is listed.

test('config exposes hiddenModels as a set in runtime context', () => {
  assert.ok(ctx.hiddenModels, 'hiddenModels should be present on context');
  assert.strictEqual(ctx.hiddenModels!.has('opus'), true);
  assert.strictEqual(ctx.hiddenModels!.has('sonnet'), true);
  assert.strictEqual(ctx.hiddenModels!.has('haiku'), true);
});

test('hidden aliases still resolve for routing', () => {
  // Hiding from the picker must NOT disable routing.
  assert.strictEqual(resolve('opus')!.modelId, 'glm-5.2');
  assert.strictEqual(resolve('haiku')!.modelId, 'MiniMax-M3');
});

// ─── Fallback safety net: Claude Code's firstParty DEFAULT model names ───
// When CrewCentral strips the ANTHROPIC_DEFAULT_*_MODEL env vars, CLI internal
// calls (token counting, small-fast tasks) fall back to hardcoded firstParty
// ids like claude-haiku-4-5-20251001. Those must route to a real backend, not
// 403 / silently hit the default upstream.

test('firstParty haiku default name routes to MiniMax-M3', () => {
  const r = resolve('claude-haiku-4-5-20251001');
  assert.strictEqual(r!.upstreamRouteId, 'minimax');
  assert.strictEqual(r!.modelId, 'MiniMax-M3');
});

test('firstParty opus default name routes to glm-5.2', () => {
  const r = resolve('claude-opus-4-7');
  assert.strictEqual(r!.upstreamRouteId, 'glm');
  assert.strictEqual(r!.modelId, 'glm-5.2');
});

test('firstParty haiku/opus default names are hidden from the picker', () => {
  assert.strictEqual(ctx.hiddenModels!.has('claude-haiku-4-5-20251001'), true);
  assert.strictEqual(ctx.hiddenModels!.has('claude-opus-4-7'), true);
});

test('claude-sonnet-4-6 stays a real selectable model (not downgraded, not hidden)', () => {
  const r = resolve('claude-sonnet-4-6');
  assert.strictEqual(r!.upstreamRouteId, 'claude');
  assert.strictEqual(r!.modelId, 'claude-sonnet-4-6');
  assert.strictEqual(ctx.hiddenModels!.has('claude-sonnet-4-6'), false);
});

test('models listing omits hidden aliases but keeps real models', () => {
  const listed: string[] = [];
  const seen = new Set<string>();
  for (const [modelName] of ctx.modelRoutesMap) {
    if (seen.has(modelName)) continue;
    if (ctx.hiddenModels?.has(modelName)) continue;
    seen.add(modelName);
    listed.push(modelName);
  }
  assert.ok(!listed.includes('opus'), 'opus should be hidden');
  assert.ok(!listed.includes('sonnet'), 'sonnet should be hidden');
  assert.ok(!listed.includes('haiku'), 'haiku should be hidden');
  assert.ok(listed.includes('glm-5.2'), 'real model glm-5.2 should be listed');
  assert.ok(listed.includes('claude-opus-4-8'), 'real model claude-opus-4-8 should be listed');
});
