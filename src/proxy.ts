import * as http from 'http';
import { logger } from './logger';
import { ProxyRuntimeContext, UpstreamConfig, ResolvedUpstream, resolveUpstreamFromModel } from './config';
import { CodePlanPoolManager, CODE_PLAN_COOLDOWN_MS } from './codePlanPool';
import { isQuotaLimitedResponse, parseQuotaResetEpochMs } from './codePlanQuota';
import { anthropicToOpenAI, openAIToAnthropic, buildUpstreamTargetUrls } from './formatTransform';
import { appendUsageLog, formatUTC8, UsageLogExtra } from './usageLogger';
import { estimateRequestTokens, computeInputBudget, trimToFitBudget, isTokenExceedError, aggressiveTrimForRetry, getModelContextWindow } from './contextBudget';

const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const STREAM_READ_TIMEOUT_MS = 180_000;
const MAX_TOOL_CALL_EXTRA_CONTENT_CACHE = 1024;
const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

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

// ─── Tool extra_content cache (process-level, FIFO) ───

const toolCallExtraContentById = new Map<string, unknown>();

function cacheToolCallExtraContent(id: string, extra: unknown): void {
  if (toolCallExtraContentById.size >= MAX_TOOL_CALL_EXTRA_CONTENT_CACHE) {
    const oldest = toolCallExtraContentById.keys().next().value;
    if (oldest !== undefined) toolCallExtraContentById.delete(oldest);
  }
  toolCallExtraContentById.set(id, extra);
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

// ─── Auth ───

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

async function authenticateRequest(token: string): Promise<{ name: string } | null> {
  if (isAuthBypassed()) {
    return { name: 'bypass' };
  }

  const authHost = getAuthHost();
  const proxyKey = getProxyApiKey();

  // 如果配置了 introspect 端点，优先尝试 introspect
  if (authHost) {
    logger.verbose('[auth] Trying introspect first (authHost configured)');
    const userInfo = await fetchUserInfo(token);
    if (userInfo) {
      logger.verbose('[auth] Introspect succeeded, got user:', userInfo.name);
      return userInfo;
    }
    logger.verbose('[auth] Introspect failed, falling back');
  }

  // fallback 到 proxy key 逻辑
  if (proxyKey) {
    if (token === proxyKey) {
      return { name: 'local' };
    }
    return null;
  }

  return null;
}

function isLikelyJwt(token: string): boolean {
  // JWT 格式: xxxxx.yyyyy.zzzzz
  const parts = token.split('.');
  return parts.length === 3;
}

async function fetchUserInfo(token: string): Promise<{ name: string } | null> {
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
    // 使用 Bearer token 方式（CrewCentral introspect 端点）
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

    return { name: name.trim() };
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

// ─── Provider pipeline helpers ───

function resolveUpstreamAPIType(provider?: string): 'responses' | 'chat_completions' {
  return provider?.toLowerCase() === 'openai' ? 'responses' : 'chat_completions';
}

function filterOpenAIToolsForProvider(openAIReq: any, provider?: string): void {
  if (provider?.toLowerCase() !== 'openai') return;
  if (Array.isArray(openAIReq.tools)) {
    openAIReq.tools = openAIReq.tools.filter((t: any) => t?.function?.name !== 'skill');
    if (openAIReq.tools.length === 0) delete openAIReq.tools;
  }
  if (openAIReq.tool_choice && typeof openAIReq.tool_choice === 'object' && openAIReq.tool_choice.function?.name === 'skill') {
    openAIReq.tool_choice = 'auto';
  }
}

function remapMessageRolesForMiniMax(openAIReq: any, provider?: string): void {
  if (provider?.toLowerCase() !== 'minimax') return;
  if (!Array.isArray(openAIReq.messages)) return;
  for (const msg of openAIReq.messages) {
    if (msg.role === 'developer') msg.role = 'system';
  }
}

function isGeminiProvider(provider?: string, baseURL?: string): boolean {
  if (provider?.toLowerCase() === 'gemini') return true;
  if (baseURL && baseURL.includes('generativelanguage.googleapis.com')) return true;
  return false;
}

function normalizeToolCallExtraContent(tc: any): unknown | undefined {
  if (tc.extra_content !== undefined) return tc.extra_content;
  if (tc.function?.thought_signature !== undefined) return { thought_signature: tc.function.thought_signature };
  return undefined;
}

function hydrateOpenAIRequestToolCalls(openAIReq: any, gemini: boolean): void {
  if (!Array.isArray(openAIReq.messages)) return;
  for (const msg of openAIReq.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (tc.extra_content !== undefined) continue;
      const cached = toolCallExtraContentById.get(tc.id);
      if (cached !== undefined) {
        tc.extra_content = cached;
      } else if (gemini) {
        tc.extra_content = { thought_signature: GEMINI_FALLBACK_THOUGHT_SIGNATURE };
      }
    }
  }
}

const OPENAI_NEW_MODEL_PATTERN = /^(gpt-5|o[134])/i;

function normalizeMaxTokensFieldForOpenAIProvider(openAIReq: any, provider?: string): void {
  if (provider?.toLowerCase() !== 'openai') return;
  if (!openAIReq.max_tokens) return;
  const model = (openAIReq.model || '').toLowerCase();
  if (OPENAI_NEW_MODEL_PATTERN.test(model)) {
    openAIReq.max_completion_tokens = openAIReq.max_tokens;
    delete openAIReq.max_tokens;
  }
}

function mergeSystemMessagesForProvider(openAIReq: any): void {
  if (!Array.isArray(openAIReq.messages)) return;
  const systemMsgs: string[] = [];
  const rest: any[] = [];
  for (const msg of openAIReq.messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      systemMsgs.push(text);
    } else {
      rest.push(msg);
    }
  }
  if (systemMsgs.length <= 1) return;
  openAIReq.messages = [{ role: 'system', content: systemMsgs.join('\n\n') }, ...rest];
}

