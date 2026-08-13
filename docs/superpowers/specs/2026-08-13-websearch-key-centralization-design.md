# WebSearch KEY 统一收敛到 Proxy 的设计方案

- **日期**：2026-08-13
- **状态**：待评审
- **涉及仓库**：`proxy`（核心）、`client`、`server`（三个独立 git 仓库，同一 gitlab group `ai/ambicrew`）

## 1. 背景与目标

当前 WebSearch（Tavily / Brave）是「旁路」：client 端在本地 settings 里填 `tavilyApiKey` / `braveApiKey`，直接 `fetch` `api.tavily.com` / `api.search.brave.com`。这条路**不经过 proxy、无鉴权、无调用记录**，server 端看不到任何 WebSearch 用量。

目标：

1. 把 Tavily / Brave 的 KEY 统一收敛到 **proxy** 管理，用户端不再填写 KEY。
2. client 的 WebSearch 改为调用 proxy 的转发端点。
3. proxy 记录每次 WebSearch 调用（用户、provider、query、时间、状态）。
4. server 端提供 WebSearch 调用次数的**历史明细 + 统计报表**，形态对齐现有模型调用报表。

**范围边界**：只收编 Tavily / Brave。`anthropic` 原生 web search（走 LLM 的 `server_tool_use`，已经过 proxy 的 `/v1/messages`，且不需要额外 KEY）**保持现状不动**。

## 2. 现状

### 2.1 client 端（`src/tools/WebSearchTool/`）

- `backend.ts` 定义 4 种 provider：`anthropic`（原生）、`tavily`、`brave`、`disabled`。
- KEY 存在 settings 的 `webSearch.tavilyApiKey` / `webSearch.braveApiKey`。
- `searchWithTavily` / `searchWithBrave` 直接 fetch 外部搜索 API。
- `resolveWebSearchProvider` 按 mode + 是否有 KEY 决定用哪个 provider。

### 2.2 proxy 端

- 认证：`extractClientApiKey`（`x-api-key` / `Authorization: Bearer`）→ `authenticateRequest` → 外部认证服务解析出 `username`。
- usage 落盘：`appendUsageLog()` 写 JSONL（`src/usageLogger.ts`），字段见 2.4。
- ES 同步：`src/scripts/sync-usage-to-es.ts` 原样 bulk 到 ES（动态 mapping，无固定 schema），索引名由 `WOICLAW_ES_INDEX` 环境变量决定。
- 端点：`/v1/messages`、`/v1/messages/count_tokens`、`/api/event_logging/batch`、`/healthz`、`/models`、`/metrics`、`/pool-status`、`/admin/config`。**无 WebSearch 端点**。

### 2.3 server 端

- 报表读 ES，`app/core/es.py` 的 `es_search()` 封装查询。
- `usage_admin.py`：`/admin/usage/overview`、`/trend`、`/records`、`/filters`（含 `by_user` 维度 + 明细分页）。
- `usage_account.py`：`/account/usage/overview`、`/trend`、`/filters`（单用户，强制按 session 用户过滤）。
- 查询核心：`username.keyword` / `modelid.keyword` / `start_time` 过滤 + `terms` / `date_histogram` 聚合。

### 2.4 现有 ES 记录字段（usageLogger.ts 写入）

`app`、`clientid`、`username`、`modelid`、`input_token`、`output_token`、`input_cached_token`、`start_time`、`out_time`、`cost_time`、`request_size`、`response_size`、`stream`、`input_content`、`output_content`、`input_fulltext`、`session_id`、`routing_key`、`status`、`error`。

## 3. 改造后数据流

```
client ──POST /v1/websearch（无 KEY，带 device token）──▶ proxy ──（proxy 持 KEY）──▶ Tavily / Brave
                                                            │
                                                            └─ appendUsageLog(kind='websearch') → JSONL → ES → server 报表
```

## 4. 数据模型（核心决策）

### 4.1 区分字段：`kind`（新增）

- **只给 websearch 记录写 `kind: 'websearch'`**；llm 记录**一个字节都不改**（不新增 kind 字段）。
- 实现：`UsageLogExtra` 增加可选 `kind?: string`；`appendUsageLog` 仅在 `kind` 有值时输出 `kind` 字段，无值则不输出。llm 现有所有调用点不传 `kind` → 输出与历史完全一致。

### 4.2 server 端过滤：排除法，保证历史零影响

现有 llm 历史记录**没有** `kind` 字段，因此：

- **llm 报表**：追加 `must_not { term: { kind: 'websearch' } }`（排除 websearch）。历史 llm（无 kind）+ 新 llm（无 kind）都命中；websearch 被排除。
- **websearch 报表**：追加 `must { term: { kind: 'websearch' } }`。

> 禁止用 `must { term: { kind: 'llm' } }` 正选法——历史记录无该字段会被漏掉，表现为「历史数据消失」。

### 4.3 provider 承载：复用 `modelid` 字段

