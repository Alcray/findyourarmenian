import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchPeople, savedLeadsWithProfiles } from './agent.js';
import { createAnalyticsStore, getAnonymousVisitor } from './analytics.js';
import {
  authEnabled,
  createLoginRateLimiter,
  expiredSessionCookie,
  requestHasValidSession,
  sessionCookie,
  verifyPassword,
} from './auth.js';
import { config, publicConfig } from './config.js';
import {
  deleteSearchJob,
  findActiveSearchJob,
  getSearchJob,
  listSearchJobs,
  startSearchJob,
} from './searchJobs.js';
import { getSearch, listContactsWithLeads, listLeads, listProfiles, listSearches, upsertLead } from './store.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const serverFile = fileURLToPath(import.meta.url);
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_CONCURRENT_SYNC_SEARCHES = 1;
const LEAD_STATUSES = new Set(['saved', 'contacted', 'helped', 'not relevant']);
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
let activeSyncSearches = 0;
const defaultSearchJobs = Object.freeze({
  findActive: findActiveSearchJob,
  start: startSearchJob,
  get: getSearchJob,
  list: listSearchJobs,
  remove: deleteSearchJob,
});

export function createServer({ runtimeConfig = config, searchJobs = defaultSearchJobs } = {}) {
  const loginRateLimiter = createLoginRateLimiter({
    maxFailures: runtimeConfig.authMaxFailures,
    windowMs: runtimeConfig.authFailureWindowSeconds * 1000,
  });
  const analytics = createAnalyticsStore({
    dataDir: runtimeConfig.dataDir,
    retentionDays: runtimeConfig.analyticsRetentionDays,
  });
  const optionalAnalyticsLimiter = createOptionalAnalyticsLimiter();

  return http.createServer(async (req, res) => {
    try {
      assertAllowedRequestHost(req, runtimeConfig);
      const url = new URL(req.url || '/', 'http://localhost');

      if (isHealthCheck(req, url)) {
        await handleApi(req, res, runtimeConfig, {
          analytics,
          isAdmin: false,
          optionalAnalyticsLimiter,
          searchJobs,
        });
        return;
      }

      const handled = await handleAuthRoute(req, res, url, runtimeConfig, loginRateLimiter);
      if (handled) return;

      const isAdmin = authEnabled(runtimeConfig) && requestHasValidSession(req, runtimeConfig);
      if (isAdminProtectedRequest(req, url) && !isAdmin) {
        sendAdminAuthenticationRequired(req, res);
        return;
      }

      assertSameOriginMutation(req);
      if (req.url?.startsWith('/api/')) {
        await handleApi(req, res, runtimeConfig, { analytics, isAdmin, optionalAnalyticsLimiter, searchJobs });
        return;
      }

      if (isAdminPath(url.pathname)) {
        await serveAdmin(req, res, url);
        return;
      }

      await serveStatic(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }

      const statusCode = validStatusCode(error?.statusCode) ? error.statusCode : 500;
      const message = statusCode >= 500 && !error?.expose ? 'Internal server error' : error?.message || 'Request failed';
      sendJson(res, statusCode, { error: message });
    }
  });
}

export function startServer({ port = config.port, host = config.host } = {}) {
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Find Your Armenian running on http://${host}:${port}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === serverFile) {
  startServer();
}

