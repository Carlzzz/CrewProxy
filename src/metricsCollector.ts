import { logger } from './logger';

export interface MetricEvent {
  upstreamId: string;
  credentialId?: string;
  model?: string;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  costMs: number;
  ts: number;
}

export interface WindowStats {
  count: number;
  success: number;
  fail: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  avgCostMs: number;
}

export const METRICS_BUCKET_MS = 10_000;          // 10s per bucket
export const METRICS_RETENTION_BUCKETS = 360;     // 1h

interface Bucket {
  count: number;
  success: number;
  fail: number;
  inputTokens: number;
  outputTokens: number;
  costMsSum: number;
}

/**
 * Time-bucketed metrics. Two dimensions are kept independently:
 *  - per-upstreamId buckets  → aggregate()      (provider cards, totals, trends)
 *  - per-credentialId buckets → aggregateByCredential() (pool load bar chart)
 *
 * Memory is bounded: each dimension retains at most METRICS_RETENTION_BUCKETS
 * buckets per key. Stale buckets are pruned on record().
 */
export class MetricsCollector {
  private byUpstream = new Map<string, Map<number, Bucket>>();
  private byCredential = new Map<string, Map<number, Bucket>>();

  constructor(private now: () => number = Date.now) {}

  record(event: MetricEvent): void {
    try {
      const bucketTs = Math.floor(event.ts / METRICS_BUCKET_MS) * METRICS_BUCKET_MS;
      if (event.upstreamId) this.put(this.byUpstream, event.upstreamId, bucketTs, event);
      if (event.credentialId) this.put(this.byCredential, event.credentialId, bucketTs, event);
    } catch (err) {
      // Metrics must NEVER break the proxy hot path.
      logger.error('[metrics] record failed:', err);
    }
  }

  private put(store: Map<string, Map<number, Bucket>>, key: string, bucketTs: number, e: MetricEvent): void {
    let buckets = store.get(key);
    if (!buckets) { buckets = new Map(); store.set(key, buckets); }
    let b = buckets.get(bucketTs);
    if (!b) {
      b = { count: 0, success: 0, fail: 0, inputTokens: 0, outputTokens: 0, costMsSum: 0 };
      buckets.set(bucketTs, b);
    }
    b.count++;
    if (e.success) b.success++; else b.fail++;
    b.inputTokens += e.inputTokens || 0;
    b.outputTokens += e.outputTokens || 0;
    b.costMsSum += e.costMs || 0;
    this.prune(buckets);
  }

  private prune(buckets: Map<number, Bucket>): void {
    if (buckets.size <= METRICS_RETENTION_BUCKETS) return;
    // remove oldest beyond retention
    const sorted = [...buckets.keys()].sort((a, b) => a - b);
    const remove = sorted.length - METRICS_RETENTION_BUCKETS;
    for (let i = 0; i < remove; i++) buckets.delete(sorted[i]);
  }

  /** Aggregate per-upstream stats over the last `windowSec` seconds. */
  aggregate(windowSec: number): Map<string, WindowStats> {
    return this.aggregateFrom(this.byUpstream, windowSec);
  }

  /** Aggregate per-credential stats over the last `windowSec` seconds. */
  aggregateByCredential(windowSec: number): Map<string, WindowStats> {
    return this.aggregateFrom(this.byCredential, windowSec);
  }

  private aggregateFrom(store: Map<string, Map<number, Bucket>>, windowSec: number): Map<string, WindowStats> {
    const cutoff = this.now() - windowSec * 1000;
    const cutoffBucket = Math.floor(cutoff / METRICS_BUCKET_MS) * METRICS_BUCKET_MS;
    const out = new Map<string, WindowStats>();
    for (const [key, buckets] of store) {
      let count = 0, success = 0, fail = 0, inputTokens = 0, outputTokens = 0, costMsSum = 0;
      for (const [bucketTs, b] of buckets) {
        // A bucket contributes only if it started within the window.
        if (bucketTs < cutoffBucket) continue;
        count += b.count; success += b.success; fail += b.fail;
        inputTokens += b.inputTokens; outputTokens += b.outputTokens; costMsSum += b.costMsSum;
      }
      if (count === 0) continue;
      out.set(key, {
        count, success, fail,
        successRate: success / count,
        inputTokens, outputTokens,
        avgCostMs: Math.round(costMsSum / count),
      });
    }
    return out;
  }
}
