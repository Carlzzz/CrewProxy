# GLM 团队版配额预估 设计文档

- **日期**: 2026-07-07
- **状态**: Draft（待用户复核）
- **关联**: 补充 `CrewCentral/docs/superpowers/specs/2026-07-07-gateway-monitoring-dashboard-design.md`（§4.2 配额）；依赖 CrewProxy `/metrics`（Plan 1 已 merge）
- **仓库**: 主要 `CrewProxy`（TokenUsageTracker + QuotaFetcher + config）；前端小改 `CrewCentral`（QuotaGrid 角标）

---

## 1. 背景与目标

GLM 团队版 coding plan 套餐的 API key 调用个人版配额查询接口（`open.bigmodel.cn/api/monitor/usage/quota/limit`）返回业务错误「当前用户不存在coding plan」，无法获取真实余量。团队版没有公开的余量查询接口。

目标：当 GLM 拿不到真实余量时，由网关自行统计 GLM 的 token 用量，按已知套餐总量预估已用百分比，让大屏仍能展示 GLM 配额消耗情况。

### 已知总量（团队版 coding plan）
- 每 5 小时：1.6 亿 token
- 每周：8 亿 token

### 成功标准
- GLM 配 `quotaMode: "estimated"` 后，大屏配额卡显示「预估」角标 + 已用%/绝对值（基于网关统计）
- 不再每 60s 发起注定失败的官方查询
- MiniMax 等能查到真实余量的 provider 不受影响（继续 `fetch` 模式）

---

## 2. 现状

- `src/quotaFetcher.ts`（Plan 1）：每 60s 调 GLM 官方接口 → 团队版 key 返回 `{status:"error", error:"GLM: 当前用户不存在coding plan"}`，`/metrics` 里 GLM credential 显示「查询失败」。每次查询浪费一次请求 + 最多 15s 超时。
- `src/metricsCollector.ts`（Plan 1）：记录每次请求 token（input+output），按 upstream/credential，10s 桶保留 1h。**窗口太短**（5h/周预估需要更长），且按 credential 维度（团队版账号共享，需 per-upstream 聚合）。
- `src/metricsPayload.ts`：`/metrics` 组装时用 `quotaLimits` 把 `usedPct` 还原绝对值（GLM 已配 `fiveHourTokens: 1.6e8`）。
- 前端 `QuotaGrid.tsx`（Plan 2）：渲染 `quota.fiveHour/weekly`（进度条 + 倒计时），`resetsAt` null 时的展示待确认（本设计会用到）。

---

## 3. 设计

### 3.1 触发与配置

`UpstreamConfig` 新增可选字段 `quotaMode?: "fetch" | "estimated"`，默认 `"fetch"`（保持现有行为，调官方接口）。

`estimated` 模式：`QuotaFetcher` 完全跳过官方 HTTP 查询，改用网关统计的 token + `quotaLimits` 算已用%。

proxy-config.json 的 GLM upstream：
```jsonc
"glm": {
  "baseURL": "...", "apiKey": "...", "model": "glm-5.2",
  "codePlanCredentials": [...],
  "quotaMode": "estimated",
  "quotaLimits": { "fiveHourTokens": 160000000, "weeklyTokens": 800000000 }
}
```

### 3.2 新模块 `src/tokenUsageTracker.ts`

专门做 per-upstream 的长窗口 token 累加，与 `MetricsCollector`（1h 实时统计）职责分离。

- 维护 `Map<upstreamId, { fiveHour: BucketLog, weekly: BucketLog }>`
- `BucketLog` = 时间桶数组：5h 窗口用 **1min 桶 × 300**，7 天窗口用 **1h 桶 × 168**；每桶存 token 总和
- `record(upstreamId, tokens, ts)`: 同时累加进 5h 和 weekly 两个窗口的对应桶，并清理过期桶
- `getUsage(upstreamId) → { fiveHourTokens: number, weeklyTokens: number }`: 聚合各窗口所有有效桶
- 纯内存，重启归零（见 §4 取舍）
- `record()` 内部 try/catch，绝不影响代理主路径（与 `MetricsCollector.record` 同原则）

**埋点位置**：`src/proxy.ts` 的 `recordMetric` 闭包里，在 `ctx.metrics?.record(...)` 旁同步调用 `ctx.tokenUsage?.record(upstreamId, inputTokens + outputTokens, ts)`。失败/无 token 出口（token=0）也可调用（累加 0 无副作用，简化埋点）。

### 3.3 QuotaFetcher estimated 集成

