# 网关监控大屏 — 实现原理与亮点

> 跨 `CrewProxy`（采集 + 配额）与 `CrewCentral`（代理 + 大屏）两个仓库。2026-07-07 落地。
> 设计文档：`CrewCentral/docs/superpowers/specs/2026-07-07-gateway-monitoring-dashboard-design.md` + `CrewProxy/docs/superpowers/specs/2026-07-07-glm-estimated-quota-design.md`

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│ CrewCentral 前端 (React + echarts)                               │
│  /admin/gateway (带导航)  ·  /dashboard/gateway (全屏投屏)        │
│  6 模块 · 3s 轮询 · 隐藏 tab 暂停                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ GET /api/v1/admin/gateway/metrics
┌──────────────────────────▼──────────────────────────────────────┐
│ CrewCentral 后端 (FastAPI)                                       │
│  gateway_admin.py → httpx 转发，Bearer crew_proxy_api_key       │
│  require_session_permission("gateway") 守卫                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ GET http://localhost:3456/metrics
┌──────────────────────────▼──────────────────────────────────────┐
│ CrewProxy (Node/TS, :3456)                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ /metrics    │←─│MetricsCollector│  │ QuotaFetcher (60s)      │ │
│  │ 一站式返回  │  │ 实时调用统计   │  │  ├ fetch: GLM/MiniMax 官方│ │
│  └─────────────┘  └──────────────┘  │  └ estimated: 自统计     │ │
│         ↑复用            ↑埋点       │ TokenUsageTracker(5h/7d) │ │
│         CodePlanPool(冷却/inFlight) └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**三层职责**：采集与配额查询都在 CrewProxy（**API key 不出网关**）；CrewCentral 后端只做鉴权转发；前端只做展示。

---

## 二、数据流

1. CrewProxy 主路径每个请求出口 → `recordMetric` 闭包 → `MetricsCollector.record()`（实时统计）+ `TokenUsageTracker.record()`（长窗口 token）
2. `QuotaFetcher` 每 60s 周期：fetch 模式调官方接口 / estimated 模式读 TokenUsageTracker → 缓存 snapshot
3. `GET /metrics` → `buildMetricsPayload(ctx)` 合并三块（实时统计 + 池子冷却 + 配额）+ 算 health → JSON
4. CrewCentral 后端 `httpx` 透传（`rc_ok(resp.json())`，不改 payload）
5. 前端 3s `getJson` → echarts `setOption` 增量更新

---

## 三、CrewProxy 采集层

### 3.1 MetricsCollector（实时调用统计）
- **10s 时间桶**，每维度保留 360 桶（=1h），内存可控（6 provider × 360 桶 ≈ 几十 KB）
- 双维度：per-upstream（provider 卡 / totals / 趋势）+ per-credential（池子条形图）
- 每桶记 `count / success / fail / inputTokens / outputTokens / costMsSum`
- **成功和失败都记**（修复了"失败请求不写 usage 日志 → 成功率算不出"的老盲区）
- `record()` try/catch 包裹，**绝不影响代理热路径**
- `aggregate(windowSec)` / `aggregateByCredential(windowSec)` 按窗口聚合

### 3.2 QuotaFetcher（配额查询）
- 每 60s 周期，per-credential 缓存 snapshot
- **fetch 模式**（默认）：调官方接口
  - GLM：`open.bigmodel.cn/api/monitor/usage/quota/limit`，**裸 key**（无 Bearer）
  - MiniMax：`api.minimaxi.com/v1/api/openplatform/coding_plan/remains`，`Bearer key`
  - 15s 超时；401/403 → `expired`；业务错误 → `error`；成功 → 解析 `usedPct` + `resetsAt`
  - **瞬时失败保留上次成功 tiers**（spec §8：配额卡不闪烁）
- 解析逻辑**翻译自 `cc-switch/src-tauri/src/services/coding_plan.rs`**（已验证的 Rust 实现 + 30 单测）
- per-credential 失败隔离（一个坏 key 不阻塞批次）

