// ─── Helper utilities ────────────────────────────────────────────────────────

function cleanSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema') continue;
    if (k === 'format' && v === 'uri') continue;
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      const cleaned: any = {};
      for (const [pk, pv] of Object.entries(v as Record<string, any>)) {
        cleaned[pk] = cleanSchema(pv);
      }
      out[k] = cleaned;
    } else if (k === 'items') {
      out[k] = cleanSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function extractToolResultContent(block: any): string {
  let text: string;
  if (typeof block.content === 'string') {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    text = block.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  } else {
    text = '';
  }
  if (block.is_error) {
    text = '[Error] ' + text;
  }
  return text;
}

function convertMessageToOpenAI(msg: any): any[] {
  if (typeof msg.content === 'string') {
    return [{ role: msg.role, content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role: msg.role, content: '' }];
  }

  const results: any[] = [];
  let pendingParts: any[] = [];
  let assistantMsg: any | null = null;

  const flushPending = () => {
    if (pendingParts.length === 0) return;
    if (pendingParts.length === 1 && pendingParts[0].type === 'text') {
      results.push({ role: msg.role, content: pendingParts[0].text });
    } else {
      results.push({ role: msg.role, content: pendingParts });
    }
    pendingParts = [];
  };

  for (const block of msg.content) {
    switch (block.type) {
      case 'text':
        pendingParts.push({ type: 'text', text: block.text });
        break;

      case 'image': {
        const dataUri = `data:${block.source.media_type};base64,${block.source.data}`;
        pendingParts.push({ type: 'image_url', image_url: { url: dataUri } });
        break;
      }

      case 'tool_use': {
        if (msg.role === 'assistant') {
          if (!assistantMsg) {
            flushPending();
            assistantMsg = { role: 'assistant', content: null as string | null, tool_calls: [] };
          }
          const tc: any = {
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          };
          if (block.extra_content) {
            tc.extra_content = block.extra_content;
          }
          assistantMsg.tool_calls.push(tc);
        }
        break;
      }

      case 'tool_result': {
        flushPending();
        if (assistantMsg) {
          results.push(assistantMsg);
          assistantMsg = null;
        }
        results.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: extractToolResultContent(block),
        });

        if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner.type === 'image') {
              const dataUri = `data:${inner.source.media_type};base64,${inner.source.data}`;
              results.push({
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: dataUri } }],
                _synthetic_image: true,
              });
            }
          }
        }
        break;
      }
    }
  }

  if (assistantMsg) {
    if (pendingParts.length > 0) {
      if (pendingParts.length === 1 && pendingParts[0].type === 'text') {
        assistantMsg.content = pendingParts[0].text;
      } else {
        assistantMsg.content = pendingParts;
      }
      pendingParts = [];
    }
    results.push(assistantMsg);
  } else {
    flushPending();
  }

  return results;
}

function retainOnlyLastSyntheticImagePair(messages: any[]): any[] {
  const pairIndices: number[] = [];

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (
      prev.role === 'tool' &&
      curr.role === 'user' &&
      curr._synthetic_image &&
      Array.isArray(curr.content) &&
      curr.content.some((p: any) => p.type === 'image_url')
    ) {
      pairIndices.push(i - 1);
    }
  }

  if (pairIndices.length <= 1) return messages;

  const toRemove = new Set<number>();
  for (let i = 0; i < pairIndices.length - 1; i++) {
    toRemove.add(pairIndices[i]);
    toRemove.add(pairIndices[i] + 1);
  }

  return messages.filter((_, idx) => !toRemove.has(idx));
}

// ─── Part 1: Anthropic → OpenAI ─────────────────────────────────────────────

export function anthropicToOpenAI(body: any): any {
  const messages: any[] = [];

  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block.type === 'text') {
          messages.push({ role: 'system', content: block.text });
        }
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      messages.push(...convertMessageToOpenAI(msg));
    }
  }

  const finalMessages = retainOnlyLastSyntheticImagePair(messages);

  const req: any = {
    model: body.model,
    messages: finalMessages,
  };

  if (Array.isArray(body.tools)) {
    const converted = body.tools
      .filter((t: any) => t.type !== 'BatchTool')
      .map((t: any) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: cleanSchema(t.input_schema),
        },
      }));
    if (converted.length > 0) {
      req.tools = converted;
    }
  }

  if (body.tool_choice !== undefined) req.tool_choice = body.tool_choice;
  if (body.max_tokens !== undefined) req.max_tokens = body.max_tokens;
  if (body.stop_sequences !== undefined) req.stop = body.stop_sequences;
  if (body.stream !== undefined) req.stream = body.stream;
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.top_k !== undefined) req.top_k = body.top_k;

  return req;
}

// ─── Part 2: OpenAI → Anthropic ─────────────────────────────────────────────

function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

export function openAIToAnthropic(openAIResponse: any): any {
  const choice = openAIResponse.choices?.[0];
  const message = choice?.message || {};
  const usage = openAIResponse.usage || {};

  const content: any[] = [];

  const reasoningText = message.reasoning_content || message.reasoning;
  if (reasoningText) {
    content.push({ type: 'thinking', thinking: reasoningText });
  }

  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item.type === 'text') {
        content.push({ type: 'text', text: item.text });
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input: any = {};
      try {
        input = JSON.parse(tc.function.arguments) || {};
      } catch {
        input = {};
      }
      const toolUse: any = {
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      };
      if (tc.extra_content) {
        toolUse.extra_content = tc.extra_content;
      }
      if (tc.function?.thought_signature) {
        toolUse.thought_signature = tc.function.thought_signature;
      }
      content.push(toolUse);
    }
  }

  const id = openAIResponse.id || 'msg_' + Math.random().toString(36).slice(2, 14);

  return {
    id,
    type: 'message',
    role: 'assistant',
    model: openAIResponse.model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    usage: {
      input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    },
  };
}

// ─── Part 3: URL Builders ───────────────────────────────────────────────────

export function buildOpenAIChatCompletionsURL(baseURL: string): string {
  let url = baseURL.replace(/\/+$/, '');
  if (url.includes('/chat/completions')) return url;
  if (/\/v\d+\/?$/.test(url)) {
    url = url.replace(/\/+$/, '');
    return url + '/chat/completions';
  }
  return url + '/v1/chat/completions';
}

export function buildOpenAIResponsesURL(baseURL: string): string {
  let url = baseURL.replace(/\/+$/, '');
  if (url.includes('/responses')) return url;
  if (/\/v\d+\/?$/.test(url)) {
    url = url.replace(/\/+$/, '');
    return url + '/responses';
  }
  return url + '/v1/responses';
}

export function buildUpstreamTargetUrls(
  baseURL: string,
  upstreamAPIType: string,
  provider?: string,
): string[] {
  if (upstreamAPIType === 'responses') {
    return [buildOpenAIResponsesURL(baseURL)];
  }

  const primary = buildOpenAIChatCompletionsURL(baseURL);
  const urls: string[] = [primary];

  const isGemini =
    provider === 'gemini' || baseURL.includes('generativelanguage.googleapis.com');

  if (isGemini) {
    if (primary.includes('/v1beta/')) {
      urls.push(primary.replace('/v1beta/', '/v1/'));
    } else if (primary.includes('/v1/')) {
      urls.push(primary.replace('/v1/', '/v1beta/'));
    }
  }

  return [...new Set(urls)];
}
