import * as http from 'http';
import { logger } from './logger';
import { ProxyRuntimeContext, UpstreamConfig, ResolvedUpstream, resolveUpstreamFromModel } from './config';
import { CodePlanPoolManager, CODE_PLAN_COOLDOWN_MS, CODE_PLAN_SHORT_COOLDOWN_MS } from './codePlanPool';
import { classify429, parseQuotaResetEpochMs } from './codePlanQuota';
import { buildAnthropicMessagesURL } from './formatTransform';
import { appendUsageLog, formatUTC8, UsageLogExtra } from './usageLogger';
import { estimateRequestTokens, computeInputBudget, trimToFitBudget, isTokenExceedError, aggressiveTrimForRetry, getModelContextWindow } from './contextBudget';
import { buildMetricsPayload } from './metricsPayload';
import { handleAdminConfigRequest } from './configAdmin';

const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const STREAM_READ_TIMEOUT_MS = 180_000;

/** Small randomised pause before retrying a different credential. Prevents
 *  a burst of concurrent retries from re-triggering rate limits in lock-step. */
function sleepWithJitter(baseMs: number, jitterMs: number): Promise<void> {
  const delay = baseMs + Math.floor(Math.random() * jitterMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

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
  extra: Partial<UsageLogExtra>,
  recordMetric?: (success: boolean, inputTokens: number, outputTokens: number) => void,
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
    recordMetric?.(false, 0, 0);
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
          // Some providers (e.g. MiniMax M3) use OpenAI-compat field names
          // (prompt_tokens / completion_tokens) instead of Anthropic names
          state.inputTokens = Math.max(state.inputTokens, u.input_tokens ?? u.prompt_tokens ?? 0);
          state.outputTokens = Math.max(state.outputTokens, u.output_tokens ?? u.completion_tokens ?? 0);
          state.cachedInputTokens = Math.max(state.cachedInputTokens, extractCachedInputTokensFromUsage(u));
        }
        if (eventType === 'message_delta' && data.usage) {
          // MiniMax M3 reports real input_tokens in message_delta, not in message_start
          state.inputTokens = Math.max(state.inputTokens, data.usage.input_tokens ?? data.usage.prompt_tokens ?? 0);
          state.outputTokens = Math.max(state.outputTokens, data.usage.output_tokens ?? data.usage.completion_tokens ?? 0);
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

    recordMetric?.(state.sawMessageStop, state.inputTokens, state.outputTokens);

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

  const codePlanPoolKey = upstreamRouteId || '__default__';
  const hasCodePlan = !!(ctx.codePlanPool && upstream.codePlanCredentials?.length);

  // ─── Build Anthropic request (no format conversion) ───
  let effectiveModel = modelId || upstream.model;
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

  // Save a pristine copy of the request body so we can reset after failed attempts
  const pristineRequestBody = structuredClone(upstreamRequestBody);

  const usageExtra: Partial<UsageLogExtra> = {
    app: 'woicrew',
    username: userInfo.name,
    stream: parsedBody.stream === true,
    request_size: rawBody.length,
    session_id: typeof req.headers['x-woicrew-session-id'] === 'string' && req.headers['x-woicrew-session-id'] ? req.headers['x-woicrew-session-id'] as string : null,
    routing_key: upstreamRouteId ?? '__default__',
  };

  const USAGE_LOG_INPUT_FULLTEXT = process.env.WOICLAW_USAGE_LOG_INPUT_FULLTEXT;
  if (USAGE_LOG_INPUT_FULLTEXT === '1' || USAGE_LOG_INPUT_FULLTEXT === 'true') {
    usageExtra.input_fulltext = JSON.stringify(upstreamRequestBody);
  }

  // ─── Metrics: record one event per request exit (success AND failure) ───
  // `usageExtra.routing_key` is reassigned below (after the credential loop);
  // the closure reads it at call time, so all exit calls see the final credential.
  const startMs = new Date(startTime).getTime();
  const recordMetric = (success: boolean, inTok: number, outTok: number): void => {
    ctx.tokenUsage?.record(upstreamRouteId ?? '__default__', (inTok || 0) + (outTok || 0));
    ctx.metrics?.record({
      upstreamId: upstreamRouteId ?? '__default__',
      credentialId: usageExtra.routing_key ?? undefined,
      model: effectiveModel,
      success, inputTokens: inTok, outputTokens: outTok,
      costMs: Date.now() - startMs, ts: Date.now(),
    });
  };

  // ─── Code Plan credential retry loop ───
  // Each iteration picks a fresh credential from the pool (skipping cooldowns).
  // On network error / 429 / 5xx: mark cooldown, retry with next credential.
  // On 4xx client errors (non-429): return immediately — retrying won't help.
  // On 400 token errors: try trim first, then switch credential if still failing.
  let upstreamResponse: Response | null = null;
  let lastError: any = null;
  let pickedCredentialId: string | null = null;
  let effectiveApiKey = upstream.apiKey;
  let effectiveBaseURL = upstream.baseURL;
  const maxCredAttempts = hasCodePlan ? ((upstream.codePlanCredentials?.length ?? 0) + 1) : 1;
  let usedOrdinaryFallback = false;

  // **Fix #1**: Skip the "ordinary fallback" branch when it can't usefully run:
  //   (a) the upstream `apiKey` is empty — there's no real fallback configured;
  //   (b) the upstream `apiKey` duplicates one of the pooled credentials — hitting
  //       it again would just bounce off the same rate limit.
  // In both cases, surface the upstream 429 to the caller instead of looping.
  const ordinaryKeyIsPooled = !!(
    hasCodePlan &&
    (
      !upstream.apiKey ||
      upstream.codePlanCredentials?.some(c => c.apiKey === upstream.apiKey)
    )
  );

  for (let credAttempt = 0; credAttempt < maxCredAttempts; credAttempt++) {
    // **Fix #3**: release the in-flight slot of the previous credential before
    // picking the next one. pickOrFallback() increments on selection, so each
    // pick must be paired with a decInFlight() somewhere.
    if (hasCodePlan && pickedCredentialId !== null && !usedOrdinaryFallback) {
      ctx.codePlanPool?.decInFlight(codePlanPoolKey, pickedCredentialId);
    }

    // ── Select credential ──
    if (hasCodePlan) {
      const pick = ctx.codePlanPool!.pickOrFallback(
        codePlanPoolKey,
        typeof req.headers['x-woicrew-session-id'] === 'string' ? req.headers['x-woicrew-session-id'] : undefined
      );
      pickedCredentialId = pick.credentialId;

      if (pick.credentialId !== null) {
        effectiveApiKey = pick.apiKey;
        effectiveModel = pick.model ?? (modelId || upstream.model);
        if (upstream.codePlanAnthropicBaseURL) effectiveBaseURL = upstream.codePlanAnthropicBaseURL;
        else if (upstream.codePlanBaseURL) effectiveBaseURL = upstream.codePlanBaseURL;
        else effectiveBaseURL = upstream.baseURL;
        usedOrdinaryFallback = false;
        logger.verbose(`[${reqId}] CodePlan pick: ${pick.credentialId} (attempt=${credAttempt}) -> model: ${effectiveModel}`);
      } else if (ordinaryKeyIsPooled) {
        // **Fix #1 active path**: all pool keys are in cooldown and the ordinary
        // key is a duplicate of one of them. Hitting it again would just bounce
        // off the same rate limit. Surface the upstream 429 to the caller.
        logger.verbose(`[${reqId}] CodePlan: all credentials exhausted; ordinary key matches a pooled credential, skipping fallback`);
        pickedCredentialId = null;
        break;
      } else {
        // All code plan credentials exhausted — fallback to ordinary key
        effectiveApiKey = upstream.apiKey;
        effectiveBaseURL = upstream.baseURL;
        effectiveModel = modelId || upstream.model;
        usedOrdinaryFallback = true;
        pickedCredentialId = null;
        logger.verbose(`[${reqId}] CodePlan: all credentials exhausted, falling back to ordinary key`);
        if (upstream.ordinaryFallbackModelMap) {
          const mapped = upstream.ordinaryFallbackModelMap[effectiveModel];
          if (mapped) {
            effectiveModel = mapped;
            logger.verbose(`[${reqId}] CodePlan ordinary fallback model remap: ${modelId || upstream.model} -> ${mapped}`);
          }
        }
      }
    }

    // Update model in request body for this credential
    upstreamRequestBody.model = effectiveModel;

    // ── Build headers for this credential ──
    const upstreamHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': effectiveApiKey,
      'Authorization': `Bearer ${effectiveApiKey}`,
    };
    for (const hdr of ['anthropic-version', 'anthropic-beta']) {
      const val = req.headers[hdr];
      if (typeof val === 'string') {
        // DeepSeek's Anthropic-compatible endpoint doesn't recognize Claude
        // beta flags (context-1m, interleaved-thinking, fine-grained-tool-
        // streaming, …); forwarding them can trigger upstream errors or odd
        // behavior. Thinking itself is driven by the request-body `thinking`
        // field (passed through), not this header, so dropping it is safe.
        if (hdr === 'anthropic-beta' && provider === 'deepseek') {
          continue;
        }
        upstreamHeaders[hdr] = val;
      }
    }

    // ── Build target URLs from current effective base URL ──
    const targetURLs = buildAnthropicMessagesURL(effectiveBaseURL);

    // ── Try all target URLs for this credential ──
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

    // ── Success ──
    if (upstreamResponse && upstreamResponse.ok) {
      logger.verbose(`[${reqId}] CodePlan success with credential=${pickedCredentialId} (attempt=${credAttempt})`);
      break;
    }

    // ── Network error (no response) — mark cooldown and retry ──
    if (!upstreamResponse) {
      if (pickedCredentialId !== null && !usedOrdinaryFallback) {
        // Network errors are usually transient; short cooldown is sufficient.
        ctx.codePlanPool?.markCooldown(codePlanPoolKey, pickedCredentialId, CODE_PLAN_SHORT_COOLDOWN_MS, 'network');
        logger.verbose(`[${reqId}] CodePlan cooldown for ${pickedCredentialId} after network error, retrying with next credential`);
        await sleepWithJitter(50, 150);
        upstreamRequestBody = structuredClone(pristineRequestBody);
        continue;
      }
      // Ordinary key failed with network error — no more fallbacks
      break;
    }

    // ── Non-ok response ──
    let errText = '';
    try { errText = await upstreamResponse.clone().text(); } catch {}
    logger.verbose(`[${reqId}] Upstream error ${upstreamResponse.status}:`, errText.substring(0, 500));

    // ── Token trimming (per credential attempt) ──
    if (upstreamResponse.status === 400 && !usedOrdinaryFallback) {
      // Try clamping max_tokens if the error suggests a limit
      if (clampMaxTokensFromAnthropicError(errText, upstreamRequestBody)) {
        const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
          method: 'POST',
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamRequestBody),
        });
        if (retryResp.ok || retryResp.status !== 400) {
          upstreamResponse = retryResp;
          logger.verbose(`[${reqId}] CodePlan success after max_tokens clamp (attempt=${credAttempt})`);
          break;
        }
      }

      // Token-exceed retry loop
      for (let trimRound = 0; trimRound < 3; trimRound++) {
        if (upstreamResponse && upstreamResponse.ok) break;
        if (!isTokenExceedError(upstreamResponse.status, errText)) break;

        upstreamRequestBody = aggressiveTrimForRetry(upstreamRequestBody, trimRound);
        logger.verbose(`[${reqId}] Token exceed error, retry round ${trimRound + 1}/3 with aggressively trimmed context`);
        const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
          method: 'POST',
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamRequestBody),
        });
        upstreamResponse = retryResp;
        if (!upstreamResponse.ok) {
          try { errText = await upstreamResponse.clone().text(); } catch {}
        }
      }
      if (upstreamResponse && upstreamResponse.ok) {
        logger.verbose(`[${reqId}] CodePlan success after token trim (attempt=${credAttempt})`);
        break;
      }
    }

    // ── Mark credential cooldown on failure ──
    // **Fix #2**: classify 429 — short cooldown for QPS/concurrency bursts,
    // long cooldown only for true quota exhaustion.
    if (pickedCredentialId !== null && !usedOrdinaryFallback) {
      let cooldownMs = CODE_PLAN_SHORT_COOLDOWN_MS;
      const cls = classify429(upstreamResponse.status, errText);
      if (cls === 'quota') {
        cooldownMs = CODE_PLAN_COOLDOWN_MS;
        const resetMs = parseQuotaResetEpochMs(errText);
        if (resetMs) cooldownMs = Math.max(resetMs - Date.now(), CODE_PLAN_COOLDOWN_MS);
      }
      ctx.codePlanPool?.markCooldown(codePlanPoolKey, pickedCredentialId, cooldownMs, cls === 'quota' ? 'quota' : 'rate_limit');
      logger.verbose(`[${reqId}] CodePlan cooldown for ${pickedCredentialId}: ${cooldownMs}ms (class=${cls})`);
    }

    // ── Decide whether to retry with next credential ──
    // 4xx client errors (non-429, non-400) are not retryable
    if (upstreamResponse.status >= 400 && upstreamResponse.status < 500 &&
        upstreamResponse.status !== 429 && upstreamResponse.status !== 400) {
      logger.verbose(`[${reqId}] Non-retryable client error ${upstreamResponse.status}, not switching credential`);
      break;
    }

    // Ordinary key failed — no more fallbacks
    if (usedOrdinaryFallback) {
      logger.verbose(`[${reqId}] Ordinary fallback failed with status ${upstreamResponse.status}, giving up`);
      break;
    }

    // **Fix #4**: jitter sleep before retrying with a different credential.
    // Without it, a burst of concurrent retries lands on the next key in
    // lock-step and can re-trigger short-window rate limits across the pool.
    if (upstreamResponse.status === 429 || upstreamResponse.status >= 500) {
      await sleepWithJitter(50, 150);
    }

    // Reset request body and retry with next credential
    logger.verbose(`[${reqId}] Retrying with next credential (attempt=${credAttempt})`);
    upstreamRequestBody = structuredClone(pristineRequestBody);
    upstreamResponse = null;
  }

  // Update usage extra with the final credential that was used
  usageExtra.routing_key = pickedCredentialId ?? upstreamRouteId ?? '__default__';

  // Release the in-flight slot of the final picked credential AFTER the
  // response is fully sent. Tracking in-flight across the whole request
  // (streaming included) is what lets pickOrFallback load-balance and what
  // /pool-status reports as real concurrent load — releasing at header time
  // left it permanently ~0 and defeated both. try/finally guarantees the
  // release runs on every exit path, including a stream handler throw, so the
  // slot can never leak.
  const releasePick = (): void => {
    if (hasCodePlan && pickedCredentialId !== null && !usedOrdinaryFallback) {
      ctx.codePlanPool?.decInFlight(codePlanPoolKey, pickedCredentialId);
    }
  };

  try {
    // ── Final error check ──
    if (!upstreamResponse) {
      recordMetric(false, 0, 0);
      sendErrorResponse(res, 502, `Upstream request failed: ${lastError?.message || 'unknown'}`, 'api_error');
      return;
    }

    if (!upstreamResponse.ok) {
      let errText = '';
      try { errText = await upstreamResponse.clone().text(); } catch {}
      recordMetric(false, 0, 0);
      sendErrorResponse(res, upstreamResponse.status, `Upstream error: ${errText.substring(0, 200)}`, 'api_error');
      return;
    }
    if (parsedBody.stream) {
      await handleAnthropicStreamResponse(upstreamResponse, req, res, clientId, effectiveModel, startTime, upstreamRequestBody, usageExtra, recordMetric);
      return;
    }

    // ─── Non-stream response: pass Anthropic response directly ───
    let anthropicResp: any;
    try {
      anthropicResp = await upstreamResponse.json();
    } catch {
      recordMetric(false, 0, 0);
      sendErrorResponse(res, 502, 'Failed to parse upstream response', 'api_error');
      return;
    }

    const inputContent = buildTrimmedInputContentForUsageLog(upstreamRequestBody);
    const outputContent = extractOutputContentFromAnthropicResponse(anthropicResp);
    const respUsage = anthropicResp.usage || { input_tokens: 0, output_tokens: 0 };
    // Some providers use OpenAI-compat field names (prompt_tokens / completion_tokens)
    const inputTokens = respUsage.input_tokens ?? respUsage.prompt_tokens ?? 0;
    const outputTokens = respUsage.output_tokens ?? respUsage.completion_tokens ?? 0;

    appendUsageLog(clientId, effectiveModel, startTime, inputTokens, outputTokens, {
      ...usageExtra,
      input_cached_token: extractCachedInputTokensFromUsage(anthropicResp.usage),
      input_content: inputContent,
      output_content: outputContent,
      response_size: JSON.stringify(anthropicResp).length,
    } as UsageLogExtra);

    recordMetric(true, inputTokens, outputTokens);
    sendJSONResponse(res, 200, anthropicResp);
  } finally {
    releasePick();
  }
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
        const pools: Record<string, { credentials: Array<{ id: string; model?: string; inCooldown: boolean; cooldownReason?: string; cooldownUntil?: number; requestsLast1h: number; inFlight: number }> }> = {};
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
              cooldownReason: c.cooldownReason,
              cooldownUntil: c.cooldownUntil,
              requestsLast1h: c.requestsLast1h,
              inFlight: ctx.codePlanPool!.getInFlight(key, c.credentialId),
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

      if (method === 'GET' && pathname === '/metrics') {
        // Auth aligned with /models (NOT the unauthenticated /pool-status).
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

        sendJSONResponse(res, 200, buildMetricsPayload(ctx));
        return;
      }

      if (pathname.startsWith('/admin/config')) {
        // Auth aligned with /models and /metrics (NOT the unauthenticated /pool-status).
        // WOICLAW_AUTH_BYPASS still works via authenticateRequest's bypass branch.
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

        await handleAdminConfigRequest(req, res, ctx);
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
