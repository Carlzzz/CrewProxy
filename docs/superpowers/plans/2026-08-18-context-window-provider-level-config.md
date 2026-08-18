# 上下文窗口统一 + provider 级动态配置 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 client 侧三处冗余上下文窗口写死表，让 proxy 的 `providerContextWindows`（provider 级 + 动态热更）成为唯一权威源。

**Architecture:** 分两个仓库。proxy 侧把 `contextBudget.ts` 的按模型正则写死表替换为按 `upstream.provider` 聚合的 `providerContextWindows` 配置（default + overrides，单位后缀），查询优先级为「模型覆盖 > provider 例外 > provider 默认 > 兜底 200k」。client 侧删除内置表 / preset / 用户手改三处，窗口完全来自 proxy `/models` 回填。

**Tech Stack:** proxy = Node.js + TypeScript + tsx（测试 `node:test`）；client = Bun + TypeScript（测试 `bun:test`）。

**Spec:** `proxy/docs/superpowers/specs/2026-08-18-context-window-provider-level-config-design.md`

## Global Constraints

- 兜底窗口 `DEFAULT_CONTEXT_WINDOW = 200_000`（原 64_000）。
- `maxOutputTokens` 默认 `32768`（`DEFAULT_MAX_OUTPUT` 保持）。
- 优先级（高→低）：`WOICLAW_CONTEXT_OVERRIDES[真实模型名]` > `providerContextWindows.overrides[provider]` > `providerContextWindows.default` > 兜底 200k。
- `contextWindow` 支持单位后缀字符串（`"1m"`/`"200k"`/`"128k"`）或纯数字。
- 模型级覆盖只覆盖 `contextWindow`，`maxOutputTokens` 始终从 provider spec 取。
- provider 粒度 = `upstream.provider` 字段（当前部署取值：`glm`/`deepseek`/`minimax`/`gpt`/`claude`/`ark`）。

## 仓库与分支

- **proxy**：已在分支 `feat/context-window-provider-config`（spec 已 commit）。
- **client**：Task 4 开始前需 `git -C client checkout -b feat/context-window-provider-config`。
- 两端独立 commit，不互相依赖；各自测试通过即可。

---

## File Structure

**proxy 仓库**
- `src/config.ts` — 新增 `providerContextWindows` 类型 + 解析 + 注入 runtime context。
- `src/contextBudget.ts` — 删写死表，新增 `parseWindowToken`，`getModelContextWindow`/`computeInputBudget` 改签名。
- `src/proxy.ts` — 三个调用点传入 provider 与 `providerContextWindows`。
- `proxy-config.json` — 新增 `providerContextWindows` 配置块。
- `test/config.test.ts` — 新增 providerContextWindows 解析测试。
- `test/contextBudget.test.ts` — 新建，测 `parseWindowToken` + `getModelContextWindow` 优先级。
- `test/modelsContextWindow.test.ts` — 更新签名与兜底断言。

**client 仓库**
- `src/utils/model/modelContextWindows.ts` — 删内置表，导出 `getConfiguredModelContextWindow`。
- `src/utils/context.ts` — import/调用改 `getConfiguredModelContextWindow`。
- `src/server/config/providerPresets.json` / `.ts` — 删 `modelContextWindows` 字段/schema。
- `src/server/types/provider.ts` — 删 `modelContextWindows` 字段。
- `src/server/services/providerService.ts` — 删 preset/用户手改逻辑，`buildManagedEnv` 单方合并。
- `src/server/__tests__/provider-presets.test.ts`、`providerService.contextWindow.test.ts`、`providers.test.ts` — 删/改断言。

---

## Proxy 仓库

### Task 1: config.ts 解析 `providerContextWindows`

**Files:**
- Modify: `proxy/src/config.ts`
- Test: `proxy/test/config.test.ts`

**Interfaces:**
- Produces: `ProviderContextWindowSpec`（`{ contextWindow: string | number; maxOutputTokens?: number }`）、`ProviderContextWindowsConfig`（`{ default: ProviderContextWindowSpec; overrides?: Record<string, ProviderContextWindowSpec> }`）、`ProxyConfig.providerContextWindows?`、`ProxyRuntimeContext.providerContextWindows?`。

