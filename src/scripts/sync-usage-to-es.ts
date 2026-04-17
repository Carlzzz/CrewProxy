import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { config as dotenvConfig } from 'dotenv';
import { logger } from '../logger';

dotenvConfig();

const LOG_DIR = process.env.WOICLAW_LOG_DIR || './logs';
const STATE_DIR = process.env.USAGE_SYNC_STATE_DIR || './data';
const STATE_FILE = path.join(STATE_DIR, 'usage-sync-state.json');
const ES_NODE = process.env.WOICLAW_ES_NODE || 'http://localhost:9200';
const ES_INDEX = process.env.WOICLAW_ES_INDEX || 'woicrew-usage';
const BULK_SIZE = parseInt(process.env.WOICLAW_ES_BULK_SIZE || '500', 10) || 500;
const INTERVAL_MS = parseInt(process.env.WOICLAW_ES_INTERVAL_MS || '600000', 10) || 600_000;
const RUN_ONCE = process.env.RUN_ONCE === '1' || process.env.RUN_ONCE === 'true';

interface SyncState {
  lastFile: string;
  lastLineNumber: number;
}

function loadState(): SyncState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as SyncState;
  } catch {
    return { lastFile: '', lastLineNumber: 0 };
  }
}

function saveState(state: SyncState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function generateDocId(record: any): string {
  const raw = `${record.app || ''}|${record.clientid || ''}|${record.start_time || ''}|${record.modelid || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

function getUsageFiles(): string[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter(f => f.startsWith('usage-') && f.endsWith('.jsonl'))
    .sort();
}

async function bulkIndex(client: any, records: { id: string; doc: any }[]): Promise<{ success: number; failed: number }> {
  const body: any[] = [];
  for (const r of records) {
    body.push({ index: { _index: ES_INDEX, _id: r.id } });
    body.push(r.doc);
  }

  const resp = await client.bulk({ body, refresh: false });
  let success = 0;
  let failed = 0;
  if (resp.items) {
    for (const item of resp.items) {
      if (item.index?.error) {
        failed++;
        logger.error('Bulk index error:', JSON.stringify(item.index.error).substring(0, 200));
      } else {
        success++;
      }
    }
  }
  return { success, failed };
}

async function syncOnce(client: any): Promise<void> {
  const state = loadState();
  const files = getUsageFiles();
  if (files.length === 0) return;

  const startIdx = state.lastFile ? files.indexOf(state.lastFile) : 0;
  const startFileIdx = Math.max(0, startIdx);

  let totalSuccess = 0;
  let totalFailed = 0;

  for (let fi = startFileIdx; fi < files.length; fi++) {
    const fileName = files[fi];
    const filePath = path.join(LOG_DIR, fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const startLine = (fileName === state.lastFile) ? state.lastLineNumber : 0;
    const batch: { id: string; doc: any }[] = [];

    for (let li = startLine; li < lines.length; li++) {
      let record: any;
      try {
        record = JSON.parse(lines[li]);
      } catch {
        logger.warn(`[es-sync] Skipping invalid JSON at ${fileName}:${li + 1}`);
        continue;
      }

      batch.push({ id: generateDocId(record), doc: record });

      if (batch.length >= BULK_SIZE) {
        const result = await bulkIndex(client, batch.splice(0));
        totalSuccess += result.success;
        totalFailed += result.failed;
        if (result.failed > 0) {
          logger.error(`[es-sync] Batch had ${result.failed} failures, stopping to avoid data loss`);
          return;
        }
        state.lastFile = fileName;
        state.lastLineNumber = li + 1;
        saveState(state);
      }
    }

    if (batch.length > 0) {
      const result = await bulkIndex(client, batch);
      totalSuccess += result.success;
      totalFailed += result.failed;
      if (result.failed > 0) {
        logger.error(`[es-sync] Batch had ${result.failed} failures, stopping`);
        return;
      }
    }

    state.lastFile = fileName;
    state.lastLineNumber = lines.length;
    saveState(state);
  }

  if (totalSuccess > 0 || totalFailed > 0) {
    logger.info(`[es-sync] ${totalSuccess} indexed, ${totalFailed} failed`);
  }
}

// ─── Exported: start as background loop inside the proxy process ───

let syncTimer: ReturnType<typeof setInterval> | null = null;

export async function startUsageSyncLoop(): Promise<void> {
  if (!process.env.WOICLAW_ES_NODE) {
    logger.info('[es-sync] WOICLAW_ES_NODE not set, usage sync disabled');
    return;
  }

  let Client: any;
  try {
    const esModule = await import('@elastic/elasticsearch');
    Client = esModule.Client;
  } catch {
    logger.warn('[es-sync] @elastic/elasticsearch not installed, usage sync disabled');
    return;
  }

  const client = new Client({ node: ES_NODE });

  // Verify ES is reachable
  try {
    await client.ping();
  } catch (err) {
    logger.warn(`[es-sync] Cannot reach ES at ${ES_NODE}, usage sync disabled:`, err);
    return;
  }

  logger.info(`[es-sync] Started — target ${ES_NODE}/${ES_INDEX}, interval ${INTERVAL_MS / 1000}s`);

  // Run first sync immediately
  try {
    await syncOnce(client);
  } catch (err) {
    logger.error('[es-sync] Initial sync error:', err);
  }

  // Schedule recurring syncs
  syncTimer = setInterval(async () => {
    try {
      await syncOnce(client);
    } catch (err) {
      logger.error('[es-sync] Sync error:', err);
    }
  }, INTERVAL_MS);
}

export function stopUsageSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// ─── Standalone entry point (npm run sync-usage) ───

async function main(): Promise<void> {
  let Client: any;
  try {
    const esModule = await import('@elastic/elasticsearch');
    Client = esModule.Client;
  } catch {
    console.error('@elastic/elasticsearch not found. Install it: npm install @elastic/elasticsearch');
    process.exit(1);
  }

  const client = new Client({ node: ES_NODE });
  console.log(`ES sync target: ${ES_NODE}/${ES_INDEX}`);

  if (RUN_ONCE) {
    await syncOnce(client);
    return;
  }

  while (true) {
    try {
      await syncOnce(client);
    } catch (err) {
      console.error('Sync error:', err);
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

// Only run main() when executed directly (not imported)
const isDirectRun = require.main === module ||
  process.argv[1]?.replace(/\\/g, '/').includes('sync-usage-to-es');

if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
