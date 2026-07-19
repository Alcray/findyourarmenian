import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionToken, verifySessionToken } from '../src/auth.js';
import { config } from '../src/config.js';
import { createServer } from '../src/server.js';

const PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-that-is-longer-than-thirty-two-bytes';

function testConfig(overrides = {}) {
  return {
    ...config,
    allowedHosts: [],
    apifyMode: 'demo',
    apifyToken: '',
    authPassword: PASSWORD,
    authSessionSecret: SESSION_SECRET,
    authSessionTtlSeconds: 3600,
    authCookieSecure: true,
    authMaxFailures: 10,
    authFailureWindowSeconds: 900,
    trustProxy: false,
    ...overrides,
  };
}

async function startTestServer(t, runtimeConfig = testConfig()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = createServer({ runtimeConfig: { ...runtimeConfig, dataDir } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function login(baseUrl, password = PASSWORD, headers = {}) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
  });
}

test('public search UI and config stay open while owner data and analytics stay private', async (t) => {
  const baseUrl = await startTestServer(t);

  const homepage = await fetch(baseUrl, { redirect: 'manual' });
  assert.equal(homepage.status, 200);
  assert.equal(homepage.headers.get('cache-control'), 'no-store');

  const publicApi = await fetch(`${baseUrl}/api/config`);
  assert.equal(publicApi.status, 200);
  const publicBody = await publicApi.json();
  assert.equal(publicBody.adminAuthEnabled, true);
  assert.equal(publicBody.adminAuthenticated, false);
  assert.equal(publicBody.pseudonymousAnalytics, true);
  assert.match(publicApi.headers.get('set-cookie'), /^__Host-fya_visitor=/);

  const adminPage = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(adminPage.status, 303);
  assert.equal(adminPage.headers.get('location'), '/admin/login');

  for (const route of ['/api/admin/analytics', '/api/jobs', '/api/searches', '/api/contacts', '/api/leads']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 401, route);
    assert.deepEqual(await response.json(), { error: 'Admin authentication required.' });
  }

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const ready = await fetch(`${baseUrl}/api/ready`);
  assert.equal(ready.status, 200);
});

test('login issues a secure signed cookie that unlocks only the owner area', async (t) => {
  const baseUrl = await startTestServer(t);

  const rejected = await login(baseUrl, 'incorrect password');
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('set-cookie'), null);

  const accepted = await login(baseUrl, PASSWORD, { origin: baseUrl });
  assert.equal(accepted.status, 200);
  const setCookie = accepted.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-fya_session=/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Lax/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; Max-Age=3600/);

  const cookie = setCookie.split(';', 1)[0];
  const analytics = await fetch(`${baseUrl}/api/admin/analytics`, { headers: { cookie } });
  assert.equal(analytics.status, 200);
  assert.equal((await analytics.json()).totals.searches, 0);
  const adminPage = await fetch(`${baseUrl}/admin`, { headers: { cookie } });
  assert.equal(adminPage.status, 200);
  assert.equal(adminPage.headers.get('cache-control'), 'no-store');

  const loginPage = await fetch(`${baseUrl}/admin/login`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(loginPage.status, 303);
  assert.equal(loginPage.headers.get('location'), '/admin');

  const separator = cookie.indexOf('=');
  const token = cookie.slice(separator + 1);
  const replacement = token.endsWith('A') ? 'B' : 'A';
  const tampered = `${cookie.slice(0, separator + 1)}${token.slice(0, -1)}${replacement}`;
  const tamperedResponse = await fetch(`${baseUrl}/api/admin/analytics`, { headers: { cookie: tampered } });
  assert.equal(tamperedResponse.status, 401);

  const stillPublic = await fetch(`${baseUrl}/api/config`, { headers: { cookie: tampered } });
  assert.equal(stillPublic.status, 200);
  assert.equal((await stillPublic.json()).adminAuthenticated, false);
});

test('logout clears the session cookie and cross-origin mutations are rejected', async (t) => {
  const baseUrl = await startTestServer(t);
  const accepted = await login(baseUrl);
  const cookie = accepted.headers.get('set-cookie').split(';', 1)[0];

  const crossOrigin = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: 'https://attacker.example',
    },
    body: JSON.stringify({ personId: 'person_123' }),
  });
  assert.equal(crossOrigin.status, 403);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^__Host-fya_session=;/);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(logout.headers.get('clear-site-data'), '"cache", "storage"');

  const clearedCookie = logout.headers.get('set-cookie').split(';', 1)[0];
  const afterLogout = await fetch(`${baseUrl}/api/admin/analytics`, { headers: { cookie: clearedCookie } });
  assert.equal(afterLogout.status, 401);
  const publicAfterLogout = await fetch(`${baseUrl}/api/config`, { headers: { cookie: clearedCookie } });
  assert.equal(publicAfterLogout.status, 200);
});

test('signed sessions reject expiry and secret rotation', () => {
  const runtimeConfig = testConfig({ authSessionTtlSeconds: 900 });
  const issuedAt = Date.UTC(2026, 0, 1);
  const token = createSessionToken(runtimeConfig, issuedAt);

  assert.equal(verifySessionToken(token, runtimeConfig, issuedAt + 899_000), true);
  assert.equal(verifySessionToken(token, runtimeConfig, issuedAt + 900_000), false);
  assert.equal(
    verifySessionToken(token, { ...runtimeConfig, authSessionSecret: `${SESSION_SECRET}-rotated` }, issuedAt),
    false,
  );
  assert.equal(verifySessionToken('malformed', runtimeConfig, issuedAt), false);
});

test('repeated login failures are throttled per client', async (t) => {
  const baseUrl = await startTestServer(t, testConfig({ authMaxFailures: 3 }));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await login(baseUrl, `incorrect-password-${attempt}`);
    assert.equal(response.status, 401);
  }

  const blocked = await login(baseUrl);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('trusted Railway client IP headers keep login throttles isolated', async (t) => {
  const baseUrl = await startTestServer(t, testConfig({ authMaxFailures: 3, trustProxy: true }));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await login(baseUrl, `incorrect-password-${attempt}`, { 'x-real-ip': '203.0.113.10' });
    assert.equal(response.status, 401);
  }

  const blocked = await login(baseUrl, PASSWORD, { 'x-real-ip': '203.0.113.10' });
  assert.equal(blocked.status, 429);
  const otherClient = await login(baseUrl, PASSWORD, { 'x-real-ip': '203.0.113.11' });
  assert.equal(otherClient.status, 200);
});

test('owner routes fail closed when admin credentials are not configured', async (t) => {
  const baseUrl = await startTestServer(t, testConfig({
    authPassword: '',
    authSessionSecret: '',
    authCookieSecure: false,
  }));

  assert.equal((await fetch(baseUrl)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/config`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/admin/analytics`)).status, 401);

  const admin = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(admin.status, 303);
  assert.equal(admin.headers.get('location'), '/admin/login');
});
