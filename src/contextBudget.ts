import { logger } from './logger';

// ─── Model context window registry ──────────────────────────────────────────

interface ModelContextSpec {
  pattern: RegExp;
  contextWindow: number;
  maxOutputTokens: number;
}

const MODEL_CONTEXT_SPECS: ModelContextSpec[] = [
  { pattern: /^gpt-4\.1/i,        contextWindow: 1_048_576, maxOutputTokens: 32_768 },
  { pattern: /^gpt-4o/i,          contextWindow: 128_000,   maxOutputTokens: 16_384 },
  { pattern: /^gpt-4-turbo/i,     contextWindow: 128_000,   maxOutputTokens: 4_096 },
  { pattern: /^gpt-5/i,           contextWindow: 1_048_576, maxOutputTokens: 32_768 },
  { pattern: /^o[134]/i,          contextWindow: 200_000,   maxOutputTokens: 100_000 },
  { pattern: /^gemini-2/i,        contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  { pattern: /^gemini-1\.5/i,     contextWindow: 1_048_576, maxOutputTokens: 8_192 },
  { pattern: /^deepseek/i,        contextWindow: 64_000,    maxOutputTokens: 8_192 },
  { pattern: /^qwen3\.5/i,        contextWindow: 262_144,   maxOutputTokens: 16_384 },
  { pattern: /^qwen/i,            contextWindow: 131_072,   maxOutputTokens: 8_192 },
  { pattern: /^doubao-seed/i,     contextWindow: 128_000,   maxOutputTokens: 8_192 },
  { pattern: /^doubao/i,          contextWindow: 128_000,   maxOutputTokens: 4_096 },
  { pattern: /^minimax/i,         contextWindow: 245_760,   maxOutputTokens: 16_384 },
  { pattern: /^claude/i,          contextWindow: 200_000,   maxOutputTokens: 8_192 },
  { pattern: /^glm/i,             contextWindow: 128_000,   maxOutputTokens: 4_096 },
  { pattern: /^yi-/i,             contextWindow: 200_000,   maxOutputTokens: 4_096 },
];

const DEFAULT_CONTEXT_WINDOW = 64_000;
const DEFAULT_MAX_OUTPUT = 4_096;

let envOverrides: Record<string, number> | null = null;
function loadEnvOverrides(): Record<string, number> {
  if (envOverrides !== null) return envOverrides;
  envOverrides = {};
  const raw = process.env.WOICLAW_CONTEXT_OVERRIDES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') envOverrides = parsed;
    } catch { /* ignore bad JSON */ }
  }
  return envOverrides!;
}

export function getModelContextWindow(modelId: string): { contextWindow: number; maxOutputTokens: number } {
  const overrides = loadEnvOverrides();
  if (overrides[modelId]) {
    return { contextWindow: overrides[modelId], maxOutputTokens: DEFAULT_MAX_OUTPUT };
  }
  for (const spec of MODEL_CONTEXT_SPECS) {
    if (spec.pattern.test(modelId)) {
      return { contextWindow: spec.contextWindow, maxOutputTokens: spec.maxOutputTokens };
    }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT };
}

// ─── Token estimation ───────────────────────────────────────────────────────

const CJK_RANGES = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_RANGES);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = text.length - cjkCount;
  const raw = Math.ceil(nonCjkCount / 4) + Math.ceil(cjkCount / 1.5);
  return Math.ceil(raw * 1.05);
}

export function estimateImageTokens(dataUri: string): number {
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx < 0) return 85;
  const base64Len = dataUri.length - commaIdx - 1;
  const byteSize = Math.ceil(base64Len * 3 / 4);
  return Math.max(85, Math.ceil(byteSize / 750));
}

function estimateContentTokens(content: any): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') {
      total += estimateTextTokens(part.text || '');
    } else if (part.type === 'image_url' && part.image_url?.url) {
      total += estimateImageTokens(part.image_url.url);
    }
  }
  return total;
}