`QuotaFetcher.refreshOnce` 改造：
- `reload` 改为接收 per-upstream 的配置（每个 upstream 带 `quotaMode` + `quotaLimits` + 其 credential 列表）。`quotaMode` 是 upstream 级配置。
- 对 `quotaMode === "estimated"` 的 upstream：跳过官方查询，对该 upstream 下**所有** credential 写入同一个账号级预估 quota（团队版账号共享额度）：
  ```ts
  const usage = tokenUsageTracker.getUsage(upstreamId);
  const fiveHourLimit = limits.fiveHourTokens ?? null;
  const weeklyLimit = limits.weeklyTokens ?? null;
  snapshot.set(key, {
    status: "ok",
    estimated: true,
    fiveHour: fiveHourLimit ? { usedPct: usage.fiveHourTokens / fiveHourLimit * 100, resetsAt: null } : undefined,
    weekly: weeklyLimit ? { usedPct: usage.weeklyTokens / weeklyLimit * 100, resetsAt: null } : undefined,
    queriedAt: now(),
  });
  ```
- `fetch` 模式（默认）：行为不变（调官方接口）
- `QuotaFetcher` 构造接收 `tokenUsageTracker` 引用（dependency injection，便于测试）

> 注：estimated quota 的 `usedPct` 不经 `metricsPayload` 的 `quotaLimits` 还原绝对值（因为预估已经直接基于 quotaLimits 算了）。`metricsPayload` 对 `estimated===true` 的 credential 直接透传 `usedPct`，并用 `quotaLimits` 填 `usedTokens`/`limitTokens`（与真实查询一致的输出契约，前端无需区分处理绝对值）。

### 3.4 /metrics 响应契约扩展

`CredentialQuota`（即 `/metrics` 里每个 credential 的 `quota` 对象）新增可选字段：
- `estimated?: boolean`（true = 预估模式；缺失 = 真实查询）
- estimated 模式下 `fiveHour.resetsAt` / `weekly.resetsAt` 为 `null`（滚动窗口无明确重置点）

### 3.5 前端（CrewCentral）

`frontend/src/components/gateway/QuotaGrid.tsx`：
- `quota.estimated === true` 时，配额卡标题旁加「预估」角标（`bg-slate-100 text-slate-600` 小标签，区别于真实查询）
- `fiveHour.resetsAt === null` 时，不显示倒计时，改显「滚动窗口」灰色小字
- 进度条颜色阈值不变（>95% 红 / >80% 橙 / 否则蓝）

`frontend/src/lib/gateway-api.ts`：`CredentialQuota` 加 `estimated?: boolean`。

---

## 4. 取舍（已与用户确认）

1. **滚动窗口**（非固定）：统计「过去 5h / 过去 7 天」的 token 用量。无需猜 GLM 团队版固定窗口的边界（未知）；预估本身近似（网关只看到经过它的流量 + 重启归零），滚动窗口实现简单、语义清晰。`resetsAt` 为 null。
2. **重启归零**：第一期纯内存统计，网关重启后预估从 0 重新累加。前端角标/文案标注「自启动以来」。未来可加周期 flush 到 JSON 文件做持久化（非目标）。
3. **per-upstream 统计**：团队版账号共享额度，`TokenUsageTracker` 按 upstreamId 聚合（不按 credential）。该 upstream 下所有 credential 在 `/metrics` 显示同一个账号级预估配额。

---

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| `quotaMode: "estimated"` 但 `quotaLimits` 未配 | 该窗口 `fiveHour`/`weekly` 为 `undefined`（无法算 usedPct），credential 仍 `status:"ok"` + `estimated:true`，前端该窗口不显示进度条 |
| `quotaMode: "estimated"` 但 `TokenUsageTracker` 无该 upstream 数据（刚启动） | `getUsage` 返回 `{0, 0}`，usedPct=0%，正常显示「自启动以来 0%」|
| `quotaMode` 缺省 | 默认 `"fetch"`，行为同 Plan 1（调官方接口）|
| MiniMax 等 `fetch` 模式 | 完全不受影响 |

---

## 6. 测试

### CrewProxy
- `tokenUsageTracker.ts`：桶聚合正确性（5h/周窗口、过期桶清理、多 record 累加、跨桶）；`getUsage` 边界（空、窗口未满、满窗口）；`record` try/catch 不抛。
- `quotaFetcher.ts`：estimated 模式跳过官方查询、用注入的 `TokenUsageTracker` + `quotaLimits` 算 usedPct；`fetch` 模式不变；`estimated:true` 标志正确设置。
- `config.ts`：`quotaMode` 解析（默认 fetch、estimated、非法值容错）；`quotaLimits.weeklyTokens` 解析。
- `/metrics` 端点：estimated credential 输出 `estimated:true` + `resetsAt:null` + 正确绝对值。

### CrewCentral
- 前端无测试框架；`QuotaGrid` 角标 + `resetsAt:null` 展示靠 `tsc -b && vite build` + 端到端手动验证。

---

## 7. 非目标

- **持久化**：重启不丢统计（文件/DB）——未来增强。
- **固定窗口对齐**：按 GLM 真实固定窗口边界统计——边界未知，用滚动窗口近似。
- **多账号区分**：若 GLM 有多个独立账号的 key，per-upstream 聚合会混——当前 GLM upstream 视为单账号团队版。
- **fetch 模式的 GLM**：若未来换个人版 key，删 `quotaMode` 或改 `fetch` 即可切回真实查询。
