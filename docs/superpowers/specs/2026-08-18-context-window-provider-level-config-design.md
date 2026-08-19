# 上下文窗口统一 + provider 级动态配置 — 设计文档

日期：2026-08-18
仓库：CrewProxy（proxy，改动起点）+ AmbiCrew（client，消费端）
关联：替代 `2026-08-03-real-context-window-backflow-design.md` 中"静态猜测"部分，以及 `2026-07-14-crewcentral-gpt-5-6-context-window-design.md` 的补丁式做法

## 背景与问题

模型上下文窗口目前**分散写死在三处**，各自独立维护，已经出现不一致与漏配：

1. client `src/utils/model/modelContextWindows.ts` 内置表（`DIRECT_MODEL_CONTEXT_WINDOWS` + `PATTERN_MODEL_CONTEXT_WINDOWS`）
2. client `src/server/config/providerPresets.json` 每个 provider 的 `modelContextWindows`（激活时序列化进 `CLAUDE_CODE_MODEL_CONTEXT_WINDOWS` env）
3. proxy `src/contextBudget.ts` 的 `MODEL_CONTEXT_SPECS` 正则表（同表还管 `maxOutputTokens` 与裁剪预算）

具体症状：

- `glm-5.2` 在 client 是 800k、proxy 是 1M，两边不一致。
- `glm-5.3` 三处全漏，走 proxy 网关时被 `/^glm/` 兜底正则归到 128k（实际 1M）。
- proxy 的 `MODEL_CONTEXT_SPECS` 里还有 `kimi`/`qwen`/`yi-` 等，但真实 `proxy-config.json` 里根本没有这些 upstream，写死表已与部署脱节。
- 每上线一个新模型就要在 client preset + proxy 各补一条（见 gpt-5.6 那篇旧 spec 的补丁模式）。

**真实架构**：AmbiCrew client 全过 CrewProxy，proxy 是唯一上游，client 本地零直连配置。因此 client 侧的写死表是纯冗余——窗口本应只由 proxy 决定。

## 目标

1. **client 收敛**：删除 client 侧三处冗余窗口来源（内置表、preset 静态值、用户手改），窗口完全来自 proxy 回填。
2. **proxy provider 化 + 动态化**：proxy 窗口配置从"按模型写死正则表"改为"按 provider 字段聚合 + 动态可热更"，模型迭代无需逐个调整。

## 架构

收敛后的数据流：

```
proxy-config.json  providerContextWindows（provider 级默认 + 例外，热更）
        │
        ▼
contextBudget.ts   getModelContextWindow(provider, modelId)
        │  优先级：模型覆盖(WOICLAW_CONTEXT_OVERRIDES) > provider 例外 > provider 默认 > 兜底 200k
        ├──► /models 广告 context_window（resolveModelContextWindow）
        ├──► auto-boost max_tokens（proxy.ts:850）
        └──► computeInputBudget 裁剪预算（proxy.ts:881）
        │
        ▼（/models → client 回填）
client models.ts  cacheProxyWindows → SavedProvider.proxyModelContextWindows
        │
        ▼
providerService   buildManagedEnv 写 CLAUDE_CODE_MODEL_CONTEXT_WINDOWS（单方，仅 proxy 回填）
        │
        ▼
context.ts        getContextWindowForModel 读 env → 兜底 200k
```

## 详细设计

### Part 1 — client 删除冗余（AmbiCrew 仓库）

**`src/utils/model/modelContextWindows.ts`**
- 删 `DIRECT_MODEL_CONTEXT_WINDOWS`（:5-33）、`PATTERN_MODEL_CONTEXT_WINDOWS`（:35-48）、`getBuiltInModelContextWindow`（:112-125）、wrapper `getConfiguredOrBuiltInModelContextWindow`（:127-134）。
- 把内部 `getConfiguredModelContextWindow`（:93）改为 `export`。
- 保留：`MODEL_CONTEXT_WINDOWS_ENV_KEY`、`MODEL_CONTEXT_WINDOW_MIN/MAX`、`normalizeModelContextKey`、`normalizeWindow`、`parseConfiguredContextWindows`、`getConfiguredModelContextWindow`。

**`src/utils/context.ts`**
- :8 import 与 :76 调用由 `getConfiguredOrBuiltInModelContextWindow` 改为 `getConfiguredModelContextWindow`。
- 其余（fallback `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000`、OpenAI/ant/beta 分支）不动。

**`src/server/config/providerPresets.json` + `.ts`**
- 删 7 个 provider 的 `modelContextWindows` 字段：deepseek、zhipuglm、kimi、minimax、jiekouai、shengsuanyun、crewcentral。
- `providerPresets.ts` 删 `modelContextWindows` schema（:29-32）。

**`src/server/types/provider.ts`**
- 删 `SavedProviderSchema.modelContextWindows`（:49）、`CreateProviderSchema.modelContextWindows`（:71）、`UpdateProviderSchema.modelContextWindows`（:83）。
- 保留 `proxyModelContextWindows`（:53），注释改为"仅 proxy 回填缓存，无 preset/user 两方合并"。
- 保留 `ModelContextWindowsSchema`（仍被 `proxyModelContextWindows` 使用）。

**`src/server/services/providerService.ts`**
- 删 `getPresetModelContextWindows`（:100-102）、`buildDefaultCrewCentralProvider` 里的 preset 窗口（:64）。
- 删 `addProvider`（:257）与 `updateProvider`（:281、:287-289）里 `modelContextWindows` 的读写。
- `buildManagedEnv` 合并（:396-400）改为单方：`const modelContextWindows = provider.proxyModelContextWindows ?? {}`。两处 env 输出（crewcentral :419-421、普通 :432-434）不变。