- [ ] **Step 1: 写失败测试**

在 `proxy/test/config.test.ts` 末尾追加（先确认文件顶部已有 `import { test } from 'node:test'` 与 `import assert from 'node:assert/strict'`，以及 `parseProxyConfigObject` 的 import；若没有则按文件现有 import 风格补）：

```ts
test('parseProxyConfigObject parses providerContextWindows with default and overrides', () => {
  const parsed = parseProxyConfigObject({
    providerContextWindows: {
      default: { contextWindow: '1m', maxOutputTokens: 32768 },
      overrides: { ark: { contextWindow: '200k' } },
    },
  });
  assert.deepEqual(parsed.providerContextWindows, {
    default: { contextWindow: '1m', maxOutputTokens: 32768 },
    overrides: { ark: { contextWindow: '200k' } },
  });
});

test('parseProxyConfigObject throws when providerContextWindows.default is missing', () => {
  assert.throws(() => parseProxyConfigObject({ providerContextWindows: {} }), /default is required/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd proxy && npx tsx --test test/config.test.ts`
Expected: FAIL（`providerContextWindows` 尚未被解析，或类型不存在）

- [ ] **Step 3: 实现**

`proxy/src/config.ts`：

在 `WebSearchConfig` 接口之后新增：

```ts
export interface ProviderContextWindowSpec {
  contextWindow: string | number;
  maxOutputTokens?: number;
}

export interface ProviderContextWindowsConfig {
  default: ProviderContextWindowSpec;
  overrides?: Record<string, ProviderContextWindowSpec>;
}
```

`ProxyConfig` 接口（`modelRoutes?` 之后、`hiddenModels?` 之前）加一行：

```ts
  providerContextWindows?: ProviderContextWindowsConfig;
```

`ProxyRuntimeContext` 接口（`hiddenModels?` 之后）加：

```ts
  providerContextWindows?: ProviderContextWindowsConfig;
```

在 `normalizeWebSearch` 函数之后新增两个 normalize 函数：

```ts
function normalizeProviderContextWindowSpec(v: unknown): ProviderContextWindowSpec {
  if (v === null || typeof v !== 'object') {
    throw new Error('providerContextWindows spec must be an object');
  }
  const o = v as Record<string, unknown>;
  if (o.contextWindow === undefined || o.contextWindow === null) {
    throw new Error('providerContextWindows spec.contextWindow is required');
  }
  if (typeof o.contextWindow !== 'string' && typeof o.contextWindow !== 'number') {
    throw new Error('providerContextWindows spec.contextWindow must be a string or number');
  }
  const spec: ProviderContextWindowSpec = { contextWindow: o.contextWindow as string | number };
  if (o.maxOutputTokens !== undefined && o.maxOutputTokens !== null) {
    if (typeof o.maxOutputTokens !== 'number') {
      throw new Error('providerContextWindows spec.maxOutputTokens must be a number');
    }
    spec.maxOutputTokens = o.maxOutputTokens;
  }
  return spec;
}

function normalizeProviderContextWindows(v: unknown): ProviderContextWindowsConfig {
  if (v === null || typeof v !== 'object') {
    throw new Error('providerContextWindows must be an object');
  }
  const o = v as Record<string, unknown>;
  if (o.default === undefined || o.default === null || typeof o.default !== 'object') {
    throw new Error('providerContextWindows.default is required');
  }
  const config: ProviderContextWindowsConfig = {
    default: normalizeProviderContextWindowSpec(o.default),
  };
  if (o.overrides !== undefined) {
    if (o.overrides === null || typeof o.overrides !== 'object') {
      throw new Error('providerContextWindows.overrides must be an object');
    }
    config.overrides = {};
    for (const [provider, spec] of Object.entries(o.overrides as Record<string, unknown>)) {
      config.overrides[provider] = normalizeProviderContextWindowSpec(spec);
    }
  }
  return config;
}
```

`parseProxyConfigObject`（`if (r.webSearch !== undefined)` 块之后、`return out` 之前）加：

```ts
  if (r.providerContextWindows !== undefined) {
    out.providerContextWindows = normalizeProviderContextWindows(r.providerContextWindows);
  }
```

