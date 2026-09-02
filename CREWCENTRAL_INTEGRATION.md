# CrewCentral 集成配置

## 概述

CrewProxy 已集成 CrewCentral 用户认证，可以在用量统计中按用户查看 token 使用情况。

## 配置方式

### 方式一：通过 Header 传递用户名（推荐，效率高）

TestCrew 等客户端可以在请求时添加以下 Header 之一：

- `x-llm-proxy-user`: 用户名
- `x-show-name`: 用户名（备选）

CrewProxy 会优先使用 Header 中的用户名。

### 方式二：通过 Token 验证获取用户名

如果 Header 中没有用户名，CrewProxy 会调用 CrewCentral 的 introspect 端点验证 token 并获取用户名。

配置以下环境变量：

```bash
# CrewCentral 地址（包含 base path）
WOICLAW_AUTH_HOST=https://your-crewcentral-host.com/woicrew

# introspect 端点路径
WOICLAW_AUTH_USER_PATH=/api/v1/auth/token/introspect

# 使用 Bearer token 方式
WOICLAW_AUTH_USE_BEARER=true

# 请求方法
WOICLAW_AUTH_METHOD=POST

# 成功响应字段和值（使用默认值即可）
WOICLAW_AUTH_SUCCESS_FIELD=rc
WOICLAW_AUTH_SUCCESS_VALUE=0

# 用户名字段路径
WOICLAW_AUTH_NAME_FIELD=data.name
```

## 端点说明

CrewCentral 新增端点: `POST /woicrew/api/v1/auth/token/introspect`

**请求头:**
```
Authorization: Bearer <access_token>
```

**响应示例:**
```json
{
  "rc": 0,
  "data": {
    "user_id": "user-uuid",
    "name": "用户名或邮箱",
    "permission_rules": {
      "providers": ["openai", "anthropic"],
      "extra_models": [],
      "denied_models": []
    },
    "quota": { "enabled": true, "daily_limit": 100, "monthly_limit": 3000 }
  }
}
```

> `permission_rules` 为 `null` 表示角色无限制（如 `super_admin`）。Proxy 可据此
> 决定哪些 provider/model 放行；`quota` 用于客户端或后续代理层做额度控制。
>
> 当 `Bearer` 传入的是 `wc_` 开头的长效 key 时，响应会额外带 `client_type`
> 字段（`anthropic` / `openai` / `im` / `mcp` / `self_hosted` / `admin`），用于
> 按客户端类型做差异化策略。

## 长效 API Key（`wc_` 前缀）

适用于第三方客户端（如 Claude Code / Anthropic SDK）在公司受监管的网络下调用
Proxy 转发到后端大模型：管理员或用户先在 CrewCentral 签发一个长效 key（`wc_`
前缀 + 32 字节 url-safe），写入客户端的 `*_API_KEY` / `Authorization` 头。

签发后的明文 key **仅展示一次**，存库只保留 SHA-256 哈希与 `wc_<8>` 前缀；
过期/吊销/前缀错误均返回 401。

```bash
# 典型示例：Anthropic SDK 客户端
export ANTHROPIC_BASE_URL=https://your-crewcentral-host.com/woicrew   # 指向 Proxy
export ANTHROPIC_API_KEY=wc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Proxy 收到 `Authorization: Bearer wc_xxx` 后会通过 `/auth/token/introspect`
反查用户身份与权限，沿用同一份用量统计（按 `data.name` 归属）。

## 完整示例

```bash
# CrewProxy 配置示例
WOICLAW_AUTH_HOST=https://crew.ambilight.com/woicrew
WOICLAW_AUTH_USER_PATH=/api/v1/auth/token/introspect
WOICLAW_AUTH_USE_BEARER=true
WOICLAW_AUTH_METHOD=POST
WOICLAW_AUTH_SUCCESS_FIELD=rc
WOICLAW_AUTH_SUCCESS_VALUE=0
WOICLAW_AUTH_NAME_FIELD=data.name
```