// ─── Responses API conversion ───

function convertChatCompletionsRequestToResponsesRequest(openAIReq: any): any {
  const input: any[] = [];

  if (Array.isArray(openAIReq.messages)) {
    for (const msg of openAIReq.messages) {
      if (msg.role === 'system') {
        input.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      } else if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments || '{}',
            });
          }
        } else {
          input.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' });
        }
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      }
    }
  }

  const responsesReq: any = {
    model: openAIReq.model,
    input,
    stream: openAIReq.stream,
  };

  if (openAIReq.max_tokens) responsesReq.max_output_tokens = openAIReq.max_tokens;
  if (openAIReq.max_completion_tokens) responsesReq.max_output_tokens = openAIReq.max_completion_tokens;
  if (openAIReq.temperature !== undefined) responsesReq.temperature = openAIReq.temperature;
  if (openAIReq.top_p !== undefined) responsesReq.top_p = openAIReq.top_p;

  if (Array.isArray(openAIReq.tools) && openAIReq.tools.length > 0) {
    responsesReq.tools = openAIReq.tools.map((t: any) => ({
      type: 'function',
      name: t.function?.name,
      description: t.function?.description,
      parameters: t.function?.parameters,
    }));
  }

  return responsesReq;
}

function convertResponsesToOpenAIResponse(responsesBody: any): any {
  const choices: any[] = [];
  const message: any = { role: 'assistant', content: '' };
  const toolCalls: any[] = [];

  if (Array.isArray(responsesBody.output)) {
    for (const item of responsesBody.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'output_text') {
            message.content += part.text || '';
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' },
        });
      }
    }
  }

  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  choices.push({
    index: 0,
    message,
    finish_reason: responsesBody.status === 'completed' ? 'stop' : (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
  });

  return {
    id: responsesBody.id || `chatcmpl-resp-${Date.now()}`,
    model: responsesBody.model,
    choices,
    usage: responsesBody.usage ? {
      prompt_tokens: responsesBody.usage.input_tokens ?? 0,
      completion_tokens: responsesBody.usage.output_tokens ?? 0,
    } : undefined,
  };
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
      tailPreview = c.map((p: any) => p.text || `[${p.type || 'unknown'}]`).join(' ');
    } else if (last.role === 'tool') {
      tailPreview = `[tool_result] ${typeof c === 'string' ? c : ''}`;
    } else if (last.role === 'assistant' && Array.isArray(last.tool_calls)) {
      tailPreview = `[tool_calls] ${last.tool_calls.map((tc: any) => tc.function?.name || '').join(',')}`;
    }
    if (tailPreview.length > USAGE_LOG_TAIL_PREVIEW_MAX) {
      tailPreview = tailPreview.substring(0, USAGE_LOG_TAIL_PREVIEW_MAX);
    }
  }
  return JSON.stringify({ model: upstreamReq.model, tail_role: tailRole, tail_preview: tailPreview });
}

function extractOutputContentFromAnthropicResponse(anthropicResp: any): string {
  if (!Array.isArray(anthropicResp.content)) return '';
  return anthropicResp.content
    .filter((b: any) => b.type === 'text' || b.type === 'thinking')
    .map((b: any) => b.text || b.thinking || '')
    .join('');
}

// ─── Streaming: Chat Completions ───

interface StreamState {
  contentIndex: number;
  currentBlockType: string | null;
  toolCalls: Map<number, { id: string; name: string; argumentsBuffer: string; extraContent?: unknown }>;
  lastUsage: { input_tokens: number; output_tokens: number; input_cached_token: number };
  messageStarted: boolean;
  messageStopped: boolean;
  outputAccumulator: string[];
  messageId: string;
  messageModel: string;
  /** MiniMax OpenAI-compat: each chunk may carry full text prefix, not only new tokens. */
  lastCumulativeText?: string;
  lastCumulativeThinking?: string;
  emittedMessageDelta: boolean;
}

function createStreamState(): StreamState {
  return {
    contentIndex: 0,
    currentBlockType: null,
    toolCalls: new Map(),
    lastUsage: { input_tokens: 0, output_tokens: 0, input_cached_token: 0 },
    messageStarted: false,
    messageStopped: false,
    outputAccumulator: [],
    messageId: '',
    messageModel: '',
    emittedMessageDelta: false,
  };
}

