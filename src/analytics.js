import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_COOKIE_NAME = 'fya_visitor';
const SECURE_COOKIE_NAME = '__Host-fya_visitor';
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const VISITOR_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 365;
const MAX_DAILY_VISITOR_HASHES = 5_000;
const MAX_DAILY_OPTIONAL_EVENTS = 10_000;
const OUTCOMES = new Set(['success', 'no_results', 'failed']);
const fileLocks = new Map();

export const ANALYTICS_RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
export const ANALYTICS_MAX_RETENTION_DAYS = MAX_RETENTION_DAYS;

/**
 * Return the server-only pseudonymous visitor identifier for a request cookie.
 *
 * The identifier is random, carries no user information, and is only returned
 * to the browser in an HttpOnly first-party cookie. Analytics persistence hashes
 * it before writing, so the raw cookie value never lands in DATA_DIR.
 */
export function getAnonymousVisitor(cookieHeaderOrRequest, options = {}) {
  const secure = Boolean(options.secure);
  const retentionDays = boundedRetentionDays(options.retentionDays);
  const cookieName = secure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
  const cookieHeader = typeof cookieHeaderOrRequest === 'string'
    ? cookieHeaderOrRequest
    : cookieHeaderOrRequest?.headers?.cookie;
  const existing = readCookie(cookieHeader, cookieName);

  if (VISITOR_ID_PATTERN.test(existing)) {
    return { id: existing, isNew: false, setCookie: '' };
  }

  const id = randomBytes(18).toString('base64url');
  const now = clockDate(options.now);
  const maxAge = retentionDays * 24 * 60 * 60;
  const attributes = [
    `${cookieName}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${new Date(now.getTime() + maxAge * 1000).toUTCString()}`,
  ];
  if (secure) attributes.push('Secure');

  return { id, isNew: true, setCookie: attributes.join('; ') };
}

/**
 * A deliberately narrow aggregate analytics store.
 *
 * It accepts only three counters and three search outcomes. There is no API for
 * arbitrary metadata, queries, IP addresses, names, emails, or user-agent
 * strings, which keeps those values out of the persisted representation by
 * construction.
 */