### 3.3 TokenUsageTracker（预估模式专用）
- per-upstream 累加 token（input+output）
- **两个滚动窗口**：5h（1min 桶 × 300）+ 7 天（1h 桶 × 168）
- 纯内存，重启归零（标注"自启动以来"）
- `record()` try/catch，不抛入热路径

### 3.4 主路径埋点
- `handleRequest` 的 `recordMetric` 闭包，在**所有出口**调用（5 个 handleRequest 出口 + 2 个 stream 出口）
- 闭包读 `usageExtra.routing_key`（最终命中的 credential），调用时才取值 → 所有出口看到正确 credential
- `ctx.tokenUsage?.record()` + `ctx.metrics?.record()` 可选链，未注入也安全

### 3.5 /metrics 端点
- 鉴权**对齐 `/models`**（`extractClientApiKey` + `authenticateRequest`），不学 `/pool-status` 裸奔
- `buildMetricsPayload` 组装：
  - `totals`（1m/5m/1h 全局聚合）
  - `providers[]`（health + stats + credentials）
  - `quotaLimits` 把 `usedPct` 还原绝对值（如 56M/160M）
- **health 分级**：`down`=全池冷却；`degraded`=部分冷却或 5min 成功率 <90%；否则 `healthy`

---

## 四、配额双模式（亮点）

| 模式 | 触发 | 数据来源 | 适用 |
|---|---|---|---|
| `fetch`（默认） | 不配 / `quotaMode:"fetch"` | 官方 API 实时查询 | 个人版 coding plan（MiniMax / GLM 个人版） |
| `estimated` | `quotaMode:"estimated"` | 网关自统计 token ÷ 已知总量 | **GLM 团队版**（官方接口查不到） |

**estimated 解决的问题**：GLM 团队版 key 调个人版接口返回「当前用户不存在coding plan」。改为网关自己统计 token 用量（5h/7d 滚动窗口），按已知套餐总量（5h 1.6亿、周 8亿）算 `usedPct`。
- `/metrics` 返回 `quota.estimated:true` + `resetsAt:null`
- 前端配额卡显示「预估」角标 + 「滚动窗口」
- **不再每 60s 发起注定失败的官方查询**（省请求 + 省日志噪音）
- 切回真实查询：`quotaMode` 改 `fetch` 或删除即可

---

## 五、CrewCentral 展示层

### 5.1 后端代理
- `backend/app/api/routes/gateway_admin.py`：`GET /admin/gateway/metrics`
- `httpx.AsyncClient` 5s 超时，`Authorization: Bearer crew_proxy_api_key`
- `rc_ok(resp.json())` **原样透传**（payload 不改，estimated 字段自动穿透）
- `Depends(require_session_permission("gateway"))` 守卫

### 5.2 权限「三处同步」gotcha
加 `"gateway"` 菜单权限必须三处都改，漏一处 super_admin 也 403：
1. `role_service.py` `ALL_MENU_KEYS`（`clean_menu_keys` 会过滤未列出的）
2. 同文件 `ROLE_MENUS["super_admin"]`（**硬编码列表，不读库**）
3. alembic 迁移 `UPDATE role_menu_permissions`（现有 DB 行）

### 5.3 前端大屏
- **echarts** + 自注册 `crew-light` 浅色主题（色板对齐 Tailwind slate/sky）
- 6 模块：KPI 条 / Provider 卡片 / 池子负载条形图 / 配额详情 / 调用趋势 / token 速率
- **3s 轮询** + 请求重叠保护（上次未返回跳过）+ **隐藏 tab 暂停**（`document.hidden` guard）
- 趋势/token 速率用前端 ring buffer（120 采样 = 6 分钟）维护历史
- **echarts mount-once init + setOption-on-data**（避免每轮询重建图表闪烁）
- 配色语义：healthy 绿 / degraded 黄 / down 红；冷却 quota=红 / rate_limit=橙；配额 >80% 橙 >95% 红

