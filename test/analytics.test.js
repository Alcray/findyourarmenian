import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ANALYTICS_MAX_RETENTION_DAYS,
  createAnalyticsStore,
  getAnonymousVisitor,
} from '../src/analytics.js';

function tempDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-analytics-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('anonymous visitor cookie is random, server-only, secure in production, and reusable', () => {
  const now = Date.parse('2026-07-19T12:00:00.000Z');
  const first = getAnonymousVisitor('', { secure: true, retentionDays: 30, now });

  assert.match(first.id, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(first.isNew, true);
  assert.match(first.setCookie, new RegExp(`^__Host-fya_visitor=${first.id};`));
  assert.match(first.setCookie, /; Path=\/;/);
  assert.match(first.setCookie, /; HttpOnly;/);
  assert.match(first.setCookie, /; SameSite=Lax;/);
  assert.match(first.setCookie, /; Max-Age=2592000;/);
  assert.match(first.setCookie, /; Secure$/);

  const reused = getAnonymousVisitor(`unrelated=value; __Host-fya_visitor=${first.id}`, {
    secure: true,
    retentionDays: 30,
    now,
  });
  assert.deepEqual(reused, { id: first.id, isNew: false, setCookie: '' });

  const invalid = getAnonymousVisitor('__Host-fya_visitor=alice@example.com', { secure: true, now });
  assert.notEqual(invalid.id, first.id);
  assert.notEqual(invalid.id, 'alice@example.com');

  const bounded = getAnonymousVisitor('', { retentionDays: 50_000, now });
  assert.match(bounded.setCookie, new RegExp(`Max-Age=${ANALYTICS_MAX_RETENTION_DAYS * 86400}`));
});

test('store reports totals, daily trends, unique visitors, and aggregate search outcomes only', async (t) => {
  const dataDir = tempDataDir(t);
  let now = Date.parse('2026-07-18T09:00:00.000Z');
  const analytics = createAnalyticsStore({ dataDir, retentionDays: 30, now: () => now });
  const visitorA = getAnonymousVisitor('').id;
  const visitorB = getAnonymousVisitor('').id;

  await analytics.recordPageView(visitorA);
  await analytics.recordPageView(visitorA);
  await analytics.recordSearch(visitorA, { outcome: 'success' });

  now = Date.parse('2026-07-19T10:00:00.000Z');
  await analytics.recordPageView(visitorA);
  await analytics.recordPageView(visitorB);
  await analytics.recordSearch(visitorB);
  await analytics.recordSearchOutcome(visitorB, 'no_results');
  await analytics.recordSearch(visitorA, { outcome: 'failed' });
  await analytics.recordResultOpen(visitorA);

  assert.deepEqual(await analytics.getSummary(), {
    retentionDays: 30,
    totals: {
      uniqueVisitors: 2,
      pageViews: 4,
      searches: 3,
      resultOpens: 1,
      searchOutcomes: { success: 1, noResults: 1, failed: 1 },
    },
    daily: [
      {
        date: '2026-07-18',
        uniqueVisitors: 1,
        pageViews: 2,
        searches: 1,
        resultOpens: 0,
        searchOutcomes: { success: 1, noResults: 0, failed: 0 },
      },
      {
        date: '2026-07-19',
        uniqueVisitors: 2,
        pageViews: 2,
        searches: 2,
        resultOpens: 1,
        searchOutcomes: { success: 0, noResults: 1, failed: 1 },
      },
    ],
  });

  const persisted = fs.readFileSync(analytics.filePath, 'utf8');
  assert.equal(persisted.includes(visitorA), false);
  assert.equal(persisted.includes(visitorB), false);
  assert.equal(persisted.includes('name'), false);
  assert.equal(persisted.includes('email'), false);
  assert.equal(persisted.includes('userAgent'), false);
  assert.equal(fs.statSync(analytics.filePath).mode & 0o777, 0o600);
});

test('retention pruning removes expired visitor hashes and clamps the configured window', async (t) => {
  const dataDir = tempDataDir(t);
  let now = Date.parse('2026-01-01T23:00:00.000Z');
  const analytics = createAnalyticsStore({ dataDir, retentionDays: 2, now: () => now });
  const oldVisitor = getAnonymousVisitor('').id;
  const currentVisitor = getAnonymousVisitor('').id;

  await analytics.recordPageView(oldVisitor);
  now = Date.parse('2026-01-03T01:00:00.000Z');
  await analytics.recordSearch(currentVisitor, { outcome: 'success' });

  const summary = await analytics.getSummary();
  assert.equal(summary.retentionDays, 2);
  assert.deepEqual(summary.daily.map((day) => day.date), ['2026-01-03']);
  assert.deepEqual(summary.totals, {
    uniqueVisitors: 1,
    pageViews: 0,
    searches: 1,
    resultOpens: 0,
    searchOutcomes: { success: 1, noResults: 0, failed: 0 },
  });

  const bounded = createAnalyticsStore({ dataDir: path.join(dataDir, 'bounded'), retentionDays: 9999 });
  assert.equal(bounded.retentionDays, ANALYTICS_MAX_RETENTION_DAYS);
  assert.equal(fs.readFileSync(analytics.filePath, 'utf8').includes(oldVisitor), false);
});

test('optional public counters stop growing after the bounded daily ceiling', async (t) => {
  const dataDir = tempDataDir(t);
  const analytics = createAnalyticsStore({
    dataDir,
    now: () => Date.parse('2026-07-19T12:00:00.000Z'),
  });
  fs.writeFileSync(analytics.filePath, `${JSON.stringify({
    version: 1,
    days: {
      '2026-07-19': {
        pageViews: 10_000,
        searches: 0,
        resultOpens: 10_000,
        searchOutcomes: { success: 0, no_results: 0, failed: 0 },
        visitors: [],
        visitorSearches: {},
      },
    },
  })}\n`);

  const visitor = getAnonymousVisitor('').id;
  await analytics.recordPageView(visitor);
  await analytics.recordResultOpen(visitor);
  const summary = await analytics.getSummary();
  assert.equal(summary.totals.pageViews, 10_000);
  assert.equal(summary.totals.resultOpens, 10_000);
  assert.equal(summary.totals.uniqueVisitors, 0);
});

test('concurrent read-modify-write events are serialized without lost counters', async (t) => {
  const dataDir = tempDataDir(t);
  const now = () => Date.parse('2026-07-19T15:00:00.000Z');
  const firstStore = createAnalyticsStore({ dataDir, now });
  const secondStore = createAnalyticsStore({ dataDir, now });
  const visitors = Array.from({ length: 25 }, () => getAnonymousVisitor('').id);

  await Promise.all(Array.from({ length: 200 }, (_, index) => {
    const store = index % 2 ? firstStore : secondStore;
    return store.recordPageView(visitors[index % visitors.length]);
  }));

  const summary = await firstStore.getSummary();
  assert.equal(summary.totals.pageViews, 200);
  assert.equal(summary.totals.uniqueVisitors, visitors.length);
  assert.equal(summary.daily[0].pageViews, 200);
});

test('search admission atomically enforces per-visitor and global daily caps', async (t) => {
  const dataDir = tempDataDir(t);
  const now = () => Date.parse('2026-07-19T23:59:30.500Z');
  const firstStore = createAnalyticsStore({ dataDir, now });
  const secondStore = createAnalyticsStore({ dataDir, now });
  const visitorA = getAnonymousVisitor('').id;
  const visitorB = getAnonymousVisitor('').id;

  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => {
    const store = index % 2 ? firstStore : secondStore;
    return store.admitSearch(visitorA, { perVisitorLimit: 3, globalLimit: 5 });
  }));
  assert.equal(attempts.filter((result) => result.allowed).length, 3);
  assert.deepEqual(attempts.at(-1), {
    allowed: false,
    reason: 'visitor',
    retryAfterSeconds: 30,
    remainingVisitor: 0,
    remainingGlobal: 2,
  });

  assert.deepEqual(await firstStore.admitSearch(visitorB, { perVisitorLimit: 3, globalLimit: 5 }), {
    allowed: true,
    reason: '',
    retryAfterSeconds: 0,
    remainingVisitor: 2,
    remainingGlobal: 1,
  });
  assert.deepEqual(await secondStore.admitSearch(visitorB, { perVisitorLimit: 3, globalLimit: 5 }), {
    allowed: true,
    reason: '',
    retryAfterSeconds: 0,
    remainingVisitor: 1,
    remainingGlobal: 0,
  });
  assert.deepEqual(await firstStore.admitSearch(visitorB, { perVisitorLimit: 3, globalLimit: 5 }), {
    allowed: false,
    reason: 'global',
    retryAfterSeconds: 30,
    remainingVisitor: 1,
    remainingGlobal: 0,
  });

  const summary = await firstStore.getSummary();
  assert.equal(summary.totals.searches, 5);
  assert.equal(summary.totals.uniqueVisitors, 2);
  assert.equal(JSON.stringify(summary).includes('visitorSearches'), false);

  const persisted = JSON.parse(fs.readFileSync(firstStore.filePath, 'utf8'));
  assert.equal(persisted.days['2026-07-19'].searches, 5);
  assert.equal(Object.keys(persisted.days['2026-07-19'].visitorSearches).length, 2);
  assert.equal(JSON.stringify(persisted).includes(visitorA), false);
  assert.equal(JSON.stringify(persisted).includes(visitorB), false);
});

