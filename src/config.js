import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

loadDotEnv();

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function floatEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boundedIntEnv(name, fallback, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(intEnv(name, fallback))));
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true/false, 1/0, yes/no, or on/off.`);
}

function csvEnv(name) {
  return [...new Set(String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean))];
}

const railwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN);
const hostedRuntime = process.env.NODE_ENV === 'production' || railwayRuntime;
const authPassword = process.env.AUTH_PASSWORD || process.env.APP_PASSWORD || '';
const authSessionSecret = process.env.AUTH_SESSION_SECRET || process.env.SESSION_SECRET || '';

if (Boolean(authPassword) !== Boolean(authSessionSecret)) {
  throw new Error('AUTH_PASSWORD and AUTH_SESSION_SECRET must be configured together.');
}
if (hostedRuntime && (!authPassword || !authSessionSecret)) {
  throw new Error('Admin authentication is required in production. Configure AUTH_PASSWORD and AUTH_SESSION_SECRET.');
}
if (authPassword && authPassword.length < 16) {
  throw new Error('AUTH_PASSWORD must contain at least 16 characters.');
}
if (authSessionSecret && Buffer.byteLength(authSessionSecret, 'utf8') < 32) {
  throw new Error('AUTH_SESSION_SECRET must contain at least 32 bytes.');
}

export const config = {
  rootDir,
  port: boundedIntEnv('PORT', 3000, 1, 65535),
  host: process.env.HOST || '127.0.0.1',
  allowedHosts: [
    ...csvEnv('ALLOWED_HOSTS'),
    process.env.RAILWAY_PUBLIC_DOMAIN || '',
    ...(railwayRuntime ? ['healthcheck.railway.app'] : []),
  ].filter(Boolean),
  trustProxy: boolEnv('TRUST_PROXY', hostedRuntime),
  authPassword,
  authSessionSecret,
  authSessionTtlSeconds: boundedIntEnv('AUTH_SESSION_TTL_SECONDS', 7 * 24 * 60 * 60, 15 * 60, 30 * 24 * 60 * 60),
  authCookieSecure: boolEnv('AUTH_COOKIE_SECURE', hostedRuntime),
  authMaxFailures: boundedIntEnv('AUTH_MAX_FAILURES', 10, 3, 100),
  authFailureWindowSeconds: boundedIntEnv('AUTH_FAILURE_WINDOW_SECONDS', 15 * 60, 60, 24 * 60 * 60),
  analyticsRetentionDays: boundedIntEnv('ANALYTICS_RETENTION_DAYS', 90, 1, 365),
  publicSearchesPerVisitorPerDay: boundedIntEnv('PUBLIC_SEARCHES_PER_VISITOR_PER_DAY', 3, 1, 100),
  publicSearchesGlobalPerDay: boundedIntEnv('PUBLIC_SEARCHES_GLOBAL_PER_DAY', 25, 1, 10000),
  searchHistoryMaxEntries: boundedIntEnv('SEARCH_HISTORY_MAX_ENTRIES', 500, 50, 5000),
  rawRunCacheMaxFiles: boundedIntEnv('RAW_RUN_CACHE_MAX_FILES', 500, 50, 5000),
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || './data'),
  apifyToken: process.env.APIFY_TOKEN || '',
  apifyMode: process.env.APIFY_MODE || 'cache-first',
  apifyFixtureFile: process.env.APIFY_FIXTURE_FILE
    ? path.resolve(rootDir, process.env.APIFY_FIXTURE_FILE)
    : '',
  apifySearchActor: process.env.APIFY_SEARCH_ACTOR || 'apify/rag-web-browser',
  // Primary structured discovery engine (highest precision). Verified best in testing.
  apifyProfileSearchActor: process.env.APIFY_PROFILE_SEARCH_ACTOR || 'harvestapi/linkedin-profile-search',
  apifyProfileSearchMode: process.env.APIFY_PROFILE_SEARCH_MODE || 'Short',
  apifyProfileSearchEnabled: boolEnv('APIFY_PROFILE_SEARCH_ENABLED', true),
  // Deep surname sweep: for a company search, additionally run this many
  // harvestapi lastNames[] passes over the top Armenian surnames. This finds
  // Armenians who never write "Armenian" on their profile (the biggest recall
  // gap) but costs ~$0.10 per surname, so it is OFF (0) by default.
  apifySurnameSeedCount: boundedIntEnv('APIFY_SURNAME_SEED_COUNT', 0, 0, 25),
  apifyCompanyEmployeesActor:
    process.env.APIFY_COMPANY_EMPLOYEES_ACTOR || 'george.the.developer/linkedin-company-employees-scraper',
  apifyCompanyEmployeesEnabled: boolEnv('APIFY_COMPANY_EMPLOYEES_ENABLED', false),
  apifyCompanySearchActor: process.env.APIFY_COMPANY_SEARCH_ACTOR || 'harvestapi/linkedin-company-search',
  // Profile enrichment: fetch full bios for top candidates so the judge has real evidence.
  apifyEnrichmentActor: process.env.APIFY_ENRICHMENT_ACTOR || 'anchor/linkedin-profile-enrichment',
  apifyEnrichEnabled: boolEnv('APIFY_ENRICH_ENABLED', true),
  apifyEnrichMaxProfiles: boundedIntEnv('APIFY_ENRICH_MAX_PROFILES', 6, 0, 50),
  apifyMcpUrl:
    process.env.APIFY_MCP_URL ||
    'https://mcp.apify.com/?tools=actors,docs,apify/rag-web-browser,harvestapi/linkedin-profile-search',
  apifyMcpEnabled: boolEnv('APIFY_MCP_ENABLED', false),
  apifyMaxResults: boundedIntEnv('APIFY_MAX_RESULTS', 12, 1, 50),
  apifyCompanyMaxEmployees: boundedIntEnv('APIFY_COMPANY_MAX_EMPLOYEES', 10, 1, 100),
  // A server-side guard on each actor run (not the aggregate search). Apify's
  // synchronous endpoint aborts that run before it exceeds this charge ceiling.
  apifyMaxTotalChargeUsd: Math.max(0.01, floatEnv('APIFY_MAX_TOTAL_CHARGE_USD', 0.25)),
  apifyDiscoveryConcurrency: boundedIntEnv('APIFY_DISCOVERY_CONCURRENCY', 3, 1, 5),
  contactCacheMaxAgeDays: boundedIntEnv('CONTACT_CACHE_MAX_AGE_DAYS', 30, 1, 3650),
  // LinkedIn scrapers legitimately take 60-120s; give them room (async job path
  // has no hard cap). Quality mode raises this further (see modes.js).
  apifyRequestTimeoutMs: boundedIntEnv('APIFY_REQUEST_TIMEOUT_MS', 90000, 10000, 300000),
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  // The strongest model for quality mode. Never use a "-lite" model here.
  geminiModelQuality: process.env.GEMINI_MODEL_QUALITY || process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  geminiApiBase: process.env.GEMINI_API_BASE || 'https://aiplatform.googleapis.com/v1/publishers/google/models',
  geminiEnabled: boolEnv('GEMINI_ENABLED', true),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowedChatIds: csvEnv('TELEGRAM_ALLOWED_CHAT_IDS'),
  telegramDefaultMode: process.env.TELEGRAM_DEFAULT_MODE || 'agent',
  telegramDefaultLimit: boundedIntEnv('TELEGRAM_DEFAULT_LIMIT', 5, 1, 10),
};

export function publicConfig(runtimeConfig = config) {
  return {
    adminAuthEnabled: Boolean(runtimeConfig.authPassword && runtimeConfig.authSessionSecret),
    pseudonymousAnalytics: true,
    analyticsRetentionDays: runtimeConfig.analyticsRetentionDays,
    publicSearchLimits: {
      perVisitorPerDay: runtimeConfig.publicSearchesPerVisitorPerDay,
      globalPerDay: runtimeConfig.publicSearchesGlobalPerDay,
    },
    mode: runtimeConfig.apifyMode,
    hasApifyToken: Boolean(runtimeConfig.apifyToken),
    searchActor: runtimeConfig.apifySearchActor,
    profileSearchActor: runtimeConfig.apifyProfileSearchActor,
    profileSearchEnabled: runtimeConfig.apifyProfileSearchEnabled,
    companyEmployeesActor: runtimeConfig.apifyCompanyEmployeesActor,
    companyEmployeesEnabled: runtimeConfig.apifyCompanyEmployeesEnabled,
    enrichmentActor: runtimeConfig.apifyEnrichmentActor,
    enrichEnabled: runtimeConfig.apifyEnrichEnabled,
    apifyMcpEnabled: Boolean(runtimeConfig.apifyMcpUrl && runtimeConfig.apifyToken && runtimeConfig.apifyMcpEnabled),
    maxResults: runtimeConfig.apifyMaxResults,
    companyMaxEmployees: runtimeConfig.apifyCompanyMaxEmployees,
    hasGeminiKey: Boolean(runtimeConfig.geminiApiKey),
    geminiEnabled: runtimeConfig.geminiEnabled,
    geminiModel: runtimeConfig.geminiModel,
    geminiApiBase: runtimeConfig.geminiApiBase.replace(/^https?:\/\//, ''),
  };
}
