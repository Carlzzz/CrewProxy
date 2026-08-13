# WebSearch 本地测试指南

验证 `client → proxy → WebSearch 后端 → 结果 → usage 落盘 → server 报表` 整条链路。按 Level 由简到繁。

## 前置条件

- 一个真实的 WebSearch API key（博查 `sk-xxx`，或 Tavily / Brave）
- Node ≥ 18，proxy 依赖已装（`npm install`）
- 已 `npm run build` 编译 proxy

---

## Level 1：proxy 单独验证（最快，先做）

### 1.1 配置 webSearch

编辑 `proxy/proxy-config.json`，在顶层加 `webSearch` 段：

```jsonc
{
  "port": 3456,
  // ... 其余配置保持不变 ...
  "webSearch": {
    "bochaApiKey": "sk-你的博查key"
    // 可选：还支持 tavilyApiKey / braveApiKey
  }
}
```

保存后约 300ms 热更新生效，**无需重启**。

### 1.2 启动 proxy（本地免认证模式）

```bash
cd proxy
npm run build
WOICLAW_AUTH_BYPASS=1 node dist/index.js
```

就绪标志：`curl http://127.0.0.1:3456/healthz` 返回 `{"ok":true}`。

### 1.3 curl 测转发

```bash
# 不传 provider —— auto 按 tavily→brave→bocha 顺序选第一个配了 key 的
curl -s -X POST http://127.0.0.1:3456/v1/websearch \
  -H "x-api-key: test" -H "Content-Type: application/json" \
  -d '{"query": "Claude Code release"}' --max-time 30

# 显式指定 provider
curl -s -X POST http://127.0.0.1:3456/v1/websearch \
  -H "x-api-key: test" -H "Content-Type: application/json" \
  -d '{"query": "Claude Code release", "provider": "bocha"}' --max-time 30
```

预期返回：`{"provider":"bocha","results":[{"title":"...","url":"..."}]}`

### 1.4 边界情况（均应返回 400）

```bash
# 显式传未配置的 provider
curl -s -X POST ... -d '{"query":"test","provider":"brave"}'
# null body
curl -s -X POST ... -d 'null'
# 缺 query
curl -s -X POST ... -d '{}'
```

### 1.5 验证 usage 落盘

```bash
tail -1 logs/usage-$(date +%F).jsonl
```

预期该行含：`"kind":"websearch"`、`"modelid":"bocha"`、`"input_content":"<搜索词>"`、`"status":200`、`input_token`/`output_token` 为 0。

> 到这一步，proxy 的「转发 + usage 落盘」核心链路已验证。

---

## Level 2：client 联调

前提：proxy 的 `defaultUpstream` / `upstreamsById` 已配好可用的 LLM 上游（client 的 agent 靠 LLM 驱动触发 WebSearch）。

### 2.1 启动 client（指向本地 proxy）

```bash
cd client
LLM_PROXY_BASE_URL=http://127.0.0.1:3456 \
LLM_PROXY_API_KEY=test \
bun run ./bin/ambi
```

进去后让 AI 联网搜索（如「帮我搜索一下 XXX」）。非 Claude 模型 + `webSearch.mode` 默认 `auto` 会触发 WebSearch，请求打到本地 proxy。

### 2.2 验证

回 proxy 看新增记录：

```bash
cd proxy && grep '"kind":"websearch"' logs/usage-$(date +%F).jsonl | tail -3
```

---

## Level 3：server 报表（需要 Elasticsearch）

报表读 ES，需要额外的 ES 实例 + usage 同步。

### 3.1 同步 usage 到 ES

```bash
cd proxy
WOICLAW_ES_NODE=http://localhost:9200 \
WOICLAW_ES_INDEX=woicrew-usage \
RUN_ONCE=1 npm run sync-usage
```

### 3.2 启动 server 并查报表

```bash
cd server/backend
uv run uvicorn app.main:app --port 8000
# 登录拿到 admin session 后：
curl http://127.0.0.1:8000/admin/usage/websearch/overview
```

`/admin/usage/websearch/*` 需要 `usage` 权限的 admin session；若配了 `base_path`（如 `/woicrew`）需加前缀。

---

## 常见排查

- **401**：proxy 未开 `WOICLAW_AUTH_BYPASS` 或 token 不匹配；本地测试用 bypass。
- **400 provider not configured**：`proxy-config.json` 的 `webSearch` 没配对应 provider 的 key。
- **502**：proxy 转发上游失败（key 无效 / 网络不通 / 上游超时 15s）。
- **usage 无记录**：确认在 `logs/` 目录看当天的 `usage-YYYY-MM-DD.jsonl`。
