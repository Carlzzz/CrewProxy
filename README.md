# WoiClaw Proxy

Standalone Anthropic-to-OpenAI format proxy for WoiClaw / LobsterAI.

Accepts Anthropic Messages API requests (`POST /v1/messages`) and transparently
converts them to OpenAI Chat Completions (or Responses) API calls, then streams
the response back in Anthropic SSE format. Upstream is selected by the request
body’s `model` field: use `upstreamId|modelId` to pick an upstream from
`upstreamsById`, or omit the prefix to use `defaultUpstream`. Client id
(x-api-key or Bearer) is required. After extracting the token, the proxy calls an **external auth service** to resolve user info; if auth fails, the request is rejected with 401 and the model is not called. The resolved **username** is written into usage logs.

## Quick Start

```bash
# Install dependencies (none required beyond Node.js ≥ 18)
npm install

# Build
npm run build

# Copy and edit the example config
cp proxy-config.example.json proxy-config.json

# （可选）复制 .env.example 为 .env，配置外部认证等环境变量
cp .env.example .env

# Start
npm start
```

## Configuration

### Config file (`proxy-config.json`)

```jsonc
{
  "port": 3456,
  "host": "0.0.0.0",

  // Used when request model has no "upstreamId|" prefix
  "defaultUpstream": {
    "baseURL": "https://api.openai.com",
    "apiKey": "sk-...",
    "model": "gpt-4o",
    "provider": "openai"       // openai | gemini | deepseek | minimax | ollama | ...
  },

  // upstreamId -> upstream; request model "upstreamId|modelId" selects upstream and sends modelId
  "upstreamsById": {
    "deepseek": { "baseURL": "https://api.deepseek.com", "apiKey": "sk-...", "model": "deepseek-chat", "provider": "deepseek" },
    "ali": { "baseURL": "https://dashscope.aliyuncs.com/...", "apiKey": "...", "model": "qwen-plus", "provider": "openai" }
  }
}
```

Config search order:
1. CLI argument: `node dist/index.js /path/to/config.json`
2. Environment variable: `WOICLAW_PROXY_CONFIG`
3. `./proxy-config.json` in the working directory

保存 `proxy-config.json` 后约 **300ms** 内会重新加载（防抖）；解析失败则保留上一版有效配置。

### 外部认证（External auth）

拿到请求头中的 `x-api-key` 或 `Authorization: Bearer <token>` 后，代理会请求**外部认证服务**获取用户信息；认证失败则返回 401，**不转发模型请求**。认证成功后将返回的 **username** 写入 usage 日志。

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `WOICLAW_AUTH_HOST` | 外部认证服务 base URL（末尾勿加 `/`） | `http://10.192.9.103:8088` |
| `WOICLAW_AUTH_USER_PATH` | 按设备查用户信息的路径（与 base 拼接，请求时追加 `?deviceId=<token>`） | `/woicrew/api/user-by-device` |

以上环境变量可在 **`.env`** 中配置（项目启动时会自动加载根目录 `.env`）；也可在系统环境或启动前 `export`/`set`。

认证请求：`GET {WOICLAW_AUTH_HOST}{WOICLAW_AUTH_USER_PATH}?deviceId=<客户端传入的 token>`（无需 Authorization 头；token 即设备 ID / device_uuid）。  
成功响应：HTTP 200，JSON 体 `{ "rc": 0, "data": { "name", "mainAccount", "Phone", "userId" } }`，代理取 `data.name` 作为用户名写入 usage。  
失败：404（设备未绑定）、401（设备 token 过期）、500 等均视为认证失败，返回 401，不转发模型请求。

### `provider` 配置说明

每个上游（`defaultUpstream` 或 `upstreamsById` 中的一项）可配置可选字段 **`provider`**。  
`provider` 不参与路由（路由只看请求里的 `model` 和 `upstreamsById`），只用于**请求转换和接口形态**，同一套代理逻辑要适配不同厂商的 API 差异。

