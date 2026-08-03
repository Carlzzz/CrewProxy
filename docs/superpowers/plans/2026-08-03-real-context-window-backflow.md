# 真实上下文窗口反向流通(梯度 1)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CrewProxy 通过 `/models` 反向流通每个模型的真实 context_window,AmbiCrew 缓存并在 spawn CLI 时按"用户手改 > proxy 真实 > preset"合并进 compact 阈值来源。

**Architecture:** 跨两仓。CrewProxy 端在 `/models` item 附 `context_window`(组 A)。AmbiCrew 端解析该字段(组 B)、持久化到独立字段 `proxyModelContextWindows`(组 C)、spawn 时三方合并(组 D)。子进程 `getContextWindowForModel` 零改动。

**Tech Stack:** TypeScript, Node.js `node:test`+`tsx`(CrewProxy 测试),vitest(AmbiCrew 测试),zod(provider schema)。

## Global Constraints

- 优先级契约(高→低):`CLAUDE_CODE_MAX_CONTEXT_TOKENS`(ant)/`[1m]` 后缀 > 用户手改 `modelContextWindows` > proxy 回报 `proxyModelContextWindows` > preset > 内置默认。
- 向后兼容:proxy 缺 `context_window` → AmbiCrew `proxyModelContextWindows` 为空 → 合并退化为现状。两端可独立部署,无顺序要求。
- 本梯度只做 `context_window`,不流通 `max_output_tokens`(属梯度 3)。
- 独立缓存:proxy 回报值写入 `proxyModelContextWindows`,绝不覆盖用户手改的 `modelContextWindows`。
- CrewProxy 测试命令 `npx tsx --test <file>`;AmbiCrew 沿用其现有测试框架与命令。

---

### Task 1: CrewProxy `/models` 附带真实 context_window

**Files:**
- Modify: `src/proxy.ts:1394-1429`(`/models` items 构建)
- Test: `test/modelsContextWindow.test.ts`(新建)

**Interfaces:**
- Consumes: `resolveUpstreamFromModel(modelStr, upstreamsByIdMap, defaultUpstream, modelRoutesMap): ResolvedUpstream | null`(`ResolvedUpstream.modelId: string`);`getModelContextWindow(modelId): { contextWindow: number; maxOutputTokens: number }`
- Produces: `/models` 每个 item 形状 `{ model_id: string; model_alias: string; context_window: number }`

- [ ] **Step 1: 写失败测试(抽一个纯函数便于测)**

`/models` handler 依赖大量 ctx,直接端到端测成本高。先抽一个纯函数 `buildModelContextWindow(modelId, ctx部件)` 承载"解析真实模型→取窗口"逻辑并单测它。

创建 `test/modelsContextWindow.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelContextWindow } from '../src/proxy';

test('resolves real context_window through alias to real model', () => {
  // opus 别名路由到 claude-opus-4-8(窗口 1M);构造最小 maps
  const upstreamsByIdMap = new Map();
  const modelRoutesMap = new Map([
    ['opus', { upstreamId: 'u1', model: 'claude-opus-4-8' }],
  ]);
  upstreamsByIdMap.set('u1', { model: 'claude-opus-4-8', baseURL: '', apiKey: '' } as any);
  const w = resolveModelContextWindow('opus', upstreamsByIdMap, undefined, modelRoutesMap);
  assert.equal(typeof w, 'number');
  assert.ok(w > 0);
});

test('falls back to the model id itself when unresolved', () => {
  const w = resolveModelContextWindow('gpt-5.6', new Map(), undefined, new Map());
  assert.equal(w, 272_000); // MODEL_CONTEXT_SPECS: /^gpt-5\.6/ → 272000
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test test/modelsContextWindow.test.ts`
Expected: FAIL —— `resolveModelContextWindow` is not exported。

- [ ] **Step 3: 实现纯函数并接入 handler**

在 `src/proxy.ts` 顶部已 import `resolveUpstreamFromModel`、`getModelContextWindow`(若未 import 则补;`getModelContextWindow` 来自 `./contextBudget`,`resolveUpstreamFromModel` 来自 `./config`)。新增导出函数(放在 `/models` handler 之前的模块作用域):

```ts
export function resolveModelContextWindow(
  modelId: string,
  upstreamsByIdMap: Map<string, any>,
  defaultUpstream: any,
  modelRoutesMap?: Map<string, any>,
): number {
  const r = resolveUpstreamFromModel(modelId, upstreamsByIdMap, defaultUpstream, modelRoutesMap);
  const realModel = r?.modelId ?? modelId;
  return getModelContextWindow(realModel).contextWindow;
}
```