export function estimateRequestTokens(body: any): number {
  let total = 0;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      total += 4; // role overhead
      total += estimateContentTokens(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          total += estimateTextTokens(JSON.stringify(tc.function || tc));
        }
      }
    }
  }
  if (Array.isArray(body.tools)) {
    total += estimateTextTokens(JSON.stringify(body.tools));
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      total += 4;
      if (typeof item.content === 'string') total += estimateTextTokens(item.content);
      if (Array.isArray(item.content)) total += estimateContentTokens(item.content);
    }
  }
  return total;
}

// ─── Budget calculation ─────────────────────────────────────────────────────

export function computeInputBudget(modelId: string, requestedMaxOutput?: number): number {
  const spec = getModelContextWindow(modelId);
  const maxOutput = requestedMaxOutput || spec.maxOutputTokens;
  const budget = Math.floor((spec.contextWindow - maxOutput) * 0.85);
  return Math.max(budget, 1024);
}

// ─── Trimming ───────────────────────────────────────────────────────────────

export interface TrimResult {
  trimmed: boolean;
  trimmedBody: any;
  estimatedTokens: number;
  actions: string[];
}

function isSystemMessage(msg: any): boolean {
  return msg.role === 'system' || msg.role === 'developer';
}

function hasImageContent(msg: any): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((p: any) => p.type === 'image_url');
}

function replaceImagesWithPlaceholder(msg: any): void {
  if (!Array.isArray(msg.content)) return;
  msg.content = msg.content.map((p: any) =>
    p.type === 'image_url' ? { type: 'text', text: '[image removed to fit context]' } : p
  );
}

function findProtectedTailIndex(messages: any[]): number {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i]._synthetic_image) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages.length;
  let protectFrom = lastUserIdx;
  if (lastUserIdx > 0 && messages[lastUserIdx - 1].role === 'assistant') {
    protectFrom = lastUserIdx - 1;
  }
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant' || messages[i].role === 'tool') {
      // keep trailing assistant/tool responses
    } else {
      break;
    }
  }
  return protectFrom;
}

export function trimToFitBudget(body: any, inputBudget: number): TrimResult {
  const trimmed = JSON.parse(JSON.stringify(body));
  const actions: string[] = [];
  const messages: any[] = trimmed.messages || trimmed.input || [];
  if (!messages.length) {
    return { trimmed: false, trimmedBody: trimmed, estimatedTokens: estimateRequestTokens(trimmed), actions };
  }

  const check = () => estimateRequestTokens(trimmed);

  // Phase 1: remove images from old messages (keep last 2 user messages' images)
  let userWithImageCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && hasImageContent(messages[i])) userWithImageCount++;
  }
  if (userWithImageCount > 2) {
    let kept = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && hasImageContent(messages[i])) {
        kept++;
        if (kept > 2) {
          replaceImagesWithPlaceholder(messages[i]);
          actions.push(`removed images from message[${i}]`);
        }
      }
    }
    if (check() <= inputBudget) {
      return { trimmed: true, trimmedBody: trimmed, estimatedTokens: check(), actions };
    }
  }

  // Phase 2: remove all remaining images
  for (let i = 0; i < messages.length; i++) {
    if (hasImageContent(messages[i]) || messages[i]._synthetic_image) {
      replaceImagesWithPlaceholder(messages[i]);
      actions.push(`removed all images from message[${i}]`);
    }
  }
  if (check() <= inputBudget) {
    return { trimmed: true, trimmedBody: trimmed, estimatedTokens: check(), actions };
  }

  // Phase 3: remove oldest non-system messages (preserve system + last exchange)
  const protectFrom = findProtectedTailIndex(messages);
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && isSystemMessage(messages[firstNonSystem])) {
    firstNonSystem++;
  }
  let removedCount = 0;
  while (firstNonSystem < protectFrom && check() > inputBudget) {
    // remove paired tool results when removing assistant with tool_calls
    const msg = messages[firstNonSystem];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const tcIds = new Set(msg.tool_calls.map((tc: any) => tc.id).filter(Boolean));
      messages.splice(firstNonSystem, 1);
      protectFrom && 0; // recalc below
      let j = firstNonSystem;
      while (j < messages.length && messages[j].role === 'tool' && tcIds.has(messages[j].tool_call_id)) {
        messages.splice(j, 1);
        removedCount++;
      }
    } else {
      messages.splice(firstNonSystem, 1);
    }
    removedCount++;
    // recalculate protectFrom since indices shifted
  }
  if (removedCount > 0) actions.push(`removed ${removedCount} oldest messages`);
  if (check() <= inputBudget) {
    return { trimmed: true, trimmedBody: trimmed, estimatedTokens: check(), actions };
  }

  // Phase 4: truncate longest text content to 50%
  for (let pass = 0; pass < 3 && check() > inputBudget; pass++) {
    let maxLen = 0;
    let maxIdx = -1;
    let maxPartIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (typeof messages[i].content === 'string' && messages[i].content.length > maxLen) {
        maxLen = messages[i].content.length;
        maxIdx = i;
        maxPartIdx = -1;
      }
      if (Array.isArray(messages[i].content)) {
        for (let j = 0; j < messages[i].content.length; j++) {
          const p = messages[i].content[j];
          if (p.type === 'text' && p.text && p.text.length > maxLen) {
            maxLen = p.text.length;
            maxIdx = i;
            maxPartIdx = j;
          }
        }
      }
    }
    if (maxIdx < 0) break;
    if (maxPartIdx >= 0) {
      messages[maxIdx].content[maxPartIdx].text =
        messages[maxIdx].content[maxPartIdx].text.slice(0, Math.ceil(maxLen / 2)) + '\n[...truncated]';
    } else {
      messages[maxIdx].content =
        messages[maxIdx].content.slice(0, Math.ceil(maxLen / 2)) + '\n[...truncated]';
    }
    actions.push(`truncated long text in message[${maxIdx}]`);
  }

  return { trimmed: actions.length > 0, trimmedBody: trimmed, estimatedTokens: check(), actions };
}

