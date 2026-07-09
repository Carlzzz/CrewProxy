import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { JsonStateStore } from '../src/stateStore';

function tmpFile(): string {
  return path.join(os.tmpdir(), `statestore-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('load returns null when file missing', () => {
  const s = new JsonStateStore(tmpFile());
  assert.equal(s.load(), null);
});

test('load returns null on corrupt JSON', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{not valid json', 'utf-8');
  const s = new JsonStateStore(f);
  assert.equal(s.load(), null);
});

test('flushSync writes immediately and load round-trips', () => {
  const f = tmpFile();
  const s = new JsonStateStore(f, { debounceMs: 1000 });
  s.scheduleSave({ a: 1, nested: { b: 2 } });
  s.flushSync();
  assert.deepEqual(s.load(), { a: 1, nested: { b: 2 } });
});

test('scheduleSave defers write — nothing on disk before window elapses', async () => {
  const f = tmpFile();
  const s = new JsonStateStore(f, { debounceMs: 40 });
  s.scheduleSave({ a: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(f), false); // not flushed yet
});

test('scheduleSave coalesces rapid calls into the last value', async () => {
  const f = tmpFile();
  const s = new JsonStateStore(f, { debounceMs: 40 });
  s.scheduleSave({ a: 1 });
  s.scheduleSave({ a: 2 });
  s.scheduleSave({ a: 3 });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(s.load(), { a: 3 });
});

test('writes create nested parent directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  const f = path.join(dir, 'nested', 'deep', 'state.json');
  const s = new JsonStateStore(f, { debounceMs: 1000 });
  s.scheduleSave({ x: 1 });
  s.flushSync();
  assert.deepEqual(s.load(), { x: 1 });
});