async function handleApi(req, res, runtimeConfig = config, context = {}) {
  const url = new URL(req.url || '/', 'http://localhost');
  const analytics = context.analytics || createAnalyticsStore({
    dataDir: runtimeConfig.dataDir,
    retentionDays: runtimeConfig.analyticsRetentionDays,
  });
  const isAdmin = Boolean(context.isAdmin);
  const optionalAnalyticsLimiter = context.optionalAnalyticsLimiter || createOptionalAnalyticsLimiter();
  const searchJobs = context.searchJobs || defaultSearchJobs;

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ready') {
    const readiness = await runtimeReadinessState(runtimeConfig);
    sendJson(res, readiness.ok ? 200 : 503, readiness);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const visitor = anonymousVisitor(req, runtimeConfig);
    if (!isAdmin && optionalAnalyticsAllowed(req) && optionalAnalyticsLimiter.allow(visitor.id)) {
      await analytics.recordPageView(visitor.id);
    }
    sendJson(res, 200, {
      ...publicConfig(runtimeConfig),
      adminAuthenticated: isAdmin,
    }, visitorHeaders(visitor));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/analytics') {
    sendJson(res, 200, {
      ...(await analytics.getSummary()),
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/events/result-open') {
    const visitor = anonymousVisitor(req, runtimeConfig);
    const body = await readBody(req, 256);
    if (Object.keys(body).length) throw httpError(400, 'This analytics event does not accept properties.');
    if (!isAdmin && optionalAnalyticsAllowed(req) && optionalAnalyticsLimiter.allow(visitor.id)) {
      await analytics.recordResultOpen(visitor.id);
    }
    sendJson(res, 202, { ok: true }, visitorHeaders(visitor));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    const input = normalizeSearchInput(await readBody(req), runtimeConfig);
    if (activeSyncSearches >= MAX_CONCURRENT_SYNC_SEARCHES) {
      throw httpError(429, 'A synchronous search is already running. Use /api/jobs or try again later.');
    }
    activeSyncSearches += 1;
    const searchPromise = searchPeople({ ...input });
    void searchPromise.finally(() => {
      activeSyncSearches -= 1;
    }).catch(() => {});
    const result = await withTimeout(
      searchPromise,
      // Quality mode can be slow; the UI uses the async /api/jobs path.
      600000,
      'Search timed out after 600s. Try fast mode or a narrower query.',
    );
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const visitor = anonymousVisitor(req, runtimeConfig);
    const input = normalizeSearchInput(await readBody(req), runtimeConfig);
    const effectiveInput = isAdmin
      ? input
      : {
          ...input,
          refresh: false,
          limit: Math.min(input.limit, clampInteger(runtimeConfig.apifyMaxResults, 1, 50, 12)),
        };
    let quota = null;

    if (!isAdmin) {
      if (input.refresh) {
        throw httpError(403, 'Public searches reuse cached data when available. Refresh is reserved for the owner dashboard.');
      }
      const activeJob = searchJobs.findActive?.(effectiveInput, { ownerId: visitor.id });
      if (activeJob) {
        sendJson(res, 202, { job: activeJob, quota: null, deduplicated: true }, visitorHeaders(visitor));
        return;
      }
      quota = await analytics.admitSearch(visitor.id, {
        perVisitorLimit: runtimeConfig.publicSearchesPerVisitorPerDay,
        globalLimit: runtimeConfig.publicSearchesGlobalPerDay,
      });
      if (!quota.allowed) {
        const message = quota.reason === 'global'
          ? 'The public search budget for today has been reached. Please try again tomorrow.'
          : 'You have used today\'s free searches in this browser. Please try again tomorrow.';
        sendJson(res, 429, { error: message, quota }, {
          ...visitorHeaders(visitor),
          'retry-after': String(quota.retryAfterSeconds),
        });
        return;
      }
    }

    const job = searchJobs.start(effectiveInput, {
      ownerId: visitor.id,
      onSettled: isAdmin
        ? undefined
        : ({ outcome }) => analytics.recordSearchOutcome(visitor.id, outcome),
    });
    sendJson(res, 202, { job, quota }, visitorHeaders(visitor));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(res, 200, { jobs: searchJobs.list({ isAdmin: true }) });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const visitor = anonymousVisitor(req, runtimeConfig);
    const jobId = decodePathId(url.pathname, '/api/jobs/');
    const job = searchJobs.get(jobId, { ownerId: visitor.id, isAdmin });
    if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
    sendJson(res, 200, { job }, visitorHeaders(visitor));
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
    const visitor = anonymousVisitor(req, runtimeConfig);
    const jobId = decodePathId(url.pathname, '/api/jobs/');
    if (!searchJobs.remove(jobId, { ownerId: visitor.id, isAdmin })) {
      throw Object.assign(new Error('Job not found'), { statusCode: 404 });
    }
    sendJson(res, 200, { ok: true }, visitorHeaders(visitor));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/searches') {
    sendJson(res, 200, {
      searches: (await listSearches()).map((search) => ({
        searchKey: search.searchKey,
        query: search.query,
        mode: searchMode(search),
        resultCount: search.resultSnapshots?.length || search.resultIds?.length || 0,
        updatedAt: search.updatedAt || search.createdAt,
        intent: search.intent || {},
      })),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/searches/')) {
    const searchKey = decodePathId(url.pathname, '/api/searches/');
    const search = await getSearch(searchKey);
    if (!search) throw Object.assign(new Error('Search not found'), { statusCode: 404 });

    const [profiles, leads] = await Promise.all([listProfiles(), listLeads()]);
    sendJson(res, 200, {
      ...search,
      mode: searchMode(search),
      cached: true,
      loadedFromHistory: true,
      results: Array.isArray(search.resultSnapshots)
        ? snapshotsWithLeads(search.resultSnapshots, leads)
        : hydrateResults(search.resultIds || [], profiles, leads),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/contacts') {
    const contacts = await listContactsWithLeads(url.searchParams.get('q') || '');
    sendJson(res, 200, { contacts, total: contacts.length });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/leads') {
    sendJson(res, 200, { leads: await savedLeadsWithProfiles() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/leads') {
    const lead = normalizeLeadInput(await readBody(req));
    sendJson(res, 200, { lead: await upsertLead(lead) });
    return;
  }

  throw Object.assign(new Error('Not found'), { statusCode: 404 });
}

async function handleAuthRoute(req, res, url, runtimeConfig, loginRateLimiter) {
  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/login' || url.pathname === '/login.html')) {
    sendRedirect(res, '/admin/login');
    return true;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/admin/login') {
    if (requestHasValidSession(req, runtimeConfig)) {
      sendRedirect(res, '/admin');
      return true;
    }
    await servePublicFile(req, res, 'login.html', { noStore: true });
    return true;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/admin/login.js') {
    await servePublicFile(req, res, 'login.js', { noStore: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    assertSameOriginMutation(req);
    const clientKey = requestClientKey(req, runtimeConfig);
    const limit = loginRateLimiter.check(clientKey);
    if (limit.blocked) {
      req.resume();
      sendJson(res, 429, { error: 'Too many login attempts. Try again later.' }, {
        'retry-after': String(limit.retryAfterSeconds),
      });
      return true;
    }

    const body = await readBody(req, 2048);
    const validShape = Object.keys(body).every((field) => field === 'password')
      && typeof body.password === 'string'
      && body.password.length <= 1024;
    if (!validShape || !verifyPassword(body.password, runtimeConfig)) {
      loginRateLimiter.recordFailure(clientKey);
      sendJson(res, 401, { error: 'Invalid password.' });
      return true;
    }

    loginRateLimiter.reset(clientKey);
    sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie(runtimeConfig) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    assertSameOriginMutation(req);
    await readBody(req, 2048);
    sendJson(res, 200, { ok: true }, {
      'clear-site-data': '"cache", "storage"',
      'set-cookie': expiredSessionCookie(runtimeConfig),
    });
    return true;
  }

  return false;
}

function isHealthCheck(req, url) {
  return req.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/api/ready');
}

function sendAdminAuthenticationRequired(req, res) {
  if (!String(req.url || '').startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
    sendRedirect(res, '/admin/login');
    return;
  }
  sendJson(res, 401, { error: 'Admin authentication required.' });
}

function isAdminProtectedRequest(req, url) {
  if (isAdminPath(url.pathname) && url.pathname !== '/admin/login' && url.pathname !== '/admin/login.js') {
    return true;
  }

  if (url.pathname === '/api/search') return true;
  if (url.pathname === '/api/jobs' && req.method === 'GET') return true;
  return isPathWithin(url.pathname, '/api/admin')
    || isPathWithin(url.pathname, '/api/searches')
    || isPathWithin(url.pathname, '/api/contacts')
    || isPathWithin(url.pathname, '/api/leads');
}

function isAdminPath(pathname) {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

function isPathWithin(pathname, root) {
  return pathname === root || pathname.startsWith(`${root}/`);
}

function sendRedirect(res, location) {
  res.writeHead(303, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'content-length': '0',
    location,
  });
  res.end();
}

function assertSameOriginMutation(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) return;

  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw httpError(403, 'Cross-origin requests are not allowed.');
  }

  const origin = String(req.headers.origin || '');
  if (!origin) return;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestHost = String(req.headers.host || '').toLowerCase();
    if (!originHost || originHost !== requestHost) throw new Error('origin mismatch');
  } catch {
    throw httpError(403, 'Cross-origin requests are not allowed.');
  }
}

function requestClientKey(req, runtimeConfig) {
  if (runtimeConfig.trustProxy) {
    const realIp = String(req.headers['x-real-ip'] || '').trim();
    if (realIp) return realIp.slice(0, 200);
    const forwardedFor = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1);
    if (forwardedFor) return forwardedFor.slice(0, 200);
  }
  return String(req.socket.remoteAddress || 'unknown').slice(0, 200);
}

function anonymousVisitor(req, runtimeConfig) {
  return getAnonymousVisitor(req, {
    secure: runtimeConfig.authCookieSecure,
    retentionDays: runtimeConfig.analyticsRetentionDays,
  });
}

function visitorHeaders(visitor) {
  return visitor?.setCookie ? { 'set-cookie': visitor.setCookie } : {};
}

function optionalAnalyticsAllowed(req) {
  return String(req.headers['sec-gpc'] || '') !== '1'
    && String(req.headers.dnt || '') !== '1';
}

function createOptionalAnalyticsLimiter({
  windowMs = 60 * 1000,
  maxPerVisitor = 15,
  maxGlobal = 60,
} = {}) {
  const visitors = new Map();
  let globalWindow = { count: 0, resetAt: 0 };

  function current(entry, now) {
    return entry?.resetAt > now ? entry : { count: 0, resetAt: now + windowMs };
  }

  return {
    allow(visitorId, now = Date.now()) {
      globalWindow = current(globalWindow, now);
      const visitorWindow = current(visitors.get(visitorId), now);
      if (globalWindow.count >= maxGlobal || visitorWindow.count >= maxPerVisitor) return false;

      globalWindow.count += 1;
      visitorWindow.count += 1;
      visitors.set(visitorId, visitorWindow);
      if (visitors.size > 5000) {
        for (const [id, entry] of visitors) {
          if (entry.resetAt <= now) visitors.delete(id);
        }
        while (visitors.size > 5000) visitors.delete(visitors.keys().next().value);
      }
      return true;
    },
  };
}

export async function readBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    req.resume();
    throw httpError(415, 'Content-Type must be application/json.');
  }
  const contentLength = Number.parseInt(req.headers['content-length'] || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    throw httpError(413, `JSON body must not exceed ${maxBytes} bytes.`);
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw httpError(413, `JSON body must not exceed ${maxBytes} bytes.`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError(400, 'Request body could not be read.');
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw httpError(400, 'Request body must contain valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'JSON body must be an object.');
  }
  return parsed;
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw httpError(405, 'Method not allowed.');
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(publicDir, `.${requested}`);

  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
    throw httpError(404, 'Not found.');
  }

  try {
    const content = await fs.readFile(filePath);
    sendStatic(res, req.method, filePath, content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const fallbackPath = path.join(publicDir, 'index.html');
      const fallback = await fs.readFile(fallbackPath);
      sendStatic(res, req.method, fallbackPath, fallback);
      return;
    }
    throw error;
  }
}

async function serveAdmin(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw httpError(405, 'Method not allowed.');
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    await servePublicFile(req, res, 'admin.html', { noStore: true });
    return;
  }
  if (url.pathname === '/admin/app.js') {
    await servePublicFile(req, res, 'admin.js', { noStore: true });
    return;
  }
  throw httpError(404, 'Not found.');
}

async function servePublicFile(req, res, fileName, { noStore = false } = {}) {
  const filePath = path.join(publicDir, fileName);
  try {
    const content = await fs.readFile(filePath);
    sendStatic(res, req.method, filePath, content, noStore ? 'no-store' : undefined);
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'Not found.');
    throw error;
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(body);
}

function sendStatic(res, method, filePath, content, cacheControl) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'cache-control': cacheControl || (filePath.endsWith('.html') ? 'no-store' : 'public, max-age=3600'),
    'content-length': content.length,
    'content-type': contentType(filePath),
  });
  res.end(method === 'HEAD' ? undefined : content);
}