// ─── 400 error detection ────────────────────────────────────────────────────

const TOKEN_EXCEED_PATTERNS = [
  /total\s+tokens?.*exceed/i,
  /context\s+length\s+exceed/i,
  /maximum\s+context\s+length/i,
  /input\s+too\s+long/i,
  /request\s+too\s+large/i,
  /token\s+limit/i,
  /max.*token.*exceed/i,
  /exceed.*max.*(?:message|input)\s+token/i,
  /content\s+length.*exceed/i,
];

export function isTokenExceedError(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  return TOKEN_EXCEED_PATTERNS.some(p => p.test(bodyText));
}

// ─── Aggressive trim for retry ──────────────────────────────────────────────

export function aggressiveTrimForRetry(body: any, round: number = 0): any {
  const trimmed = JSON.parse(JSON.stringify(body));
  const messages: any[] = trimmed.messages || trimmed.input || [];

  for (const msg of messages) {
    replaceImagesWithPlaceholder(msg);
    if (msg._synthetic_image) {
      msg.content = [{ type: 'text', text: '[image removed]' }];
    }
  }

  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && isSystemMessage(messages[firstNonSystem])) {
    firstNonSystem++;
  }
  const protectFrom = findProtectedTailIndex(messages);
  const removableCount = protectFrom - firstNonSystem;

  // round 0: remove 50%, round 1: 75%, round 2+: 90%
  const removeFraction = round === 0 ? 0.5 : round === 1 ? 0.75 : 0.9;
  const toRemove = Math.ceil(removableCount * removeFraction);
  if (toRemove > 0) {
    messages.splice(firstNonSystem, toRemove);
  }

  // Truncate tool result content — more aggressively on later rounds
  const toolMaxLen = round === 0 ? 2000 : round === 1 ? 500 : 200;
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > toolMaxLen) {
      msg.content = msg.content.slice(0, toolMaxLen) + '\n[...truncated]';
    }
  }

  // Round 2+: also truncate long system messages
  if (round >= 2) {
    for (const msg of messages) {
      if (isSystemMessage(msg) && typeof msg.content === 'string' && msg.content.length > 4000) {
        msg.content = msg.content.slice(0, 4000) + '\n[...system prompt truncated to fit context]';
      }
    }
  }

  return trimmed;
}