在 `/models` 的三处 `items.push(...)`(1403 / 1409 / 1413)把 item 补上 `context_window`。以 1403 为例:

```ts
items.push({
  model_id: modelName,
  model_alias: modelName,
  context_window: resolveModelContextWindow(modelName, ctx.upstreamsByIdMap, ctx.defaultUpstream, ctx.modelRoutesMap),
});
```

1409 用 `model_id: `${upstreamId}|${upstream.model}``,窗口用 `resolveModelContextWindow(upstream.model, ...)`;1413 用 `resolveModelContextWindow(ctx.defaultUpstream.model, ...)`。items 数组的元素类型注解(1394 `Array<{ model_id: string; model_alias: string }>`)加上 `; context_window: number`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test test/modelsContextWindow.test.ts`
Expected: PASS(2 测)。

- [ ] **Step 5: 全量测试 + 构建**

Run: `npm test` → 全绿;`npm run build` → 无 TS 报错。

- [ ] **Step 6: 提交**

```bash
git add src/proxy.ts test/modelsContextWindow.test.ts
git commit -m "feat(proxy): advertise real context_window in /models items"
```

---

### Task 2: AmbiCrew 解析 `context_window` 字段

**Files:**
- Modify: `src/services/central/proxy-client.ts`(`ProxyModelItem` 接口、`fetchProxyModelList` 解析、`parseDirectModels`)
- Test: `src/services/central/proxy-client.test.ts`(新建或追加,沿用仓库现有测试框架)

**Interfaces:**
- Consumes: `/models` item 的 `context_window?: number`(Task 1 产出)
- Produces: `ProxyModelItem { modelId: string; modelAlias: string; imageSupport?: boolean; contextWindow?: number }`

- [ ] **Step 1: 写失败测试**

创建/追加 `src/services/central/proxy-client.test.ts`(用仓库现有测试 runner;若用 vitest 则 `import { describe, it, expect } from 'vitest'`)。测 `parseDirectModels` 这一纯函数最直接:

```ts
import { parseDirectModels } from './proxy-client'

it('parses context_window when present and positive', () => {
  const raw = JSON.stringify({ items: [{ model_id: 'm1', model_alias: 'm1', context_window: 272000 }] })
  const items = parseDirectModels(raw)
  expect(items[0].contextWindow).toBe(272000)
})

it('leaves contextWindow undefined when field missing or non-positive', () => {
  const raw = JSON.stringify({ items: [
    { model_id: 'm1', model_alias: 'm1' },
    { model_id: 'm2', model_alias: 'm2', context_window: 0 },
  ] })
  const items = parseDirectModels(raw)
  expect(items[0].contextWindow).toBeUndefined()
  expect(items[1].contextWindow).toBeUndefined()
})
```

> 若 `parseDirectModels` 现有签名/输入格式与此不同,先读其实现对齐输入构造;断言目标不变(正数→填,缺失/非正→undefined)。

- [ ] **Step 2: 运行测试确认失败**

Run: AmbiCrew 测试命令(如 `npx vitest run src/services/central/proxy-client.test.ts`)
Expected: FAIL —— `contextWindow` undefined 或类型不存在。

- [ ] **Step 3: 实现解析**

`ProxyModelItem` 接口(19-23)加字段:

```ts
export interface ProxyModelItem {
  modelId: string
  modelAlias: string
  imageSupport?: boolean
  contextWindow?: number
}
```

`fetchProxyModelList` 解析处(178-186 附近)的 `rec` 类型加 `context_window?: unknown`,push 时补:

```ts
const cw = typeof rec.context_window === 'number' && rec.context_window > 0 ? rec.context_window : undefined
items.push({
  modelId: rec.model_id,
  modelAlias: rec.model_alias,
  // ...imageSupport 原样...
  ...(cw !== undefined && { contextWindow: cw }),
})
```

`parseDirectModels`(197)同样解析 `context_window`(正数才填)。

- [ ] **Step 4: 运行测试确认通过**

Run: 同 Step 2 命令
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/services/central/proxy-client.ts src/services/central/proxy-client.test.ts
git commit -m "feat(proxy-client): parse context_window from /models items"
```

---

### Task 3: AmbiCrew provider schema + 持久化方法