| 作用 | 说明 |
|------|------|
| **1. 选择上游 API 形态** | `provider === 'openai'` 时，代理使用 **OpenAI Responses API**（请求 `/v1/responses`，流式按 `response.created` / `response.output_text.delta` 等解析）。**其他任意值**（如 `ark`、`dashscope`、`minimax`、留空）均使用 **OpenAI Chat Completions API**（请求 `/v1/chat/completions`，流式按 `data: {"choices":[{"delta":...}]}` 解析）。若上游实际只支持 Chat Completions（如阿里 DashScope compatible-mode），应把 `provider` 设为非 `openai`（如 `dashscope`），否则会出现“上游 200 但客户端报错”等解析问题。 |
| **2. 工具（tools）过滤** | 仅当 `provider === 'openai'` 时：会过滤掉名为 `skill` 的 tool，并把 `tool_choice` 里对 `skill` 的强制选择改为 `auto`，避免发给非 OpenAI 兼容的上游。 |
| **3. 角色重写（MiniMax）** | 仅当 `provider === 'minimax'` 时：把消息里的 `role: 'developer'` 改为 `role: 'system'`，因为 MiniMax 只认 `system` / `user` / `assistant`。 |
| **4. max_tokens 字段（OpenAI 新模型）** | 仅当 `provider === 'openai'` 且请求的 model 为 gpt-5 / o1 / o3 / o4 等时：把请求体中的 `max_tokens` 改为 `max_completion_tokens` 并删掉 `max_tokens`，以符合 OpenAI 新 API 要求。 |
| **5. 多 system 合并** | 使用 **Chat Completions** 时（即 `provider !== 'openai'`）：会把多条 `role: system` 的消息合并成一条，避免部分上游不支持多 system。 |
| **6. Tool call 补全（Gemini）** | 当 `provider === 'gemini'` 或 `baseURL` 包含 `generativelanguage.googleapis.com` 时：会为没有 `extra_content` 的 tool_calls 补上 Gemini 所需的 `thought_signature` 占位，避免请求被拒。 |

**常见取值建议**（按实际上游选择，不区分大小写）：

- **`openai`**：真正走 OpenAI Responses API 且上游流式格式为该形态时使用。
- **`dashscope`** / **`ali`**：阿里 DashScope compatible-mode（流式是 Chat Completions 格式，不要用 `openai`）。
- **`ark`**：字节方舟等走 Chat Completions 的上游。
- **`minimax`**：MiniMax，会启用角色重写。
- **`gemini`**：Google Gemini，会启用 tool call 补全。
- **`deepseek`** / **`ollama`** 等：仅影响“是否用 Responses API”；其余用 Chat Completions + 多 system 合并。

不填或留空时，一律按 **Chat Completions** 处理（即与除 `openai` 外的其他 provider 行为一致）。

### Input/Output Token 用量记录机制

代理会把每次调用的 **input_token / output_token** 及请求/响应信息写入按天的 **JSON Lines** 文件：`logs/usage-YYYY-MM-DD.jsonl`（每行一个 JSON 对象，无逗号/引号错列问题）。  
用量**完全来自上游响应**，代理只做透传与落盘，不自己算 token。

| 请求类型 | 用量从哪里来 | 何时写一条记录 |
|----------|----------------|----------------|
| **流式（stream=true）** | **Chat Completions**：上游某条 SSE 里带 `usage`（常见是带 `finish_reason` 的那条），字段为 `prompt_tokens` / `completion_tokens`，代理读到后写入 `state.lastUsage`。<br>**Responses API**：上游在 `response.completed` 事件里带 `usage`（`input_tokens`/`output_tokens` 或 `prompt_tokens`/`completion_tokens`），代理解析后写入 `state.lastUsage`。 | 流结束后**必定写一行**：有 `state.lastUsage` 则用其值，否则写 `input_token=0, output_token=0`（表示上游未在流里返回用量）。 |
| **非流式（stream=false）** | 上游 JSON 响应里的 `usage`（或转换后的 Anthropic 格式里的 `usage`），取 `input_tokens` / `output_tokens`。 | 每次非流式响应都会写一行（含 usage 或 0）。 |