function contentType(filePath) {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(httpError(504, message)), timeoutMs);
    }),
  ]);
}

export function normalizeSearchInput(body, runtimeConfig = config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'JSON body must be an object.');
  }

  if (typeof body.query !== 'string') {
    throw httpError(400, 'query must be a string between 3 and 300 characters.');
  }
  const query = body.query.trim();
  if (query.length < 3 || query.length > 300) {
    throw httpError(400, 'query must be between 3 and 300 characters.');
  }

  const fallbackLimit = clampInteger(runtimeConfig.apifyMaxResults, 1, 50, 12);
  const limit = body.limit === undefined || body.limit === null || body.limit === ''
    ? fallbackLimit
    : clampInteger(body.limit, 1, 50);
  const mode = body.mode === undefined ? 'quality' : body.mode;
  if (mode !== 'fast' && mode !== 'quality') {
    throw httpError(400, 'mode must be either "fast" or "quality".');
  }
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') {
    throw httpError(400, 'refresh must be a boolean.');
  }

  return { query, limit, mode, refresh: body.refresh || false };
}

export function normalizeLeadInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'JSON body must be an object.');
  }

  const unknownFields = Object.keys(body).filter((field) => !['personId', 'status', 'notes'].includes(field));
  if (unknownFields.length) {
    throw httpError(400, `Unsupported lead field: ${unknownFields[0]}.`);
  }

  if (typeof body.personId !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(body.personId)) {
    throw httpError(400, 'personId must be a non-empty identifier of at most 200 characters.');
  }
  const status = body.status === undefined ? 'saved' : body.status;
  if (typeof status !== 'string' || !LEAD_STATUSES.has(status)) {
    throw httpError(400, `status must be one of: ${[...LEAD_STATUSES].join(', ')}.`);
  }
  const notes = body.notes === undefined ? '' : body.notes;
  if (typeof notes !== 'string' || notes.length > 5000 || notes.includes('\u0000')) {
    throw httpError(400, 'notes must be a string of at most 5000 characters without null bytes.');
  }

  return { personId: body.personId, status, notes };
}

