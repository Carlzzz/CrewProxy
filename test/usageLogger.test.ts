import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendUsageLog } from '../src/usageLogger';

function readLastRecord(dir: string): Record<string, unknown> {
  const files = fs.readdirSync(dir).filter(f => f.startsWith('usage-') && f.endsWith('.jsonl'));
  assert.ok(files.length > 0, 'expected at least one usage log file');
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf-8').split('\n').filter(l => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

test('appendUsageLog writes kind when provided', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  process.env.WOICLAW_LOG_DIR = dir;
  appendUsageLog('alice', 'tavily', '2026-08-13T00:00:00.000+08:00', 0, 0, { kind: 'websearch', username: 'alice' });
  await new Promise(r => setImmediate(r));
  const rec = readLastRecord(dir);
  assert.equal(rec.kind, 'websearch');
  assert.equal(rec.modelid, 'tavily');
  delete process.env.WOICLAW_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendUsageLog omits kind when not provided', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  process.env.WOICLAW_LOG_DIR = dir;
  appendUsageLog('alice', 'claude-opus', '2026-08-13T00:00:00.000+08:00', 100, 200, {});
  await new Promise(r => setImmediate(r));
  const rec = readLastRecord(dir);
  assert.equal('kind' in rec, false);
  delete process.env.WOICLAW_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});
