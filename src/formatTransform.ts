// ─── Anthropic Messages API URL builder ──────────────────────────────────────

export function buildAnthropicMessagesURL(baseURL: string): string[] {
  let url = baseURL.replace(/\/+$/, '');
  if (url.includes('/v1/messages')) return [url];
  if (/\/v\d+\/?$/.test(url)) return [url + '/messages'];
  return [url + '/v1/messages'];
}
