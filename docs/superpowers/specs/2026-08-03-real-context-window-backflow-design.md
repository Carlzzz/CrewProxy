# 梯度 1:真实上下文窗口反向流通 — 设计文档

日期:2026-08-03
仓库:CrewProxy(改动起点)+ AmbiCrew(消费端)
系列:两层裁剪衔接优化梯度 1 / 4(梯度 2/3/4 各自独立 spec)

## 背景与问题

AmbiCrew 的 compact(语义压缩)与 CrewProxy 的 trim(机械兜底)是纵深防御的两层,但两者对"上下文预算"的认知不一致且互不通信:

- AmbiCrew 用**静态猜测**的窗口算 compact 阈值:`getContextWindowForModel(model)`(`src/utils/context.ts:53`)→ `getConfiguredOrBuiltInModelContextWindow` → 读一个 map,该 map 由 `providerService.ts:364` 从 preset JSON(静态裸模型名)构建,spawn CLI 时经 `MODEL_CONTEXT_WINDOWS_ENV_KEY` 环境变量冻结传入子进程。
- CrewProxy 用**运行时真实**窗口做 trim:`computeInputBudget = (getModelContextWindow(realModel).contextWindow − maxOutput) × 0.85`(`src/contextBudget.ts`)。

只有 CrewProxy 知道请求最终打到哪个真实模型(档位别名路由、fallback 换模型都发生在 proxy 内部)。信息不对称导致两种浪费:

1. AmbiCrew 猜的窗口 > 真实窗口(路由降级/fallback 换小模型)→ 它以为没满,proxy 却被迫机械 trim → 语义损失。
2. AmbiCrew 猜的窗口 < 真实窗口 → 过早 compact → 额度没榨满。

## 目标

让 CrewProxy 把每个模型的**真实 context_window** 通过 `/models` 反向流通给 AmbiCrew,AmbiCrew 据此校准 compact 阈值。消除上述两种浪费,使机械 trim 退化为几乎不触发的安全阀。

本梯度**只做 context_window**;`max_output_tokens` 的输入/输出额度协商属于梯度 3。

## 架构

```
CrewProxy /models 每 item 附 context_window (真实模型解析后)
  → AmbiCrew proxy-client 解析该字段
  → 抓取结果存入 provider.proxyModelContextWindows(独立缓存,不碰用户手改)
  → spawn CLI 时三方合并进 MODEL_CONTEXT_WINDOWS_ENV_KEY env map
  → 子进程 getContextWindowForModel 读 env map → 算 compact 阈值
```

复用现有 env→CLI→`getContextWindowForModel` 链路,子进程侧零改动。真实窗口在"下次 /models 刷新 + 下次 spawn"生效(方案 A,可接受延迟:窗口值几乎不变,变化本就伴随切模型/重启)。

## 详细设计

### 组件 1:CrewProxy `/models` 附带真实窗口

文件:`src/proxy.ts:1394-1429`(items 构建处)。

对每个 item,用现有 `resolveUpstreamFromModel` 解析真实模型(该调用在 1422-1425 权限过滤已存在,可复用其结果),再用现有 `getModelContextWindow(realModel).contextWindow` 取真实窗口:

```ts
const r = resolveUpstreamFromModel(item.model_id, ctx.upstreamsByIdMap, ctx.defaultUpstream, ctx.modelRoutesMap);
const realModel = r?.modelId ?? item.model_id;
const { contextWindow } = getModelContextWindow(realModel);
// item: { model_id, model_alias, context_window: contextWindow }
```

item 形状:`{model_id, model_alias}` → `{model_id, model_alias, context_window}`。permission 过滤逻辑不变。老客户端忽略新字段。

### 组件 2:AmbiCrew 解析新字段

文件:`src/services/central/proxy-client.ts`。

- `ProxyModelItem` 接口加 `contextWindow?: number`。
- `fetchProxyModelList`(178-186):若 item 的 `context_window` 是正数则填入 `contextWindow`,否则不填(下游降级 preset)。
- `parseDirectModels`(197):同步支持;direct 连接无此字段时不填。

### 组件 3:抓取结果持久化到独立缓存

文件:`src/server/api/models.ts:284/308`(调用 `fetchProxyModelList` 处)、provider 类型与持久化。

- provider 类型新增字段 `proxyModelContextWindows?: Record<string, number>`,与用户手改的 `modelContextWindows` **并列且独立**。
- 抓到 items 后,把仅含真实窗口的项聚成 `{modelId: contextWindow}` 写入该 provider 的 `proxyModelContextWindows`。
- 独立缓存的理由:三方来源(preset / proxy 回报 / 用户手改)必须互不污染。proxy 回报值绝不能覆盖用户在 UI 手工设置的值。

### 组件 4:spawn 时三方合并

文件:`src/server/services/providerService.ts:364`(以及 crewcentral 分支 :384 与普通分支 :397 两处 env 输出)。

```ts
const modelContextWindows = {
  ...getPresetModelContextWindows(provider.presetId),  // 1. preset(最低)
  ...(provider.proxyModelContextWindows ?? {}),        // 2. proxy 回报真实窗口
  ...(provider.modelContextWindows ?? {}),             // 3. 用户手改(最高)
}
```

env key `MODEL_CONTEXT_WINDOWS_ENV_KEY` 与值格式(JSON)不变。

### 组件 5:子进程消费(零改动)

`getContextWindowForModel`(`src/utils/context.ts:53`)优先级链保持原样:
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`(ant)> `[1m]` 后缀 > `getConfiguredOrBuiltInModelContextWindow`(读合并后 env map)> OpenAI 表 > 默认。

真实窗口经 env map 进入第三顺位,天然满足优先级约束:**用户显式覆盖([1m]/环境变量)> 真实窗口 > preset**。

## 优先级契约(权威定义)

从高到低:
1. 用户显式:`CLAUDE_CODE_MAX_CONTEXT_TOKENS`(ant)、模型 `[1m]` 后缀。
2. 用户在 UI 手改的 `modelContextWindows`。
3. CrewProxy 回报的真实窗口 `proxyModelContextWindows`。
4. preset 静态值 `getPresetModelContextWindows`。
5. 内置默认。

## 测试计划

- CrewProxy:`/models` 每个 item 含正确 `context_window`(含 alias→真实模型解析);老形状字段不丢失;隐藏 alias 仍被过滤。
- AmbiCrew `proxy-client`:解析 `context_window` 为正数时填 `contextWindow`;缺字段/非正数时为 undefined;`parseDirectModels` 同理。
- AmbiCrew `providerService`:三方合并优先级(用户手改 > proxy > preset);`proxyModelContextWindows` 不污染 `modelContextWindows`;两处 env 输出分支(crewcentral/普通)均合并。
- 回归:无 proxy 数据时退化为原有 preset+用户手改两方行为。

## 兼容性

- 旧 proxy(无 context_window)+ 新 AmbiCrew → `proxyModelContextWindows` 为空 → 合并退化为现状。
- 新 proxy + 旧 AmbiCrew → 忽略新字段 → 现状行为。
- 两端可独立部署,无部署顺序要求。

## 不在范围

- 梯度 2(trim 触发信号 → reactive compact)、梯度 3(输入/输出额度协商,含 max_output_tokens 流通)、梯度 4(tool 配对共享契约)各自独立 spec。
- 服务器部署由用户手动完成。