`buildUpstreamsByIdMap` 的 return 对象加一行：

```ts
    webSearch: config.webSearch,
    providerContextWindows: config.providerContextWindows,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd proxy && npx tsx --test test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C proxy add src/config.ts test/config.test.ts
git -C proxy commit -m "[context-window] config 解析 providerContextWindows"
```

---

### Task 2: contextBudget.ts 改造

**Files:**
- Modify: `proxy/src/contextBudget.ts`
- Create: `proxy/test/contextBudget.test.ts`

**Interfaces:**
- Consumes: `ProviderContextWindowsConfig`（来自 Task 1）。
- Produces: `parseWindowToken(value: string | number): number`、`getModelContextWindow(provider: string | undefined, modelId: string, providerContextWindows?: ProviderContextWindowsConfig): { contextWindow: number; maxOutputTokens: number }`、`computeInputBudget(provider: string | undefined, modelId: string, requestedMaxOutput?: number, providerContextWindows?: ProviderContextWindowsConfig): number`。

- [ ] **Step 1: 写失败测试**

新建 `proxy/test/contextBudget.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWindowToken,
  getModelContextWindow,
  computeInputBudget,
  DEFAULT_CONTEXT_WINDOW,
} from '../src/contextBudget';
import type { ProviderContextWindowsConfig } from '../src/config';

test('parseWindowToken parses unit suffixes and numbers', () => {
  assert.equal(parseWindowToken('1m'), 1_000_000);
  assert.equal(parseWindowToken('200k'), 200_000);
  assert.equal(parseWindowToken('128k'), 128_000);
  assert.equal(parseWindowToken('1.5m'), 1_500_000);
  assert.equal(parseWindowToken(400_000), 400_000);
});

test('parseWindowToken throws on invalid token', () => {
  assert.throws(() => parseWindowToken('abc'), /invalid context window token/);
});

const cfg: ProviderContextWindowsConfig = {
  default: { contextWindow: '1m', maxOutputTokens: 32768 },
  overrides: { ark: { contextWindow: '200k' } },
};

test('getModelContextWindow: provider override wins over default', () => {
  assert.equal(getModelContextWindow('ark', 'doubao-seed-2.1', cfg).contextWindow, 200_000);
  assert.equal(getModelContextWindow('glm', 'glm-5.3', cfg).contextWindow, 1_000_000);
});

test('getModelContextWindow: model override wins over provider, keeps provider maxOutput', () => {
  process.env.WOICLAW_CONTEXT_OVERRIDES = JSON.stringify({ 'glm-4.5': 128_000 });
  const r = getModelContextWindow('glm', 'glm-4.5', cfg);
  assert.equal(r.contextWindow, 128_000);
  assert.equal(r.maxOutputTokens, 32768);
  delete process.env.WOICLAW_CONTEXT_OVERRIDES;
});

test('getModelContextWindow: falls back to 200k when no config and no override', () => {
  const r = getModelContextWindow(undefined, 'unknown-model', undefined);
  assert.equal(r.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(DEFAULT_CONTEXT_WINDOW, 200_000);
});

test('computeInputBudget uses provider-aware window', () => {
  const budget = computeInputBudget('glm', 'glm-5.3', undefined, cfg);
  assert.equal(budget, Math.floor((1_000_000 - 32768) * 0.85));
});
```

注意：`loadEnvOverrides` 在 `contextBudget.ts` 里是模块级缓存，测试里直接写/删 `process.env.WOICLAW_CONTEXT_OVERRIDES` 需要在实现里保证每次读取前重载。为让测试可靠，实现中把 `loadEnvOverrides` 改为**每次都解析**（去掉缓存，见 Step 3）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd proxy && npx tsx --test test/contextBudget.test.ts`
Expected: FAIL（`parseWindowToken` 等未定义，或 `DEFAULT_CONTEXT_WINDOW` 未导出）

- [ ] **Step 3: 实现**

`proxy/src/contextBudget.ts`：

顶部 import 加：

```ts
import type { ProviderContextWindowsConfig } from './config';
```

删掉 `MODEL_CONTEXT_SPECS` 整个数组（原 :11-35）。

`DEFAULT_CONTEXT_WINDOW` 改值并导出：

```ts
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT = 4_096;
```

（若原文件 `DEFAULT_CONTEXT_WINDOW`/`DEFAULT_MAX_OUTPUT` 已是 `const` 非导出，改成 `export const`；`DEFAULT_MAX_OUTPUT` 保持 4096 不变。）

`loadEnvOverrides` 改为每次都重载（去掉模块级缓存，便于测试与热更）：

```ts
function loadEnvOverrides(): Record<string, number> {
  const raw = process.env.WOICLAW_CONTEXT_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}
