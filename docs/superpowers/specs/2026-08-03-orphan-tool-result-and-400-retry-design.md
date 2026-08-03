# 孤儿 tool_result 与 400 重试分支修复 — 设计文档

日期:2026-08-03
仓库:CrewProxy

## 背景

一名同事的 AmbiCrew 会话出现"切换所有模型都无法继续"的死锁。诊断日志(session `9d01ad1e-...`)显示,30 分钟内反复打同一个 400:

```
API Error: 400 All code-plan credentials exhausted (last upstream 400):
  invalid params, tool result's tool id(call_c6d00bb46c5b4434a1bec1c3) not found (2013)
```

关键特征:tool id `call_c6d00bb46c5b4434a1bec1c3` 在 4 次报错中完全一致,但上游 request_id 每次不同。说明有一个孤儿 `tool_result`(引用的 `tool_use` 不存在)被持久化进请求,每次重发都带着它,因此换任何模型都无效。

## 根因分析

两个独立缺陷,一个制造孤儿(根因),一个把孤儿的 400 放大成"凭据耗尽"死锁。

### 缺陷 B(根因):trim 产生孤儿 tool_result

CrewProxy 在转发前调用 `trimToFitBudget`(`src/proxy.ts:859`)把上下文压进模型窗口。AmbiCrew 发出的历史本是配对完整的(其发送路径 `ensureToolResultPairing` 已双向清理),孤儿是在 **CrewProxy 内部 trim 时产生的** —— 所以 AmbiCrew 侧的校验管不到。

`src/contextBudget.ts` 两处 trim 的孤儿处理都不完整:

- `trimToFitBudget` Phase 3(287-317):逐条删老消息时,只处理"删掉的消息与紧邻的下一/上一条正好整块配对"的情况。当 tool_use 与 tool_result 之间隔了其他消息,或 `tool_result` 与文本混在同一条 user 消息里(块级混合),就会留下孤儿。且删到预算达标即 return,可能刚好停在拆散配对处。
- `aggressiveTrimForRetry`(447-469):孤儿清理是整条消息级(`allOrphaned` 才删),对"一条 user 消息里既有孤儿 tool_result 又有正常内容"的块级混合孤儿无能为力。
- 两者都缺少一个"最终统一剥离所有孤儿 tool_result 块"的兜底。

### 缺陷 A(放大器):400 重试分支错误

`src/proxy.ts` 凭据重试循环(1159-1250)对 400 只特判了 token 超限:

1. 1159 进入 400 块;1161 clampMaxTokens 只对 max_tokens 类生效;
2. 1180-1182 token-exceed 循环,`if (!isTokenExceedError) break` —— "tool id not found" 非 token 超限,立即 break,不 trim;
3. 1210-1223 落到"标记凭据 cooldown" —— 与凭据无关的错误却被 cooldown;
4. 1226-1228 的"不可重试"判断显式排除了 400(`status !== 400`),导致 400 **继续换下一个凭据重试**;
5. 逐个把凭据烧成 cooldown,`pickOrFallback` 返回 null → `exhaustedAllCredentials` → 报 "All code-plan credentials exhausted (last upstream 400)"。

后果:一个跟凭据无关的畸形请求 400,被空转烧光整个凭据池,并用误导性的"凭据耗尽"掩盖真实根因(tool id not found)。

## 修复方案

### 缺陷 B:trim 后统一剥离孤儿 tool_result

`src/contextBudget.ts` 新增函数:

```ts
// 块级剥离:删掉所有 tool_use_id 找不到对应 tool_use 的 tool_result 块。
// 若一条消息的 tool_result 被剥光只剩空 content,则整条删除。
// 覆盖 trimToFitBudget / aggressiveTrimForRetry 都处理不到的“混合块级孤儿”。
// 原地修改 messages(与现有 splice 风格一致)。
export function stripOrphanedToolResults(messages: any[]): void
```

逻辑:
1. 先扫全量 messages 收集所有 `tool_use.id` → `validUseIds`。
2. 遍历每条消息,若 content 是数组,过滤掉 `type === 'tool_result'` 且 `tool_use_id ∉ validUseIds` 的块。
3. 若过滤后 content 变空,整条消息从数组删除。

只处理"孤儿 tool_result"这一个方向。反方向(tool_use 无 result)是 Anthropic 允许的中间态,不在此处理,不扩大范围。

接入点:
- `trimToFitBudget`:在 Phase 3 收口后、各 `return` 之前调 `stripOrphanedToolResults(messages)`。这是同事本次实际走的主发送路径。
- `aggressiveTrimForRetry`:在 `return trimmed` 前调一次,补强现有整条级清理(现有块内容截断逻辑保留)。

### 缺陷 A:400 分类处理

`src/proxy.ts` 重试循环内,保留 token 类 400 的 trim/clamp 逻辑不变;对非 token 类 400 新增"立即透传"短路。

在 400 块的 token-trim 循环之后、cooldown(1210)之前插入:

```ts
// 非 token 类 400 是请求本身畸形(孤儿 tool_result → "tool id not found"、
// schema 错误等)。换凭据只会得到同样的 400,还白烧整池。立即透传真实 400,
// 让客户端看到根因而不是误导性的 "credentials exhausted"。
if (upstreamResponse.status === 400 && !isTokenExceedError(upstreamResponse.status, errText)) {
  logger.verbose(`[${reqId}] Non-token 400 (client request error), surfacing immediately without cooldown/switch`);
  break;
}
```

该 break 跳过 cooldown 与换凭据,直达循环外 1294 的 `if (!upstreamResponse.ok)`,原样返回上游 400 体。1226-1228 的判断因此不再需要改逻辑(仅更新注释说明 400 已在上游被拦截)。

边界:
- token 类 400 行为零变化(trim 重试保留)。
- 429 / 5xx / 网络错误的轮换 / backoff / cooldown 全部不动。
- 仅新增"非 token 400"一条短路。

## 结果

- trim 不再产生孤儿(B 治根),即便偶发孤儿,proxy 也不再空转烧池、误导报错(A 兜底)。
- AmbiCrew 侧看到的是真实的 400 `tool id not found`,而非 "All code-plan credentials exhausted",便于用户/开发者定位。

## 测试计划

- `test/contextBudget.test.ts`(新建):
  - `stripOrphanedToolResults`:混合块孤儿只剥孤儿块;整条孤儿删整条;无孤儿不变;tool_use 无 result 不误删。
  - `trimToFitBudget` / `aggressiveTrimForRetry`:trim 后无孤儿残留。
- `test/upstreamError.test.ts`(扩展):
  - 非 token 400 立即透传(不 cooldown、不换凭据)。
  - token 400 仍走 trim。
  - 429 仍轮换。
- `npm test` 全绿,`npm run build` 通过。

## 不在范围内

- AmbiCrew 侧 `filterUnresolvedToolUses`(单方向)不改动 —— 本次根因在 CrewProxy trim,发送路径 `ensureToolResultPairing` 已双向处理。
- 远端服务器合并由用户手动完成。
