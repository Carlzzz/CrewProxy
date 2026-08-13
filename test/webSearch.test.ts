import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTavilyResponse, parseBraveResponse, applyDomainFiltersToQuery } from '../src/webSearch';

test('parseTavilyResponse maps title/url and drops malformed hits', () => {
  const hits = parseTavilyResponse({ results: [
    { title: 'a', url: 'https://a.com' },
    { title: 1, url: 'https://b.com' },
    { title: 'c', url: null },
  ]});
  assert.deepEqual(hits, [{ title: 'a', url: 'https://a.com' }]);
});

test('parseBraveResponse maps web.results', () => {
  const hits = parseBraveResponse({ web: { results: [
    { title: 'x', url: 'https://x.com' },
  ]}});
  assert.deepEqual(hits, [{ title: 'x', url: 'https://x.com' }]);
});

test('applyDomainFiltersToQuery builds site: clauses', () => {
  const q = applyDomainFiltersToQuery('hello', ['a.com'], ['b.com']);
  assert.equal(q, '(site:a.com) -site:b.com hello');
});

test('applyDomainFiltersToQuery is query-only when no domains', () => {
  assert.equal(applyDomainFiltersToQuery('hello'), 'hello');
});