**Files:**
- Modify: `src/server/types/provider.ts`(`SavedProviderSchema` 加 `proxyModelContextWindows`)
- Modify: `src/server/services/providerService.ts`(新增 `persistProxyModelContextWindows` 方法)
- Test: `src/server/services/providerService.test.ts`(追加,沿用现有框架)

**Interfaces:**
- Consumes: `ModelContextWindowsSchema`(provider.ts 已有,形如 `z.record(z.string(), z.number())`)
- Produces:
  - `SavedProvider.proxyModelContextWindows?: Record<string, number>`
  - `providerService.persistProxyModelContextWindows(providerId: string, windows: Record<string, number>): Promise<void>` —— 合并写入指定 provider 的 `proxyModelContextWindows`(新值覆盖旧同名键);空对象则不写。

- [ ] **Step 1: 写失败测试**

追加 `src/server/services/providerService.test.ts`:

```ts
it('persistProxyModelContextWindows stores windows without touching user modelContextWindows', async () => {
  // 前置:创建一个 provider,带用户手改 modelContextWindows = { m1: 100 }
  const svc = /* 构造 providerService,指向临时 index 文件,沿用现有测试的构造方式 */;
  const p = await svc.createProvider({ /* ...最小字段..., */ modelContextWindows: { m1: 100 } } as any)

  await svc.persistProxyModelContextWindows(p.id, { m1: 999, m2: 272000 })

  const { providers } = await svc.listProviders()
  const saved = providers.find(x => x.id === p.id)!
  expect(saved.proxyModelContextWindows).toEqual({ m1: 999, m2: 272000 })
  expect(saved.modelContextWindows).toEqual({ m1: 100 }) // 用户手改不受污染
})
```

> 读 `providerService.test.ts` 现有用例,复用它构造 svc / 临时存储的方式。

- [ ] **Step 2: 运行测试确认失败**

Run: AmbiCrew 测试命令 for providerService.test.ts
Expected: FAIL —— `persistProxyModelContextWindows` 不存在。

- [ ] **Step 3: 实现 schema 字段**

`src/server/types/provider.ts` 的 `SavedProviderSchema`(50 行 `modelContextWindows` 之后)加:

```ts
  proxyModelContextWindows: ModelContextWindowsSchema.optional(),
```

(仅 `SavedProviderSchema` 需要;Create/Update 输入 schema 不加 —— 这是内部缓存,不经用户输入。)

- [ ] **Step 4: 实现持久化方法**

`providerService.ts` 新增方法(仿 `updateProvider` 的 readIndex/writeIndex 模式):

```ts
async persistProxyModelContextWindows(
  providerId: string,
  windows: Record<string, number>,
): Promise<void> {
  if (Object.keys(windows).length === 0) return
  const index = await this.readIndex()
  const idx = index.providers.findIndex((p) => p.id === providerId)
  if (idx === -1) return
  const existing = index.providers[idx]
  index.providers[idx] = {
    ...existing,
    proxyModelContextWindows: {
      ...(existing.proxyModelContextWindows ?? {}),
      ...windows,
    },
  }
  await this.writeIndex(index)
  if (index.activeId === providerId) {
    await this.syncToSettings(index.providers[idx])
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: 同 Step 2
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/server/types/provider.ts src/server/services/providerService.ts src/server/services/providerService.test.ts
git commit -m "feat(provider): add proxyModelContextWindows cache + persist method"
```

---

### Task 4: spawn 时三方合并 + 抓取后写入缓存

**Files:**
- Modify: `src/server/services/providerService.ts:364`(`buildManagedEnv` 内 modelContextWindows 合并)
- Modify: `src/server/api/models.ts`(proxy 抓取成功后调 `persistProxyModelContextWindows`)
- Test: `src/server/services/providerService.test.ts`(追加合并优先级用例)

**Interfaces:**
- Consumes: `persistProxyModelContextWindows`(Task 3);`SavedProvider.proxyModelContextWindows`(Task 3);`ProxyModelItem.contextWindow`(Task 2)
- Produces: `MODEL_CONTEXT_WINDOWS_ENV_KEY` env 值 = `{...preset, ...proxyModelContextWindows, ...modelContextWindows}` 的 JSON

- [ ] **Step 1: 写失败测试(合并优先级)**

追加 `src/server/services/providerService.test.ts`:

