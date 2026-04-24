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
const formatTransform_1 = require("./formatTransform");
const usageLogger_1 = require("./usageLogger");
const contextBudget_1 = require("./contextBudget");
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const STREAM_READ_TIMEOUT_MS = 90_000;
const MAX_TOOL_CALL_EXTRA_CONTENT_CACHE = 1024;
const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
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
// ─── Tool extra_content cache (process-level, FIFO) ───
const toolCallExtraContentById = new Map();
function cacheToolCallExtraContent(id, extra) {
    if (toolCallExtraContentById.size >= MAX_TOOL_CALL_EXTRA_CONTENT_CACHE) {
        const oldest = toolCallExtraContentById.keys().next().value;
        if (oldest !== undefined)
            toolCallExtraContentById.delete(oldest);
    }
    toolCallExtraContentById.set(id, extra);
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
// ─── Auth ───
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
        return { name: 'bypass' };
    }
    const authHost = getAuthHost();
    const proxyKey = getProxyApiKey();
    // 如果配置了 introspect 端点，优先尝试 introspect
    if (authHost) {
        logger_1.logger.verbose('[auth] Trying introspect first (authHost configured)');
        const userInfo = await fetchUserInfo(token);
        if (userInfo) {
            logger_1.logger.verbose('[auth] Introspect succeeded, got user:', userInfo.name);
            return userInfo;
        }
        logger_1.logger.verbose('[auth] Introspect failed, falling back');
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
function isLikelyJwt(token) {
    // JWT 格式: xxxxx.yyyyy.zzzzz
    const parts = token.split('.');
    return parts.length === 3;
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
        // 使用 Bearer token 方式（CrewCentral introspect 端点）
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
        return { name: name.trim() };
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
// ─── Provider pipeline helpers ───
function resolveUpstreamAPIType(provider) {
    return provider?.toLowerCase() === 'openai' ? 'responses' : 'chat_completions';
}
function filterOpenAIToolsForProvider(openAIReq, provider) {
    if (provider?.toLowerCase() !== 'openai')
        return;
    if (Array.isArray(openAIReq.tools)) {
        openAIReq.tools = openAIReq.tools.filter((t) => t?.function?.name !== 'skill');
        if (openAIReq.tools.length === 0)
            delete openAIReq.tools;
    }
    if (openAIReq.tool_choice && typeof openAIReq.tool_choice === 'object' && openAIReq.tool_choice.function?.name === 'skill') {
        openAIReq.tool_choice = 'auto';
    }
}
function remapMessageRolesForMiniMax(openAIReq, provider) {
    if (provider?.toLowerCase() !== 'minimax')
        return;
    if (!Array.isArray(openAIReq.messages))
        return;
    for (const msg of openAIReq.messages) {
        if (msg.role === 'developer')
            msg.role = 'system';
    }
}
function isGeminiProvider(provider, baseURL) {
    if (provider?.toLowerCase() === 'gemini')
        return true;
    if (baseURL && baseURL.includes('generativelanguage.googleapis.com'))
        return true;
    return false;
}
function normalizeToolCallExtraContent(tc) {
    if (tc.extra_content !== undefined)
        return tc.extra_content;
    if (tc.function?.thought_signature !== undefined)
        return { thought_signature: tc.function.thought_signature };
    return undefined;
}
function hydrateOpenAIRequestToolCalls(openAIReq, gemini) {
    if (!Array.isArray(openAIReq.messages))
        return;
    for (const msg of openAIReq.messages) {
        if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls))
            continue;
        for (const tc of msg.tool_calls) {
            if (tc.extra_content !== undefined)
                continue;
            const cached = toolCallExtraContentById.get(tc.id);
            if (cached !== undefined) {
                tc.extra_content = cached;
            }
            else if (gemini) {
                tc.extra_content = { thought_signature: GEMINI_FALLBACK_THOUGHT_SIGNATURE };
            }
        }
    }
}
const OPENAI_NEW_MODEL_PATTERN = /^(gpt-5|o[134])/i;
function normalizeMaxTokensFieldForOpenAIProvider(openAIReq, provider) {
    if (provider?.toLowerCase() !== 'openai')
        return;
    if (!openAIReq.max_tokens)
        return;
    const model = (openAIReq.model || '').toLowerCase();
    if (OPENAI_NEW_MODEL_PATTERN.test(model)) {
        openAIReq.max_completion_tokens = openAIReq.max_tokens;
        delete openAIReq.max_tokens;
    }
}
function mergeSystemMessagesForProvider(openAIReq) {
    if (!Array.isArray(openAIReq.messages))
        return;
    const systemMsgs = [];
    const rest = [];
    for (const msg of openAIReq.messages) {
        if (msg.role === 'system') {
            const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            systemMsgs.push(text);
        }
        else {
            rest.push(msg);
        }
    }
    if (systemMsgs.length <= 1)
        return;
    openAIReq.messages = [{ role: 'system', content: systemMsgs.join('\n\n') }, ...rest];
}
// ─── Responses API conversion ───
function convertChatCompletionsRequestToResponsesRequest(openAIReq) {
    const input = [];
    if (Array.isArray(openAIReq.messages)) {
        for (const msg of openAIReq.messages) {
            if (msg.role === 'system') {
                input.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
            }
            else if (msg.role === 'user') {
                input.push({ role: 'user', content: msg.content });
            }
            else if (msg.role === 'assistant') {
                if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    for (const tc of msg.tool_calls) {
                        input.push({
                            type: 'function_call',
                            call_id: tc.id,
                            name: tc.function?.name,
                            arguments: tc.function?.arguments || '{}',
                        });
                    }
                }
                else {
                    input.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' });
                }
            }
            else if (msg.role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: msg.tool_call_id,
                    output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                });
            }
        }
    }
    const responsesReq = {
        model: openAIReq.model,
        input,
        stream: openAIReq.stream,
    };
    if (openAIReq.max_tokens)
        responsesReq.max_output_tokens = openAIReq.max_tokens;
    if (openAIReq.max_completion_tokens)
        responsesReq.max_output_tokens = openAIReq.max_completion_tokens;
    if (openAIReq.temperature !== undefined)
        responsesReq.temperature = openAIReq.temperature;
    if (openAIReq.top_p !== undefined)
        responsesReq.top_p = openAIReq.top_p;
    if (Array.isArray(openAIReq.tools) && openAIReq.tools.length > 0) {
        responsesReq.tools = openAIReq.tools.map((t) => ({
            type: 'function',
            name: t.function?.name,
            description: t.function?.description,
            parameters: t.function?.parameters,
        }));
    }
    return responsesReq;
}
function convertResponsesToOpenAIResponse(responsesBody) {
    const choices = [];
    const message = { role: 'assistant', content: '' };
    const toolCalls = [];
    if (Array.isArray(responsesBody.output)) {
        for (const item of responsesBody.output) {
            if (item.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part.type === 'output_text') {
                        message.content += part.text || '';
                    }
                }
            }
            else if (item.type === 'function_call') {
                toolCalls.push({
                    id: item.call_id || item.id,
                    type: 'function',
                    function: { name: item.name, arguments: item.arguments || '{}' },
                });
            }
        }
    }
    if (toolCalls.length > 0)
        message.tool_calls = toolCalls;
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
            tailPreview = c.map((p) => p.text || `[${p.type || 'unknown'}]`).join(' ');
        }
        else if (last.role === 'tool') {
            tailPreview = `[tool_result] ${typeof c === 'string' ? c : ''}`;
        }
        else if (last.role === 'assistant' && Array.isArray(last.tool_calls)) {
            tailPreview = `[tool_calls] ${last.tool_calls.map((tc) => tc.function?.name || '').join(',')}`;
        }
        if (tailPreview.length > USAGE_LOG_TAIL_PREVIEW_MAX) {
            tailPreview = tailPreview.substring(0, USAGE_LOG_TAIL_PREVIEW_MAX);
        }
    }
    return JSON.stringify({ model: upstreamReq.model, tail_role: tailRole, tail_preview: tailPreview });
}
function extractOutputContentFromAnthropicResponse(anthropicResp) {
    if (!Array.isArray(anthropicResp.content))
        return '';
    return anthropicResp.content
        .filter((b) => b.type === 'text' || b.type === 'thinking')
        .map((b) => b.text || b.thinking || '')
        .join('');
}
function createStreamState() {
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
    };
}
function closeCurrentBlockIfNeeded(state, res) {
    if (state.currentBlockType !== null) {
        res.write(formatSSEEvent('content_block_stop', { type: 'content_block_stop', index: state.contentIndex }));
        state.contentIndex++;
        state.currentBlockType = null;
    }
}
function ensureMessageStart(state, res, chunk) {
    if (state.messageStarted)
        return;
    state.messageId = chunk.id || `msg_${Date.now()}`;
    state.messageModel = chunk.model || '';
    state.messageStarted = true;
    res.write(formatSSEEvent('message_start', {
        type: 'message_start',
        message: {
            id: state.messageId, type: 'message', role: 'assistant', model: state.messageModel,
            content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
        },
    }));
}
function ensureThinkingBlock(state, res) {
    if (state.currentBlockType === 'thinking')
        return;
    closeCurrentBlockIfNeeded(state, res);
    state.currentBlockType = 'thinking';
    res.write(formatSSEEvent('content_block_start', {
        type: 'content_block_start', index: state.contentIndex,
        content_block: { type: 'thinking', thinking: '' },
    }));
}
function ensureTextBlock(state, res) {
    if (state.currentBlockType === 'text')
        return;
    closeCurrentBlockIfNeeded(state, res);
    state.currentBlockType = 'text';
    res.write(formatSSEEvent('content_block_start', {
        type: 'content_block_start', index: state.contentIndex,
        content_block: { type: 'text', text: '' },
    }));
}
function ensureToolUseBlock(state, res, toolIndex, tc) {
    const existing = state.toolCalls.get(toolIndex);
    if (existing)
        return;
    closeCurrentBlockIfNeeded(state, res);
    state.currentBlockType = 'tool_use';
    const toolState = { id: tc.id || '', name: tc.function?.name || '', argumentsBuffer: '', extraContent: undefined };
    state.toolCalls.set(toolIndex, toolState);
    res.write(formatSSEEvent('content_block_start', {
        type: 'content_block_start', index: state.contentIndex,
        content_block: { type: 'tool_use', id: toolState.id, name: toolState.name, input: {} },
    }));
}
function extractCachedInputTokensFromUsage(usage) {
    if (!usage)
        return 0;
    let cached = 0;
    for (const detailsKey of ['input_token_details', 'inputTokenDetails', 'prompt_tokens_details', 'promptTokensDetails']) {
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
            for (const k of ['cached_tokens', 'cachedTokens', 'cache_hit_tokens', 'cacheHitTokens']) {
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
function normalizeChunkUsage(chunk) {
    const usage = chunk.usage;
    if (!usage)
        return null;
    const inp = (usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const out = (usage.completion_tokens ?? usage.output_tokens ?? 0);
    const cached = extractCachedInputTokensFromUsage(usage);
    if (inp === 0 && out === 0 && cached === 0)
        return null;
    return { input_tokens: inp, output_tokens: out, input_cached_token: cached };
}
function mergeUsageIntoState(state, usage) {
    state.lastUsage.input_tokens = Math.max(state.lastUsage.input_tokens, usage.input_tokens);
    state.lastUsage.output_tokens = Math.max(state.lastUsage.output_tokens, usage.output_tokens);
    state.lastUsage.input_cached_token = Math.max(state.lastUsage.input_cached_token, usage.input_cached_token);
}
function mapStopReason(reason) {
    if (!reason)
        return 'end_turn';
    switch (reason) {
        case 'stop': return 'end_turn';
        case 'length': return 'max_tokens';
        case 'tool_calls':
        case 'function_call': return 'tool_use';
        default: return 'end_turn';
    }
}
function emitMessageDelta(state, res, finishReason, chunkUsage) {
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
}
function flushDone(state, res) {
    if (state.messageStarted && !state.messageStopped) {
        closeCurrentBlockIfNeeded(state, res);
        if (!state.messageStopped) {
            res.write(formatSSEEvent('message_stop', { type: 'message_stop' }));
            state.messageStopped = true;
        }
    }
}
function extractDeltaTextForStream(delta) {
    const c = delta?.content;
    if (c == null || c === '')
        return null;
    if (typeof c === 'string')
        return c;
    if (Array.isArray(c)) {
        const parts = [];
        for (const p of c) {
            if (p?.type === 'text' && typeof p.text === 'string')
                parts.push(p.text);
            else if (typeof p === 'string')
                parts.push(p);
        }
        return parts.length ? parts.join('') : null;
    }
    return null;
}
function extractReasoningDeltaForStream(delta) {
    const r = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof r === 'string' && r.length > 0)
        return r;
    const rd = delta?.reasoning_details;
    if (!Array.isArray(rd))
        return null;
    const joined = rd.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('');
    return joined.length > 0 ? joined : null;
}
function sliceCumulativeDelta(full, state, key) {
    const prev = state[key] ?? '';
    if (full.startsWith(prev)) {
        state[key] = full;
        return full.slice(prev.length);
    }
    state[key] = full;
    return full;
}
function processOpenAIChunk(chunk, state, res, streamOpts) {
    ensureMessageStart(state, res, chunk);
    const chunkUsage = normalizeChunkUsage(chunk);
    if (chunkUsage)
        mergeUsageIntoState(state, chunkUsage);
    const choice = chunk.choices?.[0];
    if (!choice)
        return;
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
            const toolState = state.toolCalls.get(toolIndex);
            if (tc.id && !toolState.id)
                toolState.id = tc.id;
            if (tc.function?.name && !toolState.name)
                toolState.name = tc.function.name;
            const extraContent = normalizeToolCallExtraContent(tc);
            if (extraContent !== undefined) {
                toolState.extraContent = extraContent;
                if (tc.id)
                    cacheToolCallExtraContent(tc.id, extraContent);
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
async function handleChatCompletionsStreamResponse(upstreamResponse, req, res, clientid, modelid, startTime, upstreamReq, extra, upstreamProvider) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const state = createStreamState();
    const streamOpts = {
        minimaxCumulativeDelta: upstreamProvider?.toLowerCase() === 'minimax',
    };
    const body = upstreamResponse.body;
    if (!body) {
        res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: 'Empty upstream response body' } }));
        res.end();
        (0, usageLogger_1.appendUsageLog)(clientid, modelid, startTime, 0, 0, extra);
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
    const processBuffer = () => {
        let popped;
        while ((popped = popSSEPacket(buffer))) {
            buffer = popped.rest;
            const lines = popped.packet.split(/\r?\n/);
            const dataLines = [];
            for (const l of lines) {
                if (l.startsWith('data:'))
                    dataLines.push(l.substring(5).trim());
            }
            if (dataLines.length === 0)
                continue;
            const payload = dataLines.join('');
            if (payload === '[DONE]') {
                sawDone = true;
                return;
            }
            try {
                const chunk = JSON.parse(payload);
                processOpenAIChunk(chunk, state, res, streamOpts);
            }
            catch (parseErr) {
                logger_1.logger.verbose('SSE chunk parse error:', parseErr);
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
            buffer += decoder.decode(result.value, { stream: true });
            processBuffer();
        }
        if (!abortSignal.aborted) {
            buffer += decoder.decode(new Uint8Array(), { stream: false });
            processBuffer();
        }
    }
    catch (err) {
        logger_1.logger.error('Stream error:', err);
        if (state.messageStarted && !state.messageStopped) {
            res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } }));
        }
    }
    finally {
        try {
            reader.cancel();
        }
        catch { }
        flushDone(state, res);
        const inputContent = buildTrimmedInputContentForUsageLog(upstreamReq);
        const outputContent = state.outputAccumulator.join('');
        (0, usageLogger_1.appendUsageLog)(clientid, modelid, startTime, state.lastUsage.input_tokens, state.lastUsage.output_tokens, {
            ...extra,
            input_cached_token: state.lastUsage.input_cached_token,
            input_content: inputContent,
            output_content: outputContent,
        });
        res.end();
    }
}
async function handleResponsesStreamResponse(upstreamResponse, req, res, clientid, modelid, startTime, upstreamReq, extra) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const state = createStreamState();
    const rctx = { functionCalls: new Map() };
    const body = upstreamResponse.body;
    if (!body) {
        res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: 'Empty upstream response body' } }));
        res.end();
        (0, usageLogger_1.appendUsageLog)(clientid, modelid, startTime, 0, 0, extra);
        return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const abortSignal = { aborted: false };
    const onClose = () => { abortSignal.aborted = true; };
    req.once('close', onClose);
    res.once('close', onClose);
    const processResponsesBuffer = () => {
        let popped;
        while ((popped = popSSEPacket(buffer))) {
            buffer = popped.rest;
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
            try {
                const data = JSON.parse(dataLines.join(''));
                processResponsesStreamEvent(eventType, data, state, rctx, res);
            }
            catch (parseErr) {
                logger_1.logger.verbose('Responses SSE parse error:', parseErr);
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
            buffer += decoder.decode(result.value, { stream: true });
            processResponsesBuffer();
        }
        if (!abortSignal.aborted) {
            buffer += decoder.decode(new Uint8Array(), { stream: false });
            processResponsesBuffer();
        }
    }
    catch (err) {
        logger_1.logger.error('Responses stream error:', err);
        if (state.messageStarted && !state.messageStopped) {
            res.write(formatSSEEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } }));
        }
    }
    finally {
        try {
            reader.cancel();
        }
        catch { }
        flushDone(state, res);
        const inputContent = buildTrimmedInputContentForUsageLog(upstreamReq);
        const outputContent = state.outputAccumulator.join('');
        (0, usageLogger_1.appendUsageLog)(clientid, modelid, startTime, state.lastUsage.input_tokens, state.lastUsage.output_tokens, {
            ...extra,
            input_cached_token: state.lastUsage.input_cached_token,
            input_content: inputContent,
            output_content: outputContent,
        });
        res.end();
    }
}
function processResponsesStreamEvent(eventType, data, state, rctx, res) {
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
function isToolsUnsupportedError(status, bodyText) {
    if (status !== 400)
        return false;
    const lower = bodyText.toLowerCase();
    return lower.includes('tools') && (lower.includes('not support') || lower.includes('unsupported') || lower.includes('unknown'));
}
function stripToolsFromRequest(openAIReq) {
    delete openAIReq.tools;
    delete openAIReq.tool_choice;
}
function isMaxTokensUnsupportedError(status, bodyText) {
    if (status !== 400)
        return false;
    const lower = bodyText.toLowerCase();
    return lower.includes('max_tokens') && (lower.includes('not support') || lower.includes('unknown') || lower.includes('invalid'));
}
function convertMaxTokensToMaxCompletionTokens(openAIReq) {
    if (openAIReq.max_tokens) {
        openAIReq.max_completion_tokens = openAIReq.max_tokens;
        delete openAIReq.max_tokens;
    }
}
function clampMaxTokensFromError(bodyText, openAIReq) {
    const match = bodyText.match(/max.*?(\d{2,})/i);
    if (match) {
        const limit = parseInt(match[1], 10);
        if (limit > 0) {
            if (openAIReq.max_tokens)
                openAIReq.max_tokens = Math.min(openAIReq.max_tokens, limit);
            if (openAIReq.max_completion_tokens)
                openAIReq.max_completion_tokens = Math.min(openAIReq.max_completion_tokens, limit);
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
    const clientApiKeyRaw = extractClientApiKey(req);
    if (!clientApiKeyRaw && !isAuthBypassed()) {
        sendErrorResponse(res, 401, 'Missing API key', 'authentication_error');
        return;
    }
    const clientId = clientApiKeyRaw || 'bypass';
    // 优先从 header 读取用户名（效率更高）
    let userInfo = null;
    const xUserRaw = req.headers['x-llm-proxy-user'] || req.headers['x-show-name'];
    const xUser = Array.isArray(xUserRaw) ? xUserRaw[0] : xUserRaw;
    logger_1.logger.verbose(`[${reqId}] Auth debug:`, {
        hasXllmProxyUser: !!req.headers['x-llm-proxy-user'],
        hasXShowName: !!req.headers['x-show-name'],
        xUserValue: xUser ? `${xUser.substring(0, 20)}...` : undefined,
        clientIdLength: clientId?.length,
        clientIdPrefix: clientId ? `${clientId.substring(0, 20)}...` : undefined,
        isLikelyJwt: clientId ? isLikelyJwt(clientId) : false,
    });
    if (typeof xUser === 'string' && xUser.trim()) {
        userInfo = { name: xUser.trim() };
        logger_1.logger.verbose(`[${reqId}] Using username from header:`, userInfo.name);
    }
    else {
        userInfo = await authenticateRequest(clientId);
        logger_1.logger.verbose(`[${reqId}] Using username from authenticateRequest:`, userInfo?.name);
    }
    if (!userInfo) {
        sendErrorResponse(res, 401, 'Authentication failed', 'authentication_error');
        return;
    }
    const resolved = (0, config_1.resolveUpstreamFromModel)(model, ctx.upstreamsByIdMap, ctx.defaultUpstream, ctx.modelRoutesMap);
    if (!resolved) {
        sendErrorResponse(res, 403, 'No upstream configured for this model', 'permission_error');
        return;
    }
    const { upstream, modelId, upstreamRouteId } = resolved;
    logger_1.logger.verbose(`[${reqId}] Upstream: ${upstreamRouteId}, model: ${modelId}, provider: ${upstream.provider || 'default'}`);
    const openAIReq = (0, formatTransform_1.anthropicToOpenAI)(parsedBody);
    // Provider pipeline (strict order, do not reorder)
    openAIReq.model = modelId || upstream.model;
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
    let upstreamRequestBody;
    if (upstreamAPIType === 'responses') {
        upstreamRequestBody = convertChatCompletionsRequestToResponsesRequest(openAIReq);
    }
    else {
        upstreamRequestBody = openAIReq;
    }
    if (parsedBody.stream && upstreamAPIType === 'chat_completions') {
        upstreamRequestBody.stream = true;
        upstreamRequestBody.stream_options = { include_usage: true };
    }
    else if (parsedBody.stream) {
        upstreamRequestBody.stream = true;
    }
    // ─── Context budget: pre-flight trim ───
    {
        const effectiveModel = modelId || upstream.model;
        const requestedMaxOutput = upstreamRequestBody.max_tokens
            || upstreamRequestBody.max_completion_tokens
            || upstreamRequestBody.max_output_tokens;
        const inputBudget = (0, contextBudget_1.computeInputBudget)(effectiveModel, requestedMaxOutput);
        const estimated = (0, contextBudget_1.estimateRequestTokens)(upstreamRequestBody);
        if (estimated > inputBudget) {
            const trimResult = (0, contextBudget_1.trimToFitBudget)(upstreamRequestBody, inputBudget);
            if (trimResult.trimmed) {
                upstreamRequestBody = trimResult.trimmedBody;
                logger_1.logger.verbose(`[${reqId}] Context budget: trimmed from ~${estimated} to ~${trimResult.estimatedTokens} tokens (budget: ${inputBudget}). Actions: ${trimResult.actions.join('; ')}`);
            }
        }
    }
    const targetURLs = (0, formatTransform_1.buildUpstreamTargetUrls)(upstream.baseURL, upstreamAPIType, upstream.provider);
    const sessionId = req.headers['x-woicrew-session-id'];
    const usageExtra = {
        app: 'woicrew',
        username: userInfo.name,
        stream: parsedBody.stream === true,
        request_size: rawBody.length,
        session_id: typeof sessionId === 'string' && sessionId ? sessionId : null,
        routing_key: upstreamRouteId,
    };
    const USAGE_LOG_INPUT_FULLTEXT = process.env.WOICLAW_USAGE_LOG_INPUT_FULLTEXT;
    if (USAGE_LOG_INPUT_FULLTEXT === '1' || USAGE_LOG_INPUT_FULLTEXT === 'true') {
        usageExtra.input_fulltext = JSON.stringify(upstreamRequestBody);
    }
    let upstreamResponse = null;
    let lastError = null;
    for (const targetURL of targetURLs) {
        logger_1.logger.verbose(`[${reqId}] Fetching: ${targetURL}`);
        try {
            upstreamResponse = await fetch(targetURL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${upstream.apiKey}`,
                },
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
    if (!upstreamResponse) {
        sendErrorResponse(res, 502, `Upstream request failed: ${lastError?.message || 'unknown'}`, 'api_error');
        return;
    }
    if (!upstreamResponse.ok && upstreamAPIType === 'chat_completions') {
        let bodyText = '';
        try {
            bodyText = await upstreamResponse.clone().text();
        }
        catch { }
        if (isToolsUnsupportedError(upstreamResponse.status, bodyText)) {
            stripToolsFromRequest(upstreamRequestBody);
            const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
                body: JSON.stringify(upstreamRequestBody),
            });
            if (retryResp.ok || retryResp.status !== 400)
                upstreamResponse = retryResp;
        }
        if (!upstreamResponse.ok && isMaxTokensUnsupportedError(upstreamResponse.status, bodyText)) {
            convertMaxTokensToMaxCompletionTokens(upstreamRequestBody);
            const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
                body: JSON.stringify(upstreamRequestBody),
            });
            if (retryResp.ok || retryResp.status !== 400)
                upstreamResponse = retryResp;
        }
        if (!upstreamResponse.ok && upstreamResponse.status === 400) {
            try {
                bodyText = await upstreamResponse.clone().text();
            }
            catch { }
            if (clampMaxTokensFromError(bodyText, upstreamRequestBody)) {
                const retryResp = await fetch(targetURLs[targetURLs.length - 1], {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.apiKey}` },
                    body: JSON.stringify(upstreamRequestBody),
                });
                if (retryResp.ok || retryResp.status !== 400)
                    upstreamResponse = retryResp;
            }
        }
        for (let trimRound = 0; trimRound < 3; trimRound++) {
            if (upstreamResponse.ok || upstreamResponse.status !== 400)
                break;
            try {
                bodyText = await upstreamResponse.clone().text();
            }
            catch { }
            if (!(0, contextBudget_1.isTokenExceedError)(upstreamResponse.status, bodyText))
                break;
            upstreamRequestBody = (0, contextBudget_1.aggressiveTrimForRetry)(upstreamRequestBody, trimRound);
            logger_1.logger.verbose(`[${reqId}] Token exceed error, retry round ${trimRound + 1}/3 with aggressively trimmed context`);
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
        try {
            errText = await upstreamResponse.text();
        }
        catch { }
        logger_1.logger.verbose(`[${reqId}] Upstream error ${upstreamResponse.status}:`, errText.substring(0, 500));
        sendErrorResponse(res, upstreamResponse.status, `Upstream error: ${errText.substring(0, 200)}`, 'api_error');
        return;
    }
    if (parsedBody.stream) {
        if (upstreamAPIType === 'responses') {
            await handleResponsesStreamResponse(upstreamResponse, req, res, clientId, modelId || upstream.model, startTime, upstreamRequestBody, usageExtra);
        }
        else {
            await handleChatCompletionsStreamResponse(upstreamResponse, req, res, clientId, modelId || upstream.model, startTime, upstreamRequestBody, usageExtra, upstream.provider);
        }
        return;
    }
    let upstreamBody;
    try {
        upstreamBody = await upstreamResponse.json();
    }
    catch {
        sendErrorResponse(res, 502, 'Failed to parse upstream response', 'api_error');
        return;
    }
    if (upstreamAPIType === 'responses') {
        upstreamBody = convertResponsesToOpenAIResponse(upstreamBody);
    }
    const anthropicResp = (0, formatTransform_1.openAIToAnthropic)(upstreamBody);
    const inputContent = buildTrimmedInputContentForUsageLog(upstreamRequestBody);
    const outputContent = extractOutputContentFromAnthropicResponse(anthropicResp);
    const respUsage = anthropicResp.usage || { input_tokens: 0, output_tokens: 0 };
    (0, usageLogger_1.appendUsageLog)(clientId, modelId || upstream.model, startTime, respUsage.input_tokens || 0, respUsage.output_tokens || 0, {
        ...usageExtra,
        input_cached_token: extractCachedInputTokensFromUsage(upstreamBody.usage),
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
                const items = [];
                const seen = new Set();
                // 1. modelRoutes 中显式映射的模型（直接用模型名路由）
                for (const [modelName] of ctx.modelRoutesMap) {
                    if (seen.has(modelName))
                        continue;
                    seen.add(modelName);
                    items.push({ model_id: modelName, model_alias: modelName });
                }
                // 2. 各 upstream 的默认模型（若未被 modelRoutes 覆盖，用 upstreamId|model 路由）
                for (const [upstreamId, upstream] of ctx.upstreamsByIdMap) {
                    if (seen.has(upstream.model))
                        continue;
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
