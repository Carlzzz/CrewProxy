// ─── 429 classification ────────────────────────────────────────────────
//
// MiniMax (and similar providers) return 429 for two very different reasons:
//   1. Short-window rate limiting   — QPS / concurrent-request burst. Resets
//      within seconds. Marking a credential out of service for 30 min would
//      "freeze-dry" the pool: one bursty user disables every key for half an
//      hour. We want a short cooldown (~30s) here.
//   2. True quota exhaustion        — daily / monthly / pre-paid bundle drained.
//      Resets at an explicit time, typically hours/days away. We keep the
//      long cooldown for these, and parse the reset timestamp when present.
//
// Anything not clearly identifiable defaults to short-window (the cheaper-to-
// be-wrong case): if it really was quota, the next request just bounces back
// onto the same cooldown loop with no real harm.

const QUOTA_KEYWORDS = [
  'quota', '配额', '额度',
  'monthly', 'daily limit',
  'insufficient quota', 'quota_exceeded',
  '用量', 'plan limit', 'subscription',
];

const RATE_LIMIT_KEYWORDS = [
  'too many requests', 'rate limit', 'rate_limit',
  'qps', 'rps', 'concurrent', 'concurrency',
  'slow down', 'throttle', '请求频率', '调用次数', '并发',
];

export type QuotaClass = 'rate_limit' | 'quota' | 'unknown';

export function classify429(status: number, bodyText: string): QuotaClass {
  if (status !== 429) return 'unknown';
  const lower = bodyText.toLowerCase();

  // Rate-limit keywords take precedence — phrases like "rate limit exceeded"
  // contain "limit" but are clearly rate-limit, not quota.
  for (const kw of RATE_LIMIT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return 'rate_limit';
  }
  for (const kw of QUOTA_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return 'quota';
  }
  return 'unknown';
}

/** Back-compat: only true for the "quota" class — used to decide whether to
 * read a long reset timestamp from the response. */
export function isQuotaLimitedResponse(status: number, bodyText: string): boolean {
  return classify429(status, bodyText) === 'quota';
}

export function parseQuotaResetEpochMs(bodyText: string): number | null {
  const patterns = [
    /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/i,
    /will reset (?:at|in) ([^.,]+)/i,
    /reset.*?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/i,
  ];

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) {
      const dateStr = match[1].trim();
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed.getTime();
      }
    }
  }

  return null;
}