test('global admission cap remains exact under concurrent visitors and resets with retention buckets', async (t) => {
  const dataDir = tempDataDir(t);
  let now = Date.parse('2026-07-19T12:00:00.000Z');
  const analytics = createAnalyticsStore({ dataDir, retentionDays: 1, now: () => now });
  const visitors = Array.from({ length: 30 }, () => getAnonymousVisitor('').id);

  const results = await Promise.all(visitors.map((visitor) => analytics.admitSearch(visitor, {
    perVisitorLimit: 2,
    globalLimit: 11,
  })));
  assert.equal(results.filter((result) => result.allowed).length, 11);
  assert.equal(results.filter((result) => result.reason === 'global').length, 19);
  assert.equal((await analytics.getSummary()).totals.searches, 11);

  now = Date.parse('2026-07-20T00:00:01.000Z');
  const nextDay = await analytics.admitSearch(visitors[0], { perVisitorLimit: 2, globalLimit: 11 });
  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.remainingVisitor, 1);
  assert.equal(nextDay.remainingGlobal, 10);
  assert.deepEqual((await analytics.getSummary()).daily.map((day) => day.date), ['2026-07-20']);
});

test('search admission normalizes analytics files created before visitor counters existed', async (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, 'analytics.json'), `${JSON.stringify({
    version: 1,
    days: {
      '2026-07-19': {
        pageViews: 4,
        searches: 2,
        resultOpens: 0,
        searchOutcomes: { success: 1, no_results: 1, failed: 0 },
        visitors: [],
      },
    },
  }, null, 2)}\n`);
  const analytics = createAnalyticsStore({
    dataDir,
    now: () => Date.parse('2026-07-19T12:00:00.000Z'),
  });
  const result = await analytics.admitSearch(getAnonymousVisitor('').id, {
    perVisitorLimit: 1,
    globalLimit: 3,
  });

  assert.deepEqual(result, {
    allowed: true,
    reason: '',
    retryAfterSeconds: 0,
    remainingVisitor: 0,
    remainingGlobal: 0,
  });
  assert.equal((await analytics.getSummary()).totals.searches, 3);
  const persisted = JSON.parse(fs.readFileSync(analytics.filePath, 'utf8'));
  assert.equal(Object.keys(persisted.days['2026-07-19'].visitorSearches).length, 1);
});

test('unknown events, outcomes, and caller-chosen visitor identifiers are rejected', async (t) => {
  const analytics = createAnalyticsStore({ dataDir: tempDataDir(t) });
  const visitor = getAnonymousVisitor('').id;

  assert.throws(() => analytics.recordEvent('query_text', visitor), /Unsupported analytics event/);
  await assert.rejects(analytics.recordSearch(visitor, { outcome: 'maybe' }), /Unsupported search outcome/);
  await assert.rejects(analytics.recordPageView('alice@example.com'), /valid random analytics cookie/);
  assert.throws(
    () => analytics.admitSearch(visitor, { perVisitorLimit: -1, globalLimit: 10 }),
    /non-negative safe integer/,
  );
});
