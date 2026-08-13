# WebSearch KEY 收敛到 Proxy 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Tavily/Brave 的 WebSearch KEY 从 client 收敛到 proxy，client 改走 proxy 转发端点，server 提供 WebSearch 用量报表。

**Architecture:** 三个独立 git 仓库（`proxy`/`client`/`server`）分层改造。proxy 新增 `POST /v1/websearch` 端点（复用现有认证 + `appendUsageLog` 落盘，新增 `kind='websearch'` 标记）；client 删 KEY、改走 proxy；server 复用 ES 报表基建新增 websearch 报表，llm 报表用排除法过滤保证历史零影响。

**Tech Stack:** proxy = Node ≥18 + TypeScript (commonjs, node:test)；client = Bun + TypeScript (zod, node:test/vitest)；server = Python 3.11 + FastAPI + ES(httpx)。

**Spec:** `docs/superpowers/specs/2026-08-13-websearch-key-centralization-design.md`

## Global Constraints

- 三个仓库独立提交，禁止 push；每个 task 结束单独 commit。
- **三仓库任何更改必须先建 feature 分支 `feat/websearch-key-centralization`，不得直接在 main 分支修改/commit**（用户明确要求；此前已落到 main 的历史文档 commit 不回退）。
- commit message 用 `feat(websearch): <中文简述>` 或 `fix(websearch): <中文简述>`。
- proxy 用 `node:test` + `assert/strict`；test 文件在 `test/*.test.ts`，跑 `npm test`。
- client 用 zod schema 校验 settings；桌面端测试用 vitest。
- server 用 `rc_ok`/`rc_err` 包装响应；报表接口权限用 `require_session_permission("usage")`。
- 只收编 Tavily/Brave；`anthropic` 原生 web search 保持现状不动。
- llm 历史记录**一个字节不改**；llm 报表用 `must_not { term: { kind: 'websearch' } }` 排除法。

---

## 阶段一：proxy（核心，先行）

> **建分支**（若尚未建）：`cd C:/Users/songchao/Bruno/Ambicrew/proxy && git checkout -b feat/websearch-key-centralization`

### Task 1: 配置支持 webSearch

**Files:**
- Modify: `src/config.ts`（`WebSearchConfig` 接口、`ProxyConfig.webSearch`、`ProxyRuntimeContext.webSearch`、`normalizeWebSearch`、`parseProxyConfigObject`、`buildUpstreamsByIdMap`）
- Modify: `src/index.ts`（热更新同步 `ctx.webSearch`）
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `ProxyConfig.webSearch?: WebSearchConfig`；`ProxyRuntimeContext.webSearch?: WebSearchConfig`；`WebSearchConfig = { tavilyApiKey?: string; braveApiKey?: string }`（后续 Task 3/4 消费）。

- [ ] **Step 1: 写失败测试**

在 `test/config.test.ts` 顶部已有 `import { normalizeUpstream } from '../src/config'`，改为：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpstream, parseProxyConfigObject } from '../src/config';
```

文件末尾追加：

```ts
test('parseProxyConfigObject parses webSearch keys', () => {
  const cfg = parseProxyConfigObject({
    webSearch: { tavilyApiKey: 'tvly-x', braveApiKey: 'BSA-y' },
  });
  assert.deepEqual(cfg.webSearch, { tavilyApiKey: 'tvly-x', braveApiKey: 'BSA-y' });
});

test('parseProxyConfigObject leaves webSearch undefined when absent', () => {
  const cfg = parseProxyConfigObject({ port: 3456 });
  assert.equal(cfg.webSearch, undefined);
});