export function readinessState(runtimeConfig = config) {
  const mode = String(runtimeConfig.apifyMode || '');
  const supportedModes = new Set(['cache-first', 'live', 'demo', 'fixture']);
  const validMode = supportedModes.has(mode);
  const fixtureReady = mode !== 'fixture' || Boolean(runtimeConfig.apifyFixtureFile);
  const explicitLocalMode = mode === 'demo' || mode === 'fixture';
  const apifyReady = validMode && fixtureReady && (explicitLocalMode || Boolean(runtimeConfig.apifyToken));
  let status = 'missing';
  if (!validMode) status = 'invalid-mode';
  else if (!fixtureReady) status = 'fixture-file-missing';
  else if (explicitLocalMode) status = mode;
  else if (runtimeConfig.apifyToken) status = 'configured';
  return {
    ok: apifyReady,
    dependencies: {
      apify: status,
    },
  };
}

export async function runtimeReadinessState(runtimeConfig = config) {
  const configured = readinessState(runtimeConfig);
  const dependencies = { ...configured.dependencies };
  let storageReady = false;
  try {
    await fs.mkdir(runtimeConfig.dataDir, { recursive: true, mode: 0o700 });
    await fs.access(runtimeConfig.dataDir, fsConstants.W_OK);
    storageReady = true;
    dependencies.storage = 'writable';
  } catch {
    dependencies.storage = 'unwritable';
  }

  let fixtureReadable = true;
  if (runtimeConfig.apifyMode === 'fixture' && runtimeConfig.apifyFixtureFile) {
    try {
      await fs.access(runtimeConfig.apifyFixtureFile, fsConstants.R_OK);
      dependencies.fixture = 'readable';
    } catch {
      fixtureReadable = false;
      dependencies.fixture = 'unreadable';
    }
  }
  return { ok: configured.ok && storageReady && fixtureReadable, dependencies };
}