export function createAnalyticsStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.resolve(rootDir, process.env.DATA_DIR || './data'));
  const filePath = path.join(dataDir, 'analytics.json');
  const retentionDays = boundedRetentionDays(options.retentionDays);
  const now = options.now;

  async function record({ visitorId, counter = '', outcome = '' }) {
    assertVisitorId(visitorId);
    if (counter && !['pageViews', 'searches', 'resultOpens'].includes(counter)) {
      throw new TypeError(`Unsupported analytics counter: ${counter}`);
    }
    if (outcome && !OUTCOMES.has(outcome)) {
      throw new TypeError(`Unsupported search outcome: ${outcome}`);
    }
    if (!counter && !outcome) throw new TypeError('An analytics counter or search outcome is required.');

    return withFileLock(filePath, async () => {
      const instant = clockDate(now);
      const state = await readState(filePath);
      const pruned = pruneState(state, instant, retentionDays);
      const day = state.days[dayKey(instant)] || emptyDay();
      state.days[dayKey(instant)] = day;

      if ((counter === 'pageViews' || counter === 'resultOpens') && day[counter] >= MAX_DAILY_OPTIONAL_EVENTS) {
        if (pruned) await writeState(filePath, state);
        return summarize(state, retentionDays);
      }

      const visitorHash = hashVisitorId(visitorId);
      rememberVisitor(day, visitorHash);
      if (counter) day[counter] = safeIncrement(day[counter]);
      if (counter === 'searches') {
        day.visitorSearches[visitorHash] = safeIncrement(day.visitorSearches[visitorHash]);
      }
      if (outcome) day.searchOutcomes[outcome] = safeIncrement(day.searchOutcomes[outcome]);

      await writeState(filePath, state);
      return summarize(state, retentionDays);
    });
  }

  return Object.freeze({
    filePath,
    retentionDays,
    recordPageView(visitorId) {
      return record({ visitorId, counter: 'pageViews' });
    },
    recordSearch(visitorId, { outcome = '' } = {}) {
      return record({ visitorId, counter: 'searches', outcome });
    },
    recordSearchOutcome(visitorId, outcome) {
      return record({ visitorId, outcome });
    },
    recordResultOpen(visitorId) {
      return record({ visitorId, counter: 'resultOpens' });
    },
    admitSearch(visitorId, { perVisitorLimit = 5, globalLimit = 100 } = {}) {
      assertVisitorId(visitorId);
      const visitorCap = searchLimit(perVisitorLimit, 'per-visitor');
      const globalCap = searchLimit(globalLimit, 'global');

      return withFileLock(filePath, async () => {
        const instant = clockDate(now);
        const state = await readState(filePath);
        const pruned = pruneState(state, instant, retentionDays);
        const date = dayKey(instant);
        const day = state.days[date] || emptyDay();
        const visitorHash = hashVisitorId(visitorId);
        const visitorSearches = safeCount(day.visitorSearches[visitorHash]);
        const remainingVisitor = Math.max(0, visitorCap - visitorSearches);
        const remainingGlobal = Math.max(0, globalCap - day.searches);
        const reason = remainingGlobal === 0 ? 'global' : remainingVisitor === 0 ? 'visitor' : '';

        if (reason) {
          if (pruned) await writeState(filePath, state);
          return {
            allowed: false,
            reason,
            retryAfterSeconds: secondsUntilNextUtcDay(instant),
            remainingVisitor,
            remainingGlobal,
          };
        }

        state.days[date] = day;
        rememberVisitor(day, visitorHash);
        day.searches = safeIncrement(day.searches);
        day.visitorSearches[visitorHash] = safeIncrement(visitorSearches);
        await writeState(filePath, state);
        return {
          allowed: true,
          reason: '',
          retryAfterSeconds: 0,
          remainingVisitor: Math.max(0, visitorCap - day.visitorSearches[visitorHash]),
          remainingGlobal: Math.max(0, globalCap - day.searches),
        };
      });
    },
    recordEvent(event, visitorId, { outcome = '' } = {}) {
      if (event === 'page_view') return record({ visitorId, counter: 'pageViews' });
      if (event === 'search') return record({ visitorId, counter: 'searches', outcome });
      if (event === 'search_outcome') return record({ visitorId, outcome });
      if (event === 'result_open') return record({ visitorId, counter: 'resultOpens' });
      throw new TypeError(`Unsupported analytics event: ${event}`);
    },
    getSummary() {
      return withFileLock(filePath, async () => {
        const state = await readState(filePath);
        const changed = pruneState(state, clockDate(now), retentionDays);
        if (changed) await writeState(filePath, state);
        return summarize(state, retentionDays);
      });
    },
  });
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function assertVisitorId(visitorId) {
  if (!VISITOR_ID_PATTERN.test(String(visitorId || ''))) {
    throw new TypeError('Visitor ID must be a valid random analytics cookie value.');
  }
}

function hashVisitorId(visitorId) {
  return createHash('sha256').update(`find-your-armenian:analytics:v1:${visitorId}`, 'utf8').digest('hex');
}

function boundedRetentionDays(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_RETENTION_DAYS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError('Analytics retention days must be a finite number.');
  return Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.trunc(parsed)));
}