function closeCurrentBlockIfNeeded(state: StreamState, res: http.ServerResponse): void {
  if (state.currentBlockType !== null) {
    res.write(formatSSEEvent('content_block_stop', { type: 'content_block_stop', index: state.contentIndex }));
    state.contentIndex++;
    state.currentBlockType = null;
  }
}

function ensureMessageStart(state: StreamState, res: http.ServerResponse, chunk: any): void {
  if (state.messageStarted) return;
  state.messageId = chunk.id || `msg_${Date.now()}`;
  if (!state.messageModel) {
    state.messageModel = chunk.model || '';
  }
  state.messageStarted = true;
  res.write(formatSSEEvent('message_start', {
    type: 'message_start',
    message: {
      id: state.messageId, type: 'message', role: 'assistant', model: state.messageModel,
      content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  }));
}

function ensureThinkingBlock(state: StreamState, res: http.ServerResponse): void {
  if (state.currentBlockType === 'thinking') return;
  closeCurrentBlockIfNeeded(state, res);
  state.currentBlockType = 'thinking';
  res.write(formatSSEEvent('content_block_start', {
    type: 'content_block_start', index: state.contentIndex,
    content_block: { type: 'thinking', thinking: '' },
  }));
}

function ensureTextBlock(state: StreamState, res: http.ServerResponse): void {
  if (state.currentBlockType === 'text') return;
  closeCurrentBlockIfNeeded(state, res);
  state.currentBlockType = 'text';
  res.write(formatSSEEvent('content_block_start', {
    type: 'content_block_start', index: state.contentIndex,
    content_block: { type: 'text', text: '' },
  }));
}

function ensureToolUseBlock(state: StreamState, res: http.ServerResponse, toolIndex: number, tc: any): void {
  const existing = state.toolCalls.get(toolIndex);
  if (existing) return;

  closeCurrentBlockIfNeeded(state, res);
  state.currentBlockType = 'tool_use';

  const toolState = { id: tc.id || '', name: tc.function?.name || '', argumentsBuffer: '', extraContent: undefined as unknown };
  state.toolCalls.set(toolIndex, toolState);

  res.write(formatSSEEvent('content_block_start', {
    type: 'content_block_start', index: state.contentIndex,
    content_block: { type: 'tool_use', id: toolState.id, name: toolState.name, input: {} },
  }));
}

function extractCachedInputTokensFromUsage(usage: any): number {
  if (!usage) return 0;
  let cached = 0;

  for (const detailsKey of ['input_token_details', 'inputTokenDetails', 'prompt_tokens_details', 'promptTokensDetails']) {
    let details = usage[detailsKey];
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { continue; } }
    if (details && typeof details === 'object') {
      for (const k of ['cached_tokens', 'cachedTokens', 'cache_hit_tokens', 'cacheHitTokens']) {
        if (typeof details[k] === 'number') cached = Math.max(cached, details[k]);
      }
    }
  }

  for (const k of ['cached_tokens', 'prompt_cache_hit_tokens']) {
    if (typeof usage[k] === 'number') cached = Math.max(cached, usage[k]);
  }

  return cached;
}

function normalizeChunkUsage(chunk: any): { input_tokens: number; output_tokens: number; input_cached_token: number } | null {
  const usage = chunk.usage;
  if (!usage) return null;
  const inp = (usage.prompt_tokens ?? usage.input_tokens ?? 0) as number;
  const out = (usage.completion_tokens ?? usage.output_tokens ?? 0) as number;
  const cached = extractCachedInputTokensFromUsage(usage);
  if (inp === 0 && out === 0 && cached === 0) return null;
  return { input_tokens: inp, output_tokens: out, input_cached_token: cached };
}

function mergeUsageIntoState(state: StreamState, usage: { input_tokens: number; output_tokens: number; input_cached_token: number }): void {
  state.lastUsage.input_tokens = Math.max(state.lastUsage.input_tokens, usage.input_tokens);
  state.lastUsage.output_tokens = Math.max(state.lastUsage.output_tokens, usage.output_tokens);
  state.lastUsage.input_cached_token = Math.max(state.lastUsage.input_cached_token, usage.input_cached_token);
}

function mapStopReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': case 'function_call': return 'tool_use';
    default: return null;
  }
}

function emitMessageDelta(state: StreamState, res: http.ServerResponse, finishReason: string | null, chunkUsage?: any): void {
  closeCurrentBlockIfNeeded(state, res);
  const usageForDelta = chunkUsage ? {
    input_tokens: chunkUsage.prompt_tokens ?? chunkUsage.input_tokens ?? 0,
    output_tokens: chunkUsage.completion_tokens ?? chunkUsage.output_tokens ?? 0,
  } : { output_tokens: state.lastUsage.output_tokens };

  res.write(formatSSEEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(finishReason) },
    usage: usageForDelta,
  }));
  state.emittedMessageDelta = true;
}

function flushDone(state: StreamState, res: http.ServerResponse): void {
  if (state.messageStarted && !state.messageStopped) {
    closeCurrentBlockIfNeeded(state, res);
    if (!state.emittedMessageDelta) {
      res.write(formatSSEEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: null },
        usage: { input_tokens: state.lastUsage.input_tokens, output_tokens: state.lastUsage.output_tokens },
      }));
      state.emittedMessageDelta = true;
    }
    if (!state.messageStopped) {
      res.write(formatSSEEvent('message_stop', { type: 'message_stop' }));
      state.messageStopped = true;
    }
  }
}