```

新增 `parseWindowToken`（放在 `loadEnvOverrides` 之后）：

```ts
export function parseWindowToken(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`invalid context window: ${value}`);
    }
    return value;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(k|m)$/i.exec(value.trim());
  if (!m) {
    throw new Error(`invalid context window token: "${value}" (expected e.g. "128k" or "1m")`);
  }
  const n = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  return unit === 'm' ? Math.round(n * 1_000_000) : Math.round(n * 1_000);
}
```

替换 `getModelContextWindow` 为：

```ts
export function getModelContextWindow(
  provider: string | undefined,
  modelId: string,
  providerContextWindows?: ProviderContextWindowsConfig,
): { contextWindow: number; maxOutputTokens: number } {
  const overrides = loadEnvOverrides();
  const modelOverride = overrides[modelId];

  const providerSpec = provider
    ? providerContextWindows?.overrides?.[provider] ?? providerContextWindows?.default
    : providerContextWindows?.default;

  const contextWindow =
    modelOverride ??
    (providerSpec ? parseWindowToken(providerSpec.contextWindow) : undefined) ??
    DEFAULT_CONTEXT_WINDOW;

  const maxOutputTokens = providerSpec?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT;

  return { contextWindow, maxOutputTokens };
}
```

替换 `computeInputBudget` 为：

```ts
export function computeInputBudget(
  provider: string | undefined,
  modelId: string,
  requestedMaxOutput?: number,
  providerContextWindows?: ProviderContextWindowsConfig,
): number {
  const spec = getModelContextWindow(provider, modelId, providerContextWindows);
  const maxOutput = requestedMaxOutput || spec.maxOutputTokens;
  const budget = Math.floor((spec.contextWindow - maxOutput) * 0.85);
  return Math.max(budget, 1024);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd proxy && npx tsx --test test/contextBudget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C proxy add src/contextBudget.ts test/contextBudget.test.ts
git -C proxy commit -m "[context-window] contextBudget 改造为 provider 级窗口"
```

---

### Task 3: proxy.ts 接线 + proxy-config.json 配置

**Files:**
- Modify: `proxy/src/proxy.ts`
- Modify: `proxy/proxy-config.json`
- Modify: `proxy/test/modelsContextWindow.test.ts`

**Interfaces:**
- Consumes: `getModelContextWindow(provider, modelId, providerContextWindows)`、`computeInputBudget(provider, modelId, requestedMaxOutput, providerContextWindows)`（Task 2）、`ProxyRuntimeContext.providerContextWindows`（Task 1）。
- Produces: `resolveModelContextWindow(modelId, upstreamsByIdMap, defaultUpstream, modelRoutesMap, providerContextWindows?)`。

- [ ] **Step 1: 更新 modelsContextWindow.test.ts（先让测试反映新契约）**

替换 `proxy/test/modelsContextWindow.test.ts` 全文件为：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd proxy && npx tsx --test test/modelsContextWindow.test.ts`
Expected: FAIL（`resolveModelContextWindow` 旧签名，或返回旧值 272000/128000）

- [ ] **Step 3: 实现 proxy.ts 接线**

`proxy/src/proxy.ts`：

`resolveModelContextWindow`（:19-28）改为：

```ts
export function resolveModelContextWindow(
  modelId: string,
  upstreamsByIdMap: Map<string, any>,
  defaultUpstream: any,
  modelRoutesMap?: Map<string, any>,
  providerContextWindows?: ProviderContextWindowsConfig,
): number {
  const r = resolveUpstreamFromModel(modelId, upstreamsByIdMap, defaultUpstream, modelRoutesMap);
  const realModel = r?.modelId ?? modelId;
  const provider = r?.upstream?.provider;
  return getModelContextWindow(provider, realModel, providerContextWindows).contextWindow;
}
```

（若文件顶部尚未 import `ProviderContextWindowsConfig`，在现有 `import { ... } from './config'` 里加 `type ProviderContextWindowsConfig`。）

`/models` 端点里调用 `resolveModelContextWindow` 处（:1539 附近），末尾追加 `ctx.providerContextWindows`：

```ts
resolveModelContextWindow(m, ctx.upstreamsByIdMap, ctx.defaultUpstream, ctx.modelRoutesMap, ctx.providerContextWindows);
```

auto-boost 块（:850 附近），把 `getModelContextWindow(anthropicReq.model)` 改为：

```ts
const { maxOutputTokens } = getModelContextWindow(provider, anthropicReq.model, ctx.providerContextWindows);
```

（此处的 `provider` 变量在 :862 已定义为 `upstream.provider?.toLowerCase()`，但 auto-boost 在 :850 更早。直接把 :850 处改为使用 `upstream.provider`：

```ts
const { maxOutputTokens } = getModelContextWindow(upstream.provider, anthropicReq.model, ctx.providerContextWindows);
```

）

裁剪预算块（:881 附近），把 `computeInputBudget(effectiveModelForBudget, requestedMaxOutput)` 改为：

```ts
const inputBudget = computeInputBudget(upstream.provider, effectiveModelForBudget, requestedMaxOutput, ctx.providerContextWindows);
```

- [ ] **Step 4: 更新 proxy-config.json**

在 `proxy/proxy-config.json` 顶层（`"hiddenModels"` 之前）插入：

```jsonc
  "providerContextWindows": {
    "default": { "contextWindow": "1m", "maxOutputTokens": 32768 },
    "overrides": {
      "ark": { "contextWindow": "200k" }
    }
  },
```

（注意与相邻字段的逗号对齐。插入后手动确认 JSON 合法。）

- [ ] **Step 5: 跑测试 + 构建确认通过**

Run: `cd proxy && npx tsx --test test/modelsContextWindow.test.ts test/contextBudget.test.ts test/config.test.ts`
Expected: 全 PASS

Run: `cd proxy && npm run build`
Expected: tsc 无错误

- [ ] **Step 6: Commit**

```bash
git -C proxy add src/proxy.ts proxy-config.json test/modelsContextWindow.test.ts
git -C proxy commit -m "[context-window] proxy 接线 provider 级窗口并落地默认配置"
```

---

## Client 仓库

> Task 4 前先建分支：`git -C client checkout -b feat/context-window-provider-config`

### Task 4: modelContextWindows.ts 删内置表 + context.ts 改 import

**Files:**
- Modify: `client/src/utils/model/modelContextWindows.ts`
- Modify: `client/src/utils/context.ts`
- Modify: `client/src/services/compact/autoCompact.test.ts`

**Interfaces:**
- Produces: `getConfiguredModelContextWindow(model: string): number | undefined`（导出，原内部函数）。

- [ ] **Step 1: 删内置表**

`client/src/utils/model/modelContextWindows.ts`：

删 `DIRECT_MODEL_CONTEXT_WINDOWS`（:5-33）与 `PATTERN_MODEL_CONTEXT_WINDOWS`（:35-48）两个常量。

删 `getBuiltInModelContextWindow` 函数（:112-125）。

把 `getConfiguredModelContextWindow`（:93）的 `function` 改为 `export function`。

删 wrapper `getConfiguredOrBuiltInModelContextWindow`（:127-134）。

保留其余：`MODEL_CONTEXT_WINDOWS_ENV_KEY`、`MODEL_CONTEXT_WINDOW_MIN/MAX`、`normalizeModelContextKey`、`normalizeWindow`、`parseConfiguredContextWindows`、`getConfiguredModelContextWindow`。

- [ ] **Step 2: 改 context.ts**

`client/src/utils/context.ts`：

:8 `import { getConfiguredOrBuiltInModelContextWindow } from './model/modelContextWindows.js'` 改为 `import { getConfiguredModelContextWindow } from './model/modelContextWindows.js'`。

:76 `const configuredWindow = getConfiguredOrBuiltInModelContextWindow(model)` 改为 `const configuredWindow = getConfiguredModelContextWindow(model)`。

- [ ] **Step 3: 改 autoCompact.test.ts**

`client/src/services/compact/autoCompact.test.ts`：

删整个测试「uses built-in windows for current third-party coding models」（:31-37，含 deepseek-v4-pro / MiniMax-M2.7 / kimi-k2.6 / glm-5.2 / glm-4.5-air 五条断言，全部依赖已删除的内置表）。

把测试「uses per-model provider overrides before built-in defaults」（:39）改名为「uses per-model env overrides」（断言体不变，env 覆盖仍生效）。

测试「global auto compact window can raise unknown models above the default」（:49）保持不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd client && bun test src/services/compact/autoCompact.test.ts`
Expected: PASS（剩余两个测试通过，第一个已删）

- [ ] **Step 5: Commit**

```bash
git -C client add src/utils/model/modelContextWindows.ts src/utils/context.ts src/services/compact/autoCompact.test.ts
git -C client commit -m "[context-window] client 删除内置窗口表"
```

---

### Task 5: providerPresets + provider 类型删字段

**Files:**
- Modify: `client/src/server/config/providerPresets.json`
- Modify: `client/src/server/config/providerPresets.ts`
- Modify: `client/src/server/types/provider.ts`
- Modify: `client/src/server/__tests__/provider-presets.test.ts`

- [ ] **Step 1: 删 JSON 字段**

`client/src/server/config/providerPresets.json`：删除 7 个 provider 对象的整个 `modelContextWindows` 块（deepseek、zhipuglm、kimi、minimax、jiekouai、shengsuanyun、crewcentral）。注意删除后保持相邻字段逗号合法。

- [ ] **Step 2: 删 schema**

`client/src/server/config/providerPresets.ts`：删 `ProviderPresetSchema` 里的 `modelContextWindows` 字段（:29-32）。

`client/src/server/types/provider.ts`：删三处 `modelContextWindows`（`SavedProviderSchema` :49、`CreateProviderSchema` :71、`UpdateProviderSchema` :83）。保留 `proxyModelContextWindows`（:53），并把其上方注释改为「Real context windows advertised by CrewProxy /models. Sole source; no preset/user merge.」。

- [ ] **Step 3: 删测试断言**

`client/src/server/__tests__/provider-presets.test.ts` 删除以下行（全部是 `modelContextWindows` 断言）：

- :100 `expect(minimax?.modelContextWindows?.['MiniMax-M3']).toBe(800000)`
- :106 `expect(jiekouai?.modelContextWindows?.['claude-sonnet-4-6']).toBe(1000000)`
- :111 `expect(shengsuanyun?.modelContextWindows?.['anthropic/claude-sonnet-4.6']).toBe(1000000)`
- :138-139 deepseek 两行
- :143-144 zhipu 两行
- :146 kimi 一行
- :159-163 shengsuanyun/crewcentral 五行

- [ ] **Step 4: 跑测试确认通过**

Run: `cd client && bun test src/server/__tests__/provider-presets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C client add src/server/config/providerPresets.json src/server/config/providerPresets.ts src/server/types/provider.ts src/server/__tests__/provider-presets.test.ts
git -C client commit -m "[context-window] client 删除 preset 与 provider 类型窗口字段"
```

---

### Task 6: providerService.ts 单方合并 + 测试清理

**Files:**
- Modify: `client/src/server/services/providerService.ts`
- Modify: `client/src/server/__tests__/providerService.contextWindow.test.ts`
- Modify: `client/src/server/__tests__/providers.test.ts`

- [ ] **Step 1: 删 providerService 冗余逻辑**

`client/src/server/services/providerService.ts`：

删 `getPresetModelContextWindows`（:100-102）。

删 `buildDefaultCrewCentralProvider` 里的 `...(preset.modelContextWindows && { modelContextWindows: preset.modelContextWindows }),`（:64）。

删 `addProvider` 里的 `...(input.modelContextWindows !== undefined && { modelContextWindows: input.modelContextWindows }),`（:257）。

删 `updateProvider` 里的 `...(input.modelContextWindows !== undefined && input.modelContextWindows !== null && { modelContextWindows: input.modelContextWindows }),`（:281）与 `if (input.modelContextWindows === null) { delete updated.modelContextWindows }`（:287-289）。

`buildManagedEnv`（:396-400）三方合并改为单方：

```ts
    const modelContextWindows = provider.proxyModelContextWindows ?? {}
```

（删除原 `getPresetModelContextWindows(provider.presetId)` 与 `...(provider.modelContextWindows ?? {})` 两行。）

- [ ] **Step 2: 改 providerService.contextWindow.test.ts**

`client/src/server/__tests__/providerService.contextWindow.test.ts`：

`sampleInput` 里不再有 `modelContextWindows`（`CreateProviderInput` 已删该字段）。

第一个测试「stores proxy windows without touching user modelContextWindows」改为只验证 proxy 存储，删除 `modelContextWindows: { m1: 100 }` 入参与 `expect(saved.modelContextWindows)` 行：

```ts
  test('stores proxy windows', async () => {
    const svc = new ProviderService()
    const p = await svc.addProvider(sampleInput())

    await svc.persistProxyModelContextWindows(p.id, { m1: 999, m2: 272000 })

    const { providers } = await svc.listProviders()
    const saved = providers.find((x) => x.id === p.id)!
    expect(saved.proxyModelContextWindows).toEqual({ m1: 999, m2: 272000 })
  })
```

第三个 describe「env merge priority: user > proxy > preset」改为「env carries proxy windows」：

```ts
describe('env carries proxy windows', () => {
  test('proxy windows are serialized into env; no user override', async () => {
    const svc = new ProviderService()
    const p = await svc.addProvider(sampleInput())
    await svc.persistProxyModelContextWindows(p.id, { shared: 222, proxyOnly: 333 })

    const env = await svc.getProviderRuntimeEnv(p.id)
    const parsed = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>
    expect(parsed).toEqual({ shared: 222, proxyOnly: 333 })
  })
})
```

- [ ] **Step 3: 改 providers.test.ts**

`client/src/server/__tests__/providers.test.ts`：

删整个测试「should preserve optional model context windows」（:177-190）。

删整个测试「updating active provider should override and clear model context windows」（:288-316）。

改测试「CrewCentral runtime env should include preset model context windows」（:411-428）为验证「无 proxy 回填时 env 不含窗口 key」：

```ts
    test('CrewCentral runtime env has no context windows until proxy backfills', async () => {
      const svc = new ProviderService()

      const runtimeEnv = await svc.getProviderRuntimeEnv('crewcentral-default')

      expect(runtimeEnv.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS).toBeUndefined()
    })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd client && bun test src/server/__tests__/providerService.contextWindow.test.ts src/server/__tests__/providers.test.ts src/server/__tests__/provider-presets.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 全量 server 测试回归**

Run: `cd client && bun run check:server`
Expected: 通过（若存在与本改动无关的历史失败，确认非本次引入后记录）

- [ ] **Step 6: Commit**

```bash
git -C client add src/server/services/providerService.ts src/server/__tests__/providerService.contextWindow.test.ts src/server/__tests__/providers.test.ts
git -C client commit -m "[context-window] providerService 单方合并并清理测试"
```

---

## 完成验收

- proxy：`npm run build` 通过；`npm test`（或分文件跑三个 test 文件）通过；`providerContextWindows` 在 `proxy-config.json` 生效，`glm-5.3` 经 `/models` 广告 1m。
- client：`bun test src/services/compact/autoCompact.test.ts` 通过；`bun run check:server` 通过；`grep -r "modelContextWindows" src/` 仅剩 `proxyModelContextWindows` 相关引用，无 `DIRECT_MODEL_CONTEXT_WINDOWS`/`PATTERN_MODEL_CONTEXT_WINDOWS`/preset 的 `modelContextWindows` 残留。
- 两个仓库各自分支 `feat/context-window-provider-config` 上的 commit 可编译、测试通过。
