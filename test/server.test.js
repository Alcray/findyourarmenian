import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  createServer,
  normalizeLeadInput,
  normalizeSearchInput,
  readinessState,
  runtimeReadinessState,
} from '../src/server.js';

test('search request validation trims queries and bounds limits', () => {
  assert.deepEqual(
    normalizeSearchInput(
      { query: '  Armenian founders  ', limit: 500, mode: 'fast', refresh: false },
      { apifyMaxResults: 12 },
    ),
    { query: 'Armenian founders', limit: 50, mode: 'fast', refresh: false },
  );
  assert.equal(normalizeSearchInput({ query: 'abc', limit: -2 }, { apifyMaxResults: 12 }).limit, 1);
  assert.equal(normalizeSearchInput({ query: 'abc' }, { apifyMaxResults: 100 }).limit, 50);

  assert.throws(() => normalizeSearchInput({ query: 'ab' }), /between 3 and 300/);
  assert.throws(() => normalizeSearchInput({ query: 'x'.repeat(301) }), /between 3 and 300/);
  assert.throws(() => normalizeSearchInput({ query: 'valid', limit: '2.5' }), /limit must be an integer/);
  assert.throws(() => normalizeSearchInput({ query: 'valid', mode: 'turbo' }), /mode must be/);
  assert.throws(() => normalizeSearchInput({ query: 'valid', refresh: 'false' }), /refresh must be a boolean/);
});

test('lead request validation accepts only bounded known fields', () => {
  assert.deepEqual(normalizeLeadInput({ personId: 'person_123' }), {
    personId: 'person_123',
    status: 'saved',
    notes: '',
  });
  assert.throws(
    () => normalizeLeadInput({ personId: 'person_123', status: 'deleted' }),
    /status must be one of/,
  );
  assert.throws(() => normalizeLeadInput({ personId: 'two words' }), /personId must be/);
  assert.throws(() => normalizeLeadInput({ personId: 'person_123', notes: 7 }), /notes must be a string/);
  assert.throws(
    () => normalizeLeadInput({ personId: 'person_123', unexpected: true }),
    /Unsupported lead field/,
  );
});

test('readiness requires Apify credentials except in explicit demo or fixture mode', () => {
  assert.deepEqual(readinessState({ apifyMode: 'live', apifyToken: '' }), {
    ok: false,
    dependencies: { apify: 'missing' },
  });
  assert.equal(readinessState({ apifyMode: 'cache-first', apifyToken: 'configured' }).ok, true);
  assert.equal(readinessState({ apifyMode: 'demo', apifyToken: '' }).ok, true);
  assert.equal(readinessState({ apifyMode: 'fixture', apifyToken: '', apifyFixtureFile: '/tmp/fixture.json' }).ok, true);
  assert.equal(readinessState({ apifyMode: 'fixture', apifyToken: '', apifyFixtureFile: '' }).ok, false);
  assert.equal(readinessState({ apifyMode: 'DEMO', apifyToken: '' }).dependencies.apify, 'invalid-mode');
  assert.equal(readinessState({ apifyMode: 'garbage', apifyToken: 'configured' }).ok, false);
});

test('runtime readiness verifies fixture readability and writable storage', async () => {
  const state = await runtimeReadinessState({
    apifyMode: 'fixture',
    apifyToken: '',
    apifyFixtureFile: '/definitely/missing/find-your-armenian-fixture.json',
    dataDir: '/tmp',
  });
  assert.equal(state.ok, false);
  assert.equal(state.dependencies.storage, 'writable');
  assert.equal(state.dependencies.fixture, 'unreadable');
});

test('HTTP boundary rejects malformed and oversized JSON and applies security headers', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);

  const malformed = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);

  const unsafeSimplePost = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ query: 'Armenian founders' }),
  });
  assert.equal(unsafeSimplePost.status, 415);

  const invalidSearch = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'no' }),
  });
  assert.equal(invalidSearch.status, 400);

  const invalidLead = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personId: 'person_123', status: 'delete-everything' }),
  });
  assert.equal(invalidLead.status, 400);

  const oversized = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'x'.repeat(70_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get('cache-control'), 'no-store');

  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
