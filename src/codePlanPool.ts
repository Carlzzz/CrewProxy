import type { ProxyConfig, CodePlanCredential } from './config';
import type { JsonStateStore } from './stateStore';
import { logger } from './logger';

export interface CodePlanPickResult {
  credentialId: string | null;
  apiKey: string;
  model?: string;
  upstreamKey: string;
}

export interface CredentialHeatmap {
  credentialId: string;
  requestsLast1h: number;
  heatLast1h: number;
  inCooldown: boolean;
  cooldownUntil?: number;
  cooldownReason?: CooldownReason;
}

export const CODE_PLAN_COOLDOWN_MS = 30 * 60 * 1000;
export const CODE_PLAN_SHORT_COOLDOWN_MS = 30_000; // 30 s for rate-limit burst

export type CooldownReason = 'quota' | 'rate_limit' | 'network';

/** Serialized cooldown: keyed by `${upstreamKey}\0${credentialId}`. */
export type CooldownSnapshot = Record<string, { until: number; reason: CooldownReason }>;

export class CodePlanPoolManager {
  private pool: Map<string, CodePlanCredential[]> = new Map();
  private cooldowns: Map<string, number> = new Map();      // key → until-epoch-ms
  private cooldownReasons: Map<string, CooldownReason> = new Map();
  private roundRobin: Map<string, number> = new Map();
  private inFlight: Map<string, number> = new Map();       // key → active-request-count
  // Sliding window: key → sorted array of epoch-ms timestamps (last 1h)
  private requestLog: Map<string, number[]> = new Map();
  private sweepIntervalMs = 60_000;                         // sweep stale log entries every 1 min
  private lastSweep = Date.now();
  private store?: JsonStateStore;

  constructor(opts: { store?: JsonStateStore } = {}) {
    this.store = opts.store;
    if (this.store) {
      const snap = this.store.load<CooldownSnapshot>();
      if (snap) {
        try {
          this.restoreCooldowns(snap);
          if (this.cooldowns.size > 0) {
            logger.info(`[codePlan] restored ${this.cooldowns.size} active cooldown(s) from persisted state`);
          }
        } catch (err) {
          logger.warn('[codePlan] cooldown restore failed, starting empty:', err);
        }
      }
    }
  }

  reconcileFromConfig(config: ProxyConfig): void {
    this.pool.clear();
    this.roundRobin.clear();

    const upstreams = config.upstreamsById ?? {};
    for (const [upstreamKey, upstream] of Object.entries(upstreams)) {
      if (!upstream.codePlanCredentials || upstream.codePlanCredentials.length === 0) {
        continue;
      }
      this.pool.set(upstreamKey, upstream.codePlanCredentials.filter(c => c.enabled));
    }

    if (config.defaultUpstream?.codePlanCredentials) {
      const defaultKey = '__default__';
      this.pool.set(defaultKey, config.defaultUpstream.codePlanCredentials.filter(c => c.enabled));
    }

    for (const [key] of this.pool) {
      if (!this.roundRobin.has(key)) {
        this.roundRobin.set(key, 0);
      }
    }

    this.cleanupStaleCooldowns();
  }

  pickOrFallback(upstreamKey: string, sessionId?: string): CodePlanPickResult {
    const credentials = this.pool.get(upstreamKey);
    if (!credentials || credentials.length === 0) {
      return { credentialId: null, apiKey: '', upstreamKey };
    }

    // Build available set (not in cooldown), preserving order
    const availableIndices: number[] = [];
    for (let i = 0; i < credentials.length; i++) {
      if (!this.isInCooldown(upstreamKey, credentials[i].id)) {
        availableIndices.push(i);
      }
    }
    if (availableIndices.length === 0) {
      return { credentialId: null, apiKey: '', upstreamKey };
    }

    let selectedIdx: number;
    if (sessionId) {
      // Hash to slot on the FULL list, then probe for first available
      const startSlot = this.sessionIdToCodePlanSlot(sessionId, credentials.length);
      let found = -1;
      for (let probe = 0; probe < credentials.length; probe++) {
        const idx = (startSlot + probe) % credentials.length;
        if (availableIndices.includes(idx)) {
          found = idx;
          break;
        }
      }
      // Should always find one since availableIndices.length > 0
      selectedIdx = found >= 0 ? found : availableIndices[0];
    } else {
      // **Fix #3: pick the available credential with the LOWEST in-flight count**
      let minIdx = availableIndices[0];
      let minVal = this.inFlight.get(this.inFlightKey(upstreamKey, credentials[minIdx].id)) ?? 0;
      for (let i = 1; i < availableIndices.length; i++) {
        const idx = availableIndices[i];
        const v = this.inFlight.get(this.inFlightKey(upstreamKey, credentials[idx].id)) ?? 0;
        if (v < minVal) {
          minVal = v;
          minIdx = idx;
        }
      }
      selectedIdx = minIdx;
    }

    const selected = credentials[selectedIdx];
    const inflightKey = this.inFlightKey(upstreamKey, selected.id);
    const cur = this.inFlight.get(inflightKey) ?? 0;
    this.inFlight.set(inflightKey, cur + 1);

    // Log request timestamp for 1h sliding window
    this.logRequest(upstreamKey, selected.id);

    return {
      credentialId: selected.id,
      apiKey: selected.apiKey,
      model: selected.model,
      upstreamKey,
    };
  }

