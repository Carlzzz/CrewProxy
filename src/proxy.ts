import * as http from 'http';
import { logger } from './logger';
import { ProxyRuntimeContext, UpstreamConfig, ResolvedUpstream, resolveUpstreamFromModel } from './config';
import { CodePlanPoolManager, CODE_PLAN_COOLDOWN_MS } from './codePlanPool';
import { isQuotaLimitedResponse, parseQuotaResetEpochMs } from './codePlanQuota';
import { buildAnthropicMessagesURL } from './formatTransform';
import { appendUsageLog, formatUTC8, UsageLogExtra } from './usageLogger';
import { estimateRequestTokens, computeInputBudget, trimToFitBudget, isTokenExceedError, aggressiveTrimForRetry, getModelContextWindow } from './contextBudget';

const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const STREAM_READ_TIMEOUT_MS = 180_000;

const USAGE_LOG_TAIL_PREVIEW_MAX = Math.max(
  4096,
  parseInt(process.env.WOICLAW_USAGE_LOG_TAIL_PREVIEW_MAX || '8192', 10) || 8192
);

function getAuthHost(): string {
  return process.env.WOICLAW_AUTH_HOST || '';
}

function getAuthUserPath(): string {
  return process.env.WOICLAW_AUTH_USER_PATH || '/woicrew/api/user-by-device';
}

function getAuthMethod(): string {
  return (process.env.WOICLAW_AUTH_METHOD || 'GET').toUpperCase();
}

function getAuthTokenParam(): string {
  return process.env.WOICLAW_AUTH_TOKEN_PARAM || 'deviceId';
}

function getAuthSuccessField(): string {
  return process.env.WOICLAW_AUTH_SUCCESS_FIELD || 'rc';
}

function getAuthSuccessValue(): string {
  return process.env.WOICLAW_AUTH_SUCCESS_VALUE || '0';
}

function getAuthNameField(): string {
  return process.env.WOICLAW_AUTH_NAME_FIELD || 'data.name';
}

function useAuthBearerToken(): boolean {
  return process.env.WOICLAW_AUTH_USE_BEARER === '1' || process.env.WOICLAW_AUTH_USE_BEARER === 'true';
}

function getNestedField(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

// ─── Error body helpers ───

export function createAnthropicErrorBody(message: string, type: string): object {
  return { type: 'error', error: { type, message } };
}

export function formatSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sendJSONResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(json);
}

function sendErrorResponse(res: http.ServerResponse, statusCode: number, message: string, errorType: string): void {
  sendJSONResponse(res, statusCode, createAnthropicErrorBody(message, errorType));
}

// ─── Request body reader ───

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function consumeBody(req: http.IncomingMessage): void {
  req.resume();
}

// ─── Auth Cache & Helpers ───

const AUTH_CACHE_MAX_SIZE = 1000;

interface CacheEntry {
  userInfo: { name: string; allowedModels: string[] | null };
  expiresAt: number;
}
const authCache = new Map<string, CacheEntry>();

function authCacheSet(key: string, entry: CacheEntry): void {
  if (authCache.size >= AUTH_CACHE_MAX_SIZE) {
    const firstKey = authCache.keys().next().value;
    if (firstKey !== undefined) authCache.delete(firstKey);
  }
  authCache.set(key, entry);
}

function getAuthCacheTtlMs(): number {
  const seconds = parseInt(process.env.WOICLAW_AUTH_CACHE_TTL_SECONDS || '60', 10);
  return (isNaN(seconds) ? 60 : seconds) * 1000;
}

function getProxyApiKey(): string {
  return process.env.WOICLAW_PROXY_API_KEY || '';
}

function isAuthBypassed(): boolean {
  return process.env.WOICLAW_AUTH_BYPASS === '1' || process.env.WOICLAW_AUTH_BYPASS === 'true';
}

function extractClientApiKey(req: http.IncomingMessage): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();

  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