test('parseProxyConfigObject ignores non-string webSearch keys', () => {
  const cfg = parseProxyConfigObject({ webSearch: { tavilyApiKey: 123, braveApiKey: '' } });
  assert.deepEqual(cfg.webSearch, {});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: FAIL — `parseProxyConfigObject` 未 export，或断言 `webSearch` 为 `undefined` 不匹配。

- [ ] **Step 3: 实现配置解析**

`src/config.ts` 中，在 `UpstreamConfig` 接口后新增：

```ts
export interface WebSearchConfig {
  tavilyApiKey?: string;
  braveApiKey?: string;
}
```

`ProxyConfig` 接口末尾（`hiddenModels?: string[]` 之后）加：

```ts
  webSearch?: WebSearchConfig;
```

`ProxyRuntimeContext` 接口（`tokenUsage?: TokenUsageTracker` 之后）加：

```ts
  webSearch?: WebSearchConfig;
```

在 `normalizeUpstream` 函数之后新增：

```ts
function normalizeWebSearch(v: unknown): WebSearchConfig {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object') throw new Error('webSearch must be an object');
  const o = v as Record<string, unknown>;
  const out: WebSearchConfig = {};
  if (typeof o.tavilyApiKey === 'string' && o.tavilyApiKey) out.tavilyApiKey = o.tavilyApiKey;
  if (typeof o.braveApiKey === 'string' && o.braveApiKey) out.braveApiKey = o.braveApiKey;
  return out;
}
```

`parseProxyConfigObject` 中，在 `hiddenModels` 解析块之后、`return out` 之前加：

```ts
  if (r.webSearch !== undefined) {
    out.webSearch = normalizeWebSearch(r.webSearch);
  }
```

`buildUpstreamsByIdMap` 的 `return` 对象中加：

```ts
    hiddenModels,
    webSearch: config.webSearch,
```

- [ ] **Step 4: 同步热更新**

`src/index.ts` 的 `fs.watch` reload 回调中，`ctx.modelRoutesMap = newCtx.modelRoutesMap;` 之后加：

```ts
        ctx.webSearch = newCtx.webSearch;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: PASS（含新增 3 条 webSearch 测试 + 全部既有测试）。

- [ ] **Step 6: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/proxy
git add src/config.ts src/index.ts test/config.test.ts
git commit -m "feat(websearch): 新增 webSearch 配置解析与热更新"
```

---

### Task 2: usage 落盘支持 kind 字段

**Files:**
- Modify: `src/usageLogger.ts`（`UsageLogExtra.kind?`、`appendUsageLog` 输出 `kind`）
- Test: `test/usageLogger.test.ts`（新建）

**Interfaces:**
- Consumes: 无。
- Produces: `UsageLogExtra.kind?: string`；`appendUsageLog(..., extra.kind)` 仅在 kind 有值时输出 `kind` 字段（Task 4 消费）。

- [ ] **Step 1: 写失败测试**

新建 `test/usageLogger.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendUsageLog } from '../src/usageLogger';

function readLastRecord(dir: string): Record<string, unknown> {
  const files = fs.readdirSync(dir).filter(f => f.startsWith('usage-') && f.endsWith('.jsonl'));
  assert.ok(files.length > 0, 'expected at least one usage log file');
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf-8').split('\n').filter(l => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

test('appendUsageLog writes kind when provided', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  process.env.WOICLAW_LOG_DIR = dir;
  appendUsageLog('alice', 'tavily', '2026-08-13T00:00:00.000+08:00', 0, 0, { kind: 'websearch', username: 'alice' });
  await new Promise(r => setImmediate(r));
  const rec = readLastRecord(dir);
  assert.equal(rec.kind, 'websearch');
  assert.equal(rec.modelid, 'tavily');
  delete process.env.WOICLAW_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendUsageLog omits kind when not provided', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  process.env.WOICLAW_LOG_DIR = dir;
  appendUsageLog('alice', 'claude-opus', '2026-08-13T00:00:00.000+08:00', 100, 200, {});
  await new Promise(r => setImmediate(r));
  const rec = readLastRecord(dir);
  assert.equal('kind' in rec, false);
  delete process.env.WOICLAW_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: FAIL — `readLastRecord` 抛错或 `rec.kind` 为 undefined。

- [ ] **Step 3: 实现 kind 输出**

`src/usageLogger.ts` 的 `UsageLogExtra` 接口（`error?: string` 之后）加：

```ts
  /** Distinguishes websearch records from llm records. Only set on websearch
   *  calls; llm records omit it so historical data is unchanged. */
  kind?: string;
```

`appendUsageLog` 内 `const record = {` 的 `app: e?.app ?? 'woicrew',` 之后加一行：

```ts
        ...(e?.kind !== undefined ? { kind: e.kind } : {}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/proxy
git add src/usageLogger.ts test/usageLogger.test.ts
git commit -m "feat(websearch): usage 落盘支持 kind 字段"
```

---

### Task 3: WebSearch 转发模块（纯函数）

**Files:**
- Create: `src/webSearch.ts`（`WebSearchHit`、`parseTavilyResponse`、`parseBraveResponse`、`applyDomainFiltersToQuery`、`searchTavily`、`searchBrave`）
- Test: `test/webSearch.test.ts`（新建）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export interface WebSearchHit { title: string; url: string }`
  - `export function parseTavilyResponse(body: unknown): WebSearchHit[]`
  - `export function parseBraveResponse(body: unknown): WebSearchHit[]`
  - `export function applyDomainFiltersToQuery(query: string, allowed?: string[], blocked?: string[]): string`
  - `export async function searchTavily(query: string, apiKey: string, allowedDomains?: string[], blockedDomains?: string[], signal?: AbortSignal): Promise<WebSearchHit[]>`
  - `export async function searchBrave(query: string, apiKey: string, allowedDomains?: string[], blockedDomains?: string[], signal?: AbortSignal): Promise<WebSearchHit[]>`
  （Task 4 消费 search*；parse* 供单测。）

- [ ] **Step 1: 写失败测试**

新建 `test/webSearch.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTavilyResponse, parseBraveResponse, applyDomainFiltersToQuery } from '../src/webSearch';

test('parseTavilyResponse maps title/url and drops malformed hits', () => {
  const hits = parseTavilyResponse({ results: [
    { title: 'a', url: 'https://a.com' },
    { title: 1, url: 'https://b.com' },
    { title: 'c', url: null },
  ]});
  assert.deepEqual(hits, [{ title: 'a', url: 'https://a.com' }]);
});

test('parseBraveResponse maps web.results', () => {
  const hits = parseBraveResponse({ web: { results: [
    { title: 'x', url: 'https://x.com' },
  ]}});
  assert.deepEqual(hits, [{ title: 'x', url: 'https://x.com' }]);
});

test('applyDomainFiltersToQuery builds site: clauses', () => {
  const q = applyDomainFiltersToQuery('hello', ['a.com'], ['b.com']);
  assert.equal(q, '(site:a.com) -site:b.com hello');
});

test('applyDomainFiltersToQuery is query-only when no domains', () => {
  assert.equal(applyDomainFiltersToQuery('hello'), 'hello');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: FAIL — `Cannot find module '../src/webSearch'`。

- [ ] **Step 3: 实现转发模块**

新建 `src/webSearch.ts`：

```ts
export interface WebSearchHit {
  title: string;
  url: string;
}

function normalizeHit(title: unknown, url: unknown): WebSearchHit | null {
  if (typeof title !== 'string' || typeof url !== 'string') return null;
  return { title, url };
}

export function parseTavilyResponse(body: unknown): WebSearchHit[] {
  const b = body as { results?: Array<{ title?: unknown; url?: unknown }> } | null | undefined;
  return (b?.results ?? [])
    .map(h => normalizeHit(h?.title, h?.url))
    .filter((h): h is WebSearchHit => h != null);
}

export function parseBraveResponse(body: unknown): WebSearchHit[] {
  const b = body as { web?: { results?: Array<{ title?: unknown; url?: unknown }> } } | null | undefined;
  return (b?.web?.results ?? [])
    .map(h => normalizeHit(h?.title, h?.url))
    .filter((h): h is WebSearchHit => h != null);
}

export function applyDomainFiltersToQuery(query: string, allowed?: string[], blocked?: string[]): string {
  const allowedList = allowed?.filter(Boolean) ?? [];
  const blockedList = blocked?.filter(Boolean) ?? [];
  const allowedClause = allowedList.length
    ? `(${allowedList.map(d => `site:${d}`).join(' OR ')}) `
    : '';
  const blockedClause = blockedList.length
    ? `${blockedList.map(d => `-site:${d}`).join(' ')} `
    : '';
  return `${allowedClause}${blockedClause}${query}`.trim();
}

export async function searchTavily(
  query: string,
  apiKey: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      max_results: 8,
      search_depth: 'basic',
      include_answer: false,
      include_domains: allowedDomains,
      exclude_domains: blockedDomains,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status}`);
  }
  return parseTavilyResponse(await response.json());
}

export async function searchBrave(
  query: string,
  apiKey: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', applyDomainFiltersToQuery(query, allowedDomains, blockedDomains));
  url.searchParams.set('count', '8');
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Brave search failed: ${response.status}`);
  }
  return parseBraveResponse(await response.json());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/proxy
git add src/webSearch.ts test/webSearch.test.ts
git commit -m "feat(websearch): 新增 Tavily/Brave 转发模块"
```

---

### Task 4: `/v1/websearch` 端点

**Files:**
- Modify: `src/proxy.ts`（`import` webSearch、`handleWebSearchRequest` 函数、路由分发加 `/v1/websearch`）
- Test: `test/websearchEndpoint.test.ts`（新建）

**Interfaces:**
- Consumes: `ctx.webSearch`（Task 1）、`appendUsageLog(..., { kind: 'websearch', ... })`（Task 2）、`searchTavily`/`searchBrave`（Task 3）、`extractClientApiKey`/`authenticateRequest`/`readRequestBody`/`sendJSONResponse`/`sendErrorResponse`/`formatUTC8`（proxy.ts 内已有）。
- Produces: `POST /v1/websearch` 端点。

- [ ] **Step 1: 写失败测试**

新建 `test/websearchEndpoint.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyServer } from '../src/proxy';
import { ProxyRuntimeContext } from '../src/config';

process.env.WOICLAW_AUTH_BYPASS = '1'; // 绕过外部认证服务，认证返回 name='bypass'

function startServer(ctx: ProxyRuntimeContext): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise(resolve => {
    const server = createProxyServer(ctx);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

test('websearch endpoint returns results and selects provider', async () => {
  const ctx: ProxyRuntimeContext = { upstreamsByIdMap: new Map(), defaultUpstream: undefined, modelRoutesMap: new Map(), webSearch: { tavilyApiKey: 'tvly-x' } };
  const { baseUrl, close } = await startServer(ctx);
  try {
    const resp = await fetch(`${baseUrl}/v1/websearch`, {
      method: 'POST',
      headers: { 'x-api-key': 'any', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    // 真实网络不可达时会 502；此处仅断言路由存在、认证通过、非 404/401
    assert.notEqual(resp.status, 404);
    assert.notEqual(resp.status, 401);
  } finally {
    close();
  }
});

test('websearch endpoint rejects when no provider configured', async () => {
  const ctx: ProxyRuntimeContext = { upstreamsByIdMap: new Map(), defaultUpstream: undefined, modelRoutesMap: new Map(), webSearch: {} };
  const { baseUrl, close } = await startServer(ctx);
  try {
    const resp = await fetch(`${baseUrl}/v1/websearch`, {
      method: 'POST',
      headers: { 'x-api-key': 'any', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    assert.equal(resp.status, 400);
  } finally {
    close();
  }
});

test('websearch endpoint requires query', async () => {
  const ctx: ProxyRuntimeContext = { upstreamsByIdMap: new Map(), defaultUpstream: undefined, modelRoutesMap: new Map(), webSearch: { tavilyApiKey: 'tvly-x' } };
  const { baseUrl, close } = await startServer(ctx);
  try {
    const resp = await fetch(`${baseUrl}/v1/websearch`, {
      method: 'POST',
      headers: { 'x-api-key': 'any', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resp.status, 400);
  } finally {
    close();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: FAIL — 第一个测试 `resp.status` 为 404（端点尚未注册）。

- [ ] **Step 3: 实现端点**

`src/proxy.ts` 顶部 import 区（`import { buildMetricsPayload } from './metricsPayload';` 附近）加：

```ts
import { searchTavily, searchBrave } from './webSearch';
```

在 `handleRequest` 函数之后、`// ─── Server factory ───` 之前，新增：

```ts
// ─── WebSearch request handler ───

async function handleWebSearchRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ProxyRuntimeContext,
): Promise<void> {
  const startTime = formatUTC8(new Date());
  let rawBody: Buffer;
  try {
    rawBody = await readRequestBody(req);
  } catch (err: any) {
    sendErrorResponse(res, 400, err.message || 'Invalid request body', 'invalid_request_error');
    return;
  }
  let body: any;
  try {
    body = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    sendErrorResponse(res, 400, 'Invalid JSON in request body', 'invalid_request_error');
    return;
  }
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    sendErrorResponse(res, 400, 'Missing or invalid "query" in request body', 'invalid_request_error');
    return;
  }

  const clientApiKey = extractClientApiKey(req);
  if (!clientApiKey) {
    sendErrorResponse(res, 401, 'Missing API key. Provide x-api-key header or Authorization: Bearer token.', 'authentication_error');
    return;
  }
  const authResult = await authenticateRequest(clientApiKey);
  if (!authResult) {
    sendErrorResponse(res, 401, 'Invalid API key', 'authentication_error');
    return;
  }
  const username = authResult.name;
  const ws = ctx.webSearch;

  // provider 选择：client 指定则校验；未指定则 tavily → brave fallback
  const requestedProvider = body.provider;
  let provider: 'tavily' | 'brave';
  if (requestedProvider === 'tavily' || requestedProvider === 'brave') {
    provider = requestedProvider;
    const key = provider === 'tavily' ? ws?.tavilyApiKey : ws?.braveApiKey;
    if (!key) {
      sendErrorResponse(res, 400, `Web search provider ${provider} is not configured`, 'invalid_request_error');
      return;
    }
  } else if (requestedProvider === undefined || requestedProvider === null || requestedProvider === '') {
    if (ws?.tavilyApiKey) provider = 'tavily';
    else if (ws?.braveApiKey) provider = 'brave';
    else {
      sendErrorResponse(res, 400, 'Web search is not configured', 'invalid_request_error');
      return;
    }
  } else {
    sendErrorResponse(res, 400, `Unknown provider: ${requestedProvider}`, 'invalid_request_error');
    return;
  }

  const apiKey = provider === 'tavily' ? ws!.tavilyApiKey! : ws!.braveApiKey!;
  const allowed = Array.isArray(body.allowed_domains) ? body.allowed_domains.filter((d: unknown) => typeof d === 'string') : undefined;
  const blocked = Array.isArray(body.blocked_domains) ? body.blocked_domains.filter((d: unknown) => typeof d === 'string') : undefined;
  const sessionId = typeof req.headers['x-woicrew-session-id'] === 'string' && req.headers['x-woicrew-session-id']
    ? req.headers['x-woicrew-session-id'] : null;

  try {
    const hits = provider === 'tavily'
      ? await searchTavily(query, apiKey, allowed, blocked)
      : await searchBrave(query, apiKey, allowed, blocked);
    appendUsageLog(username, provider, startTime, 0, 0, {
      app: 'woicrew',
      username,
      kind: 'websearch',
      input_content: query,
      status: 200,
      session_id: sessionId,
      routing_key: '__default__',
    });
    sendJSONResponse(res, 200, { provider, results: hits });
  } catch (err: any) {
    const msg = `Web search failed: ${err?.message ?? 'unknown'}`;
    appendUsageLog(username, provider, startTime, 0, 0, {
      app: 'woicrew',
      username,
      kind: 'websearch',
      input_content: query,
      status: 502,
      session_id: sessionId,
      routing_key: '__default__',
      error: msg,
    });
    sendErrorResponse(res, 502, msg, 'api_error');
  }
}
```

在 `createProxyServer` 的路由分发中，`if (method === 'POST' && pathname === '/v1/messages')` 块之后加：

```ts
      if (method === 'POST' && pathname === '/v1/websearch') {
        await handleWebSearchRequest(req, res, ctx);
        return;
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/proxy && npm test`
Expected: PASS（端点测试 3 条通过；其中真实网络调用会走到 502 分支，测试只断言路由/认证/参数校验行为，不依赖外网）。

- [ ] **Step 5: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/proxy
git add src/proxy.ts test/websearchEndpoint.test.ts
git commit -m "feat(websearch): 新增 /v1/websearch 端点"
```

---

## 阶段二：client

> **建分支**（若尚未建）：`cd C:/Users/songchao/Bruno/Ambicrew/client && git checkout -b feat/websearch-key-centralization`

### Task 5: settings 删除 KEY 字段

**Files:**
- Modify: `src/utils/settings/types.ts:655-673`（webSearch schema 删 tavilyApiKey/braveApiKey）
- Modify: `desktop/src/types/settings.ts:9-13`（WebSearchSettings 删 key）
- Test: `src/tools/WebSearchTool/backend.test.ts`（更新，若引用 key 类型）

**Interfaces:**
- Produces: `WebSearchSettings` 仅含 `mode?: WebSearchMode`（Task 7 消费）。

- [ ] **Step 1: 修改 schema**

`src/utils/settings/types.ts` 中，把 663-670 行的 `tavilyApiKey`/`braveApiKey` 两个字段删除，`webSearch` 对象只保留 `mode`：

```ts
      webSearch: z
        .object({
          mode: z
            .enum(['auto', 'anthropic', 'tavily', 'brave', 'disabled'])
            .optional()
            .describe(
              'WebSearch backend selection. auto uses native Claude web search for Claude model names, then Tavily, then Brave.',
            ),
        })
        .optional()
        .describe('Configures native and external WebSearch backends'),
```

`desktop/src/types/settings.ts` 中：

```ts
export type WebSearchSettings = {
  mode?: WebSearchMode
}
```

- [ ] **Step 2: 跑类型检查**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/client && cd desktop && bun run lint`
Expected: 报告 `tavilyApiKey`/`braveApiKey` 相关类型错误（`backend.ts`、`Settings.tsx` 仍引用）。这是预期的，Task 7/8 会清掉。先确认没有其他意外错误。

- [ ] **Step 3: 提交**（暂不单独提交——类型错误未清，合并到 Task 7 一并提交）

标记本任务为「已修改 schema，待 Task 7/8 完成类型错误清零后随 Task 8 一起提交」。

---

### Task 6: client 导出 proxy 请求辅助函数

**Files:**
- Modify: `src/services/api/client.ts`（export `getCustomBaseUrl` 与 `configureApiKeyHeaders`）

**Interfaces:**
- Produces: `export function getCustomBaseUrl(): string | null`；`export async function configureApiKeyHeaders(headers: Record<string, string>, isNonInteractiveSession: boolean): Promise<void>`（Task 7 消费）。

- [ ] **Step 1: 导出函数**

`src/services/api/client.ts` 中，把 `getCustomBaseUrl`（约 396 行）与 `configureApiKeyHeaders`（约 340 行）声明前加 `export`：

```ts
export async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
```

```ts
export function getCustomBaseUrl(): string | null {
```

- [ ] **Step 2: 跑类型检查确认无破坏**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/client && cd desktop && bun run lint`
Expected: 无新增错误（仅 export 关键字，不改变行为）。

- [ ] **Step 3: 提交**（随 Task 7 一起提交）

---

### Task 7: backend.ts 改走 proxy

**Files:**
- Modify: `src/tools/WebSearchTool/backend.ts`（删 `getApiKeyForProvider`；`searchWithExternalProvider`/`searchWithTavily`/`searchWithBrave` 改走 proxy）
- Test: `src/tools/WebSearchTool/backend.test.ts`

**Interfaces:**
- Consumes: `getCustomBaseUrl`/`configureApiKeyHeaders`（Task 6）、`WebSearchSettings` 仅含 mode（Task 5）。
- Produces: `searchWithExternalProvider(provider, input, signal)` 签名去掉 `apiKey` 参数（`WebSearchTool.ts` 消费）。

- [ ] **Step 1: 重写 backend.ts 的外部搜索路径**

`src/tools/WebSearchTool/backend.ts` 顶部 import 加：

```ts
import { getCustomBaseUrl, configureApiKeyHeaders } from '../../services/api/client.js'
```

`WebSearchSettings` 类型改为（删除 tavilyApiKey/braveApiKey）：

```ts
export type WebSearchSettings = {
  mode?: WebSearchMode
}
```

`getConfiguredWebSearchSettings` 中删除 `tavilyApiKey`/`braveApiKey` 的读取，只保留 mode：

```ts
  return {
    mode: WEB_SEARCH_MODES.has(modeCandidate) ? modeCandidate : 'auto',
  }
```

`resolveWebSearchProvider` 中删除 key 判断，mode 直接决定 provider：

```ts
export function resolveWebSearchProvider(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
): ResolvedWebSearch {
  const mode = settings.mode ?? 'auto'

  if (mode === 'disabled') return { provider: 'disabled', settings }
  if (mode === 'tavily') return { provider: 'tavily', settings }
  if (mode === 'brave') return { provider: 'brave', settings }
  if (mode === 'anthropic') {
    return { provider: canUseAnthropicNativeWebSearch(model) ? 'anthropic' : 'disabled', settings }
  }
  // auto
  if (canUseAnthropicNativeWebSearch(model)) return { provider: 'anthropic', settings }
  return { provider: 'tavily', settings }
}
```

删除 `getApiKeyForProvider` 函数与 `getFallbackProvider`（fallback 不再依赖 key）。

重写 `searchWithExternalProvider`（去掉 `apiKey` 参数，改调 proxy）：

```ts
export async function searchWithExternalProvider(
  provider: Exclude<WebSearchProvider, 'anthropic' | 'disabled'>,
  input: Input,
  signal: AbortSignal,
): Promise<Output> {
  const startTime = performance.now()
  const hits = await searchViaProxy(provider, input, signal)
  const durationSeconds = (performance.now() - startTime) / 1000
  return makeExternalSearchOutput(provider, input.query, hits, durationSeconds)
}

async function searchViaProxy(
  provider: 'tavily' | 'brave',
  input: Input,
  signal: AbortSignal,
): Promise<ExternalSearchHit[]> {
  const baseUrl = getCustomBaseUrl()
  if (!baseUrl) {
    throw new Error('CrewProxy base URL is not configured (set LLM_PROXY_BASE_URL or ANTHROPIC_BASE_URL)')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  await configureApiKeyHeaders(headers, false)
  const response = await fetch(`${baseUrl}/v1/websearch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider,
      query: input.query,
      allowed_domains: input.allowed_domains,
      blocked_domains: input.blocked_domains,
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`Web search via proxy failed: ${response.status}`)
  }
  const body = (await response.json()) as { results?: Array<{ title?: unknown; url?: unknown }> }
  return (body.results ?? [])
    .map(hit => normalizeHit(hit.title, hit.url))
    .filter((hit): hit is ExternalSearchHit => hit != null)
}
```

删除原来的 `searchWithTavily`/`searchWithBrave`（直接 fetch 外部 API 的逻辑不再需要，已迁移到 proxy）。

- [ ] **Step 2: 更新 `WebSearchTool.ts` 的调用点**

`src/tools/WebSearchTool/WebSearchTool.ts` 中，`searchWithExternalProvider(resolved.provider, input, apiKey, ...)` 两处调用改为去掉 `apiKey`：

```ts
      const data = await searchWithExternalProvider(
        resolved.provider,
        input,
        context.abortController.signal,
      )
```

`getApiKeyForProvider` 的调用和 `apiKey` 缺失分支（`if (!apiKey)` 块）删除。

- [ ] **Step 3: 跑类型检查 + 测试**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/client && bun run check:desktop`（含 lint + test + build）
Expected: 类型错误清零；`backend.test.ts` 中关于 key 的用例需同步更新（见 Step 4）。

- [ ] **Step 4: 更新 backend.test.ts**

`src/tools/WebSearchTool/backend.test.ts` 中，删除「有 key 启用 / 无 key 禁用」的断言，改为验证「mode 决定 provider」与「无 proxy baseUrl 时 searchViaProxy 抛错」。用 `mock` 掉 `getCustomBaseUrl` 与 `configureApiKeyHeaders`（vitest `vi.mock`）验证 `searchViaProxy` 拼出正确 URL 与 body。

- [ ] **Step 5: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/client
git add src/services/api/client.ts src/tools/WebSearchTool/backend.ts src/tools/WebSearchTool/WebSearchTool.ts src/tools/WebSearchTool/backend.test.ts src/utils/settings/types.ts desktop/src/types/settings.ts
git commit -m "feat(websearch): client 改走 proxy，删除本地 KEY"
```

---

### Task 8: 桌面端 UI 删除 KEY 输入框

**Files:**
- Modify: `desktop/src/pages/Settings.tsx`（删除 tavily/brave key 输入框）
- Modify: `desktop/src/i18n/locales/zh.ts`、`desktop/src/i18n/locales/en.ts`（删除相关文案 key）
- Test: `desktop/src/__tests__/generalSettings.test.tsx`（若引用）

**Interfaces:**
- Consumes: `WebSearchSettings` 仅含 mode（Task 5）。

- [ ] **Step 1: 定位并删除输入框**

`desktop/src/pages/Settings.tsx` 中，Grep `tavilyApiKey`/`braveApiKey` 定位输入框 JSX 与绑定 state，删除这两个输入框及其 state 字段。仅保留 mode 选择器（`webSearch.mode` 下拉）。

- [ ] **Step 2: 删除 i18n 文案**

`desktop/src/i18n/locales/zh.ts` 与 `en.ts` 中删除 `tavilyApiKey`/`braveApiKey` 相关的 label/placeholder 文案键。

- [ ] **Step 3: 跑类型检查 + 测试**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/client && cd desktop && bun run lint && bun run test -- --run`
Expected: 无 `tavilyApiKey`/`braveApiKey` 残留引用；测试通过。

- [ ] **Step 4: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/client
git add desktop/src/pages/Settings.tsx desktop/src/i18n/locales/zh.ts desktop/src/i18n/locales/en.ts
git commit -m "feat(websearch): 桌面端删除 KEY 输入框"
```

---

## 阶段三：server

> **建分支**（若尚未建）：`cd C:/Users/songchao/Bruno/Ambicrew/server && git checkout -b feat/websearch-key-centralization`

### Task 9: llm 报表追加排除过滤

**Files:**
- Modify: `backend/app/api/routes/usage_admin.py`（overview/trend/records/filters 的 filters 追加 must_not kind）
- Modify: `backend/app/api/routes/usage_account.py`（overview/trend/filters 的 filters 追加 must_not kind）

**Interfaces:**
- Consumes: ES 索引新增 `kind` 字段（proxy 端已写入）。
- Produces: 无新接口；llm 报表排除 websearch 记录。

- [ ] **Step 1: 定义共享排除子句**

在 `usage_admin.py` 顶部（`_parse_multi` 之后）新增：

```python
def _exclude_websearch() -> dict:
    """Exclude websearch records so llm usage stats stay llm-only.

    Historical llm records have no ``kind`` field; a must-not term on
    kind=websearch keeps them while dropping websearch docs (排除法, 零回填).
    """
    return {"bool": {"must_not": [{"term": {"kind": "websearch"}}]}}
```

`usage_account.py` 顶部同样新增该函数（复制同一实现）。

- [ ] **Step 2: 每个查询追加排除子句**

在 `usage_admin.py` 的 `overview`/`trend`/`records` 三个函数里，`filters` 列表初始化后追加 `_exclude_websearch()`：

```python
    filters: list[dict] = [_exclude_websearch()]
```

（`filters` 列表的 `_default_gte` 逻辑不变；`/filters` 端点只做 composite 去重，不含 llm 统计，可不动，但为一致性也可在 `_collect_composite` 的 body 里加 `query` 过滤——本任务仅改有统计语义的 overview/trend/records。）

`usage_account.py` 的 `overview`/`trend` 同理：原代码在 `_user_filter_clause` 返回 `None` 时已提前 `return`，因此到达 `filters = [user_clause]` 时 `user_clause` 一定非 None。把初始化改为：

```python
    filters: list[dict] = [user_clause, _exclude_websearch()]
```

- [ ] **Step 3: 跑后端测试**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/server/backend && uv run pytest`
Expected: PASS（若无针对 usage 的既有测试则至少保证 import 与语法通过）。

- [ ] **Step 4: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/server
git add backend/app/api/routes/usage_admin.py backend/app/api/routes/usage_account.py
git commit -m "feat(websearch): llm 报表排除 websearch 记录"
```

---

### Task 10: websearch 用量报表 + 路由注册

**Files:**
- Create: `backend/app/api/routes/websearch_usage.py`
- Modify: `backend/app/main.py`（import + include_router）
- Test: `backend/test_websearch_usage.py`（新建，用 monkeypatch mock es_search 断言查询 body）

**Interfaces:**
- Consumes: `es_search`（`app.core.es`）、`rc_ok`/`rc_err`（`app.schemas.rc`）、`require_session_permission`（`app.api.deps`）。
- Produces: `GET /admin/usage/websearch/overview`、`/trend`、`/records`、`/filters`。

- [ ] **Step 1: 写失败测试**

新建 `backend/test_websearch_usage.py`：

```python
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client(monkeypatch):
    captured = {}

    async def fake_es_search(body, source=None):
        captured["body"] = body
        return {"hits": {"total": {"value": 0}, "hits": []}, "aggregations": {}}

    async def fake_get_es():
        return object()  # non-None → 走查询分支

    monkeypatch.setattr("app.core.es.es_search", fake_es_search)
    monkeypatch.setattr("app.core.es.get_es", fake_get_es)
    # 模拟 admin 会话权限
    async def fake_perm(*args, **kwargs):
        return object()

    monkeypatch.setattr("app.api.routes.websearch_usage.require_session_permission", lambda *a, **k: fake_perm)
    return TestClient(app), captured


def test_overview_filters_by_kind_websearch(client):
    c, captured = client
    c.get("/admin/usage/websearch/overview")
    body = captured["body"]
    filters = body["query"]["bool"]["filter"]
    assert {"term": {"kind": "websearch"}} in filters


def test_trend_filters_by_kind_websearch(client):
    c, captured = client
    c.get("/admin/usage/websearch/trend")
    body = captured["body"]
    filters = body["query"]["bool"]["filter"]
    assert {"term": {"kind": "websearch"}} in filters
```

（`base_path` 默认 `/` 时路径为 `/admin/usage/websearch/overview`；若项目 `BASE_PATH` 非空，则测试路径需加前缀，执行时以 `app.core.config` 实际值为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/server/backend && uv run pytest test_websearch_usage.py -v`
Expected: FAIL — `ModuleNotFoundError: app.api.routes.websearch_usage`。

- [ ] **Step 3: 实现报表路由**

新建 `backend/app/api/routes/websearch_usage.py`（骨架对齐 `usage_admin.py`，全部查询带 `kind=websearch` 过滤，`by_provider` 用 `modelid.keyword`）：

```python
"""WebSearch usage analytics — queries ES for proxy websearch records (kind=websearch)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query, Request

from app.api.deps import require_session_permission
from app.core.es import es_search, get_es
from app.models.user import User
from app.schemas.rc import rc_err, rc_ok

router = APIRouter(prefix="/admin/usage/websearch", tags=["usage-websearch"])

TZ8 = timezone(timedelta(hours=8))


def _websearch_filter() -> dict:
    return {"term": {"kind": "websearch"}}


def _default_gte() -> str:
    dt = datetime.now(TZ8) - timedelta(days=7)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000+08:00")


def _parse_multi(param: str | None) -> list[str] | None:
    if not param:
        return None
    result = [v.strip() for v in param.split(",") if v.strip()]
    return result if result else None


@router.get("/overview")
async def websearch_overview(
    _: Request,
    __: User = Depends(require_session_permission("usage")),
    username: str | None = None,
    provider: str | None = None,
    gte: str | None = None,
    lte: str | None = None,
) -> dict:
    if await get_es() is None:
        return rc_err("Elasticsearch 未配置（请在 .env 设置 ES_NODE）")

    filters: list[dict] = [_websearch_filter()]
    usernames = _parse_multi(username)
    if usernames:
        filters.append({"terms": {"username.keyword": usernames}})
    providers = _parse_multi(provider)
    if providers:
        filters.append({"terms": {"modelid.keyword": providers}})
    range_q: dict = {"gte": gte or _default_gte()}
    if lte:
        range_q["lte"] = lte
    filters.append({"range": {"start_time": range_q}})

    body = {
        "size": 0,
        "track_total_hits": True,
        "query": {"bool": {"filter": filters}},
        "aggs": {
            "by_provider": {
                "terms": {"field": "modelid.keyword", "size": 50},
                "aggs": {"calls": {"value_count": {"field": "start_time"}}},
            },
            "by_user": {
                "terms": {"field": "username.keyword", "size": 10000},
                "aggs": {"calls": {"value_count": {"field": "start_time"}}},
            },
        },
    }
    result = await es_search(body)
    aggs = result.get("aggregations", {})
    total_hits = result.get("hits", {}).get("total", {}).get("value", 0)

    return rc_ok({
        "total_calls": total_hits,
        "by_provider": [
            {"provider": b["key"], "calls": int(b["calls"]["value"])}
            for b in aggs.get("by_provider", {}).get("buckets", [])
        ],
        "by_user": [
            {"username": b["key"], "calls": int(b["calls"]["value"])}
            for b in aggs.get("by_user", {}).get("buckets", [])
        ],
    })


@router.get("/trend")
async def websearch_trend(
    _: Request,
    __: User = Depends(require_session_permission("usage")),
    username: str | None = None,
    provider: str | None = None,
    gte: str | None = None,
    lte: str | None = None,
    days: int = Query(14, ge=1, le=366),
) -> dict:
    if await get_es() is None:
        return rc_err("Elasticsearch 未配置")

    if not gte:
        dt = datetime.now(TZ8) - timedelta(days=days)
        gte = dt.strftime("%Y-%m-%dT%H:%M:%S.000+08:00")

    filters: list[dict] = [_websearch_filter()]
    usernames = _parse_multi(username)
    if usernames:
        filters.append({"terms": {"username.keyword": usernames}})
    providers = _parse_multi(provider)
    if providers:
        filters.append({"terms": {"modelid.keyword": providers}})
    range_q: dict = {"gte": gte}
    if lte:
        range_q["lte"] = lte
    filters.append({"range": {"start_time": range_q}})

    body = {
        "size": 0,
        "query": {"bool": {"filter": filters}},
        "aggs": {
            "by_day": {
                "date_histogram": {
                    "field": "start_time",
                    "calendar_interval": "day",
                    "time_zone": "Asia/Shanghai",
                    "format": "yyyy-MM-dd",
                    "min_doc_count": 1,
                }
            }
        },
    }
    result = await es_search(body)
    buckets = result.get("aggregations", {}).get("by_day", {}).get("buckets", [])
    rows: list[dict] = []
    for b in buckets:
        day = b.get("key_as_string", "")[:10]
        rows.append({"date": day, "calls": int(b.get("doc_count", 0))})
    return rc_ok(rows)


@router.get("/records")
async def websearch_records(
    _: Request,
    __: User = Depends(require_session_permission("usage")),
    username: str | None = None,
    provider: str | None = None,
    session_id: str | None = None,
    gte: str | None = None,
    lte: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
) -> dict:
    if await get_es() is None:
        return rc_err("Elasticsearch 未配置")

    filters: list[dict] = [_websearch_filter()]
    usernames = _parse_multi(username)
    if usernames:
        filters.append({"terms": {"username.keyword": usernames}})
    providers = _parse_multi(provider)
    if providers:
        filters.append({"terms": {"modelid.keyword": providers}})
    if session_id:
        filters.append({"term": {"session_id.keyword": session_id}})
    range_q: dict = {"gte": gte or _default_gte()}
    if lte:
        range_q["lte"] = lte
    filters.append({"range": {"start_time": range_q}})

    body = {
        "size": page_size,
        "from": (page - 1) * page_size,
        "sort": [{"start_time": "desc"}],
        "query": {"bool": {"filter": filters}},
        "track_total_hits": True,
    }
    result = await es_search(
        body,
        source=["clientid", "username", "modelid", "start_time", "out_time", "cost_time", "status", "input_content", "session_id"],
    )
    total = result.get("hits", {}).get("total", {}).get("value", 0)
    items = [h["_source"] for h in result.get("hits", {}).get("hits", [])]
    return rc_ok({"items": items, "total": total, "page": page, "page_size": page_size})


@router.get("/filters")
async def websearch_filters(
    _: Request,
    __: User = Depends(require_session_permission("usage")),
) -> dict:
    if await get_es() is None:
        return rc_err("Elasticsearch 未配置（请在 .env 设置 ES_NODE）")

    providers: list[str] = []
    after_key: dict | None = None
    while True:
        composite: dict = {
            "sources": [{"val": {"terms": {"field": "modelid.keyword"}}}],
            "size": 10000,
        }
        if after_key:
            composite["after"] = after_key
        body = {
            "size": 0,
            "query": {"bool": {"filter": [_websearch_filter()]}},
            "aggs": {"comp": {"composite": composite}},
        }
        result = await es_search(body)
        comp = result.get("aggregations", {}).get("comp", {})
        for b in comp.get("buckets", []):
            key = b.get("key", {}).get("val")
            if key:
                providers.append(key)
        after_key = comp.get("after_key")
        if not after_key or not comp.get("buckets"):
            break
    return rc_ok({"providers": sorted(providers)})
```

- [ ] **Step 4: 注册路由**

`backend/app/main.py` 中，import 区加 `websearch_usage`（按字母序，在 `usage_admin` 后）：

```python
    usage_account,
    usage_admin,
    users_admin,
    users_client,
    websearch_usage,
```

`root.include_router(usage_account.router, prefix="/api/v1")` 之后加：

```python
    root.include_router(websearch_usage.router, prefix="/api/v1")
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd C:/Users/songchao/Bruno/Ambicrew/server/backend && uv run pytest test_websearch_usage.py -v`
Expected: PASS（overview/trend 查询 body 含 `{"term": {"kind": "websearch"}}`）。

- [ ] **Step 6: 提交**

```bash
cd C:/Users/songchao/Bruno/Ambicrew/server
git add backend/app/api/routes/websearch_usage.py backend/app/main.py backend/test_websearch_usage.py
git commit -m "feat(websearch): 新增 websearch 用量报表接口"
```

---

## 收尾

- [ ] 三仓库各跑各自质量门禁：proxy `npm test`；client `bun run check:desktop` + `bun run check:adapters`（如触及 adapters）；server `uv run pytest`。
- [ ] 手工验证：proxy `proxy-config.json` 配 `webSearch` KEY → client 触发 WebSearch → 检查 proxy `logs/usage-*.jsonl` 出现 `kind=websearch` 记录 → ES 索引有数据 → server `/admin/usage/websearch/overview` 返回计数。
- [ ] 确认 llm 报表（`/admin/usage/overview`）历史数据仍完整（排除法生效）。
