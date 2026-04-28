import type { ProxyConfig, CodePlanCredential } from './config';
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
}

export const CODE_PLAN_COOLDOWN_MS = 30 * 60 * 1000;

export class CodePlanPoolManager {
  private pool: Map<string, CodePlanCredential[]> = new Map();
  private cooldowns: Map<string, number> = new Map();
  private roundRobin: Map<string, number> = new Map();

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
      // Round-robin on available set
      const rrIdx = (this.roundRobin.get(upstreamKey) ?? 0) % availableIndices.length;
      this.roundRobin.set(upstreamKey, rrIdx + 1);
      selectedIdx = availableIndices[rrIdx];
    }

    const selected = credentials[selectedIdx];
    return {
      credentialId: selected.id,
      apiKey: selected.apiKey,
      model: selected.model,
      upstreamKey,
    };
  }

  markCooldown(upstreamKey: string, credentialId: string, cooldownMs: number = CODE_PLAN_COOLDOWN_MS): void {
    const key = this.cooldownKey(upstreamKey, credentialId);
    this.cooldowns.set(key, Date.now() + cooldownMs);
    logger.verbose(`[codePlan] cooldown set for ${upstreamKey}/${credentialId}: ${cooldownMs}ms`);
  }

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

  private cleanupStaleCooldowns(): void {
    const now = Date.now();
    for (const [key, expiry] of this.cooldowns.entries()) {
      if (now > expiry) {
        this.cooldowns.delete(key);
      }
    }
  }

  getPoolStatus(upstreamKey: string): CredentialHeatmap[] {
    const credentials = this.pool.get(upstreamKey) ?? [];
    return credentials.map(c => {
      const key = this.cooldownKey(upstreamKey, c.id);
      const expiry = this.cooldowns.get(key);
      const inCooldown = expiry !== undefined && Date.now() < expiry;
      return {
        credentialId: c.id,
        requestsLast1h: 0,
        heatLast1h: 0,
        inCooldown,
        cooldownUntil: inCooldown ? expiry : undefined,
      };
    });
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
}