JSONL 每行字段：`app`, `clientid`, `username`, `modelid`, `input_token`, `output_token`, `input_cached_token`, `start_time`, `out_time`, `cost_time`, `request_size`, `response_size`, `stream`, `input_content`, `output_content`, **`session_id`**（请求头 `X-WoiCrew-Session-Id`；无或空时为 JSON `null`）、**`routing_key`**（`upstreamsById` 的路由 key，走 `defaultUpstream` 时为 `__default__`）、`input_fulltext`（可选）。（结束时间仅用 `out_time`，与 `start_time` 成对。）  
- **按天滚动**：文件名 `usage-YYYY-MM-DD.jsonl`，次日自动新文件。  
- **按大小滚动**：当日单文件超过上限时自动切到 `usage-YYYY-MM-DD-2.jsonl`、`usage-YYYY-MM-DD-3.jsonl`…。  
- 环境变量：`WOICLAW_LOG_DIR` 指定目录（默认 `./logs`）；`WOICLAW_USAGE_LOG_MAX_BYTES` 指定单文件最大字节数（默认 100MB，最小 1MB）。  
- **精简 proxy 文本日志**：默认只写启动摘要、告警与错误；需要逐请求/认证/上游等详情时设置 **`WOICLAW_PROXY_VERBOSE=1`**（或 `true`）。
- 每条记录包含 **username**（来自外部认证服务返回的用户名）。

**要点**：  
- 流式：**每次请求都会记一条**；上游没给用量时记为 0。  
- 非流式：每次响应记一条。  
- 数值完全依赖上游；若上游不返回或格式不对，记录里会是 0。  
- 使用 **JSON Lines** 格式，逗号、换行、引号不会导致列错位。  
- 每条记录包含 **app** 字段（如 `woiclaw`），便于多应用共用同一 proxy 时区分。

### Usage 同步到 Elasticsearch（方案 A）

可将 `logs/usage-*.jsonl` **增量同步到 Elasticsearch**，供统计与审计。  
Compose 中提供 **usage-sync** 服务：与 proxy 同镜像、独立容器，每 **10 分钟**读取自上次断点后的新行并 bulk 写入 ES。

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `ELASTIC_HOST` | ES 主机（与 `ELASTIC_PORT` 拼成节点地址） | - |
| `ELASTIC_PORT` | ES 端口 | `9200` |
| `ELASTIC_USER` | ES 用户名（Basic 认证） | - |
| `ELASTIC_PASSWORD` | ES 密码 | - |
| `ES_INDEX` | 写入的索引名 | `woi-llm-usage-logs` |
| `ELASTICSEARCH_URL` | 可选，直接指定节点地址（覆盖 HOST+PORT） | - |
| `ES_API_KEY` | 可选，ES API Key 认证（与 Basic 二选一） | - |
| `USAGE_SYNC_STATE_DIR` | 断点状态文件目录 | `/app/data`（容器内） |
| `USAGE_SYNC_BULK_REFRESH` | 设为 `1` 或 `true` 时 bulk 后 `refresh`，便于立刻在 Kibana 搜到 | 默认关闭 |

同步脚本会打印 **ES 节点、索引、日志目录、每批 bulk 成功/失败数**；若存在 **bulk 项级失败**，会打出前几条错误详情且 **不更新断点**，避免「日志显示已索引但 ES 无数据」仍推进 state。

在 **`.env`** 中配置示例（与 usage-sync 服务共用）：

