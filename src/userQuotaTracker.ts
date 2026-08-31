import { logger } from './logger';
import type { JsonStateStore } from './stateStore';

const TZ8_OFFSET_MS = 8 * 3_600_000;

interface UserEntry {
  dailyKey: string;
  dailyUsed: number;
  monthlyKey: string;
  monthlyUsed: number;
}

type Snapshot = Record<string, { dailyKey: string; dailyUsed: number; monthlyKey: string; monthlyUsed: number }>;

function tz8Keys(ts: number): { day: string; month: string } {
  const d = new Date(ts + TZ8_OFFSET_MS);
  const day = d.toISOString().slice(0, 10);   // '2026-08-31'
  const month = day.slice(0, 7);               // '2026-08'
  return { day, month };
}

/**
 * Per-user 自然日/自然月 token 累计器（东八区）。对标 TokenUsageTracker 的
 * try/catch 保护 + JsonStateStore 持久化契约：任何异常都不能阻断 proxy 热路径。
 */
export class UserQuotaTracker {
  private byUser = new Map<string, UserEntry>();
  private now: () => number;
  private store?: JsonStateStore;

  constructor(opts: { now?: () => number; store?: JsonStateStore } = {}) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
    if (this.store) {
      try {
        const snap = this.store.load<Snapshot>();
        if (snap) {
          try {
            this.restore(snap);
            logger.info(`[userQuota] restored ${this.byUser.size} user(s) from persisted state`);
          } catch (err) {
            logger.warn('[userQuota] restore failed, starting empty:', err);
            this.byUser.clear();
          }
        }
      } catch (err) {
        logger.warn('[userQuota] store.load failed, starting empty:', err);
        this.byUser.clear();
      }
    }
  }

  record(userId: string, tokens: number, ts?: number): void {
    try {
      if (!userId || !Number.isFinite(tokens) || tokens <= 0) return;
      const t = ts === undefined ? this.now() : ts;
      if (!Number.isFinite(t)) return;
      const { day, month } = tz8Keys(t);
      let e = this.byUser.get(userId);
      if (!e) {
        e = { dailyKey: day, dailyUsed: 0, monthlyKey: month, monthlyUsed: 0 };
        this.byUser.set(userId, e);
      }
      if (e.dailyKey !== day) { e.dailyKey = day; e.dailyUsed = 0; }
      if (e.monthlyKey !== month) { e.monthlyKey = month; e.monthlyUsed = 0; }
      e.dailyUsed += tokens;
      e.monthlyUsed += tokens;
      this.store?.scheduleSave(this.dump());
    } catch (err) {
      logger.error('[userQuota] record failed:', err);
    }
  }

  getUsage(userId: string, ts?: number): { dailyUsed: number; monthlyUsed: number } {
    try {
      const t = ts === undefined ? this.now() : ts;
      const { day, month } = tz8Keys(t);
      const e = this.byUser.get(userId);
      if (!e) return { dailyUsed: 0, monthlyUsed: 0 };
      return {
        dailyUsed: e.dailyKey === day ? e.dailyUsed : 0,
        monthlyUsed: e.monthlyKey === month ? e.monthlyUsed : 0,
      };
    } catch (err) {
      logger.error('[userQuota] getUsage failed:', err);
      return { dailyUsed: 0, monthlyUsed: 0 };
    }
  }

  dump(): Snapshot {
    const out: Snapshot = {};
    for (const [uid, e] of this.byUser) out[uid] = { ...e };
    return out;
  }

  restore(snapshot: Snapshot): void {
    for (const [uid, e] of Object.entries(snapshot)) {
      if (!e || !Number.isFinite(e.dailyUsed) || !Number.isFinite(e.monthlyUsed)) continue;
      this.byUser.set(uid, {
        dailyKey: String(e.dailyKey ?? ''),
        dailyUsed: e.dailyUsed,
        monthlyKey: String(e.monthlyKey ?? ''),
        monthlyUsed: e.monthlyUsed,
      });
    }
  }
}