---

## 六、亮点

1. **key 不出网关** —— 配额查询在 CrewProxy 进程内发起，CrewCentral 只收聚合结果，API key 零外泄
2. **单一 `/metrics` 入口** —— 前端一次请求拿全部数据（实时统计 + 池子 + 配额 + health），简化消费端
3. **成功+失败都埋点** —— 修复了"失败请求不写 usage 日志 → 成功率算不出"的 ES 盲区，`record` try/catch 不影响热路径
4. **时间桶控内存** —— 10s 桶 × 360 = 1h，几十 KB；查询时按窗口聚合，O(桶数)
5. **配额双模式** —— fetch（真实查询）+ estimated（网关自统计 fallback），个人版/团队版都覆盖；切换只需改一行配置
6. **瞬时失败保留上次值** —— 配额查询临时失败不抹掉上次 tiers，大屏不闪烁
7. **健康分级 + 冷却配色** —— down/degraded/healthy 自动判定 + reason 区分红/橙，运维一眼定位
8. **复用 cc-switch 已验证逻辑** —— GLM/MiniMax 配额解析翻译自 cc-switch 的 Rust 实现（含 30 单测），不重复造轮子
9. **echarts 生命周期** —— mount-once + setOption-on-data，3s 轮询不重建图表；隐藏 tab 暂停省资源
10. **全流程工程化** —— brainstorm → spec → plan → subagent（每 task implementer+reviewer 双 gate）→ final review → fix → merge，全程 spec/plan/review 记录可追溯

---

## 七、关键文件索引

### CrewProxy
| 文件 | 职责 |
|---|---|
| `src/metricsCollector.ts` | 10s 时间桶实时统计（成功/失败/token/耗时） |
| `src/quotaFetcher.ts` | 配额查询（fetch 调官方 / estimated 自统计） |
| `src/tokenUsageTracker.ts` | 5h/7d 滚动窗口 token 累加（estimated 专用） |
| `src/metricsPayload.ts` | 组装 /metrics 响应 + health 计算 + 绝对值还原 |
| `src/proxy.ts` | recordMetric 闭包埋点 + /metrics 路由 |
| `src/config.ts` | UpstreamConfig（quotaMode / quotaLimits） |
| `src/index.ts` | 启动注入 + 热重载 buildQuotaUpstreams |
| `proxy-config.json` | GLM quotaMode:estimated + quotaLimits |

### CrewCentral
| 文件 | 职责 |
|---|---|
| `backend/app/api/routes/gateway_admin.py` | 代理 /metrics |
| `backend/app/auth/role_service.py` | gateway 权限（三处同步之一） |
| `backend/alembic/versions/20260707_0015_gateway_menu.py` | 权限 seed 迁移 |
| `frontend/src/lib/gateway-api.ts` | GatewayMetrics 类型 + fetch |
| `frontend/src/lib/echarts-theme.ts` | crew-light 浅色主题 |
| `frontend/src/hooks/useGatewayMetrics.ts` | 3s 轮询 + hidden 暂停 + history buffer |
| `frontend/src/components/gateway/*.tsx` | 6 个图表/卡片组件 |
| `frontend/src/pages/admin/GatewayDashboardPage.tsx` | 大屏主页 |

---

## 八、运维要点

- **启动验证**：CrewProxy `WOICLAW_AUTH_BYPASS=1 node dist/index.js` → `curl -H "x-api-key: dummy" http://localhost:3456/metrics`
- **生产鉴权**：给 CrewProxy 配真实 `crew_proxy_api_key`（取代 bypass）；CrewCentral 后端用 `crew_proxy_api_key` 转发
- **GLM 切回真实查询**：个人版 key → 删 `quotaMode` 或改 `"fetch"`
- **MiniMax 回归**：MiniMax 卡应显示真实百分比 + 倒计时（无「预估」角标）—— 确认 fetch 模式没被破坏
