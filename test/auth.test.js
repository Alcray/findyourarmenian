import assert from 'node:assert/strict';
import { once } from 'node:events';
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
  const server = createServer({ runtimeConfig });
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

test('hosted auth protects the UI and API while leaving health probes public', async (t) => {
  const baseUrl = await startTestServer(t);

  const homepage = await fetch(baseUrl, { redirect: 'manual' });
  assert.equal(homepage.status, 303);
  assert.equal(homepage.headers.get('location'), '/login');
  assert.equal(homepage.headers.get('cache-control'), 'no-store');

  const api = await fetch(`${baseUrl}/api/config`);
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: 'Authentication required.' });

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const ready = await fetch(`${baseUrl}/api/ready`);
  assert.equal(ready.status, 200);
});

test('login issues a secure signed cookie that permits same-origin access', async (t) => {
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
  const configResponse = await fetch(`${baseUrl}/api/config`, { headers: { cookie } });
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.json()).authEnabled, true);
  const authenticatedHomepage = await fetch(baseUrl, { headers: { cookie } });
  assert.equal(authenticatedHomepage.status, 200);
  assert.equal(authenticatedHomepage.headers.get('cache-control'), 'no-store');

  const loginPage = await fetch(`${baseUrl}/login`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(loginPage.status, 303);
  assert.equal(loginPage.headers.get('location'), '/');

  const separator = cookie.indexOf('=');
  const token = cookie.slice(separator + 1);
  const replacement = token.endsWith('A') ? 'B' : 'A';
  const tampered = `${cookie.slice(0, separator + 1)}${token.slice(0, -1)}${replacement}`;
  const tamperedResponse = await fetch(`${baseUrl}/api/config`, { headers: { cookie: tampered } });
  assert.equal(tamperedResponse.status, 401);
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
  const afterLogout = await fetch(`${baseUrl}/api/config`, { headers: { cookie: clearedCookie } });
  assert.equal(afterLogout.status, 401);
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
