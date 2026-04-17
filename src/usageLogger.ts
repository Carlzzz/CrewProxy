import * as fs from 'node:fs';
import * as path from 'node:path';
import logger from './logger';

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 104857600;
const MIN_MAX_BYTES = 1048576;

export interface UsageLogExtra {
  app?: string;
  username?: string;
  input_cached_token?: number;
  request_size?: number;
  response_size?: number;
  stream?: boolean;
  input_content?: string;
  output_content?: string;
  input_fulltext?: string;
  session_id?: string | null;
  routing_key?: string;
}

export function formatUTC8(date: Date): string {
  const shifted = new Date(date.getTime() + UTC8_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const min = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');
  const ms = String(shifted.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}.${ms}+08:00`;
}

function dateStampUTC8(date: Date): string {
  const shifted = new Date(date.getTime() + UTC8_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLogDir(): string {
  return process.env.WOICLAW_LOG_DIR || './logs';
}

function getMaxBytes(): number {
  const raw = process.env.WOICLAW_USAGE_LOG_MAX_BYTES;
  let n = DEFAULT_MAX_BYTES;
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      n = parsed;
    }
  }
  return Math.max(n, MIN_MAX_BYTES);
}

function resolveUsageLogPath(dir: string, dateStr: string, maxBytes: number): string {
  for (let n = 1; ; n += 1) {
    const filePath =
      n === 1
        ? path.join(dir, `usage-${dateStr}.jsonl`)
        : path.join(dir, `usage-${dateStr}-${n}.jsonl`);
    try {
      const { size } = fs.statSync(filePath);
      if (size < maxBytes) {
        return filePath;
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return filePath;
      }
      throw err;
    }
  }
}

function costTimeSeconds(startTime: string, end: Date): string {
  const start = new Date(startTime);
  if (!Number.isFinite(start.getTime())) {
    return '0.00';
  }
  return ((end.getTime() - start.getTime()) / 1000).toFixed(2);
}

export function appendUsageLog(
  clientid: string,
  modelid: string,
  startTime: string,
  inputToken: number,
  outputToken: number,
  extra?: UsageLogExtra
): void {
  setImmediate(() => {
    try {
      const now = new Date();
      const dir = getLogDir();
      fs.mkdirSync(dir, { recursive: true });
      const dateStr = dateStampUTC8(now);
      const maxBytes = getMaxBytes();
      const filePath = resolveUsageLogPath(dir, dateStr, maxBytes);
      const e = extra;
      const record = {
        app: e?.app ?? 'woicrew',
        clientid,
        username: e?.username ?? null,
        modelid,
        input_token: inputToken,
        output_token: outputToken,
        input_cached_token: e?.input_cached_token ?? 0,
        start_time: startTime,
        out_time: formatUTC8(now),
        cost_time: costTimeSeconds(startTime, now),
        request_size: e?.request_size ?? null,
        response_size: e?.response_size ?? null,
        stream: e?.stream ?? null,
        input_content: e?.input_content ?? null,
        output_content: e?.output_content ?? null,
        input_fulltext: e?.input_fulltext ?? null,
        session_id: e?.session_id !== undefined ? e.session_id : null,
        routing_key: e?.routing_key ?? null,
      };
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (err) {
      logger.error('appendUsageLog failed', err);
    }
  });
}