function extractDeltaTextForStream(delta: any): string | null {
  const c = delta?.content;
  if (c == null || c === '') return null;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const p of c) {
      if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text);
      else if (typeof p === 'string') parts.push(p);
    }
    return parts.length ? parts.join('') : null;
  }
  return null;
}

function extractReasoningDeltaForStream(delta: any): string | null {
  const r = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof r === 'string' && r.length > 0) return r;
  const rd = delta?.reasoning_details;
  if (!Array.isArray(rd)) return null;
  const joined = rd.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('');
  return joined.length > 0 ? joined : null;
}

function sliceCumulativeDelta(full: string, state: StreamState, key: 'lastCumulativeText' | 'lastCumulativeThinking'): string {
  const prev = state[key] ?? '';
  if (full.startsWith(prev)) {
    state[key] = full;
    return full.slice(prev.length);
  }
  state[key] = full;
  return full;
}

interface OpenAIStreamChunkOptions {
  minimaxCumulativeDelta: boolean;
}

function processOpenAIChunk(chunk: any, state: StreamState, res: http.ServerResponse, streamOpts: OpenAIStreamChunkOptions): void {
  ensureMessageStart(state, res, chunk);

  const chunkUsage = normalizeChunkUsage(chunk);
  if (chunkUsage) mergeUsageIntoState(state, chunkUsage);

  const choice = chunk.choices?.[0];
  if (!choice) return;

  const delta = choice.delta;
  if (!delta) {
    if (choice.finish_reason) {
      emitMessageDelta(state, res, choice.finish_reason, chunk.usage);
    }
    return;
  }

  const reasoningFull = extractReasoningDeltaForStream(delta);
  if (reasoningFull) {
    const reasoningEmit = streamOpts.minimaxCumulativeDelta
      ? sliceCumulativeDelta(reasoningFull, state, 'lastCumulativeThinking')
      : reasoningFull;
    if (reasoningEmit) {
      ensureThinkingBlock(state, res);
      res.write(formatSSEEvent('content_block_delta', {
        type: 'content_block_delta', index: state.contentIndex,
        delta: { type: 'thinking_delta', thinking: reasoningEmit },
      }));
      state.outputAccumulator.push(reasoningEmit);
    }
  }

  const textFull = extractDeltaTextForStream(delta);
  if (textFull !== null && textFull !== '') {
    const textEmit = streamOpts.minimaxCumulativeDelta
      ? sliceCumulativeDelta(textFull, state, 'lastCumulativeText')
      : textFull;
    if (textEmit) {
      ensureTextBlock(state, res);
      res.write(formatSSEEvent('content_block_delta', {
        type: 'content_block_delta', index: state.contentIndex,
        delta: { type: 'text_delta', text: textEmit },
      }));
      state.outputAccumulator.push(textEmit);
    }
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const toolIndex = tc.index ?? 0;
      ensureToolUseBlock(state, res, toolIndex, tc);
      const toolState = state.toolCalls.get(toolIndex)!;

      if (tc.id && !toolState.id) toolState.id = tc.id;
      if (tc.function?.name && !toolState.name) toolState.name = tc.function.name;

      const extraContent = normalizeToolCallExtraContent(tc);
      if (extraContent !== undefined) {
        toolState.extraContent = extraContent;
        if (tc.id) cacheToolCallExtraContent(tc.id, extraContent);
      }

      if (tc.function?.arguments) {
        toolState.argumentsBuffer += tc.function.arguments;
        res.write(formatSSEEvent('content_block_delta', {
          type: 'content_block_delta', index: state.contentIndex,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        }));
      }
    }
  }

  if (choice.finish_reason) {
    emitMessageDelta(state, res, choice.finish_reason, chunk.usage);
  }
}

/** Pop one SSE event block; supports both LF and CRLF framing (OpenAI uses LF; some upstreams use CRLF). */
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