```ts
it('env merge priority: user modelContextWindows > proxy > preset', async () => {
  const svc = /* 同上构造 */;
  const p = await svc.createProvider({ /* preset 提供 m1 的某默认值 */,
    modelContextWindows: { shared: 111 } } as any)
  await svc.persistProxyModelContextWindows(p.id, { shared: 222, proxyOnly: 333 })

  const env = await svc.buildManagedEnv(/* 该 provider,沿用现有测试调用方式 */)
  const parsed = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY])
  expect(parsed.shared).toBe(111)   // 用户手改胜出
  expect(parsed.proxyOnly).toBe(333) // proxy 独有项保留
})
```

> `buildManagedEnv` 若为 private,测试用与仓库现有用例相同的手段调用(现有测试若通过 public 包装测 env,则复用那个入口)。`MODEL_CONTEXT_WINDOWS_ENV_KEY` 从 `../../utils/model/modelContextWindows.js` import。

- [ ] **Step 2: 运行测试确认失败**

Run: AmbiCrew 测试命令
Expected: FAIL —— 当前合并只有两方(preset+用户),`proxyOnly` 缺失或 `shared` 值错。

- [ ] **Step 3: 实现三方合并**

`providerService.ts:364` 的 `modelContextWindows` 构建改为:

```ts
const modelContextWindows = {
  ...getPresetModelContextWindows(provider.presetId),
  ...(provider.proxyModelContextWindows ?? {}),
  ...(provider.modelContextWindows ?? {}),
}
```

此变量在 crewcentral 分支(:384）与普通分支(:397）两处 env 输出都被引用,一处改动即两处生效(确认两处都用同名变量;若各自内联则两处都改)。

- [ ] **Step 4: 抓取后写入缓存**

`src/server/api/models.ts` proxy 抓取成功处(284/308 两处 `fetchProxyModelList` 后),把带窗口的项聚成 map 并持久化到当前 crewcentral provider。抽一个本地 helper 避免重复:

```ts
function collectProxyWindows(items: ProxyModelItem[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of items) if (typeof m.contextWindow === 'number') out[m.modelId] = m.contextWindow
  return out
}
```

在两处 `result.items` 拿到后:

```ts
const windows = collectProxyWindows(result.items)
if (Object.keys(windows).length > 0) {
  const { providerService } = await import('../services/providerService.js')
  const { activeId } = await providerService.listProviders()
  if (activeId) void providerService.persistProxyModelContextWindows(activeId, windows)
}
```

> `void` + 不 await:持久化失败不应阻塞模型列表返回(降级到 preset 即可)。import 路径按 models.ts 现有相对路径习惯调整。

- [ ] **Step 5: 运行测试 + 构建**

Run: AmbiCrew 全量测试 → 全绿;类型检查/构建命令 → 无报错。

- [ ] **Step 6: 提交**

```bash
git add src/server/services/providerService.ts src/server/api/models.ts src/server/services/providerService.test.ts
git commit -m "feat(provider): merge proxy real context windows into CLI env at spawn"
```

---

## Self-Review

**Spec coverage:**
- 组件 1(/models 附窗口)→ Task 1。✓
- 组件 2(proxy-client 解析)→ Task 2。✓
- 组件 3(独立缓存持久化)→ Task 3。✓
- 组件 4(spawn 三方合并)→ Task 4 Step 3;抓取写缓存 → Task 4 Step 4。✓
- 组件 5(子进程零改动)→ 无任务,符合设计。✓
- 优先级契约 → Task 4 合并顺序 preset→proxy→用户,与契约一致(用户手改在 spread 最后胜出;[1m]/env 覆盖由子进程 `getContextWindowForModel` 既有更高分支保证,未改动)。✓
- 兼容性(缺字段降级)→ Task 2 正数才填 + Task 4 `?? {}` 空合并。✓

**Placeholder scan:** 代码步骤均含完整代码。测试步骤中"沿用现有测试构造方式"是对已有测试基建的指认(读现有用例复用),非占位——因 AmbiCrew 测试框架细节需以仓库实际为准,故指明复用点而非臆造 svc 构造。

**Type consistency:** `proxyModelContextWindows: Record<string, number>` 在 Task 3 schema、Task 3 方法、Task 4 合并三处一致;`ProxyModelItem.contextWindow?: number` 在 Task 2 定义、Task 4 `collectProxyWindows` 消费一致;`resolveModelContextWindow` 签名 Task 1 定义并自用。一致。
