import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface JsonStateStoreOptions {
  /** Debounce window for scheduleSave (ms). Default 1000. */
  debounceMs?: number;
}

/**
 * Append-only-ish JSON state store with debounced atomic writes.
 *
 * Contract (same as MetricsCollector / TokenUsageTracker): IO failures must
 * NEVER throw into the caller — every method swallows errors and logs a warn,
 * so persistence can never break the proxy hot path.
 *
 * On load, a missing or corrupt file is treated as "no state" (returns null),
 * letting the process start fresh instead of crashing.
 */
export class JsonStateStore {
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: unknown = null;
  private hasPending = false;

  constructor(private readonly filePath: string, opts: JsonStateStoreOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 1000;
  }

  /** Synchronous read at startup. Returns null if file missing/corrupt. */
  load<T>(): T | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn(`[stateStore] load failed (${this.filePath}), starting empty:`, err);
      return null;
    }
  }

  /**
   * Schedule a debounced write. Multiple calls within the debounce window
   * coalesce: only the most recent `snapshot` is written, once.
   */
  scheduleSave(snapshot: unknown): void {
    this.pending = snapshot;
    this.hasPending = true;
    if (this.timer) return; // already scheduled — payload refreshed, keep the window
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, this.debounceMs);
  }

  /** Write any pending snapshot immediately (use on shutdown). No-op if clean. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.hasPending) return;
    const snapshot = this.pending;
    this.hasPending = false;
    this.pending = null;
    this.writeAtomic(snapshot);
  }

  private writeAtomic(snapshot: unknown): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
      fs.renameSync(tmp, this.filePath); // atomic on same filesystem
    } catch (err) {
      logger.warn(`[stateStore] save failed (${this.filePath}), keeping last good file:`, err);
    }
  }
}