async function handleChatCompletionsStreamResponse(
  upstreamResponse: Response,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientid: string,
  modelid: string,
  startTime: string,
  upstreamReq: any,
  extra: Partial<UsageLogExtra>,
  upstreamProvider?: string
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  const state = createStreamState();
  state.messageModel = modelid;
  const streamOpts: OpenAIStreamChunkOptions = {
    minimaxCumulativeDelta: upstreamProvider?.toLowerCase() === 'minimax',
  };
  const body = upstreamResponse.body;
  if (!body) {
    res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: 'Empty upstream response body' } }));
    res.end();
    appendUsageLog(clientid, modelid, startTime, 0, 0, extra as UsageLogExtra);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abortSignal = { aborted: false };

  const onClose = () => { abortSignal.aborted = true; };
  req.once('close', onClose);
  res.once('close', onClose);

  let sawDone = false;
  const processBuffer = (): void => {
    let popped: { packet: string; rest: string } | null;
    while ((popped = popSSEPacket(buffer))) {
      buffer = popped.rest;
      const lines = popped.packet.split(/\r?\n/);
      const dataLines: string[] = [];
      for (const l of lines) {
        if (l.startsWith('data:')) dataLines.push(l.substring(5).trim());
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('');

      if (payload === '[DONE]') {
        sawDone = true;
        return;
      }

      try {
        const chunk = JSON.parse(payload);
        processOpenAIChunk(chunk, state, res, streamOpts);
      } catch (parseErr) {
        logger.verbose('SSE chunk parse error:', parseErr);
      }
    }
  };

  try {
    while (!sawDone && !abortSignal.aborted) {
      const result = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, abortSignal);
      if (result.done) {
        buffer += decoder.decode(new Uint8Array(), { stream: false });
        processBuffer();
        break;
      }
      buffer += decoder.decode(result.value!, { stream: true });
      processBuffer();
    }
    if (!abortSignal.aborted) {
      buffer += decoder.decode(new Uint8Array(), { stream: false });
      processBuffer();
    }
  } catch (err) {
    logger.error('Stream error:', err);
    if (state.messageStarted && !state.messageStopped) {
      res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } }));
    }
  } finally {
    reader.cancel().catch(() => {});
    flushDone(state, res);

    const inputContent = buildTrimmedInputContentForUsageLog(upstreamReq);
    const outputContent = state.outputAccumulator.join('');
    appendUsageLog(clientid, modelid, startTime, state.lastUsage.input_tokens, state.lastUsage.output_tokens, {
      ...extra,
      input_cached_token: state.lastUsage.input_cached_token,
      input_content: inputContent,
      output_content: outputContent,
    } as UsageLogExtra);

    res.end();
  }
}

// ─── Streaming: Responses API ───

interface ResponsesStreamContext {
  functionCalls: Map<number, { callId: string; name: string; argumentsBuffer: string; outputIndex: number }>;
}

async function handleResponsesStreamResponse(
  upstreamResponse: Response,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientid: string,
  modelid: string,
  startTime: string,
  upstreamReq: any,
  extra: Partial<UsageLogExtra>
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  const state = createStreamState();
  state.messageModel = modelid;
  const rctx: ResponsesStreamContext = { functionCalls: new Map() };
  const body = upstreamResponse.body;
  if (!body) {
    res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: 'Empty upstream response body' } }));
    res.end();
    appendUsageLog(clientid, modelid, startTime, 0, 0, extra as UsageLogExtra);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abortSignal = { aborted: false };

  const onClose = () => { abortSignal.aborted = true; };
  req.once('close', onClose);
  res.once('close', onClose);

  const processResponsesBuffer = (): void => {
    let popped: { packet: string; rest: string } | null;
    while ((popped = popSSEPacket(buffer))) {
      buffer = popped.rest;
      let eventType = '';
      const dataLines: string[] = [];
      for (const l of popped.packet.split(/\r?\n/)) {
        if (l.startsWith('event:')) eventType = l.substring(6).trim();
        else if (l.startsWith('data:')) dataLines.push(l.substring(5).trim());
      }
      if (dataLines.length === 0) continue;

      try {
        const data = JSON.parse(dataLines.join(''));
        processResponsesStreamEvent(eventType, data, state, rctx, res);
      } catch (parseErr) {
        logger.verbose('Responses SSE parse error:', parseErr);
      }
    }
  };

  try {
    while (!abortSignal.aborted) {
      const result = await readWithTimeout(reader, STREAM_READ_TIMEOUT_MS, abortSignal);
      if (result.done) {
        buffer += decoder.decode(new Uint8Array(), { stream: false });
        processResponsesBuffer();
        break;
      }
      buffer += decoder.decode(result.value!, { stream: true });
      processResponsesBuffer();
    }
    if (!abortSignal.aborted) {
      buffer += decoder.decode(new Uint8Array(), { stream: false });
      processResponsesBuffer();
    }
  } catch (err) {
    logger.error('Responses stream error:', err);
    if (state.messageStarted && !state.messageStopped) {
      res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } }));
    }
  } finally {
    reader.cancel().catch(() => {});
    flushDone(state, res);

    const inputContent = buildTrimmedInputContentForUsageLog(upstreamReq);
    const outputContent = state.outputAccumulator.join('');
    appendUsageLog(clientid, modelid, startTime, state.lastUsage.input_tokens, state.lastUsage.output_tokens, {
      ...extra,
      input_cached_token: state.lastUsage.input_cached_token,
      input_content: inputContent,
      output_content: outputContent,
    } as UsageLogExtra);

    res.end();
  }
}

