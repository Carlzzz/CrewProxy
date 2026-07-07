import { logger } from './logger';

export const TOKEN_FIVEHOUR_BUCKET_MS = 60_000;      // 1 min
export const TOKEN_WEEKLY_BUCKET_MS = 3_600_000;     // 1 hour
const FIVEHOUR_WINDOW_MS = 5 * 3_600_000;            // 5h
const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;         // 7d

interface WindowLog {
  buckets: Map<number, number>;  // bucketStartMs → token sum
}

/**
 * Per-upstream rolling-window token accumulator. Two independent windows:
 *  - 5h, 1-min buckets (300 buckets max)
 *  - 7d, 1-hour buckets (168 buckets max)
 *
 * Pure in-memory; resets on restart. record() is try/catch-guarded so it can
 * never break the proxy hot path (same contract as MetricsCollector).
 */
export class TokenUsageTracker {
  private byUpstream = new Map<string, { fiveHour: WindowLog; weekly: WindowLog }>();
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  record(upstreamId: string, tokens: number, ts?: number): void {
    try {
      if (!upstreamId || !Number.isFinite(tokens) || tokens <= 0) return;
      // `ts` undefined → default to now(); explicitly NaN/Infinity → ignore
      // (7th test contract: NaN ts must not contribute a valid value).
      const t = ts === undefined ? this.now() : ts;
      if (!Number.isFinite(t)) return;
      let entry = this.byUpstream.get(upstreamId);
      if (!entry) {
        entry = { fiveHour: { buckets: new Map() }, weekly: { buckets: new Map() } };
        this.byUpstream.set(upstreamId, entry);
      }
      this.put(entry.fiveHour, t, tokens, TOKEN_FIVEHOUR_BUCKET_MS, FIVEHOUR_WINDOW_MS);
      this.put(entry.weekly, t, tokens, TOKEN_WEEKLY_BUCKET_MS, WEEKLY_WINDOW_MS);
    } catch (err) {
      logger.error('[tokenUsage] record failed:', err);
    }
  }

  private put(log: WindowLog, ts: number, tokens: number, bucketMs: number, _windowMs: number): void {
    const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    log.buckets.set(bucketTs, (log.buckets.get(bucketTs) ?? 0) + tokens);
    this.prune(log, bucketMs);
  }

  private prune(log: WindowLog, bucketMs: number): void {
    const windowBuckets = bucketMs === TOKEN_FIVEHOUR_BUCKET_MS ? 300 : 168;
    if (log.buckets.size <= windowBuckets) return;
    const sorted = [...log.buckets.keys()].sort((a, b) => a - b);
    const remove = sorted.length - windowBuckets;
    for (let i = 0; i < remove; i++) log.buckets.delete(sorted[i]);
  }

  getUsage(upstreamId: string): { fiveHourTokens: number; weeklyTokens: number } {
    const entry = this.byUpstream.get(upstreamId);
    if (!entry) return { fiveHourTokens: 0, weeklyTokens: 0 };
    return {
      fiveHourTokens: this.sumSince(entry.fiveHour, FIVEHOUR_WINDOW_MS, TOKEN_FIVEHOUR_BUCKET_MS),
      weeklyTokens: this.sumSince(entry.weekly, WEEKLY_WINDOW_MS, TOKEN_WEEKLY_BUCKET_MS),
    };
  }

  private sumSince(log: WindowLog, windowMs: number, bucketMs: number): number {
    const cutoff = this.now() - windowMs;
    const cutoffBucket = Math.floor(cutoff / bucketMs) * bucketMs;
    let sum = 0;
    for (const [bucketTs, tokens] of log.buckets) {
      if (bucketTs >= cutoffBucket) sum += tokens;
    }
    return sum;
  }
}