  /** Call when the request finishes (success or terminal failure). */
  decInFlight(upstreamKey: string, credentialId: string): void {
    const k = this.inFlightKey(upstreamKey, credentialId);
    const cur = this.inFlight.get(k) ?? 0;
    if (cur <= 1) {
      this.inFlight.delete(k);
    } else {
      this.inFlight.set(k, cur - 1);
    }
  }

  markCooldown(upstreamKey: string, credentialId: string, cooldownMs: number = CODE_PLAN_COOLDOWN_MS, reason: CooldownReason = 'rate_limit'): void {
    const key = this.cooldownKey(upstreamKey, credentialId);
    this.cooldowns.set(key, Date.now() + cooldownMs);
    this.cooldownReasons.set(key, reason);
    logger.verbose(`[codePlan] cooldown set for ${upstreamKey}/${credentialId}: ${cooldownMs}ms (reason=${reason})`);
    this.store?.scheduleSave(this.dumpCooldowns());
  }

  // ── private helpers ──

  private isInCooldown(upstreamKey: string, credentialId: string): boolean {
    const key = this.cooldownKey(upstreamKey, credentialId);
    const expiry = this.cooldowns.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }

  private cooldownKey(upstreamKey: string, credentialId: string): string {
    return `${upstreamKey}\0${credentialId}`;
  }

  private inFlightKey(upstreamKey: string, credentialId: string): string {
    return `${upstreamKey}\0${credentialId}`;
  }

  private cleanupStaleCooldowns(): void {
    const now = Date.now();
    for (const [key, expiry] of this.cooldowns.entries()) {
      if (now > expiry) {
        this.cooldowns.delete(key);
        this.cooldownReasons.delete(key);
      }
    }
  }

  // ── Sliding-window request log ──

  private logRequest(upstreamKey: string, credentialId: string): void {
    this.sweepRequestLog();
    const k = this.cooldownKey(upstreamKey, credentialId);
    let arr = this.requestLog.get(k);
    if (!arr) {
      arr = [];
      this.requestLog.set(k, arr);
    }
    arr.push(Date.now());
  }

  private sweepRequestLog(): void {
    const now = Date.now();
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;
    const cutoff = now - 3_600_000; // 1 hour ago
    for (const [k, arr] of this.requestLog) {
      // Binary-sweep: find first index >= cutoff
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < cutoff) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) {
        // Clear the first `lo` stale entries (mutating in-place is safe because
        // we copy only the tail portion, then replace).
        const tail = arr.slice(lo);
        this.requestLog.set(k, tail);
      }
    }
  }

  private countRecent1h(upstreamKey: string, credentialId: string): number {
    this.sweepRequestLog();
    const k = this.cooldownKey(upstreamKey, credentialId);
    const arr = this.requestLog.get(k);
    return arr?.length ?? 0;
  }

  // ── Public status / introspection ──

  getPoolStatus(upstreamKey: string): CredentialHeatmap[] {
    const credentials = this.pool.get(upstreamKey) ?? [];
    return credentials.map(c => {
      const key = this.cooldownKey(upstreamKey, c.id);
      const expiry = this.cooldowns.get(key);
      const inCooldown = expiry !== undefined && Date.now() < expiry;
      return {
        credentialId: c.id,
        requestsLast1h: this.countRecent1h(upstreamKey, c.id),
        heatLast1h: 0,
        inCooldown,
        cooldownUntil: inCooldown ? expiry : undefined,
        cooldownReason: inCooldown ? this.cooldownReasons.get(key) : undefined,
      };
    });
  }

  /** Return live in-flight count for a specific credential (0 if unknown). */
  getInFlight(upstreamKey: string, credentialId: string): number {
    return this.inFlight.get(this.inFlightKey(upstreamKey, credentialId)) ?? 0;
  }

  hasCredentials(upstreamKey: string): boolean {
    const creds = this.pool.get(upstreamKey);
    return creds !== undefined && creds.length > 0;
  }

  private sessionIdToCodePlanSlot(sessionId: string, length: number): number {
    let hash = 2166136261;
    for (let i = 0; i < sessionId.length; i++) {
      hash ^= sessionId.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash % Math.max(length, 1);
  }

  // ── Cooldown persistence ──

  /** Serialize active cooldowns to a JSON-friendly snapshot. */
  dumpCooldowns(): CooldownSnapshot {
    const out: CooldownSnapshot = {};
    for (const [key, until] of this.cooldowns) {
      out[key] = { until, reason: this.cooldownReasons.get(key) ?? 'rate_limit' };
    }
    return out;
  }

  /** Restore cooldowns from a snapshot. Already-expired entries are dropped. */
  restoreCooldowns(snapshot: CooldownSnapshot): void {
    if (!snapshot) return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(snapshot)) {
      if (!entry || !Number.isFinite(entry.until)) continue;
      if (now > entry.until) continue; // expired — discard
      this.cooldowns.set(key, entry.until);
      this.cooldownReasons.set(key, entry.reason ?? 'rate_limit');
    }
  }
}