import { logger } from './logger';
import type { ProviderContextWindowsConfig } from './config';

// 鈹€鈹€鈹€ Model context window registry 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT = 4_096;

function loadEnvOverrides(): Record<string, number> {
  const raw = process.env.WOICLAW_CONTEXT_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function parseWindowToken(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`invalid context window: ${value}`);
    }
    return value;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(k|m)$/i.exec(value.trim());
  if (!m) {
    throw new Error(`invalid context window token: "${value}" (expected e.g. "128k" or "1m")`);
  }
  const n = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  return unit === 'm' ? Math.round(n * 1_000_000) : Math.round(n * 1_000);
}

export function getModelContextWindow(
  provider: string | undefined,
  modelId: string,
  providerContextWindows?: ProviderContextWindowsConfig,
): { contextWindow: number; maxOutputTokens: number } {
  const overrides = loadEnvOverrides();
  const modelOverride = overrides[modelId];

  const providerSpec = provider
    ? providerContextWindows?.overrides?.[provider] ?? providerContextWindows?.default
    : providerContextWindows?.default;

  const contextWindow =
    modelOverride ??
    (providerSpec ? parseWindowToken(providerSpec.contextWindow) : undefined) ??
    DEFAULT_CONTEXT_WINDOW;

  const maxOutputTokens =
    providerSpec?.maxOutputTokens ??
    providerContextWindows?.default?.maxOutputTokens ??
    DEFAULT_MAX_OUTPUT;

  return { contextWindow, maxOutputTokens };
}

// 鈹€鈹€鈹€ Token estimation (Anthropic format) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€


export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0xF900 && code <= 0xFAFF)) {
      cjkCount++;
    }
  }
  const nonCjkCount = text.length - cjkCount;
  const raw = Math.ceil(nonCjkCount / 4) + Math.ceil(cjkCount / 1.5);
  return Math.ceil(raw * 1.05);
}

function estimateImageTokensFromBase64(base64Data: string): number {
  const byteSize = Math.ceil(base64Data.length * 3 / 4);
  return Math.max(85, Math.ceil(byteSize / 750));
}

function estimateAnthropicContent(content: any): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        total += estimateTextTokens(block.text || '');
        break;
      case 'image':
        if (block.source?.type === 'base64' && block.source.data) {
          total += estimateImageTokensFromBase64(block.source.data);
        } else {
          total += 85;
        }
        break;
      case 'tool_use':
        total += estimateTextTokens(JSON.stringify(block.input || {}));
        total += estimateTextTokens(block.name || '');
        break;
      case 'tool_result':
        total += estimateAnthropicContent(block.content);
        break;
      case 'thinking':
        total += estimateTextTokens(block.thinking || '');
        break;
    }
  }
  return total;
}

export function estimateRequestTokens(body: any): number {
  let total = 0;
  // System prompt
  if (body.system) {
    if (typeof body.system === 'string') {
      total += estimateTextTokens(body.system);
    } else if (Array.isArray(body.system)) {
      total += estimateAnthropicContent(body.system);
    }
  }
  // Messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      total += 4; // role overhead
      total += estimateAnthropicContent(msg.content);
    }
  }
  // Tools
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      total += estimateTextTokens(tool.description || '');
      total += estimateTextTokens(JSON.stringify(tool.input_schema || {}));
    }
  }
  return total;
}

// 鈹€鈹€鈹€ Budget calculation 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export function computeInputBudget(
  provider: string | undefined,
  modelId: string,
  requestedMaxOutput?: number,
  providerContextWindows?: ProviderContextWindowsConfig,
): number {
  const spec = getModelContextWindow(provider, modelId, providerContextWindows);
  const maxOutput = requestedMaxOutput || spec.maxOutputTokens;
  const budget = Math.floor((spec.contextWindow - maxOutput) * 0.85);
  return Math.max(budget, 1024);
}

// 鈹€鈹€鈹€ Trimming (Anthropic format) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface TrimResult {
  trimmed: boolean;
  trimmedBody: any;
  estimatedTokens: number;
  actions: string[];
}

function hasImageInContent(content: any): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block.type === 'image');
}

function replaceImagesWithPlaceholderInContent(content: any): void {
  if (!Array.isArray(content)) return;
  for (let i = 0; i < content.length; i++) {
    if (content[i].type === 'image') {
      content[i] = { type: 'text', text: '[image removed to fit context]' };
    }
  }
}