async function authenticateRequest(token: string): Promise<{ name: string; allowedModels: string[] | null } | null> {
  if (isAuthBypassed()) {
    return { name: 'bypass', allowedModels: null };
  }

  const cacheKey = token;
  const cached = authCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      logger.verbose('[auth] Cache hit for token');
      return cached.userInfo;
    } else {
      authCache.delete(cacheKey);
    }
  }

  const authHost = getAuthHost();
  const proxyKey = getProxyApiKey();
  let userInfo: { name: string; allowedModels: string[] | null } | null = null;

  if (authHost) {
    logger.verbose('[auth] Trying introspect first (authHost configured)');
    const fetched = await fetchUserInfo(token);
    if (fetched) {
      logger.verbose('[auth] Introspect succeeded, got user:', fetched.name);
      userInfo = fetched;
    } else {
      logger.verbose('[auth] Introspect failed, falling back');
    }
  }

  if (!userInfo && proxyKey) {
    if (token === proxyKey) {
      userInfo = { name: 'local', allowedModels: null };
    }
  }

  if (userInfo) {
    const ttlMs = getAuthCacheTtlMs();
    if (ttlMs > 0) {
      authCacheSet(cacheKey, {
        userInfo,
        expiresAt: Date.now() + ttlMs,
      });
    }
    return userInfo;
  }

  return null;
}

async function fetchUserInfo(token: string): Promise<{ name: string; allowedModels: string[] | null } | null> {
  const authHost = getAuthHost();
  if (!authHost) {
    logger.error('Auth host not configured (WOICLAW_AUTH_HOST)');
    return null;
  }

  const method = getAuthMethod();
  const tokenParam = getAuthTokenParam();
  const useBearer = useAuthBearerToken();
  let url: string;
  let fetchOptions: RequestInit;

  if (useBearer) {
    url = `${authHost}${getAuthUserPath()}`;
    fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    };
  } else if (method === 'GET') {
    url = `${authHost}${getAuthUserPath()}?${tokenParam}=${encodeURIComponent(token)}`;
    fetchOptions = { method: 'GET' };
  } else {
    url = `${authHost}${getAuthUserPath()}`;
    fetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [tokenParam]: token }),
    };
  }

  logger.verbose('Auth request:', url.replace(token, token.substring(0, 6) + '***'));
  try {
    const resp = await fetch(url, fetchOptions);
    if (resp.status !== 200) {
      logger.verbose('Auth failed: status', resp.status);
      return null;
    }
    const body: any = await resp.json();

    const successField = getAuthSuccessField();
    const successValue = getAuthSuccessValue();
    if (successField) {
      const actual = getNestedField(body, successField);
      if (String(actual) !== successValue) {
        logger.verbose(`Auth failed: ${successField}=${actual}, expected ${successValue}`);
        return null;
      }
    }

    const nameField = getAuthNameField();
    const name = getNestedField(body, nameField);
    if (!name || typeof name !== 'string' || !name.trim()) {
      logger.verbose(`Auth failed: name field "${nameField}" is empty or missing`);
      return null;
    }

    const allowedModels = getNestedField(body, 'data.allowed_models');
    let parsedAllowedModels: string[] | null = null;
    if (Array.isArray(allowedModels)) {
      parsedAllowedModels = allowedModels.map((m: any) => String(m).trim());
    }

    return { name: name.trim(), allowedModels: parsedAllowedModels };
  } catch (err) {
    logger.error('Auth error:', err);
    return null;
  }
}

// ─── Stub detection ───

function isClaudeAgentSdkInternalModel(model: string): boolean {
  if (model.includes('|')) return false;
  return /^claude-(haiku|sonnet)-[0-9-]+$/.test(model);
}

function sendSdkInternalStubResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedBody: any
): void {
  const isStream = parsedBody.stream === true;
  const stubModel = parsedBody.model || 'claude-haiku-4-5-20251001';
  const msgId = `msg_stub_${Date.now()}`;

  if (!isStream) {
    sendJSONResponse(res, 200, {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: stubModel,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const write = (event: string, data: unknown) => res.write(formatSSEEvent(event, data));

  write('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model: stubModel,
      content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } });
  write('content_block_stop', { type: 'content_block_stop', index: 0 });
  write('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
  write('message_stop', { type: 'message_stop' });

  res.end();
}

// ─── Usage helpers ───

function buildTrimmedInputContentForUsageLog(upstreamReq: any): string {
  const messages = upstreamReq.messages;
  let tailRole = '';
  let tailPreview = '';
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    tailRole = last.role || '';
    const c = last.content;
    if (typeof c === 'string') {
      tailPreview = c;
    } else if (Array.isArray(c)) {
      tailPreview = c.map((p: any) => {
        if (p.type === 'text') return p.text || '';
        if (p.type === 'tool_use') return `[tool_use:${p.name || ''}]`;
        if (p.type === 'tool_result') return `[tool_result]`;
        if (p.type === 'thinking') return `[thinking]`;
        if (p.type === 'image') return `[image]`;
        return `[${p.type || 'unknown'}]`;
      }).join(' ');
    }
    if (tailPreview.length > USAGE_LOG_TAIL_PREVIEW_MAX) {
      tailPreview = tailPreview.substring(0, USAGE_LOG_TAIL_PREVIEW_MAX);
    }
  }
  const systemPreview = typeof upstreamReq.system === 'string'
    ? upstreamReq.system.substring(0, 200)
    : '';
  return JSON.stringify({ model: upstreamReq.model, tail_role: tailRole, tail_preview: tailPreview, system_preview: systemPreview });
}

function extractOutputContentFromAnthropicResponse(anthropicResp: any): string {
  if (!Array.isArray(anthropicResp.content)) return '';
  return anthropicResp.content
    .filter((b: any) => b.type === 'text' || b.type === 'thinking')
    .map((b: any) => b.text || b.thinking || '')
    .join('');
}

function extractCachedInputTokensFromUsage(usage: any): number {
  if (!usage) return 0;
  let cached = 0;
  // Anthropic native fields
  if (typeof usage.cache_read_input_tokens === 'number') {
    cached = Math.max(cached, usage.cache_read_input_tokens);
  }
  // OpenAI-compat fields (some providers may still use these in Anthropic mode)
  for (const detailsKey of ['input_token_details', 'prompt_tokens_details']) {
    let details = usage[detailsKey];
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { continue; } }
    if (details && typeof details === 'object') {
      for (const k of ['cached_tokens', 'cache_hit_tokens']) {
        if (typeof details[k] === 'number') cached = Math.max(cached, details[k]);
      }
    }
  }
  for (const k of ['cached_tokens', 'prompt_cache_hit_tokens']) {
    if (typeof usage[k] === 'number') cached = Math.max(cached, usage[k]);
  }
  return cached;
}

// ─── Streaming: Anthropic pass-through ───