function processResponsesStreamEvent(
  eventType: string,
  data: any,
  state: StreamState,
  rctx: ResponsesStreamContext,
  res: http.ServerResponse
): void {
  if (eventType === 'response.created' || eventType === 'response.in_progress') {
    ensureMessageStart(state, res, { id: data.id || `msg_${Date.now()}`, model: data.model || '' });
    return;
  }

  if (eventType === 'response.output_text.delta') {
    ensureMessageStart(state, res, { id: state.messageId, model: state.messageModel });
    ensureTextBlock(state, res);
    const text = data.delta || '';
    res.write(formatSSEEvent('content_block_delta', {
      type: 'content_block_delta', index: state.contentIndex,
      delta: { type: 'text_delta', text },
    }));
    state.outputAccumulator.push(text);
    return;
  }

  if (eventType === 'response.function_call_arguments.delta') {
    const outputIndex = data.output_index ?? 0;
    let fc = rctx.functionCalls.get(outputIndex);
    if (!fc) {
      fc = { callId: data.call_id || '', name: data.name || '', argumentsBuffer: '', outputIndex };
      rctx.functionCalls.set(outputIndex, fc);
      closeCurrentBlockIfNeeded(state, res);
      state.currentBlockType = 'tool_use';
      res.write(formatSSEEvent('content_block_start', {
        type: 'content_block_start', index: state.contentIndex,
        content_block: { type: 'tool_use', id: fc.callId, name: fc.name, input: {} },
      }));
    }
    const argDelta = data.delta || '';
    fc.argumentsBuffer += argDelta;
    res.write(formatSSEEvent('content_block_delta', {
      type: 'content_block_delta', index: state.contentIndex,
      delta: { type: 'input_json_delta', partial_json: argDelta },
    }));
    return;
  }

  if (eventType === 'response.function_call_arguments.done') {
    return;
  }

  if (eventType === 'response.output_text.done') {
    return;
  }

  if (eventType === 'response.completed') {
    if (data.response?.usage) {
      const u = data.response.usage;
      mergeUsageIntoState(state, {
        input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
        output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
        input_cached_token: extractCachedInputTokensFromUsage(u),
      });
    }
    const stopReason = data.response?.status === 'completed' ? 'end_turn' : 'end_turn';
    emitMessageDelta(state, res, 'stop', data.response?.usage);
    return;
  }
}

// ─── 400 retry helpers ───

function isToolsUnsupportedError(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('tools') && (lower.includes('not support') || lower.includes('unsupported') || lower.includes('unknown'));
}

function stripToolsFromRequest(openAIReq: any): void {
  delete openAIReq.tools;
  delete openAIReq.tool_choice;
}

function isMaxTokensUnsupportedError(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('max_tokens') && (lower.includes('not support') || lower.includes('unknown') || lower.includes('invalid'));
}

function convertMaxTokensToMaxCompletionTokens(openAIReq: any): void {
  if (openAIReq.max_tokens) {
    openAIReq.max_completion_tokens = openAIReq.max_tokens;
    delete openAIReq.max_tokens;
  }
}