function findToolUseIdsInMessage(msg: any): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) ids.add(block.id);
    }
  }
  return ids;
}

function findToolResultIdsInMessage(msg: any): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) ids.add(block.tool_use_id);
    }
  }
  return ids;
}

function findProtectedTailIndex(messages: any[]): number {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages.length;
  let protectFrom = lastUserIdx;
  if (lastUserIdx > 0 && messages[lastUserIdx - 1].role === 'assistant') {
    protectFrom = lastUserIdx - 1;
  }
  return protectFrom;
}

function estimateMessageTokens(msg: any): number {
  return 4 + estimateAnthropicContent(msg.content);
}

export function trimToFitBudget(body: any, inputBudget: number): TrimResult {
  const trimmed = structuredClone(body);
  const actions: string[] = [];
  const messages: any[] = trimmed.messages || [];
  if (!messages.length) {
    return { trimmed: false, trimmedBody: trimmed, estimatedTokens: estimateRequestTokens(trimmed), actions };
  }

  let currentEstimate = estimateRequestTokens(trimmed);

  // Phase 1: remove images from old messages (keep last 2 user messages' images)
  let userWithImageCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && hasImageInContent(messages[i].content)) userWithImageCount++;
  }
  if (userWithImageCount > 2) {
    let kept = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && hasImageInContent(messages[i].content)) {
        kept++;
        if (kept > 2) {
          const before = estimateAnthropicContent(messages[i].content);
          replaceImagesWithPlaceholderInContent(messages[i].content);
          const after = estimateAnthropicContent(messages[i].content);
          currentEstimate -= (before - after);
          actions.push(`removed images from message[${i}]`);
        }
      }
    }
    if (currentEstimate <= inputBudget) {
      return { trimmed: true, trimmedBody: trimmed, estimatedTokens: currentEstimate, actions };
    }
  }

  // Phase 2: remove all remaining images
  let removedAnyImage = false;
  for (let i = 0; i < messages.length; i++) {
    if (hasImageInContent(messages[i].content)) {
      const before = estimateAnthropicContent(messages[i].content);
      replaceImagesWithPlaceholderInContent(messages[i].content);
      const after = estimateAnthropicContent(messages[i].content);
      currentEstimate -= (before - after);
      actions.push(`removed all images from message[${i}]`);
      removedAnyImage = true;
    }
  }
  if (Array.isArray(trimmed.system)) {
    for (let i = 0; i < trimmed.system.length; i++) {
      if (trimmed.system[i].type === 'image') {
        const before = estimateAnthropicContent([trimmed.system[i]]);
        trimmed.system[i] = { type: 'text', text: '[image removed to fit context]' };
        const after = estimateAnthropicContent([trimmed.system[i]]);
        currentEstimate -= (before - after);
        removedAnyImage = true;
      }
    }
  }
  if (removedAnyImage && currentEstimate <= inputBudget) {
    return { trimmed: true, trimmedBody: trimmed, estimatedTokens: currentEstimate, actions };
  }

  // Phase 3: remove oldest messages (preserve protected tail)
  let protectFrom = findProtectedTailIndex(messages);
  let idx = 0;
  let removedCount = 0;
  while (idx < protectFrom && currentEstimate > inputBudget) {
    const msg = messages[idx];
    const msgTokens = estimateMessageTokens(msg);
    const toolUseIds = findToolUseIdsInMessage(msg);
    const toolResultIds = findToolResultIdsInMessage(msg);

    messages.splice(idx, 1);
    currentEstimate -= msgTokens;
    removedCount++;

    if (toolUseIds.size > 0 && idx < messages.length && messages[idx].role === 'user') {
      const nextResultIds = findToolResultIdsInMessage(messages[idx]);
      const allMatch = [...nextResultIds].every(id => toolUseIds.has(id));
      if (allMatch && nextResultIds.size > 0) {
        currentEstimate -= estimateMessageTokens(messages[idx]);
        messages.splice(idx, 1);
        removedCount++;
      }
    } else if (toolResultIds.size > 0 && idx > 0 && messages[idx - 1].role === 'assistant') {
      const prevUseIds = findToolUseIdsInMessage(messages[idx - 1]);
      const allMatch = [...prevUseIds].every(id => toolResultIds.has(id));
      if (allMatch && prevUseIds.size > 0) {
        currentEstimate -= estimateMessageTokens(messages[idx - 1]);
        messages.splice(idx - 1, 1);
        removedCount++;
        idx--;
      }
    }

    protectFrom = findProtectedTailIndex(messages);
  }
  if (removedCount > 0) actions.push(`removed ${removedCount} oldest messages`);
  // 删除老消息可能拆散跨消息的 tool_use/tool_result 配对(或 body 本就带孤儿)。
  // 统一剥离孤儿 tool_result,覆盖下面 320/388 两个 return(Phase 4 只截断文本
  // 不删消息,不会再产生孤儿)。
  stripOrphanedToolResults(messages);
  if (currentEstimate <= inputBudget) {
    return { trimmed: true, trimmedBody: trimmed, estimatedTokens: currentEstimate, actions };
  }

  // Phase 4: truncate longest text content to 50%
  for (let pass = 0; pass < 3 && currentEstimate > inputBudget; pass++) {
    let maxLen = 0;
    let maxMsgIdx = -1;
    let maxBlockIdx = -1;

    // Check messages
    for (let i = 0; i < messages.length; i++) {
      if (Array.isArray(messages[i].content)) {
        for (let j = 0; j < messages[i].content.length; j++) {
          const block = messages[i].content[j];
          if (block.type === 'text' && block.text && block.text.length > maxLen) {
            maxLen = block.text.length;
            maxMsgIdx = i;
            maxBlockIdx = j;
          }
        }
      } else if (typeof messages[i].content === 'string' && messages[i].content.length > maxLen) {
        maxLen = messages[i].content.length;
        maxMsgIdx = i;
        maxBlockIdx = -1;
      }
    }

    // Check system
    if (typeof trimmed.system === 'string' && trimmed.system.length > maxLen) {
      maxLen = trimmed.system.length;
      maxMsgIdx = -2; // sentinel for system
      maxBlockIdx = -1;
    } else if (Array.isArray(trimmed.system)) {
      for (let j = 0; j < trimmed.system.length; j++) {
        if (trimmed.system[j].type === 'text' && trimmed.system[j].text && trimmed.system[j].text.length > maxLen) {
          maxLen = trimmed.system[j].text.length;
          maxMsgIdx = -2;
          maxBlockIdx = j;
        }
      }
    }

    if (maxMsgIdx < 0 && maxMsgIdx !== -2) break;

    const halfLen = Math.ceil(maxLen / 2);
    const savedTokens = Math.floor((maxLen - halfLen - 15) / 4);

    if (maxMsgIdx === -2) {
      if (maxBlockIdx >= 0) {
        trimmed.system[maxBlockIdx].text =
          trimmed.system[maxBlockIdx].text.slice(0, Math.ceil(maxLen / 2)) + '\n[...truncated]';
      } else {
        trimmed.system =
          (trimmed.system as string).slice(0, Math.ceil(maxLen / 2)) + '\n[...truncated]';
      }
      actions.push('truncated long text in system');
    } else if (maxBlockIdx >= 0) {
      messages[maxMsgIdx].content[maxBlockIdx].text =
        messages[maxMsgIdx].content[maxBlockIdx].text.slice(0, Math.ceil(maxLen / 2)) + '\n[...truncated]';
      actions.push(`truncated long text in message[${maxMsgIdx}]`);
    } else {
      messages[maxMsgIdx].content =
        (messages[maxMsgIdx].content as string).slice(0, Math.ceil(maxLen / 2)) + '\n[...truncated]';
      actions.push(`truncated long text in message[${maxMsgIdx}]`);
    }
    currentEstimate -= Math.max(0, savedTokens);
  }

  return { trimmed: actions.length > 0, trimmedBody: trimmed, estimatedTokens: currentEstimate, actions };
}

