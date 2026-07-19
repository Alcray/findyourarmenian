import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../src/config.js';
import { createSearchJobManager } from '../src/searchJobs.js';
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
  assert.equal(invalidLead.status, 401);
  assert.deepEqual(await invalidLead.json(), { error: 'Admin authentication required.' });

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

test('public jobs are cookie-scoped, rate-limited, cache-only, and do not require admin login', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-public-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runtimeConfig = {
    ...config,
    dataDir,
    allowedHosts: [],
    apifyMode: 'demo',
    apifyToken: '',
    apifyMaxResults: 3,
    authPassword: 'public-test-admin-password',
    authSessionSecret: 'public-test-session-secret-longer-than-thirty-two-bytes',
    authCookieSecure: false,
    analyticsRetentionDays: 30,
    publicSearchesPerVisitorPerDay: 1,
    publicSearchesGlobalPerDay: 3,
  };
  let finishSearch;
  const pendingSearch = new Promise((resolve) => {
    finishSearch = resolve;
  });
  const searchJobs = createSearchJobManager({ executeSearch: () => pendingSearch });
  const server = createServer({ runtimeConfig, searchJobs });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const visitorAConfig = await fetch(`${baseUrl}/api/config`);
  const visitorBConfig = await fetch(`${baseUrl}/api/config`);
  const visitorA = visitorAConfig.headers.get('set-cookie').split(';', 1)[0];
  const visitorB = visitorBConfig.headers.get('set-cookie').split(';', 1)[0];
  assert.notEqual(visitorA, visitorB);

  const crossOrigin = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example', cookie: visitorA },
    body: JSON.stringify({ query: 'Armenian founders', mode: 'fast' }),
  });
  assert.equal(crossOrigin.status, 403);

  const refresh = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: visitorA },
    body: JSON.stringify({ query: 'Armenian founders', mode: 'fast', refresh: true }),
  });
  assert.equal(refresh.status, 403);

  const started = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: visitorA },
    body: JSON.stringify({ query: 'Armenian founders', mode: 'fast', limit: 50 }),
  });
  assert.equal(started.status, 202);
  const startedBody = await started.json();
  assert.equal(startedBody.quota.allowed, true);
  assert.equal(startedBody.quota.remainingVisitor, 0);
  assert.equal(startedBody.job.limit, runtimeConfig.apifyMaxResults);
  const jobId = startedBody.job.id;

  const duplicate = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: visitorA },
    body: JSON.stringify({ query: 'Armenian founders', mode: 'fast' }),
  });
  assert.equal(duplicate.status, 202);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.deduplicated, true);
  assert.equal(duplicateBody.job.id, jobId);
  assert.equal(duplicateBody.quota, null);

  finishSearch({
    query: 'Armenian founders',
    mode: 'fast',
    results: [{
      id: 'person_public_test',
      name: 'Public Test Person',
      displayBucket: 'likely',
      lead: { status: 'contacted', notes: 'must stay private' },
    }],
  });

  const otherVisitorRead = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
    headers: { cookie: visitorB },
  });
  assert.equal(otherVisitorRead.status, 404);

  let completed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
      headers: { cookie: visitorA },
    });
    assert.equal(response.status, 200);
    completed = (await response.json()).job;
    if (completed.status === 'completed' || completed.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(completed.status, 'completed');
  assert.equal(JSON.stringify(completed).includes('"lead"'), false);
  assert.equal(JSON.stringify(completed).includes('must stay private'), false);

  const resultOpen = await fetch(`${baseUrl}/api/events/result-open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: visitorA },
    body: '{}',
  });
  assert.equal(resultOpen.status, 202);
  const optedOutOpen = await fetch(`${baseUrl}/api/events/result-open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: visitorA, 'sec-gpc': '1' },
    body: '{}',
  });
  assert.equal(optedOutOpen.status, 202);
  const eventWithProperties = await fetch(`${baseUrl}/api/events/result-open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: visitorA },
    body: JSON.stringify({ profile: 'must not be accepted' }),
  });
  assert.equal(eventWithProperties.status, 400);

  const overLimit = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: visitorA },
    body: JSON.stringify({ query: 'Armenian engineers', mode: 'fast' }),
  });
  assert.equal(overLimit.status, 429);
  assert.equal((await overLimit.json()).quota.reason, 'visitor');

  const jobList = await fetch(`${baseUrl}/api/jobs`, { headers: { cookie: visitorA } });
  assert.equal(jobList.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: runtimeConfig.authPassword }),
  });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get('set-cookie').split(';', 1)[0];
  let analytics;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    analytics = await fetch(`${baseUrl}/api/admin/analytics`, { headers: { cookie: adminCookie } })
      .then((response) => response.json());
    if (analytics.totals.searchOutcomes.success === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(analytics.totals.pageViews, 2);
  assert.equal(analytics.totals.searches, 1);
  assert.equal(analytics.totals.resultOpens, 1);
  assert.deepEqual(analytics.totals.searchOutcomes, { success: 1, noResults: 0, failed: 0 });
});