function popSSEPacket(buffer: string): { packet: string; rest: string } | null {
  const idxNL = buffer.indexOf('\n\n');
  const idxCRLF = buffer.indexOf('\r\n\r\n');
  let boundary = -1;
  let sepLen = 0;
  if (idxNL !== -1 && (idxCRLF === -1 || idxNL < idxCRLF)) {
    boundary = idxNL;
    sepLen = 2;
  } else if (idxCRLF !== -1) {
    boundary = idxCRLF;
    sepLen = 4;
  }
  if (boundary === -1) return null;
  return { packet: buffer.slice(0, boundary), rest: buffer.slice(boundary + sepLen) };
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  abortSignal: { aborted: boolean }
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Stream read timed out after ${timeoutMs}ms`)); }
    }, timeoutMs);

    const interval = setInterval(() => {
      if (abortSignal.aborted && !settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(interval);
        reject(new Error('Stream read aborted: client disconnected'));
      }
    }, 500);

    reader.read().then(
      (result) => {
        if (!settled) { settled = true; clearTimeout(timer); clearInterval(interval); resolve(result); }
      },
      (err) => {
        if (!settled) { settled = true; clearTimeout(timer); clearInterval(interval); reject(err); }
      }
    );
  });
}

interface AnthropicStreamState {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  outputAccumulator: string[];
  sawMessageStop: boolean;
}

async function handleAnthropicStreamResponse(
  upstreamResponse: Response,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientId: string,
  modelId: string,
  startTime: string,
  upstreamReq: any,
  extra: Partial<UsageLogExtra>
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const state: AnthropicStreamState = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    outputAccumulator: [],
    sawMessageStop: false,
  };

  const body = upstreamResponse.body;
  if (!body) {
    res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: 'Empty upstream response body' } }));
    res.end();
    appendUsageLog(clientId, modelId, startTime, 0, 0, extra as UsageLogExtra);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const bufferChunks: string[] = [];
  let bufferStr = '';
  const abortSignal = { aborted: false };

  const onClose = () => { abortSignal.aborted = true; };
  req.once('close', onClose);
  res.once('close', onClose);

  const getBuffer = (): string => {
    if (bufferChunks.length > 0) {
      bufferStr += bufferChunks.join('');
      bufferChunks.length = 0;
    }
    return bufferStr;
  };

  const processBuffer = (): void => {
    let buf = getBuffer();
    let popped: { packet: string; rest: string } | null;
    while ((popped = popSSEPacket(buf))) {
      buf = popped.rest;
      let eventType = '';
      const dataLines: string[] = [];
      for (const l of popped.packet.split(/\r?\n/)) {
        if (l.startsWith('event:')) eventType = l.substring(6).trim();
        else if (l.startsWith('data:')) dataLines.push(l.substring(5).trim());
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('');

      try {
        const data = JSON.parse(payload);

        // Extract usage from message_start and message_delta events for logging
        if (eventType === 'message_start' && data.message?.usage) {
          const u = data.message.usage;
          state.inputTokens = Math.max(state.inputTokens, u.input_tokens ?? 0);
          state.outputTokens = Math.max(state.outputTokens, u.output_tokens ?? 0);
          state.cachedInputTokens = Math.max(state.cachedInputTokens, extractCachedInputTokensFromUsage(u));
        }
        if (eventType === 'message_delta' && data.usage) {
          state.outputTokens = Math.max(state.outputTokens, data.usage.output_tokens ?? 0);
        }
        if (eventType === 'message_stop') {
          state.sawMessageStop = true;
        }

        // Extract text/thinking from content_block_delta for output logging
        if (eventType === 'content_block_delta' && data.delta) {
          if (data.delta.type === 'text_delta' && data.delta.text) {
            state.outputAccumulator.push(data.delta.text);
          } else if (data.delta.type === 'thinking_delta' && data.delta.thinking) {
            state.outputAccumulator.push(data.delta.thinking);
          }
        }

        // Forward the SSE event to the client unchanged
        res.write(formatSSEEvent(eventType, data));
      } catch (parseErr) {
        logger.verbose('Anthropic SSE chunk parse error:', parseErr);
      }
    }
    bufferStr = buf;
  };

  try {
    while (!abortSignal.aborted) {
      const result = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, abortSignal);
      if (result.done) {
        bufferChunks.push(decoder.decode(new Uint8Array(), { stream: false }));
        processBuffer();
        break;
      }
      bufferChunks.push(decoder.decode(result.value!, { stream: true }));
      processBuffer();
    }
  } catch (err) {
    logger.error('Anthropic stream error:', err);
    if (!state.sawMessageStop) {
      res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } }));
    }
  } finally {
    reader.cancel().catch(() => {});

    const inputContent = buildTrimmedInputContentForUsageLog(upstreamReq);
    const outputContent = state.outputAccumulator.join('');
    appendUsageLog(clientId, modelId, startTime, state.inputTokens, state.outputTokens, {
      ...extra,
      input_cached_token: state.cachedInputTokens,
      input_content: inputContent,
      output_content: outputContent,
    } as UsageLogExtra);

    res.end();
  }
}

// ─── 400 retry helpers ───

function clampMaxTokensFromAnthropicError(bodyText: string, anthropicReq: any): boolean {
  const match = bodyText.match(/max.*?(\d{2,})/i);
  if (match) {
    const limit = parseInt(match[1], 10);
    if (limit > 0 && anthropicReq.max_tokens) {
      anthropicReq.max_tokens = Math.min(anthropicReq.max_tokens, limit);
      return true;
    }
  }
  return false;
}

// ─── Main request handler ───

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ProxyRuntimeContext
): Promise<void> {
  const reqId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const startTime = formatUTC8(new Date());
  logger.verbose(`[${reqId}] POST /v1/messages`);

  let rawBody: Buffer;
  try {
    rawBody = await readRequestBody(req);
  } catch (err: any) {
    sendErrorResponse(res, 400, err.message || 'Invalid request body', 'invalid_request_error');
    return;
  }

  let parsedBody: any;
  try {
    parsedBody = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    sendErrorResponse(res, 400, 'Invalid JSON in request body', 'invalid_request_error');
    return;
  }

  const model = parsedBody.model || '';

  if (isClaudeAgentSdkInternalModel(model)) {
    logger.verbose(`[${reqId}] Stub model: ${model}`);
    sendSdkInternalStubResponse(req, res, parsedBody);
    return;
  }

  // ─── Authentication ───
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

  const headerUser = req.headers['x-llm-proxy-user'] || req.headers['x-show-name'];
  let userInfo: { name: string; allowedModels?: string[] | null };
  if (typeof headerUser === 'string' && headerUser.trim()) {
    userInfo = { name: decodeURIComponent(headerUser.trim()), allowedModels: authResult.allowedModels };
  } else {
    userInfo = authResult;
  }
  const clientId = userInfo.name;

  // ─── Model Permissions Check ───
  if (userInfo.allowedModels !== undefined && userInfo.allowedModels !== null) {
    if (!userInfo.allowedModels.includes(model)) {
      sendErrorResponse(res, 403, `Model ${model} is not allowed for your account.`, 'permission_error');
      return;
    }
  }

  // ─── Upstream resolution ───
  const resolved = resolveUpstreamFromModel(model, ctx.upstreamsByIdMap, ctx.defaultUpstream, ctx.modelRoutesMap);
  if (!resolved) {
    sendErrorResponse(res, 403, `No upstream configured for model: ${model}`, 'permission_error');
    return;
  }
  const { upstream, modelId, upstreamRouteId } = resolved;

  // ─── Code Plan credential selection ───
  let effectiveApiKey = upstream.apiKey;
  let effectiveModel = modelId || upstream.model;
  let effectiveBaseURL = upstream.baseURL;
  const codePlanPoolKey = upstreamRouteId || '__default__';
  let pickedCredentialId: string | null = null;

  if (ctx.codePlanPool && upstream.codePlanCredentials?.length) {
    const pick = ctx.codePlanPool.pickOrFallback(codePlanPoolKey, typeof req.headers['x-woicrew-session-id'] === 'string' ? req.headers['x-woicrew-session-id'] : undefined);
    pickedCredentialId = pick.credentialId;
    if (pick.credentialId !== null) {
      effectiveApiKey = pick.apiKey;
      if (pick.model) effectiveModel = pick.model;
      // Prefer Anthropic-specific base URL, then generic code plan base URL
      if (upstream.codePlanAnthropicBaseURL) effectiveBaseURL = upstream.codePlanAnthropicBaseURL;
      else if (upstream.codePlanBaseURL) effectiveBaseURL = upstream.codePlanBaseURL;
      logger.verbose(`[${reqId}] CodePlan pick: ${pick.credentialId} -> effectiveModel: ${effectiveModel}`);
    } else {
      logger.verbose(`[${reqId}] CodePlan: no available credential, using ordinary key`);
      if (upstream.ordinaryFallbackModelMap) {
        const mapped = upstream.ordinaryFallbackModelMap[effectiveModel];
        if (mapped) {
          effectiveModel = mapped;
          logger.verbose(`[${reqId}] CodePlan ordinary fallback model remap: ${modelId || upstream.model} -> ${mapped}`);
        }
      }
    }
  }

  // ─── Build Anthropic request (no format conversion) ───
  const anthropicReq = structuredClone(parsedBody);
  anthropicReq.model = effectiveModel;

  // Auto-boost max_tokens to model maximum if not set or too low
  {
    const { maxOutputTokens } = getModelContextWindow(anthropicReq.model);
    if (maxOutputTokens > 0) {
      const currentMax = anthropicReq.max_tokens ?? 0;
      if (!currentMax || currentMax < maxOutputTokens) {
        anthropicReq.max_tokens = maxOutputTokens;
        logger.verbose(`[${reqId}] Auto-set max_tokens to ${maxOutputTokens} for model ${anthropicReq.model} (was ${currentMax || 'unset'})`);
      }
    }
  }

  // If the provider is not Anthropic and the model name starts with "claude-",
  // swap it for the upstream's default model
  const provider = upstream.provider?.toLowerCase();
  if (provider && provider !== 'anthropic') {
    if (/^claude-/.test(anthropicReq.model)) {
      anthropicReq.model = upstream.model;
    }
  }

  // Preserve stream flag
  if (parsedBody.stream) {
    anthropicReq.stream = true;
  }

  let upstreamRequestBody: any = anthropicReq;

  // ─── Context budget: pre-flight trim ───
  {
    const effectiveModelForBudget = modelId || upstream.model;
    const requestedMaxOutput = upstreamRequestBody.max_tokens;
    const inputBudget = computeInputBudget(effectiveModelForBudget, requestedMaxOutput);
    const estimated = estimateRequestTokens(upstreamRequestBody);

    if (estimated > inputBudget) {
      const trimResult = trimToFitBudget(upstreamRequestBody, inputBudget);
      if (trimResult.trimmed) {
        upstreamRequestBody = trimResult.trimmedBody;
        logger.verbose(`[${reqId}] Context budget: trimmed from ~${estimated} to ~${trimResult.estimatedTokens} tokens (budget: ${inputBudget}). Actions: ${trimResult.actions.join('; ')}`);
      }
    }
  }

  const targetURLs = buildAnthropicMessagesURL(effectiveBaseURL);

  const usageExtra: Partial<UsageLogExtra> = {
    app: 'woicrew',
    username: userInfo.name,
    stream: parsedBody.stream === true,
    request_size: rawBody.length,
    session_id: typeof req.headers['x-woicrew-session-id'] === 'string' && req.headers['x-woicrew-session-id'] ? req.headers['x-woicrew-session-id'] as string : null,
    routing_key: pickedCredentialId ?? upstreamRouteId ?? '__default__',
  };

  const USAGE_LOG_INPUT_FULLTEXT = process.env.WOICLAW_USAGE_LOG_INPUT_FULLTEXT;
  if (USAGE_LOG_INPUT_FULLTEXT === '1' || USAGE_LOG_INPUT_FULLTEXT === 'true') {
    usageExtra.input_fulltext = JSON.stringify(upstreamRequestBody);
  }

  // ─── Build upstream request headers ───
  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': effectiveApiKey,
    'Authorization': `Bearer ${effectiveApiKey}`,
  };
  // Forward Anthropic-specific headers from client
  for (const hdr of ['anthropic-version', 'anthropic-beta']) {
    const val = req.headers[hdr];
    if (typeof val === 'string') {
      upstreamHeaders[hdr] = val;
    }
  }

  let upstreamResponse: Response | null = null;
  let lastError: any = null;

  for (const targetURL of targetURLs) {
    logger.verbose(`[${reqId}] Fetching: ${targetURL}`);
    try {
      upstreamResponse = await fetch(targetURL, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamRequestBody),
      });

      if (upstreamResponse.status === 404 && targetURLs.indexOf(targetURL) < targetURLs.length - 1) {
        logger.verbose(`[${reqId}] 404 from ${targetURL}, trying next URL`);
        upstreamResponse = null;
        continue;
      }
      break;
    } catch (fetchErr) {
      lastError = fetchErr;
      logger.error(`[${reqId}] Fetch error:`, fetchErr);
    }
  }

  if (!upstreamResponse) {
    sendErrorResponse(res, 502, `Upstream request failed: ${lastError?.message || 'unknown'}`, 'api_error');
    return;
  }

  // ─── Error retry logic ───
  if (!upstreamResponse.ok) {
    let bodyText = '';
    try { bodyText = await upstreamResponse.clone().text(); } catch {}

    // Try clamping max_tokens if the error suggests a limit
    if (upstreamResponse.status === 400 && clampMaxTokensFromAnthropicError(bodyText, upstreamRequestBody)) {
      const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamRequestBody),
      });
      if (retryResp.ok || retryResp.status !== 400) upstreamResponse = retryResp;
    }

    // Token-exceed retry loop
    for (let trimRound = 0; trimRound < 3; trimRound++) {
      if (upstreamResponse.ok || upstreamResponse.status !== 400) break;
      try { bodyText = await upstreamResponse.clone().text(); } catch {}
      if (!isTokenExceedError(upstreamResponse.status, bodyText)) break;

      upstreamRequestBody = aggressiveTrimForRetry(upstreamRequestBody, trimRound);
      logger.verbose(`[${reqId}] Token exceed error, retry round ${trimRound + 1}/3 with aggressively trimmed context`);
      const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamRequestBody),
      });
      upstreamResponse = retryResp;
    }
  }

  if (!upstreamResponse.ok) {
    let errText = '';
    try { errText = await upstreamResponse.clone().text(); } catch {}
    logger.verbose(`[${reqId}] Upstream error ${upstreamResponse.status}:`, errText.substring(0, 500));

    // Code Plan cooldown: if 429 quota exceeded, mark credential in cooldown
    if (pickedCredentialId !== null && isQuotaLimitedResponse(upstreamResponse.status, errText)) {
      const resetMs = parseQuotaResetEpochMs(errText);
      const cooldownMs = resetMs ? Math.max(resetMs - Date.now(), CODE_PLAN_COOLDOWN_MS) : CODE_PLAN_COOLDOWN_MS;
      ctx.codePlanPool?.markCooldown(codePlanPoolKey, pickedCredentialId, cooldownMs);
      logger.verbose(`[${reqId}] CodePlan cooldown triggered for ${pickedCredentialId}: ${cooldownMs}ms`);
    }

    sendErrorResponse(res, upstreamResponse.status, `Upstream error: ${errText.substring(0, 200)}`, 'api_error');
    return;
  }

  if (parsedBody.stream) {
    await handleAnthropicStreamResponse(upstreamResponse, req, res, clientId, effectiveModel, startTime, upstreamRequestBody, usageExtra);
    return;
  }

  // ─── Non-stream response: pass Anthropic response directly ───
  let anthropicResp: any;
  try {
    anthropicResp = await upstreamResponse.json();
  } catch {
    sendErrorResponse(res, 502, 'Failed to parse upstream response', 'api_error');
    return;
  }

  const inputContent = buildTrimmedInputContentForUsageLog(upstreamRequestBody);
  const outputContent = extractOutputContentFromAnthropicResponse(anthropicResp);
  const respUsage = anthropicResp.usage || { input_tokens: 0, output_tokens: 0 };

  appendUsageLog(clientId, effectiveModel, startTime, respUsage.input_tokens || 0, respUsage.output_tokens || 0, {
    ...usageExtra,
    input_cached_token: extractCachedInputTokensFromUsage(anthropicResp.usage),
    input_content: inputContent,
    output_content: outputContent,
    response_size: JSON.stringify(anthropicResp).length,
  } as UsageLogExtra);

  sendJSONResponse(res, 200, anthropicResp);
}

// ─── Server factory ───

export function createProxyServer(ctx: ProxyRuntimeContext): http.Server {
  const server = http.createServer(async (req, res) => {
    const { method, url } = req;
    const pathname = (url || '/').split('?')[0];
    logger.verbose(`← ${method} ${url}`);

    try {
      if (method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/healthz') {
        sendJSONResponse(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && pathname === '/models') {
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

        const headerUser = req.headers['x-llm-proxy-user'] || req.headers['x-show-name'];
        let userInfo: { name: string; allowedModels: string[] | null };
        if (typeof headerUser === 'string' && headerUser.trim()) {
          userInfo = { name: decodeURIComponent(headerUser.trim()), allowedModels: authResult.allowedModels };
        } else {
          userInfo = authResult;
        }

        const items: Array<{ model_id: string; model_alias: string }> = [];
        const seen = new Set<string>();

        for (const [modelName] of ctx.modelRoutesMap) {
          if (seen.has(modelName)) continue;
          seen.add(modelName);
          items.push({ model_id: modelName, model_alias: modelName });
        }

        for (const [upstreamId, upstream] of ctx.upstreamsByIdMap) {
          if (seen.has(upstream.model)) continue;
          seen.add(upstream.model);
          items.push({ model_id: `${upstreamId}|${upstream.model}`, model_alias: upstream.model });
        }

        if (ctx.defaultUpstream && !seen.has(ctx.defaultUpstream.model)) {
          items.push({ model_id: ctx.defaultUpstream.model, model_alias: ctx.defaultUpstream.model });
        }

        let filteredItems = items;
        if (userInfo.allowedModels !== null) {
          filteredItems = items.filter(item => userInfo.allowedModels!.includes(item.model_id));
        }

        sendJSONResponse(res, 200, { items: filteredItems });
        return;
      }

      if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
        consumeBody(req);
        await new Promise<void>((r) => req.once('end', r));
        sendJSONResponse(res, 200, { input_tokens: 0 });
        return;
      }

      if (method === 'POST' && pathname === '/api/event_logging/batch') {
        consumeBody(req);
        await new Promise<void>((r) => req.once('end', r));
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'POST' && pathname === '/v1/messages') {
        await handleRequest(req, res, ctx);
        return;
      }

      if (method === 'GET' && pathname === '/pool-status') {
        if (!ctx.codePlanPool) {
          sendJSONResponse(res, 200, { pools: {} });
          return;
        }
        const pools: Record<string, { credentials: Array<{ id: string; model?: string; inCooldown: boolean; cooldownUntil?: number }> }> = {};
        const allKeys = new Set<string>();
        for (const [upstreamId] of ctx.upstreamsByIdMap) allKeys.add(upstreamId);
        allKeys.add('__default__');
        for (const key of allKeys) {
          if (!ctx.codePlanPool.hasCredentials(key)) continue;
          const status = ctx.codePlanPool.getPoolStatus(key);
          pools[key] = {
            credentials: status.map(c => ({
              id: c.credentialId,
              inCooldown: c.inCooldown,
              cooldownUntil: c.cooldownUntil,
            })),
          };
          const upstream = ctx.upstreamsByIdMap.get(key) ?? ctx.defaultUpstream;
          if (upstream?.codePlanCredentials) {
            for (const cred of upstream.codePlanCredentials) {
              const entry = pools[key].credentials.find(c => c.id === cred.id);
              if (entry && cred.model) entry.model = cred.model;
            }
          }
        }
        sendJSONResponse(res, 200, { pools });
        return;
      }

      sendErrorResponse(res, 404, `Not found: ${method} ${url}`, 'not_found_error');
    } catch (err) {
      logger.error('Unhandled error:', err);
      if (!res.headersSent) {
        sendErrorResponse(res, 500, 'Internal server error', 'api_error');
      }
    }
  });

  return server;
}