```bash
ELASTIC_HOST=10.192.9.103
ELASTIC_PORT=9200
ELASTIC_USER=elastic
ELASTIC_PASSWORD=changeme
ES_INDEX=woi-llm-usage-logs
```

**本地测试同步**（不启动 Docker，直接跑一次）：

1. 在项目根目录确保 **`.env`** 已配置上述 ES 变量（或本机可访问的 ES 地址）。
2. 确保 **`logs/`** 下已有 usage 日志，例如 `logs/usage-2026-03-17.jsonl`（可先跑几次 proxy 产生几条请求，或手动放一条合法 JSON 行做测试）。
3. 编译并执行**一次**同步后退出：
   ```bash
   npm run build
   RUN_ONCE=1 npm run sync-usage
   ```
   Windows CMD：`set RUN_ONCE=1 && npm run sync-usage`  
   Windows PowerShell：`$env:RUN_ONCE="1"; npm run sync-usage`
4. 控制台会输出本次同步条数；断点会写入 **`data/usage-sync-state.json`**。在 Kibana 或 `curl` 查索引 `woi-llm-usage-logs` 可确认是否写入成功。
5. 若需常驻、每 10 分钟同步一次：直接 `npm run sync-usage`（不设 `RUN_ONCE`）。

- 断点状态保存在 **data/usage-sync-state.json**（宿主机 `./data` 挂载到容器的 `/app/data`），重启后从断点继续。  
- 索引设计、字段说明与可选 mapping 见 [docs/es-usage-index.md](docs/es-usage-index.md)。  
- 若不需要同步，可不启动 `usage-sync` 服务（例如 `docker compose up -d woiclaw-proxy`）。

### Environment-variable mode (single upstream)

If no config file is found, the proxy falls back to environment variables:

```bash
UPSTREAM_BASE_URL=https://api.openai.com \
UPSTREAM_API_KEY=sk-... \
UPSTREAM_MODEL=gpt-4o \
UPSTREAM_PROVIDER=openai \
PORT=3456 \
node dist/index.js
```

### 容器部署（Docker）

有 `.env` 后容器部署**行为不变**：应用始终从 `process.env` 读配置，本地开发时 dotenv 会从工作目录的 `.env` 加载；容器内通常**不**把 `.env` 打进镜像，而是通过运行时注入环境变量。

- **Dockerfile**：无需修改，当前多阶段构建即可。镜像内不包含 `.env`（也不建议把敏感配置写进镜像）。
- **环境变量注入方式**：
  - **docker run**：`docker run -e WOICLAW_AUTH_HOST=http://... -e WOICLAW_AUTH_USER_PATH=/woicrew/api/user-by-device ...`
  - **Docker Compose**：在 `environment:` 里逐项写，或使用 `env_file: [.env]`（在宿主机存在 `.env` 时，compose 会把这些变量注入容器）。
- 若使用 `env_file: .env`，请保证宿主机在 `docker-compose up` 前已存在 `.env`，否则 compose 会报错；也可只在 `environment:` 里写需要的变量，不依赖 `.env` 文件。

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Main proxy endpoint (Anthropic Messages API format) |
| `POST` | `/v1/messages/count_tokens` | Stub — returns `{ input_tokens: 0 }` |
| `POST` | `/api/event_logging/batch` | Stub — returns `204` |
| `GET`  | `/healthz` | Health check |

## Usage with LobsterAI

In LobsterAI settings, set the **Base URL** to `http://<proxy-host>:3456` and
send any non-empty client id via **x-api-key** or **Authorization: Bearer**.
The proxy will call the external auth service with this token; if auth fails, the request is rejected with 401. Set the model in the request to
e.g. `deepseek|deepseek-chat` or leave unset to use `defaultUpstream`.

### How upstream is chosen

- **`model` is `upstreamId|modelId`** (e.g. `deepseek|deepseek-chat`): the proxy
  looks up `upstreamId` in `upstreamsById` and uses that upstream; the value
  sent to the upstream is `modelId`. If `upstreamId` is unknown, the proxy
  falls back to `defaultUpstream` and still sends `modelId`.