websearch 记录的 `modelid` 直接存 provider 名（`tavily` / `brave`）。server 端「按 provider 分组」**直接复用现有 `modelid.keyword` 聚合**（`terms: { field: 'modelid.keyword' }`），无需新增字段。前端 websearch 报表页将该维度标签显示为「搜索服务商 / provider」。

### 4.4 字段映射总表

| WebSearch 概念 | ES 字段 | 值 / 说明 |
|----------------|---------|-----------|
| 区分标记 | `kind` | `'websearch'`（仅 websearch 有） |
| provider | `modelid` | `'tavily'` / `'brave'` |
| 用户 | `username` | 来自外部认证服务 |
| 搜索词 | `input_content` | query 全文（明细报表展示） |
| 时间 | `start_time` / `out_time` / `cost_time` | 复用 |
| 成功/失败 | `status` | `200` / 4xx / 5xx |
| token | `input_token` / `output_token` | 恒为 `0` |
| 会话 | `session_id` | 复用（请求头 `X-WoiCrew-Session-Id`） |
| 应用 | `app` | `'woicrew'`（保持现状） |

## 5. proxy 端设计

### 5.1 配置（`src/config.ts`）

`ProxyConfig` 新增：

```ts
export interface WebSearchConfig {
  tavilyApiKey?: string;
  braveApiKey?: string;
}
export interface ProxyConfig {
  // ...现有字段
  webSearch?: WebSearchConfig;
}
```

`ProxyRuntimeContext` 新增 `webSearch?: WebSearchConfig`。`proxy-config.json` 示例：

```jsonc
{
  "webSearch": {
    "tavilyApiKey": "tvly-...",
    "braveApiKey": "BSA-..."
  }
}
```

热更新：`index.ts` 的 `fs.watch` reload 逻辑中，`reload` 时同步更新 `ctx.webSearch`（与现有 `upstreamsByIdMap` 等一致）。

### 5.2 新端点：`POST /v1/websearch`（`src/proxy.ts`）

在 `createProxyServer` 路由分发中新增。

**请求体**：

```jsonc
{
  "provider": "tavily",        // 可选；"tavily" | "brave"
  "query": "...",              // 必填
  "allowed_domains": ["..."],  // 可选
  "blocked_domains": ["..."]   // 可选
}
```

**处理流程**：

1. 读 body、解析 JSON（校验 `query` 非空）。
2. 认证：`extractClientApiKey` + `authenticateRequest`（与 `/v1/messages` 一致），得到 `username`。
3. 解析 provider：
   - client 指定 → 用指定值；校验 `ctx.webSearch` 配了对应 KEY，未配置返回 `400 provider not configured`。
   - client 未指定 → 按 `tavily → brave` 顺序选第一个配了 KEY 的；都没有返回 `400 web search not configured`。
4. 转发到 Tavily / Brave（逻辑与 client 现有 `searchWithTavily` / `searchWithBrave` 等价，见 5.4）。
5. 记录 usage（见 5.3）。
6. 返回结果。

**成功响应（200）**：

```jsonc
{ "provider": "tavily", "results": [ { "title": "...", "url": "..." } ] }
```

**失败响应**：复用现有 `createAnthropicErrorBody` 结构；401（未认证）、400（参数/未配置）、502（上游失败）分别对应。

### 5.3 usage 记录

```ts
appendUsageLog(username, provider, startTime, 0, 0, {
  app: 'woicrew',
  username,
  kind: 'websearch',
  input_content: query,
  status,                          // 200 或失败状态
  session_id,                      // 请求头 X-WoiCrew-Session-Id
  routing_key: '__default__',      // websearch 无上游路由，固定
  error,                           // 失败时的错误摘要
});
```

- `clientid` 参数 = `username`（与 llm 记录一致）。
- `modelid` 参数 = `provider`（`tavily` / `brave`）。
- token 恒为 0。

### 5.4 Tavily / Brave 转发逻辑

与 client 现有 `backend.ts` 中 `searchWithTavily` / `searchWithBrave` 等价：直接 fetch 外部 API（Tavily `POST /search` Bearer 认证；Brave `GET /res/v1/web/search` `X-Subscription-Token` 认证），解析出 `[{ title, url }]`。**不涉及** codePlan credentials pool、context trim、多轮重试——WebSearch 是简单单 KEY 转发，失败直接返回错误。

## 6. client 端设计

### 6.1 settings：删 KEY，保留 mode

- 保留 `webSearch.mode`（`auto` / `tavily` / `brave` / `anthropic` / `disabled`）。
- 删除 `webSearch.tavilyApiKey` / `webSearch.braveApiKey` 字段，及桌面端 Settings UI 中对应的 KEY 输入框。
- 涉及：`src/utils/settings/types.ts`（`SettingsJson.webSearch` 类型）、`src/utils/settings/settings.ts`（schema/默认值）、桌面端 Settings 组件。

### 6.2 `backend.ts`：去掉 KEY 判断，改走 proxy

