import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchPeople, savedLeadsWithProfiles } from './agent.js';
import { config, publicConfig } from './config.js';
import { deleteSearchJob, getSearchJob, listSearchJobs, startSearchJob } from './searchJobs.js';
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

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      assertAllowedRequestHost(req);
      if (req.url?.startsWith('/api/')) {
        await handleApi(req, res);
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

async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ready') {
    const readiness = await runtimeReadinessState();
    sendJson(res, readiness.ok ? 200 : 503, readiness);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, publicConfig());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    const input = normalizeSearchInput(await readBody(req));
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
    const input = normalizeSearchInput(await readBody(req));
    const job = startSearchJob(input);
    sendJson(res, 202, { job });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(res, 200, { jobs: listSearchJobs() });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const jobId = decodePathId(url.pathname, '/api/jobs/');
    const job = getSearchJob(jobId);
    if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
    sendJson(res, 200, { job });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
    const jobId = decodePathId(url.pathname, '/api/jobs/');
    deleteSearchJob(jobId);
    sendJson(res, 200, { ok: true });
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

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

function sendStatic(res, method, filePath, content) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'cache-control': filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
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