- **`model` is missing or has no `|`**: the proxy uses `defaultUpstream` and the
  request’s model (or the default upstream’s model).

You must configure **`defaultUpstream`** so that requests without a prefix, or
with an unknown `upstreamId`, can be served.

## Provider Support

| Provider | `provider` value | API Type |
|----------|-----------------|----------|
| OpenAI   | `openai`        | Responses API |
| Gemini   | `gemini`        | Chat Completions (via OpenAI compat) |
| DeepSeek | `deepseek`      | Chat Completions |
| MiniMax  | `minimax`       | Chat Completions |
| Ollama   | `ollama`        | Chat Completions |
| Others   | (any string)    | Chat Completions |

## Architecture

```
LobsterAI App ──(Anthropic API)──▶ WoiClaw Proxy ──(OpenAI API)──▶ Upstream LLM
                                        │
                                  route by API key
                                  convert format
                                  handle retries
```

The proxy is a single-process Node.js HTTP server. For horizontal scaling,
deploy behind an ADC / load balancer with sticky sessions disabled (the proxy
is stateless per-request; tool-call extra-content cache is per-instance but
optional).

## Monitoring: GET /metrics

Returns real-time gateway metrics (call stats, pool cooldowns, GLM/MiniMax quota) as JSON.
Auth: same as `/models` (x-api-key or Authorization: Bearer). Intended for the CrewCentral
monitoring dashboard. Optional per-upstream `quotaLimits` in proxy-config.json renders
absolute token usage (e.g. GLM 1.6亿/5h).

Top-level fields:

| Field | Description |
|-------|-------------|
| `ts` | Unix ms timestamp of this snapshot. |
| `gatewayOnline` | Always `true` while the process is serving. |
| `totals` | Aggregated call counts across all upstreams for `last1m` / `last5m` / `last1h` (`count`, `success`, `fail`, `successRate`, `inputTokens`, `outputTokens`, `avgCostMs`). |
| `activeProviders` / `downProviders` | Number of upstreams not in / in full-cooldown state. |
| `providers` | Per-upstream object: `upstreamId`, `provider`, `model`, `health` (`healthy` / `degraded` / `down`), `stats` (same window shape as `totals`), and `credentials[]`. |

Each entry in `credentials[]`:

| Field | Description |
|-------|-------------|
| `id` | Credential id from `codePlanCredentials`. |
| `inCooldown` / `cooldownUntil` / `cooldownReason` | Current cooldown state from the code-plan pool. |
| `inFlight` | Active in-flight requests for this credential. |
| `requestsLast1h` | Requests seen in the last hour. |
| `quota` | Quota snapshot when `quotaStatus === 'ok'`, else `null`. For GLM contains `fiveHour` (with `limitTokens` from `quotaLimits.fiveHourTokens` if set); for MiniMax contains `weekly`. |
| `quotaStatus` | `ok` (real quota returned) · `expired` (key rejected) · `error` (network/API issue) · `not_configured` (no fetcher for this provider). |

Example:

```bash
curl -s -H "x-api-key: $KEY" http://127.0.0.1:3456/metrics | jq '.totals.last5m, .providers[] | {upstreamId, health, quotaStatus: .credentials[].quotaStatus}'
```

To opt a GLM/MiniMax upstream into absolute-token display, add `quotaLimits` next to
`baseURL` / `apiKey` / `codePlanCredentials`:

```jsonc
"glm": {
  "baseURL": "https://open.bigmodel.cn/api/anthropic",
  "apiKey": "",
  "model": "glm-5.2",
  "provider": "glm",
  "codePlanCredentials": [ /* ... */ ],
  "quotaLimits": { "fiveHourTokens": 160000000 }   // optional: surfaces quota.fiveHour.limitTokens
}
```
