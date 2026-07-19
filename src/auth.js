import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECURE_COOKIE_NAME = '__Host-fya_session';
const LOCAL_COOKIE_NAME = 'fya_session';
const TOKEN_VERSION = 1;

export function authEnabled(runtimeConfig) {
  return Boolean(runtimeConfig.authPassword && runtimeConfig.authSessionSecret);
}

export function verifyPassword(candidate, runtimeConfig) {
  if (!authEnabled(runtimeConfig) || typeof candidate !== 'string') return false;
  return timingSafeEqual(digest(candidate), digest(runtimeConfig.authPassword));
}

export function createSessionToken(runtimeConfig, now = Date.now()) {
  if (!authEnabled(runtimeConfig)) throw new Error('Authentication is not configured.');

  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: TOKEN_VERSION,
    iat: issuedAt,
    exp: issuedAt + runtimeConfig.authSessionTtlSeconds,
    nonce: randomBytes(16).toString('base64url'),
  })).toString('base64url');
  return `${payload}.${sign(payload, runtimeConfig.authSessionSecret)}`;
}

export function verifySessionToken(token, runtimeConfig, now = Date.now()) {
  if (!authEnabled(runtimeConfig) || typeof token !== 'string' || token.length > 2048) return false;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  const [payload, suppliedSignature] = parts;
  const expectedSignature = sign(payload, runtimeConfig.authSessionSecret);
  if (!safeEqual(suppliedSignature, expectedSignature)) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const currentTime = Math.floor(now / 1000);
    return session?.v === TOKEN_VERSION
      && Number.isSafeInteger(session.iat)
      && Number.isSafeInteger(session.exp)
      && typeof session.nonce === 'string'
      && /^[A-Za-z0-9_-]{16,64}$/.test(session.nonce)
      && session.iat <= currentTime + 60
      && session.exp > currentTime
      && session.exp - session.iat <= runtimeConfig.authSessionTtlSeconds;
  } catch {
    return false;
  }
}

export function requestHasValidSession(req, runtimeConfig, now = Date.now()) {
  const token = readCookie(req.headers.cookie, sessionCookieName(runtimeConfig));
  return verifySessionToken(token, runtimeConfig, now);
}

export function sessionCookie(runtimeConfig, now = Date.now()) {
  const secure = runtimeConfig.authCookieSecure;
  return serializeCookie(sessionCookieName(runtimeConfig), createSessionToken(runtimeConfig, now), {
    maxAge: runtimeConfig.authSessionTtlSeconds,
    secure,
  });
}

export function expiredSessionCookie(runtimeConfig) {
  return serializeCookie(sessionCookieName(runtimeConfig), '', {
    expires: new Date(0),
    maxAge: 0,
    secure: runtimeConfig.authCookieSecure,
  });
}

export function sessionCookieName(runtimeConfig) {
  return runtimeConfig.authCookieSecure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
}

export function createLoginRateLimiter({ maxFailures = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();

  function activeEntry(key, now) {
    const entry = failures.get(key);
    if (entry && entry.resetAt > now) return entry;
    failures.delete(key);
    return null;
  }

  function prune(now) {
    if (failures.size < 1000) return;
    for (const [key, entry] of failures) {
      if (entry.resetAt <= now) failures.delete(key);
    }
    while (failures.size >= 1000) failures.delete(failures.keys().next().value);
  }

  return {
    check(key, now = Date.now()) {
      const entry = activeEntry(key, now);
      if (!entry || entry.count < maxFailures) return { blocked: false, retryAfterSeconds: 0 };
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
    recordFailure(key, now = Date.now()) {
      prune(now);
      const entry = activeEntry(key, now) || { count: 0, resetAt: now + windowMs };
      entry.count += 1;
      failures.set(key, entry);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function serializeCookie(name, value, { expires, maxAge, secure }) {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.trunc(maxAge))}`,
  ];
  if (expires) attributes.push(`Expires=${expires.toUTCString()}`);
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}