function clockDate(clock) {
  const value = typeof clock === 'function' ? clock() : clock ?? Date.now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Analytics clock returned an invalid date.');
  return date;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function emptyDay() {
  return {
    pageViews: 0,
    searches: 0,
    resultOpens: 0,
    searchOutcomes: { success: 0, no_results: 0, failed: 0 },
    visitors: [],
    visitorSearches: {},
  };
}

function emptyState() {
  return { version: FILE_VERSION, days: {} };
}

async function readState(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return normalizeState(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const state = emptyState();
  const sourceDays = value.days && typeof value.days === 'object' && !Array.isArray(value.days)
    ? value.days
    : {};

  for (const [date, source] of Object.entries(sourceDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !source || typeof source !== 'object' || Array.isArray(source)) continue;
    const day = emptyDay();
    day.pageViews = safeCount(source.pageViews);
    day.searches = safeCount(source.searches);
    day.resultOpens = safeCount(source.resultOpens);
    day.searchOutcomes.success = safeCount(source.searchOutcomes?.success);
    day.searchOutcomes.no_results = safeCount(source.searchOutcomes?.no_results);
    day.searchOutcomes.failed = safeCount(source.searchOutcomes?.failed);
    day.visitors = [...new Set(
      Array.isArray(source.visitors)
        ? source.visitors.filter((hash) => VISITOR_HASH_PATTERN.test(String(hash)))
        : [],
    )].sort().slice(0, MAX_DAILY_VISITOR_HASHES);
    const visitorSearches = source.visitorSearches && typeof source.visitorSearches === 'object'
      && !Array.isArray(source.visitorSearches)
      ? source.visitorSearches
      : {};
    for (const [hash, count] of Object.entries(visitorSearches)) {
      if (!VISITOR_HASH_PATTERN.test(hash)) continue;
      const normalizedCount = safeCount(count);
      if (normalizedCount > 0) day.visitorSearches[hash] = normalizedCount;
    }
    state.days[date] = day;
  }
  return state;
}

function safeCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return 0;
  return count;
}

function safeIncrement(value) {
  return Math.min(Number.MAX_SAFE_INTEGER, safeCount(value) + 1);
}

function rememberVisitor(day, visitorHash) {
  if (day.visitors.includes(visitorHash) || day.visitors.length >= MAX_DAILY_VISITOR_HASHES) return;
  day.visitors.push(visitorHash);
}

function searchLimit(value, label) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError(`Analytics ${label} search limit must be a non-negative safe integer.`);
  }
  return limit;
}

function secondsUntilNextUtcDay(now) {
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000));
}

function pruneState(state, now, retentionDays) {
  const today = dayKey(now);
  const cutoff = dayKey(new Date(now.getTime() - (retentionDays - 1) * DAY_MS));
  let changed = false;
  for (const date of Object.keys(state.days)) {
    if (date < cutoff || date > today) {
      delete state.days[date];
      changed = true;
    }
  }
  return changed;
}

function summarize(state, retentionDays) {
  const totals = {
    uniqueVisitors: 0,
    pageViews: 0,
    searches: 0,
    resultOpens: 0,
    searchOutcomes: { success: 0, noResults: 0, failed: 0 },
  };
  const allVisitors = new Set();
  const daily = Object.entries(state.days)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => {
      for (const hash of day.visitors) allVisitors.add(hash);
      totals.pageViews += day.pageViews;
      totals.searches += day.searches;
      totals.resultOpens += day.resultOpens;
      totals.searchOutcomes.success += day.searchOutcomes.success;
      totals.searchOutcomes.noResults += day.searchOutcomes.no_results;
      totals.searchOutcomes.failed += day.searchOutcomes.failed;
      return {
        date,
        uniqueVisitors: day.visitors.length,
        pageViews: day.pageViews,
        searches: day.searches,
        resultOpens: day.resultOpens,
        searchOutcomes: {
          success: day.searchOutcomes.success,
          noResults: day.searchOutcomes.no_results,
          failed: day.searchOutcomes.failed,
        },
      };
    });
  totals.uniqueVisitors = allVisitors.size;
  return { retentionDays, totals, daily };
}

function withFileLock(filePath, task) {
  const prior = fileLocks.get(filePath) || Promise.resolve();
  const next = prior.then(task, task);
  fileLocks.set(filePath, next.then(
    () => {},
    () => {},
  ));
  return next;
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