### Part 2 — proxy provider 级动态窗口（CrewProxy 仓库）

**`proxy-config.json` 新增配置**

```jsonc
"providerContextWindows": {
  "default": { "contextWindow": "1m", "maxOutputTokens": 32768 },
  "overrides": {
    "ark": { "contextWindow": "200k" }
  }
}
```

- `contextWindow` 支持带单位字符串（`"1m"`/`"200k"`/`"128k"`）或纯数字。
- `maxOutputTokens` 为数字，可省略（继承 `default` 的 32768）。
- `overrides` 按 `upstream.provider` 字段聚合（当前部署取值：`glm`/`deepseek`/`minimax`/`gpt`/`claude`/`ark`）。
- 走 proxy-config.json 的热更机制（保存后约 300ms 防抖重载），满足"动态参数"。

**`src/config.ts`**
- `ProxyConfig` 加 `providerContextWindows?: { default: ProviderContextWindowSpec; overrides?: Record<string, ProviderContextWindowSpec> }`。
- `parseProxyConfigObject` 解析该字段；`default` 必填，`overrides` 可选。

**`src/contextBudget.ts`**
- 删 `MODEL_CONTEXT_SPECS`（:11-35）写死正则表。
- `DEFAULT_CONTEXT_WINDOW` 由 `64_000` 改为 `200_000`。
- 新增 `parseWindowToken(s: string | number): number`，解析 `"1m"`→1_000_000、`"200k"`→200_000；非法值抛错。
- `getModelContextWindow` 签名由 `(modelId)` 改为 `(provider: string | undefined, modelId: string)`，返回 `{ contextWindow, maxOutputTokens }`，查询顺序：
  1. `WOICLAW_CONTEXT_OVERRIDES[modelId]`（模型级覆盖，精确匹配真实模型名）
  2. `providerContextWindows.overrides[provider]`
  3. `providerContextWindows.default`
  4. 兜底 `DEFAULT_CONTEXT_WINDOW`（200k）
- **修正现有坑**：模型覆盖只覆盖 `contextWindow`；`maxOutputTokens` 始终从 provider spec 取（默认 32768），不再因命中覆盖而掉到 4096。
- `computeInputBudget` 签名同步加 `provider` 参数。

**`src/proxy.ts`**
- `resolveModelContextWindow`（:19-28）：`getModelContextWindow(realModel)` → `getModelContextWindow(upstream.provider, realModel)`（`resolveUpstreamFromModel` 已返回 upstream）。
- :850 auto-boost 与 :881 `computeInputBudget`：从已解析的 `resolved.upstream.provider` 传入 provider。

### 优先级契约（权威定义）

从高到低：

1. 模型级覆盖 `WOICLAW_CONTEXT_OVERRIDES[真实模型名]`
2. provider 例外 `providerContextWindows.overrides[provider]`
3. provider 默认 `providerContextWindows.default`
4. 兜底 `DEFAULT_CONTEXT_WINDOW = 200_000`

## 测试计划

**proxy（CrewProxy）**
- `parseWindowToken`：`"1m"`/`"200k"`/`"128k"`/数字/非法值。
- `getModelContextWindow`：覆盖命中 > provider 例外 > 默认 > 兜底 200k；模型覆盖不改变 maxOutputTokens。
- `providerContextWindows` 配置解析：default 必填、overrides 可选、非法单位报错。
- `resolveModelContextWindow`：alias 路由解析到真实模型后按 provider 取窗口。
- 回归：`/models` 每 item 的 `context_window` 正确；裁剪预算（`computeInputBudget`）随 provider 默认变化。

**client（AmbiCrew）**
- `provider-presets.test.ts`：删全部 `modelContextWindows` 断言。
- `providerService.contextWindow.test.ts`：三方合并改单方（仅 `proxyModelContextWindows`）；删用户手改覆盖断言。
- `providers.test.ts`：删 `modelContextWindows` 相关断言（add/update/merge）。
- `autoCompact.test.ts`：`MODEL_CONTEXT_WINDOWS_ENV_KEY` env 机制仍在，基本不动。

## 兼容性

- 旧 proxy（仍用 `MODEL_CONTEXT_SPECS` 旧表）+ 新 client：旧 proxy 的 `/models` 会广告旧表的 `context_window`（如 glm-5.3 命中 `/^glm/` → 128k），新 client 回填旧表值，故显示旧表值而非 200k。client 的 200k 兜底只在 proxy 完全不返回 `context_window` 字段（real-context-window-backflow 之前的更老 proxy）时才生效。
- 新 proxy + 旧 client：旧 client 仍读 env，忽略 provider 级结构，行为不变。
- 两端可独立部署，无部署顺序要求。

## 不在范围

- 二期：proxy 向上游 `/models` 动态拉取真实 `context_window`（本设计仍是"配置"而非"自动发现"）。
- `buildManagedEnv` 的 anthropic→上游 baseUrl 直连死代码清理（独立任务）。
- `proxy-config.json` 明文 api key 治理（独立安全任务）。
- `max_output_tokens` 的输入/输出额度协商（原 spec 的梯度 3）。
- OpenAI 表 / ant 表 / `getModelCapability`（client 侧独立场景，非本次"第三方模型冗余表"）。