// 鈹€鈹€鈹€ 400 error detection 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

/**
 * 原地剥离孤儿 tool_result:删除所有 tool_use_id 找不到对应 tool_use 的
 * tool_result 块。若某条消息的 content 因此变空,整条删除。
 *
 * 覆盖 trimToFitBudget / aggressiveTrimForRetry 的整块级配对删除处理不到的
 * “混合块级孤儿”(一条 user 消息里既有孤儿 tool_result 又有正常内容)。
 * 只处理孤儿 tool_result 一个方向;tool_use 无 result 是 Anthropic 允许的
 * 中间态,不在此处理。
 */
export function stripOrphanedToolResults(messages: any[]): void {
  const validUseIds = new Set<string>();
  for (const msg of messages) {
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_use' && block.id) validUseIds.add(block.id);
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg?.content)) continue;
    const filtered = msg.content.filter(
      (block: any) =>
        !(block?.type === 'tool_result' && !validUseIds.has(block.tool_use_id)),
    );
    if (filtered.length === msg.content.length) continue;
    if (filtered.length === 0) {
      messages.splice(i, 1);
      i--;
    } else {
      msg.content = filtered;
    }
  }
}

// 鈹€鈹€鈹€ Aggressive trim for retry (Anthropic format) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export function aggressiveTrimForRetry(body: any, round: number = 0): any {
  const trimmed = structuredClone(body);
  const messages: any[] = trimmed.messages || [];

  // Replace images in all message content
  for (const msg of messages) {
    if (hasImageInContent(msg.content)) {
      replaceImagesWithPlaceholderInContent(msg.content);
    }
  }
  // Replace images in system
  if (Array.isArray(trimmed.system)) {
    for (let i = 0; i < trimmed.system.length; i++) {
      if (trimmed.system[i].type === 'image') {
        trimmed.system[i] = { type: 'text', text: '[image removed]' };
      }
    }
  }

  const protectFrom = findProtectedTailIndex(messages);
  const removableCount = protectFrom;

  // round 0: remove 50%, round 1: 75%, round 2+: 90%
  const removeFraction = round === 0 ? 0.5 : round === 1 ? 0.75 : 0.9;
  const toRemove = Math.ceil(removableCount * removeFraction);
  if (toRemove > 0) {
    // Collect tool IDs from messages being removed, then clean up orphaned pairs
    const removedToolUseIds = new Set<string>();
    const removedToolResultIds = new Set<string>();
    for (let i = 0; i < toRemove && i < protectFrom; i++) {
      for (const id of findToolUseIdsInMessage(messages[i])) removedToolUseIds.add(id);
      for (const id of findToolResultIdsInMessage(messages[i])) removedToolResultIds.add(id);
    }
    messages.splice(0, toRemove);

    // Remove orphaned tool_result messages whose parent tool_use was deleted
    for (let i = 0; i < messages.length; i++) {
      const resultIds = findToolResultIdsInMessage(messages[i]);
      if (resultIds.size > 0 && [...resultIds].some(id => removedToolUseIds.has(id))) {
        // Check if ALL tool_results in this message are orphans
        const allOrphaned = [...resultIds].every(id => removedToolUseIds.has(id));
        if (allOrphaned) {
          messages.splice(i, 1);
          i--;
        }
      }
    }
    // Remove orphaned tool_use messages whose child tool_result was deleted
    for (let i = 0; i < messages.length; i++) {
      const useIds = findToolUseIdsInMessage(messages[i]);
      if (useIds.size > 0 && [...useIds].some(id => removedToolResultIds.has(id))) {
        const allOrphaned = [...useIds].every(id => removedToolResultIds.has(id));
        if (allOrphaned) {
          messages.splice(i, 1);
          i--;
        }
      }
    }
  }

  // Truncate tool_result content blocks 鈥?more aggressively on later rounds
  const toolMaxLen = round === 0 ? 2000 : round === 1 ? 500 : 200;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string' && block.content.length > toolMaxLen) {
            block.content = block.content.slice(0, toolMaxLen) + '\n[...truncated]';
          } else if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (inner.type === 'text' && inner.text && inner.text.length > toolMaxLen) {
                inner.text = inner.text.slice(0, toolMaxLen) + '\n[...truncated]';
              }
            }
          }
        }
      }
    }
  }

  // Round 2+: also truncate long system prompt
  if (round >= 2) {
    if (typeof trimmed.system === 'string' && trimmed.system.length > 4000) {
      trimmed.system = trimmed.system.slice(0, 4000) + '\n[...system prompt truncated to fit context]';
    } else if (Array.isArray(trimmed.system)) {
      for (const block of trimmed.system) {
        if (block.type === 'text' && block.text && block.text.length > 4000) {
          block.text = block.text.slice(0, 4000) + '\n[...system prompt truncated to fit context]';
        }
      }
    }
  }

  // 兜底剥离整条级 allOrphaned 清理漏掉的混合块级孤儿(messages 是 trimmed.messages
  // 同一引用,原地剥离即生效)。
  stripOrphanedToolResults(messages);

  return trimmed;
}
