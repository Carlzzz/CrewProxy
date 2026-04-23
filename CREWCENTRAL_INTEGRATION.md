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
    "name": "用户名或邮箱"
  }
}
```

## 完整示例

```bash
# CrewProxy 配置示例
WOICLAW_AUTH_HOST=https://crew.ambilight.com/woicrew
WOICLAW_AUTH_USER_PATH=/api/v1/auth/token/introspect
WOICLAW_AUTH_USE_BEARER=true
WOICLAW_AUTH_METHOD=POST
```