function clampMaxTokensFromError(bodyText: string, openAIReq: any): boolean {
  const match = bodyText.match(/max.*?(\d{2,})/i);
  if (match) {
    const limit = parseInt(match[1], 10);
    if (limit > 0) {
      if (openAIReq.max_tokens) openAIReq.max_tokens = Math.min(openAIReq.max_tokens, limit);
      if (openAIReq.max_completion_tokens) openAIReq.max_completion_tokens = Math.min(openAIReq.max_completion_tokens, limit);
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

  const clientApiKeyRaw = extractClientApiKey(req);
  if (!clientApiKeyRaw && !isAuthBypassed()) {
    sendErrorResponse(res, 401, 'Missing API key', 'authentication_error');
    return;
  }
  const clientId = clientApiKeyRaw || 'bypass';

  // 优先从 header 读取用户名（效率更高）
  let userInfo: { name: string } | null = null;
  const xUserRaw = req.headers['x-llm-proxy-user'] || req.headers['x-show-name'];
  const xUser = Array.isArray(xUserRaw) ? xUserRaw[0] : xUserRaw;
  logger.verbose(`[${reqId}] Auth debug:`, {
    hasXllmProxyUser: !!req.headers['x-llm-proxy-user'],
    hasXShowName: !!req.headers['x-show-name'],
    xUserValue: xUser ? `${xUser.substring(0, 20)}...` : undefined,
    clientIdLength: clientId?.length,
    clientIdPrefix: clientId ? `${clientId.substring(0, 20)}...` : undefined,
    isLikelyJwt: clientId ? isLikelyJwt(clientId) : false,
  });

  if (typeof xUser === 'string' && xUser.trim()) {
    // 客户端用 encodeURIComponent 编码非 ASCII 用户名，此处还原
    let decoded = xUser.trim();
    try { decoded = decodeURIComponent(decoded); } catch {}
    userInfo = { name: decoded };
    logger.verbose(`[${reqId}] Using username from header:`, userInfo.name);
  } else {
    userInfo = await authenticateRequest(clientId);
    logger.verbose(`[${reqId}] Using username from authenticateRequest:`, userInfo?.name);
  }
  if (!userInfo) {
    sendErrorResponse(res, 401, 'Authentication failed', 'authentication_error');
    return;
  }

  const resolved = resolveUpstreamFromModel(model, ctx.upstreamsByIdMap, ctx.defaultUpstream, ctx.modelRoutesMap);
  if (!resolved) {
    sendErrorResponse(res, 403, 'No upstream configured for this model', 'permission_error');
    return;
  }

  const { upstream, modelId, upstreamRouteId } = resolved;
  logger.verbose(`[${reqId}] Upstream: ${upstreamRouteId}, model: ${modelId}, provider: ${upstream.provider || 'default'}`);

  const sessionId = req.headers['x-woicrew-session-id'];

  // ─── Code Plan credential selection ───
  let effectiveApiKey = upstream.apiKey;
  let effectiveModel = modelId || upstream.model;
  let effectiveBaseURL = upstream.baseURL;
  const codePlanPoolKey = upstreamRouteId || '__default__';
  let pickedCredentialId: string | null = null;

  if (ctx.codePlanPool && upstream.codePlanCredentials?.length) {
    const pick = ctx.codePlanPool.pickOrFallback(codePlanPoolKey, typeof sessionId === 'string' ? sessionId : undefined);
    pickedCredentialId = pick.credentialId;
    if (pick.credentialId !== null) {
      effectiveApiKey = pick.apiKey;
      if (pick.model) effectiveModel = pick.model;
      if (upstream.codePlanBaseURL) effectiveBaseURL = upstream.codePlanBaseURL;
      logger.verbose(`[${reqId}] CodePlan pick: ${pick.credentialId} -> effectiveModel: ${effectiveModel}`);
    } else {
      logger.verbose(`[${reqId}] CodePlan: no available credential, using ordinary key`);
      // ordinaryFallbackModelMap: remap model when falling back to ordinary key
      if (upstream.ordinaryFallbackModelMap) {
        const mapped = upstream.ordinaryFallbackModelMap[effectiveModel];
        if (mapped) {
          effectiveModel = mapped;
          logger.verbose(`[${reqId}] CodePlan ordinary fallback model remap: ${modelId || upstream.model} -> ${mapped}`);
        }
      }
    }
  }

  const openAIReq = anthropicToOpenAI(parsedBody);

  // Provider pipeline (strict order, do not reorder)
  openAIReq.model = effectiveModel;

  // 动态设置 max_tokens：若未指定或低于模型上限，提升到该模型支持的最大输出 token
  {
    const { maxOutputTokens } = getModelContextWindow(openAIReq.model);
    if (maxOutputTokens > 0) {
      const currentMax = openAIReq.max_tokens ?? openAIReq.max_completion_tokens ?? 0;
      if (!currentMax || currentMax < maxOutputTokens) {
        openAIReq.max_tokens = maxOutputTokens;
        delete openAIReq.max_completion_tokens;
        logger.verbose(`[${reqId}] Auto-set max_tokens to ${maxOutputTokens} for model ${openAIReq.model} (was ${currentMax || 'unset'})`);
      }
    }
  }

  const provider = upstream.provider?.toLowerCase();
  if (provider && provider !== 'anthropic' && provider !== 'openai') {
    if (/^claude-/.test(openAIReq.model)) {
      openAIReq.model = upstream.model;
    }
  }

  const upstreamAPIType = resolveUpstreamAPIType(upstream.provider);
  filterOpenAIToolsForProvider(openAIReq, upstream.provider);
  remapMessageRolesForMiniMax(openAIReq, upstream.provider);

  const gemini = isGeminiProvider(upstream.provider, upstream.baseURL);
  hydrateOpenAIRequestToolCalls(openAIReq, gemini);

  if (upstreamAPIType === 'chat_completions') {
    normalizeMaxTokensFieldForOpenAIProvider(openAIReq, upstream.provider);
    mergeSystemMessagesForProvider(openAIReq);
  }

  let upstreamRequestBody: any;
  if (upstreamAPIType === 'responses') {
    upstreamRequestBody = convertChatCompletionsRequestToResponsesRequest(openAIReq);
  } else {
    upstreamRequestBody = openAIReq;
  }

  if (parsedBody.stream && upstreamAPIType === 'chat_completions') {
    upstreamRequestBody.stream = true;
    upstreamRequestBody.stream_options = { include_usage: true };
  } else if (parsedBody.stream) {
    upstreamRequestBody.stream = true;
  }

  // ─── Context budget: pre-flight trim ───
  {
    const effectiveModel = modelId || upstream.model;
    const requestedMaxOutput = upstreamRequestBody.max_tokens
      || upstreamRequestBody.max_completion_tokens
      || upstreamRequestBody.max_output_tokens;
    const inputBudget = computeInputBudget(effectiveModel, requestedMaxOutput);
    const estimated = estimateRequestTokens(upstreamRequestBody);

    if (estimated > inputBudget) {
      const trimResult = trimToFitBudget(upstreamRequestBody, inputBudget);
      if (trimResult.trimmed) {
        upstreamRequestBody = trimResult.trimmedBody;
        logger.verbose(`[${reqId}] Context budget: trimmed from ~${estimated} to ~${trimResult.estimatedTokens} tokens (budget: ${inputBudget}). Actions: ${trimResult.actions.join('; ')}`);
      }
    }
  }

  const targetURLs = buildUpstreamTargetUrls(effectiveBaseURL, upstreamAPIType, upstream.provider);

  const usageExtra: Partial<UsageLogExtra> = {
    app: 'woicrew',
    username: userInfo.name,
    stream: parsedBody.stream === true,
    request_size: rawBody.length,
    session_id: typeof sessionId === 'string' && sessionId ? sessionId : null,
    routing_key: pickedCredentialId ?? upstreamRouteId ?? '__default__',
  };

  const USAGE_LOG_INPUT_FULLTEXT = process.env.WOICLAW_USAGE_LOG_INPUT_FULLTEXT;
  if (USAGE_LOG_INPUT_FULLTEXT === '1' || USAGE_LOG_INPUT_FULLTEXT === 'true') {
    usageExtra.input_fulltext = JSON.stringify(upstreamRequestBody);
  }

  let upstreamResponse: Response | null = null;
  let lastError: any = null;

  for (const targetURL of targetURLs) {
    logger.verbose(`[${reqId}] Fetching: ${targetURL}`);
    try {
      upstreamResponse = await fetch(targetURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${effectiveApiKey}`,
        },
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

  if (!upstreamResponse.ok && upstreamAPIType === 'chat_completions') {
    let bodyText = '';
    try { bodyText = await upstreamResponse.clone().text(); } catch {}

    if (isToolsUnsupportedError(upstreamResponse.status, bodyText)) {
      stripToolsFromRequest(upstreamRequestBody);
      const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
        body: JSON.stringify(upstreamRequestBody),
      });
      if (retryResp.ok || retryResp.status !== 400) upstreamResponse = retryResp;
    }

    if (!upstreamResponse.ok && isMaxTokensUnsupportedError(upstreamResponse.status, bodyText)) {
      convertMaxTokensToMaxCompletionTokens(upstreamRequestBody);
      const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
        body: JSON.stringify(upstreamRequestBody),
      });
      if (retryResp.ok || retryResp.status !== 400) upstreamResponse = retryResp;
    }

    if (!upstreamResponse.ok && upstreamResponse.status === 400) {
      try { bodyText = await upstreamResponse.clone().text(); } catch {}
      if (clampMaxTokensFromError(bodyText, upstreamRequestBody)) {
        const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
          body: JSON.stringify(upstreamRequestBody),
        });
        if (retryResp.ok || retryResp.status !== 400) upstreamResponse = retryResp;
      }
    }

    for (let trimRound = 0; trimRound < 3; trimRound++) {
      if (upstreamResponse.ok || upstreamResponse.status !== 400) break;
      try { bodyText = await upstreamResponse.clone().text(); } catch {}
      if (!isTokenExceedError(upstreamResponse.status, bodyText)) break;

      upstreamRequestBody = aggressiveTrimForRetry(upstreamRequestBody, trimRound);
      logger.verbose(`[${reqId}] Token exceed error, retry round ${trimRound + 1}/3 with aggressively trimmed context`);
      const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
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
    if (upstreamAPIType === 'responses') {
      await handleResponsesStreamResponse(upstreamResponse, req, res, clientId, effectiveModel, startTime, upstreamRequestBody, usageExtra);
    } else {
      await handleChatCompletionsStreamResponse(upstreamResponse, req, res, clientId, effectiveModel, startTime, upstreamRequestBody, usageExtra, upstream.provider);
    }
    return;
  }

  let upstreamBody: any;
  try {
    upstreamBody = await upstreamResponse.json();
  } catch {
    sendErrorResponse(res, 502, 'Failed to parse upstream response', 'api_error');
    return;
  }

  if (upstreamAPIType === 'responses') {
    upstreamBody = convertResponsesToOpenAIResponse(upstreamBody);
  }

  const anthropicResp = openAIToAnthropic(upstreamBody);

  const inputContent = buildTrimmedInputContentForUsageLog(upstreamRequestBody);
  const outputContent = extractOutputContentFromAnthropicResponse(anthropicResp);
  const respUsage = anthropicResp.usage || { input_tokens: 0, output_tokens: 0 };

  appendUsageLog(clientId, effectiveModel, startTime, respUsage.input_tokens || 0, respUsage.output_tokens || 0, {
    ...usageExtra,
    input_cached_token: extractCachedInputTokensFromUsage(upstreamBody.usage),
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
        const items: Array<{ model_id: string; model_alias: string }> = [];
        const seen = new Set<string>();

        // 1. modelRoutes 中显式映射的模型（直接用模型名路由）
        for (const [modelName] of ctx.modelRoutesMap) {
          if (seen.has(modelName)) continue;
          seen.add(modelName);
          items.push({ model_id: modelName, model_alias: modelName });
        }

        // 2. 各 upstream 的默认模型（若未被 modelRoutes 覆盖，用 upstreamId|model 路由）
        for (const [upstreamId, upstream] of ctx.upstreamsByIdMap) {
          if (seen.has(upstream.model)) continue;
          seen.add(upstream.model);
          items.push({ model_id: `${upstreamId}|${upstream.model}`, model_alias: upstream.model });
        }

        // 3. defaultUpstream 的模型（兜底）
        if (ctx.defaultUpstream && !seen.has(ctx.defaultUpstream.model)) {
          items.push({ model_id: ctx.defaultUpstream.model, model_alias: ctx.defaultUpstream.model });
        }

        sendJSONResponse(res, 200, { items });
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
          // Attach model info from config
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
