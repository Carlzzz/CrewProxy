# Quickstart: Claw Proxy

**Feature**: 001-claw-proxy-gateway
**Date**: 2026-04-13

---

## 前置条件

- Node.js ≥ 18 已安装
- 一个可用的 OpenAI 兼容上游（如 OpenAI API、DeepSeek、通义千问等）
- 一个可用的外部认证服务（或先用 Stub 测试 SDK 内部模型）

## 1. 初始化项目

```bash
npm install
```

## 2. 配置

### 配置文件

```bash
cp proxy-config.example.json proxy-config.json
```

编辑 `proxy-config.json`，填入上游 API 密钥：

```jsonc
{
  "port": 3456,
  "host": "0.0.0.0",
  "defaultUpstream": {
    "baseURL": "https://api.openai.com",
    "apiKey": "sk-your-key-here",
    "model": "gpt-4o",
    "provider": "openai"
  }
}
```

### 环境变量

```bash
cp .env.example .env
```

编辑 `.env`，配置认证服务地址：

```bash
WOICLAW_AUTH_HOST=http://your-auth-service:8088
WOICLAW_AUTH_USER_PATH=/woicrew/api/user-by-device
```

## 3. 构建与启动

```bash
npm run build
npm start
```

或带详细日志：

```bash
# Linux/macOS
WOICLAW_PROXY_VERBOSE=1 node dist/index.js

# Windows PowerShell
$env:WOICLAW_PROXY_VERBOSE="1"; node dist/index.js
```

## 4. 验证

### Health check

```bash
curl http://localhost:3456/healthz
# → {"ok":true}
```

### SDK 内部模型 Stub（无需认证/上游）

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
# → 返回 Anthropic 格式 JSON stub 响应
```

### 非流式对话（需认证 + 上游）

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-device-token" \
  -d '{"model":"gpt-4o","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

### 流式对话

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-device-token" \
  -d '{"model":"gpt-4o","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

### 多上游路由

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-device-token" \
  -d '{"model":"deepseek|deepseek-chat","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

## 5. 检查用量日志

```bash
cat logs/usage-$(date +%Y-%m-%d).jsonl
```

每行一个 JSON 对象，包含 `app`、`username`、`modelid`、`input_token`、`output_token` 等。

## 6. ES 同步（可选）

确保 `.env` 中配置了 ES 连接信息，然后：

```bash
# 运行一次
RUN_ONCE=1 npm run sync-usage

# 常驻同步（每 10 分钟）
npm run sync-usage
```

## 7. 与 Claude Agent SDK 集成

在 SDK/客户端中将 Base URL 设为 `http://<proxy-host>:3456`，
`x-api-key` 设为你的设备 token。SDK 会自动使用 Anthropic Messages API 语义与代理通信。

## 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| 401 | 认证服务不可达或 token 无效 | 检查 `WOICLAW_AUTH_HOST` 和 token |
| 403 | 无可用上游 | 检查 `proxy-config.json` 中 `defaultUpstream` |
| 502 | 上游网络不可达 | 检查上游 `baseURL` 和网络连通性 |
| 流式无输出 | 上游不支持流式或 provider 设置错误 | 确认 provider 值与上游 API 形态匹配 |
