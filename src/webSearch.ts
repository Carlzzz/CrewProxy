export interface WebSearchHit {
  title: string;
  url: string;
}

function normalizeHit(title: unknown, url: unknown): WebSearchHit | null {
  if (typeof title !== 'string' || typeof url !== 'string') return null;
  return { title, url };
}

export function parseTavilyResponse(body: unknown): WebSearchHit[] {
  const b = body as { results?: Array<{ title?: unknown; url?: unknown }> } | null | undefined;
  return (b?.results ?? [])
    .map(h => normalizeHit(h?.title, h?.url))
    .filter((h): h is WebSearchHit => h != null);
}

export function parseBraveResponse(body: unknown): WebSearchHit[] {
  const b = body as { web?: { results?: Array<{ title?: unknown; url?: unknown }> } } | null | undefined;
  return (b?.web?.results ?? [])
    .map(h => normalizeHit(h?.title, h?.url))
    .filter((h): h is WebSearchHit => h != null);
}

export function applyDomainFiltersToQuery(query: string, allowed?: string[], blocked?: string[]): string {
  const allowedList = allowed?.filter(Boolean) ?? [];
  const blockedList = blocked?.filter(Boolean) ?? [];
  const allowedClause = allowedList.length
    ? `(${allowedList.map(d => `site:${d}`).join(' OR ')}) `
    : '';
  const blockedClause = blockedList.length
    ? `${blockedList.map(d => `-site:${d}`).join(' ')} `
    : '';
  return `${allowedClause}${blockedClause}${query}`.trim();
}

export async function searchTavily(
  query: string,
  apiKey: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      max_results: 8,
      search_depth: 'basic',
      include_answer: false,
      include_domains: allowedDomains,
      exclude_domains: blockedDomains,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status}`);
  }
  return parseTavilyResponse(await response.json());
}

export async function searchBrave(
  query: string,
  apiKey: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
  signal?: AbortSignal,
): Promise<WebSearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', applyDomainFiltersToQuery(query, allowedDomains, blockedDomains));
  url.searchParams.set('count', '8');
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Brave search failed: ${response.status}`);
  }
  return parseBraveResponse(await response.json());
}
