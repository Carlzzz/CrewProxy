const QUOTA_KEYWORDS = [
  'quota', '配额', '额度', 'limit exceeded', 'rate limit',
  '请求频率', '调用次数', '用量', 'monthly', 'daily limit',
  'insufficient quota', 'quota_exceeded', 'QUOTA_EXCEEDED',
];

export function isQuotaLimitedResponse(status: number, bodyText: string): boolean {
  if (status !== 429) return false;

  const lower = bodyText.toLowerCase();
  for (const keyword of QUOTA_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return true;
    }
  }

  return false;
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