function assertAllowedRequestHost(req, runtimeConfig = config) {
  const hostname = requestHostname(req.headers.host);
  const allowed = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    ...(runtimeConfig.allowedHosts || []).map(requestHostname).filter(Boolean),
  ]);
  if (!hostname || !allowed.has(hostname)) {
    throw httpError(403, 'Request host is not allowed. Configure ALLOWED_HOSTS for trusted network access.');
  }
}

function requestHostname(value) {
  if (!value) return '';
  try {
    const candidate = String(value).includes('://') ? String(value) : `http://${value}`;
    return new URL(candidate).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function clampInteger(value, min, max, fallback) {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(numeric)) {
    if (fallback !== undefined) return fallback;
    throw httpError(400, `limit must be an integer between ${min} and ${max}.`);
  }
  return Math.min(max, Math.max(min, numeric));
}

function decodePathId(pathname, prefix) {
  try {
    const id = decodeURIComponent(pathname.slice(prefix.length));
    if (!id || id.includes('/')) throw new Error('invalid path identifier');
    return id;
  } catch {
    throw httpError(400, 'Invalid path identifier.');
  }
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

function validStatusCode(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599;
}

function searchMode(search) {
  if (search.mode) return search.mode;
  if (search.agent?.framework === 'langchain-langgraph' || search.plan || search.agent?.planning || search.agent?.mcp) {
    return 'quality';
  }
  return 'fast';
}

function hydrateResults(resultIds, profiles, leads) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const leadByPerson = new Map(leads.map((lead) => [lead.personId, lead]));
  return resultIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((profile) => ({
      ...profile,
      lead: leadByPerson.get(profile.id) || null,
    }));
}

function snapshotsWithLeads(snapshots, leads) {
  const leadByPerson = new Map(leads.map((lead) => [lead.personId, lead]));
  return snapshots.map((profile) => ({
    ...profile,
    lead: leadByPerson.get(profile.id) || null,
  }));
}