- `WebSearchSettings` 类型去掉 `tavilyApiKey` / `braveApiKey`。
- `resolveWebSearchProvider`：`mode='tavily'` → 直接 `tavily`（不再检查 KEY）；`mode='brave'` → `brave`；`auto` → claude 模型走原生，否则 fallback 到 proxy（proxy 按 tavily→brave 决定）。
- `searchWithTavily` / `searchWithBrave` 改为调用 proxy 的 `POST /v1/websearch`，返回 hits 后复用现有 `makeExternalSearchOutput` 组装 `Output`。
- 删除 `getApiKeyForProvider`（不再需要 KEY）。

### 6.3 连接 proxy 的方式

复用 client 现有的 CrewProxy 配置：base URL 取 `getCustomBaseUrl()`（`ANTHROPIC_BASE_URL` / `LLM_PROXY_BASE_URL`），认证复用现有 central token（`x-api-key` + `Authorization: Bearer`）。WebSearch 请求拼到 `{baseURL}/v1/websearch`。具体函数名与组装方式在实现计划中精确对齐 `src/services/api/client.ts` 的现有逻辑。

## 7. server 端设计

### 7.1 新增路由 `websearch_usage.py`

复用 `es_search()` 与现有 `usage_admin.py` / `usage_account.py` 的查询骨架，**所有查询追加 `filter: [{ term: { kind: 'websearch' } }]`**。

**MVP（admin 版）**，前缀 `/admin/usage/websearch`，对齐 `usage_admin.py`：

| 端点 | 说明 |
|------|------|
| `GET /overview` | 总调用次数；`by_provider`（`modelid.keyword` 聚合）；`by_user`（`username.keyword` 聚合） |
| `GET /trend` | 按天调用次数（`date_histogram` on `start_time`） |
| `GET /records` | 明细分页（`query`=`input_content`、`username`、`modelid`、`start_time`、`status`） |
| `GET /filters` | provider 下拉（`modelid.keyword` 去重） |

**可选第二阶段（account 版）**：前缀 `/account/usage/websearch`，单用户视角，复用同一套查询 + `_user_filter_clause` 强过滤（与 `usage_account.py` 一致）。

### 7.2 现有 llm 报表追加排除过滤

`usage_admin.py` 与 `usage_account.py` 的所有查询 body，在现有 `filters` 基础上追加：

```jsonc
{ "bool": { "must_not": [ { "term": { "kind": "websearch" } } ] } }
```

保证 llm 报表不混入 websearch 记录，且历史 llm 数据零影响。

## 8. 错误处理

| 场景 | 行为 |
|------|------|
| 未认证 / token 无效 | proxy 返回 401（复用现有认证） |
| `query` 缺失 | proxy 返回 400 |
| 指定 provider 未配置 KEY | proxy 返回 400 `provider not configured` |
| 未指定 provider 且两者都未配置 | proxy 返回 400 `web search not configured` |
| Tavily / Brave 上游失败 | proxy 返回上游状态或 502，usage 记 `status` + `error` |
| client 端收到 proxy 4xx | 沿用现有 `makeWebSearchUnavailableOutput` 提示「Web search 未配置」 |

## 9. 测试

- **proxy**：单测 `/v1/websearch` —— 认证、provider 选择（指定/缺省 fallback）、未配置返回 400、转发 mock、usage 记录含 `kind='websearch'` 且 `modelid=provider`。
- **client**：更新 `backend.test.ts` —— 去掉 KEY 逻辑，改为 mock proxy 调用；验证 `resolveWebSearchProvider` 新逻辑。
- **server**：报表接口单测 —— 验证 ES 查询 body 正确包含 `kind` 过滤（llm 用 must_not，websearch 用 must）。

## 10. 迁移与兼容

- **历史数据**：llm 历史记录无 `kind` 字段，靠排除法过滤，零影响、零回填。
- **client 老用户**：settings 里残留的 `tavilyApiKey` / `braveApiKey` 被忽略（不再读取），无需迁移脚本。
- **proxy 配置**：`webSearch` 为可选配置；未配置时 websearch 端点返回「未配置」，不影响现有 llm 转发。
- **索引**：复用现有 ES 索引，ES 动态 mapping 自动为 `kind` 建立 `keyword` 子字段，无需手动建索引。

## 11. 明确不做（YAGNI）

- 不改造 `anthropic` 原生 web search。
- WebSearch 不走 codePlan credentials pool / cooldown / context trim / 多轮重试。
- 不做 WebSearch 的限流 / 配额 / 成本计费（后续需要再加）。
- 不做 websearch 独立的 ES 索引或独立落盘管线。

## 12. 实施顺序（三仓库）

1. **proxy**：配置 + `/v1/websearch` 端点 + `kind` 落盘（核心，先行）。
2. **client**：删 KEY + 改走 proxy。
3. **server**：llm 报表追加排除过滤 + 新增 websearch 报表。

每仓库独立提交，遵循各自仓库的提交规范与质量门禁。
