import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFetchError, fetchUpstream } from '../src/proxy';

// ── formatFetchError: the fix for the "Upstream request failed: unknown" hole ──
//
// undici/network errors put the reason in `.code` (ECONNRESET, ETIMEDOUT,
// UND_ERR_*) or nested `.cause`, NOT in `.message`. The old 502 path read only
// `.message`, so every network failure surfaced as opaque "unknown". These
// tests pin the new extraction so that regression is caught.

test('null error → honest "no response" summary, not "unknown"', () => {
  const info = formatFetchError(null);
  assert.equal(info.code, null);
  assert.match(info.summary, /no response/i);
});

test('undici ECONNRESET with empty message → summary carries the code', () => {
  // Real undici socket reset: code set, message often empty.
  const info = formatFetchError({ code: 'ECONNRESET', message: '' });
  assert.equal(info.code, 'ECONNRESET');
  assert.equal(info.summary, 'ECONNRESET'); // NOT "unknown"
});

test('UND_ERR_* code + message → "code: message"', () => {
  const info = formatFetchError({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'connect timeout' });
  assert.equal(info.code, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(info.summary, 'UND_ERR_CONNECT_TIMEOUT: connect timeout');
});

test('cause is serialized (nested undici reason)', () => {
  const info = formatFetchError({ code: 'UND_ERR_SOCKET', message: 'Socket error', cause: { code: 'EPIPE', message: 'broken pipe' } });
  assert.match(info.cause!, /EPIPE/);
  assert.match(info.cause!, /broken pipe/);
});

test('AbortError (no code) falls back to name', () => {
  const info = formatFetchError({ name: 'AbortError', message: 'This operation was aborted' });
  assert.equal(info.code, 'AbortError');
  assert.match(info.summary, /AbortError/);
});

test('error with only a message (e.g. our timeout) → message used', () => {
  const info = formatFetchError(new Error('upstream timeout after 60000ms: https://x'));
  assert.match(info.summary, /upstream timeout after 60000ms/);
});

test('bare Error with .code property works too', () => {
  const e: any = new Error('boom');
  e.code = 'ETIMEDOUT';
  const info = formatFetchError(e);
  assert.equal(info.code, 'ETIMEDOUT');
  assert.equal(info.summary, 'ETIMEDOUT: boom');
});

// ── fetchUpstream: connect/first-byte timeout ──

test('fetchUpstream aborts and reports a clear timeout when upstream never responds', async () => {
  const origFetch = globalThis.fetch;
  // Stand in for a GLM upstream that accepts the connection but never returns
  // headers — exactly the stall that used to hang the request indefinitely.
  // The mock must honor AbortSignal the way real fetch does; otherwise the
  // abort would never surface and the await would hang forever.
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const sig = init?.signal;
    if (!sig) return;
    if (sig.aborted) reject(new Error('aborted'));
    else sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchUpstream('https://upstream.example/v1/messages', { method: 'POST' }, 50),
      /upstream timeout after 50ms/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchUpstream clears the timer once headers arrive (no abort leak on success)', async () => {
  const origFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    signal = init?.signal;
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  }) as typeof fetch;
  try {
    const resp = await fetchUpstream('https://upstream.example/v1/messages', { method: 'POST' }, 50);
    assert.equal(resp.status, 200);
    // Signal must not have been aborted by our timer after success.
    assert.equal(signal?.aborted, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
