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

// ─── Authorization runs on the RESOLVED real model + provider ───
// Mirrors /v1/messages: resolve upstream first, then
// isModelAllowed(resolved.modelId, resolved.upstream.provider, rules).
// alias 是路由语法糖, 权限跟随其展开目标, 不引入 alias 层的独立语义。

import { isModelAllowed } from '../src/config';

function isAllowed(model: string, rules: any): boolean {
  const r = resolve(model);
  const realModel = r?.modelId ?? model;
  const provider = r?.upstream.provider;
  return isModelAllowed(realModel, provider, rules);
}

test('null rules (super_admin / bypass) permits everything', () => {
  assert.strictEqual(isAllowed('opus', null), true);
  assert.strictEqual(isAllowed('claude-opus-4-8', null), true);
});

test('provider whitelist permits its models AND aliases展开到该 provider', () => {
  // glm provider 放开 → glm-5.3 命中; opus 展开 glm-5.3 后也命中
  const rules = { providers: ['glm'], extra_models: [], denied_models: [] };
  assert.strictEqual(isAllowed('glm-5.3', rules), true);
  assert.strictEqual(isAllowed('opus', rules), true);
  // deepseek 未放开 → sonnet (展开 deepseek-v4-pro) 被拒
  assert.strictEqual(isAllowed('sonnet', rules), false);
  assert.strictEqual(isAllowed('deepseek-v4-pro', rules), false);
});

test('extra_models 允许具体真实模型, alias 展开命中也放行', () => {
  // 只放 glm-5.3 到 extra, 不开 glm provider
  const rules = { providers: [], extra_models: ['glm-5.3'], denied_models: [] };
  assert.strictEqual(isAllowed('glm-5.3', rules), true);
  // opus 展开 glm-5.3 → 命中 extra
  assert.strictEqual(isAllowed('opus', rules), true);
  // 未放 deepseek-v4-pro → sonnet 展开后被拒
  assert.strictEqual(isAllowed('sonnet', rules), false);
});

test('extra_models 独立放开单个模型 (跨 provider 补丁)', () => {
  const rules = { providers: [], extra_models: ['claude-opus-4-8'], denied_models: [] };
  assert.strictEqual(isAllowed('claude-opus-4-8', rules), true);
  assert.strictEqual(isAllowed('claude-sonnet-4-6', rules), false);
});

test('denied_models 在 provider 全开下挖洞', () => {
  const rules = { providers: ['gpt'], extra_models: [], denied_models: ['gpt-5.6-sol'] };
  assert.strictEqual(isAllowed('gpt-5.6-luna', rules), true);
  assert.strictEqual(isAllowed('gpt-5.6-sol', rules), false);
});

test('denied_models 命中 alias 的展开目标时也拒绝 alias', () => {
  // opus 展开 glm-5.3。glm provider 放开但 glm-5.3 被 denied → opus 也被拒
  const rules = { providers: ['glm'], extra_models: [], denied_models: ['glm-5.3'] };
  assert.strictEqual(isAllowed('opus', rules), false);
  assert.strictEqual(isAllowed('glm-5.3', rules), false);
});

test('优先级 deny > extra > provider', () => {
  const rules = { providers: ['glm'], extra_models: ['glm-5.3'], denied_models: ['glm-5.3'] };
  assert.strictEqual(isAllowed('glm-5.3', rules), false);
});

test('providers=["*"] 通配符放开所有 provider', () => {
  const rules = { providers: ['*'], extra_models: [], denied_models: [] };
  assert.strictEqual(isAllowed('glm-5.3', rules), true);
  assert.strictEqual(isAllowed('deepseek-v4-pro', rules), true);
  assert.strictEqual(isAllowed('opus', rules), true);
});

test('空 rules 拒绝全部', () => {
  const rules = { providers: [], extra_models: [], denied_models: [] };
  assert.strictEqual(isAllowed('glm-5.3', rules), false);
  assert.strictEqual(isAllowed('opus', rules), false);
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

// ─── /v1/models emits provider per item (drives frontend provider grouping) ───

test('resolved upstream carries provider for /v1/models item enrichment', () => {
  const providerFor = (m: string) => resolve(m)?.upstream.provider;
  // Real models: provider comes from the routed upstream
  assert.strictEqual(providerFor('deepseek-v4-pro'), 'deepseek');
  assert.strictEqual(providerFor('glm-5.3'), 'glm');
  assert.strictEqual(providerFor('MiniMax-M3'), 'minimax');
  // Alias routes to a different provider than its name suggests — we still
  // want the ROUTED provider so the frontend groups aliases correctly.
  assert.strictEqual(providerFor('opus'), 'glm');
});
