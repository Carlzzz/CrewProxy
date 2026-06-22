"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAnthropicErrorBody = createAnthropicErrorBody;
exports.formatSSEEvent = formatSSEEvent;
exports.createProxyServer = createProxyServer;
const http = __importStar(require("http"));
const logger_1 = require("./logger");
const config_1 = require("./config");
const codePlanPool_1 = require("./codePlanPool");
const codePlanQuota_1 = require("./codePlanQuota");
const formatTransform_1 = require("./formatTransform");
const usageLogger_1 = require("./usageLogger");
const contextBudget_1 = require("./contextBudget");
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const STREAM_READ_TIMEOUT_MS = 180_000;
/** Small randomised pause before retrying a different credential. Prevents
 *  a burst of concurrent retries from re-triggering rate limits in lock-step. */
function sleepWithJitter(baseMs, jitterMs) {
    const delay = baseMs + Math.floor(Math.random() * jitterMs);
    return new Promise(resolve => setTimeout(resolve, delay));
}
const USAGE_LOG_TAIL_PREVIEW_MAX = Math.max(4096, parseInt(process.env.WOICLAW_USAGE_LOG_TAIL_PREVIEW_MAX || '8192', 10) || 8192);
function getAuthHost() {
    return process.env.WOICLAW_AUTH_HOST || '';
}
function getAuthUserPath() {
    return process.env.WOICLAW_AUTH_USER_PATH || '/woicrew/api/user-by-device';
}
function getAuthMethod() {
    return (process.env.WOICLAW_AUTH_METHOD || 'GET').toUpperCase();
}
function getAuthTokenParam() {
    return process.env.WOICLAW_AUTH_TOKEN_PARAM || 'deviceId';
}
function getAuthSuccessField() {
    return process.env.WOICLAW_AUTH_SUCCESS_FIELD || 'rc';
}
function getAuthSuccessValue() {
    return process.env.WOICLAW_AUTH_SUCCESS_VALUE || '0';
}
function getAuthNameField() {
    return process.env.WOICLAW_AUTH_NAME_FIELD || 'data.name';
}
function useAuthBearerToken() {
    return process.env.WOICLAW_AUTH_USE_BEARER === '1' || process.env.WOICLAW_AUTH_USE_BEARER === 'true';
}
function getNestedField(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null || typeof current !== 'object')
            return undefined;
        current = current[part];
    }
    return current;
}
// ─── Error body helpers ───
function createAnthropicErrorBody(message, type) {
    return { type: 'error', error: { type, message } };
}
function formatSSEEvent(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function sendJSONResponse(res, statusCode, body) {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(json);
}
function sendErrorResponse(res, statusCode, message, errorType) {
    sendJSONResponse(res, statusCode, createAnthropicErrorBody(message, errorType));
}
// ─── Request body reader ───
function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalLength = 0;
        req.on('data', (chunk) => {
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
function consumeBody(req) {
    req.resume();
}
// ─── Auth Cache & Helpers ───
const AUTH_CACHE_MAX_SIZE = 1000;
const authCache = new Map();
function authCacheSet(key, entry) {
    if (authCache.size >= AUTH_CACHE_MAX_SIZE) {
        const firstKey = authCache.keys().next().value;
        if (firstKey !== undefined)
            authCache.delete(firstKey);
    }
    authCache.set(key, entry);
}
function getAuthCacheTtlMs() {
    const seconds = parseInt(process.env.WOICLAW_AUTH_CACHE_TTL_SECONDS || '60', 10);
    return (isNaN(seconds) ? 60 : seconds) * 1000;
}
function getProxyApiKey() {
    return process.env.WOICLAW_PROXY_API_KEY || '';
}
function isAuthBypassed() {
    return process.env.WOICLAW_AUTH_BYPASS === '1' || process.env.WOICLAW_AUTH_BYPASS === 'true';
}
function extractClientApiKey(req) {
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey.trim())
        return xApiKey.trim();
    const auth = req.headers['authorization'];
    if (typeof auth === 'string') {
        const m = auth.match(/^Bearer\s+(.+)$/i);
        if (m && m[1].trim())
            return m[1].trim();
    }
    return null;
}
async function authenticateRequest(token) {
    if (isAuthBypassed()) {
        return { name: 'bypass', allowedModels: null };
    }
    const cacheKey = token;
    const cached = authCache.get(cacheKey);
    if (cached) {
        if (cached.expiresAt > Date.now()) {
            logger_1.logger.verbose('[auth] Cache hit for token');
            return cached.userInfo;
        }
        else {
            authCache.delete(cacheKey);
        }
    }
    const authHost = getAuthHost();
    const proxyKey = getProxyApiKey();
    let userInfo = null;
    if (authHost) {
        logger_1.logger.verbose('[auth] Trying introspect first (authHost configured)');
        const fetched = await fetchUserInfo(token);
        if (fetched) {
            logger_1.logger.verbose('[auth] Introspect succeeded, got user:', fetched.name);
            userInfo = fetched;
        }
        else {
            logger_1.logger.verbose('[auth] Introspect failed, falling back');
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
async function fetchUserInfo(token) {
    const authHost = getAuthHost();
    if (!authHost) {
        logger_1.logger.error('Auth host not configured (WOICLAW_AUTH_HOST)');
        return null;
    }
    const method = getAuthMethod();
    const tokenParam = getAuthTokenParam();
    const useBearer = useAuthBearerToken();
    let url;
    let fetchOptions;
    if (useBearer) {
        url = `${authHost}${getAuthUserPath()}`;
        fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
        };
    }
    else if (method === 'GET') {
        url = `${authHost}${getAuthUserPath()}?${tokenParam}=${encodeURIComponent(token)}`;
        fetchOptions = { method: 'GET' };
    }
    else {
        url = `${authHost}${getAuthUserPath()}`;
        fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [tokenParam]: token }),
        };
    }
    logger_1.logger.verbose('Auth request:', url.replace(token, token.substring(0, 6) + '***'));
    try {
        const resp = await fetch(url, fetchOptions);
        if (resp.status !== 200) {
            logger_1.logger.verbose('Auth failed: status', resp.status);
            return null;
        }
        const body = await resp.json();
        const successField = getAuthSuccessField();
        const successValue = getAuthSuccessValue();
        if (successField) {
            const actual = getNestedField(body, successField);
            if (String(actual) !== successValue) {
                logger_1.logger.verbose(`Auth failed: ${successField}=${actual}, expected ${successValue}`);
                return null;
            }
        }
        const nameField = getAuthNameField();
        const name = getNestedField(body, nameField);
        if (!name || typeof name !== 'string' || !name.trim()) {
            logger_1.logger.verbose(`Auth failed: name field "${nameField}" is empty or missing`);
            return null;
        }
        const allowedModels = getNestedField(body, 'data.allowed_models');
        let parsedAllowedModels = null;
        if (Array.isArray(allowedModels)) {
            parsedAllowedModels = allowedModels.map((m) => String(m).trim());
        }
        return { name: name.trim(), allowedModels: parsedAllowedModels };
    }
    catch (err) {
        logger_1.logger.error('Auth error:', err);
        return null;
    }
}
// ─── Stub detection ───
function isClaudeAgentSdkInternalModel(model) {
    if (model.includes('|'))
        return false;
    return /^claude-(haiku|sonnet)-[0-9-]+$/.test(model);
}
function sendSdkInternalStubResponse(req, res, parsedBody) {
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
    const write = (event, data) => res.write(formatSSEEvent(event, data));
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
function buildTrimmedInputContentForUsageLog(upstreamReq) {
    const messages = upstreamReq.messages;
    let tailRole = '';
    let tailPreview = '';
    if (Array.isArray(messages) && messages.length > 0) {
        const last = messages[messages.length - 1];
        tailRole = last.role || '';
        const c = last.content;
        if (typeof c === 'string') {
            tailPreview = c;
        }
        else if (Array.isArray(c)) {
            tailPreview = c.map((p) => {
                if (p.type === 'text')
                    return p.text || '';
                if (p.type === 'tool_use')
                    return `[tool_use:${p.name || ''}]`;
                if (p.type === 'tool_result')
                    return `[tool_result]`;
                if (p.type === 'thinking')
                    return `[thinking]`;
                if (p.type === 'image')
                    return `[image]`;
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
function extractOutputContentFromAnthropicResponse(anthropicResp) {
    if (!Array.isArray(anthropicResp.content))
        return '';
    return anthropicResp.content
        .filter((b) => b.type === 'text' || b.type === 'thinking')
        .map((b) => b.text || b.thinking || '')
        .join('');
}
function extractCachedInputTokensFromUsage(usage) {
    if (!usage)
        return 0;
    let cached = 0;
    // Anthropic native fields
    if (typeof usage.cache_read_input_tokens === 'number') {
        cached = Math.max(cached, usage.cache_read_input_tokens);
    }
    // OpenAI-compat fields (some providers may still use these in Anthropic mode)
    for (const detailsKey of ['input_token_details', 'prompt_tokens_details']) {
        let details = usage[detailsKey];
        if (typeof details === 'string') {
            try {
                details = JSON.parse(details);
            }
            catch {
                continue;
            }
        }
        if (details && typeof details === 'object') {
            for (const k of ['cached_tokens', 'cache_hit_tokens']) {
                if (typeof details[k] === 'number')
                    cached = Math.max(cached, details[k]);
            }
        }
    }
    for (const k of ['cached_tokens', 'prompt_cache_hit_tokens']) {
        if (typeof usage[k] === 'number')
            cached = Math.max(cached, usage[k]);
    }
    return cached;
}
// ─── Streaming: Anthropic pass-through ───
function popSSEPacket(buffer) {
    const idxNL = buffer.indexOf('\n\n');
    const idxCRLF = buffer.indexOf('\r\n\r\n');
    let boundary = -1;
    let sepLen = 0;
    if (idxNL !== -1 && (idxCRLF === -1 || idxNL < idxCRLF)) {
        boundary = idxNL;
        sepLen = 2;
    }
    else if (idxCRLF !== -1) {
        boundary = idxCRLF;
        sepLen = 4;
    }
    if (boundary === -1)
        return null;
    return { packet: buffer.slice(0, boundary), rest: buffer.slice(boundary + sepLen) };
}
function readWithTimeout(reader, timeoutMs, abortSignal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`Stream read timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);
        const interval = setInterval(() => {
            if (abortSignal.aborted && !settled) {
                settled = true;
                clearTimeout(timer);
                clearInterval(interval);
                reject(new Error('Stream read aborted: client disconnected'));
            }
        }, 500);
        reader.read().then((result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                clearInterval(interval);
                resolve(result);
            }
        }, (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                clearInterval(interval);
                reject(err);
            }
        });
    });
}
async function handleAnthropicStreamResponse(upstreamResponse, req, res, clientId, modelId, startTime, upstreamReq, extra) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    const state = {
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
        (0, usageLogger_1.appendUsageLog)(clientId, modelId, startTime, 0, 0, extra);
        return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const bufferChunks = [];
    let bufferStr = '';
    const abortSignal = { aborted: false };
    const onClose = () => { abortSignal.aborted = true; };
    req.once('close', onClose);
    res.once('close', onClose);
    const getBuffer = () => {
        if (bufferChunks.length > 0) {
            bufferStr += bufferChunks.join('');
            bufferChunks.length = 0;
        }
        return bufferStr;
    };
    const processBuffer = () => {
        let buf = getBuffer();
        let popped;
        while ((popped = popSSEPacket(buf))) {
            buf = popped.rest;
            let eventType = '';
            const dataLines = [];
            for (const l of popped.packet.split(/\r?\n/)) {
                if (l.startsWith('event:'))
                    eventType = l.substring(6).trim();
                else if (l.startsWith('data:'))
                    dataLines.push(l.substring(5).trim());
            }
            if (dataLines.length === 0)
                continue;
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
                    }
                    else if (data.delta.type === 'thinking_delta' && data.delta.thinking) {
                        state.outputAccumulator.push(data.delta.thinking);
                    }
                }
                // Forward the SSE event to the client unchanged
                res.write(formatSSEEvent(eventType, data));
            }
            catch (parseErr) {
                logger_1.logger.verbose('Anthropic SSE chunk parse error:', parseErr);
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
            bufferChunks.push(decoder.decode(result.value, { stream: true }));
            processBuffer();
        }
    }
    catch (err) {
        logger_1.logger.error('Anthropic stream error:', err);
        if (!state.sawMessageStop) {
            res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } }));
        }
    }
    finally {
        reader.cancel().catch(() => { });
        const inputContent = buildTrimmedInputContentForUsageLog(upstreamReq);
        const outputContent = state.outputAccumulator.join('');
        (0, usageLogger_1.appendUsageLog)(clientId, modelId, startTime, state.inputTokens, state.outputTokens, {
            ...extra,
            input_cached_token: state.cachedInputTokens,
            input_content: inputContent,
            output_content: outputContent,
        });
        res.end();
    }
}
// ─── 400 retry helpers ───
function clampMaxTokensFromAnthropicError(bodyText, anthropicReq) {
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
async function handleRequest(req, res, ctx) {
    const reqId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const startTime = (0, usageLogger_1.formatUTC8)(new Date());
    logger_1.logger.verbose(`[${reqId}] POST /v1/messages`);
    let rawBody;
    try {
        rawBody = await readRequestBody(req);
    }
    catch (err) {
        sendErrorResponse(res, 400, err.message || 'Invalid request body', 'invalid_request_error');
        return;
    }
    let parsedBody;
    try {
        parsedBody = JSON.parse(rawBody.toString('utf-8'));
    }
    catch {
        sendErrorResponse(res, 400, 'Invalid JSON in request body', 'invalid_request_error');
        return;
    }
    const model = parsedBody.model || '';
    if (isClaudeAgentSdkInternalModel(model)) {
        logger_1.logger.verbose(`[${reqId}] Stub model: ${model}`);
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
    let userInfo;
    if (typeof headerUser === 'string' && headerUser.trim()) {
        userInfo = { name: decodeURIComponent(headerUser.trim()), allowedModels: authResult.allowedModels };
    }
    else {
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
    const resolved = (0, config_1.resolveUpstreamFromModel)(model, ctx.upstreamsByIdMap, ctx.defaultUpstream, ctx.modelRoutesMap);
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
        const { maxOutputTokens } = (0, contextBudget_1.getModelContextWindow)(anthropicReq.model);
        if (maxOutputTokens > 0) {
            const currentMax = anthropicReq.max_tokens ?? 0;
            if (!currentMax || currentMax < maxOutputTokens) {
                anthropicReq.max_tokens = maxOutputTokens;
                logger_1.logger.verbose(`[${reqId}] Auto-set max_tokens to ${maxOutputTokens} for model ${anthropicReq.model} (was ${currentMax || 'unset'})`);
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
    let upstreamRequestBody = anthropicReq;
    // ─── Context budget: pre-flight trim ───
    {
        const effectiveModelForBudget = modelId || upstream.model;
        const requestedMaxOutput = upstreamRequestBody.max_tokens;
        const inputBudget = (0, contextBudget_1.computeInputBudget)(effectiveModelForBudget, requestedMaxOutput);
        const estimated = (0, contextBudget_1.estimateRequestTokens)(upstreamRequestBody);
        if (estimated > inputBudget) {
            const trimResult = (0, contextBudget_1.trimToFitBudget)(upstreamRequestBody, inputBudget);
            if (trimResult.trimmed) {
                upstreamRequestBody = trimResult.trimmedBody;
                logger_1.logger.verbose(`[${reqId}] Context budget: trimmed from ~${estimated} to ~${trimResult.estimatedTokens} tokens (budget: ${inputBudget}). Actions: ${trimResult.actions.join('; ')}`);
            }
        }
    }
    // Save a pristine copy of the request body so we can reset after failed attempts
    const pristineRequestBody = structuredClone(upstreamRequestBody);
    const usageExtra = {
        app: 'woicrew',
        username: userInfo.name,
        stream: parsedBody.stream === true,
        request_size: rawBody.length,
        session_id: typeof req.headers['x-woicrew-session-id'] === 'string' && req.headers['x-woicrew-session-id'] ? req.headers['x-woicrew-session-id'] : null,
        routing_key: upstreamRouteId ?? '__default__',
    };
    const USAGE_LOG_INPUT_FULLTEXT = process.env.WOICLAW_USAGE_LOG_INPUT_FULLTEXT;
    if (USAGE_LOG_INPUT_FULLTEXT === '1' || USAGE_LOG_INPUT_FULLTEXT === 'true') {
        usageExtra.input_fulltext = JSON.stringify(upstreamRequestBody);
    }
    // ─── Code Plan credential retry loop ───
    // Each iteration picks a fresh credential from the pool (skipping cooldowns).
    // On network error / 429 / 5xx: mark cooldown, retry with next credential.
    // On 4xx client errors (non-429): return immediately — retrying won't help.
    // On 400 token errors: try trim first, then switch credential if still failing.
    let upstreamResponse = null;
    let lastError = null;
    let pickedCredentialId = null;
    let effectiveApiKey = upstream.apiKey;
    let effectiveBaseURL = upstream.baseURL;
    const maxCredAttempts = hasCodePlan ? ((upstream.codePlanCredentials?.length ?? 0) + 1) : 1;
    let usedOrdinaryFallback = false;
    // **Fix #1**: Skip the "ordinary fallback" branch when it can't usefully run:
    //   (a) the upstream `apiKey` is empty — there's no real fallback configured;
    //   (b) the upstream `apiKey` duplicates one of the pooled credentials — hitting
    //       it again would just bounce off the same rate limit.
    // In both cases, surface the upstream 429 to the caller instead of looping.
    const ordinaryKeyIsPooled = !!(hasCodePlan &&
        (!upstream.apiKey ||
            upstream.codePlanCredentials?.some(c => c.apiKey === upstream.apiKey)));
    for (let credAttempt = 0; credAttempt < maxCredAttempts; credAttempt++) {
        // **Fix #3**: release the in-flight slot of the previous credential before
        // picking the next one. pickOrFallback() increments on selection, so each
        // pick must be paired with a decInFlight() somewhere.
        if (hasCodePlan && pickedCredentialId !== null && !usedOrdinaryFallback) {
            ctx.codePlanPool?.decInFlight(codePlanPoolKey, pickedCredentialId);
        }
        // ── Select credential ──
        if (hasCodePlan) {
            const pick = ctx.codePlanPool.pickOrFallback(codePlanPoolKey, typeof req.headers['x-woicrew-session-id'] === 'string' ? req.headers['x-woicrew-session-id'] : undefined);
            pickedCredentialId = pick.credentialId;
            if (pick.credentialId !== null) {
                effectiveApiKey = pick.apiKey;
                effectiveModel = pick.model ?? (modelId || upstream.model);
                if (upstream.codePlanAnthropicBaseURL)
                    effectiveBaseURL = upstream.codePlanAnthropicBaseURL;
                else if (upstream.codePlanBaseURL)
                    effectiveBaseURL = upstream.codePlanBaseURL;
                else
                    effectiveBaseURL = upstream.baseURL;
                usedOrdinaryFallback = false;
                logger_1.logger.verbose(`[${reqId}] CodePlan pick: ${pick.credentialId} (attempt=${credAttempt}) -> model: ${effectiveModel}`);
            }
            else if (ordinaryKeyIsPooled) {
                // **Fix #1 active path**: all pool keys are in cooldown and the ordinary
                // key is a duplicate of one of them. Hitting it again would just bounce
                // off the same rate limit. Surface the upstream 429 to the caller.
                logger_1.logger.verbose(`[${reqId}] CodePlan: all credentials exhausted; ordinary key matches a pooled credential, skipping fallback`);
                pickedCredentialId = null;
                break;
            }
            else {
                // All code plan credentials exhausted — fallback to ordinary key
                effectiveApiKey = upstream.apiKey;
                effectiveBaseURL = upstream.baseURL;
                effectiveModel = modelId || upstream.model;
                usedOrdinaryFallback = true;
                pickedCredentialId = null;
                logger_1.logger.verbose(`[${reqId}] CodePlan: all credentials exhausted, falling back to ordinary key`);
                if (upstream.ordinaryFallbackModelMap) {
                    const mapped = upstream.ordinaryFallbackModelMap[effectiveModel];
                    if (mapped) {
                        effectiveModel = mapped;
                        logger_1.logger.verbose(`[${reqId}] CodePlan ordinary fallback model remap: ${modelId || upstream.model} -> ${mapped}`);
                    }
                }
            }
        }
        // Update model in request body for this credential
        upstreamRequestBody.model = effectiveModel;
        // ── Build headers for this credential ──
        const upstreamHeaders = {
            'Content-Type': 'application/json',
            'x-api-key': effectiveApiKey,
            'Authorization': `Bearer ${effectiveApiKey}`,
        };
        for (const hdr of ['anthropic-version', 'anthropic-beta']) {
            const val = req.headers[hdr];
            if (typeof val === 'string') {
                upstreamHeaders[hdr] = val;
            }
        }
        // ── Build target URLs from current effective base URL ──
        const targetURLs = (0, formatTransform_1.buildAnthropicMessagesURL)(effectiveBaseURL);
        // ── Try all target URLs for this credential ──
        for (const targetURL of targetURLs) {
            logger_1.logger.verbose(`[${reqId}] Fetching: ${targetURL}`);
            try {
                upstreamResponse = await fetch(targetURL, {
                    method: 'POST',
                    headers: upstreamHeaders,
                    body: JSON.stringify(upstreamRequestBody),
                });
                if (upstreamResponse.status === 404 && targetURLs.indexOf(targetURL) < targetURLs.length - 1) {
                    logger_1.logger.verbose(`[${reqId}] 404 from ${targetURL}, trying next URL`);
                    upstreamResponse = null;
                    continue;
                }
                break;
            }
            catch (fetchErr) {
                lastError = fetchErr;
                logger_1.logger.error(`[${reqId}] Fetch error:`, fetchErr);
            }
        }
        // ── Success ──
        if (upstreamResponse && upstreamResponse.ok) {
            logger_1.logger.verbose(`[${reqId}] CodePlan success with credential=${pickedCredentialId} (attempt=${credAttempt})`);
            break;
        }
        // ── Network error (no response) — mark cooldown and retry ──
        if (!upstreamResponse) {
            if (pickedCredentialId !== null && !usedOrdinaryFallback) {
                // Network errors are usually transient; short cooldown is sufficient.
                ctx.codePlanPool?.markCooldown(codePlanPoolKey, pickedCredentialId, codePlanPool_1.CODE_PLAN_SHORT_COOLDOWN_MS);
                logger_1.logger.verbose(`[${reqId}] CodePlan cooldown for ${pickedCredentialId} after network error, retrying with next credential`);
                await sleepWithJitter(50, 150);
                upstreamRequestBody = structuredClone(pristineRequestBody);
                continue;
            }
            // Ordinary key failed with network error — no more fallbacks
            break;
        }
        // ── Non-ok response ──
        let errText = '';
        try {
            errText = await upstreamResponse.clone().text();
        }
        catch { }
        logger_1.logger.verbose(`[${reqId}] Upstream error ${upstreamResponse.status}:`, errText.substring(0, 500));
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
                    logger_1.logger.verbose(`[${reqId}] CodePlan success after max_tokens clamp (attempt=${credAttempt})`);
                    break;
                }
            }
            // Token-exceed retry loop
            for (let trimRound = 0; trimRound < 3; trimRound++) {
                if (upstreamResponse && upstreamResponse.ok)
                    break;
                if (!(0, contextBudget_1.isTokenExceedError)(upstreamResponse.status, errText))
                    break;
                upstreamRequestBody = (0, contextBudget_1.aggressiveTrimForRetry)(upstreamRequestBody, trimRound);
                logger_1.logger.verbose(`[${reqId}] Token exceed error, retry round ${trimRound + 1}/3 with aggressively trimmed context`);
                const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
                    method: 'POST',
                    headers: upstreamHeaders,
                    body: JSON.stringify(upstreamRequestBody),
                });
                upstreamResponse = retryResp;
                if (!upstreamResponse.ok) {
                    try {
                        errText = await upstreamResponse.clone().text();
                    }
                    catch { }
                }
            }
            if (upstreamResponse && upstreamResponse.ok) {
                logger_1.logger.verbose(`[${reqId}] CodePlan success after token trim (attempt=${credAttempt})`);
                break;
            }
        }
        // ── Mark credential cooldown on failure ──
        // **Fix #2**: classify 429 — short cooldown for QPS/concurrency bursts,
        // long cooldown only for true quota exhaustion.
        if (pickedCredentialId !== null && !usedOrdinaryFallback) {
            let cooldownMs = codePlanPool_1.CODE_PLAN_SHORT_COOLDOWN_MS;
            const cls = (0, codePlanQuota_1.classify429)(upstreamResponse.status, errText);
            if (cls === 'quota') {
                cooldownMs = codePlanPool_1.CODE_PLAN_COOLDOWN_MS;
                const resetMs = (0, codePlanQuota_1.parseQuotaResetEpochMs)(errText);
                if (resetMs)
                    cooldownMs = Math.max(resetMs - Date.now(), codePlanPool_1.CODE_PLAN_COOLDOWN_MS);
            }
            ctx.codePlanPool?.markCooldown(codePlanPoolKey, pickedCredentialId, cooldownMs);
            logger_1.logger.verbose(`[${reqId}] CodePlan cooldown for ${pickedCredentialId}: ${cooldownMs}ms (class=${cls})`);
        }
        // ── Decide whether to retry with next credential ──
        // 4xx client errors (non-429, non-400) are not retryable
        if (upstreamResponse.status >= 400 && upstreamResponse.status < 500 &&
            upstreamResponse.status !== 429 && upstreamResponse.status !== 400) {
            logger_1.logger.verbose(`[${reqId}] Non-retryable client error ${upstreamResponse.status}, not switching credential`);
            break;
        }
        // Ordinary key failed — no more fallbacks
        if (usedOrdinaryFallback) {
            logger_1.logger.verbose(`[${reqId}] Ordinary fallback failed with status ${upstreamResponse.status}, giving up`);
            break;
        }
        // **Fix #4**: jitter sleep before retrying with a different credential.
        // Without it, a burst of concurrent retries lands on the next key in
        // lock-step and can re-trigger short-window rate limits across the pool.
        if (upstreamResponse.status === 429 || upstreamResponse.status >= 500) {
            await sleepWithJitter(50, 150);
        }
        // Reset request body and retry with next credential
        logger_1.logger.verbose(`[${reqId}] Retrying with next credential (attempt=${credAttempt})`);
        upstreamRequestBody = structuredClone(pristineRequestBody);
        upstreamResponse = null;
    }
    // **Fix #3 final release**: decrement the last in-flight credential we held.
    // Note: this happens before stream handling, so in-flight reflects "fetching
    // headers" rather than "still streaming". That's the signal we want for
    // picking the *next* credential — full stream-duration tracking would need
    // handler cooperation and isn't the goal here.
    if (hasCodePlan && pickedCredentialId !== null && !usedOrdinaryFallback) {
        ctx.codePlanPool?.decInFlight(codePlanPoolKey, pickedCredentialId);
    }
    // Update usage extra with the final credential that was used
    usageExtra.routing_key = pickedCredentialId ?? upstreamRouteId ?? '__default__';
    // ── Final error check ──
    if (!upstreamResponse) {
        sendErrorResponse(res, 502, `Upstream request failed: ${lastError?.message || 'unknown'}`, 'api_error');
        return;
    }
    if (!upstreamResponse.ok) {
        let errText = '';
        try {
            errText = await upstreamResponse.clone().text();
        }
        catch { }
        sendErrorResponse(res, upstreamResponse.status, `Upstream error: ${errText.substring(0, 200)}`, 'api_error');
        return;
    }
    if (parsedBody.stream) {
        await handleAnthropicStreamResponse(upstreamResponse, req, res, clientId, effectiveModel, startTime, upstreamRequestBody, usageExtra);
        return;
    }
    // ─── Non-stream response: pass Anthropic response directly ───
    let anthropicResp;
    try {
        anthropicResp = await upstreamResponse.json();
    }
    catch {
        sendErrorResponse(res, 502, 'Failed to parse upstream response', 'api_error');
        return;
    }
    const inputContent = buildTrimmedInputContentForUsageLog(upstreamRequestBody);
    const outputContent = extractOutputContentFromAnthropicResponse(anthropicResp);
    const respUsage = anthropicResp.usage || { input_tokens: 0, output_tokens: 0 };
    // Some providers use OpenAI-compat field names (prompt_tokens / completion_tokens)
    const inputTokens = respUsage.input_tokens ?? respUsage.prompt_tokens ?? 0;
    const outputTokens = respUsage.output_tokens ?? respUsage.completion_tokens ?? 0;
    (0, usageLogger_1.appendUsageLog)(clientId, effectiveModel, startTime, inputTokens, outputTokens, {
        ...usageExtra,
        input_cached_token: extractCachedInputTokensFromUsage(anthropicResp.usage),
        input_content: inputContent,
        output_content: outputContent,
        response_size: JSON.stringify(anthropicResp).length,
    });
    sendJSONResponse(res, 200, anthropicResp);
}
// ─── Server factory ───
function createProxyServer(ctx) {
    const server = http.createServer(async (req, res) => {
        const { method, url } = req;
        const pathname = (url || '/').split('?')[0];
        logger_1.logger.verbose(`← ${method} ${url}`);
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
                let userInfo;
                if (typeof headerUser === 'string' && headerUser.trim()) {
                    userInfo = { name: decodeURIComponent(headerUser.trim()), allowedModels: authResult.allowedModels };
                }
                else {
                    userInfo = authResult;
                }
                const items = [];
                const seen = new Set();
                for (const [modelName] of ctx.modelRoutesMap) {
                    if (seen.has(modelName))
                        continue;
                    seen.add(modelName);
                    items.push({ model_id: modelName, model_alias: modelName });
                }
                for (const [upstreamId, upstream] of ctx.upstreamsByIdMap) {
                    if (seen.has(upstream.model))
                        continue;
                    seen.add(upstream.model);
                    items.push({ model_id: `${upstreamId}|${upstream.model}`, model_alias: upstream.model });
                }
                if (ctx.defaultUpstream && !seen.has(ctx.defaultUpstream.model)) {
                    items.push({ model_id: ctx.defaultUpstream.model, model_alias: ctx.defaultUpstream.model });
                }
                let filteredItems = items;
                if (userInfo.allowedModels !== null) {
                    filteredItems = items.filter(item => userInfo.allowedModels.includes(item.model_id));
                }
                sendJSONResponse(res, 200, { items: filteredItems });
                return;
            }
            if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
                consumeBody(req);
                await new Promise((r) => req.once('end', r));
                sendJSONResponse(res, 200, { input_tokens: 0 });
                return;
            }
            if (method === 'POST' && pathname === '/api/event_logging/batch') {
                consumeBody(req);
                await new Promise((r) => req.once('end', r));
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
                const pools = {};
                const allKeys = new Set();
                for (const [upstreamId] of ctx.upstreamsByIdMap)
                    allKeys.add(upstreamId);
                allKeys.add('__default__');
                for (const key of allKeys) {
                    if (!ctx.codePlanPool.hasCredentials(key))
                        continue;
                    const status = ctx.codePlanPool.getPoolStatus(key);
                    pools[key] = {
                        credentials: status.map(c => ({
                            id: c.credentialId,
                            inCooldown: c.inCooldown,
                            cooldownUntil: c.cooldownUntil,
                            requestsLast1h: c.requestsLast1h,
                            inFlight: ctx.codePlanPool.getInFlight(key, c.credentialId),
                        })),
                    };
                    const upstream = ctx.upstreamsByIdMap.get(key) ?? ctx.defaultUpstream;
                    if (upstream?.codePlanCredentials) {
                        for (const cred of upstream.codePlanCredentials) {
                            const entry = pools[key].credentials.find(c => c.id === cred.id);
                            if (entry && cred.model)
                                entry.model = cred.model;
                        }
                    }
                }
                sendJSONResponse(res, 200, { pools });
                return;
            }
            sendErrorResponse(res, 404, `Not found: ${method} ${url}`, 'not_found_error');
        }
        catch (err) {
            logger_1.logger.error('Unhandled error:', err);
            if (!res.headersSent) {
                sendErrorResponse(res, 500, 'Internal server error', 'api_error');
            }
        }
    });
    return server;
}
