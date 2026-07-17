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
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  rootDir,
  port: intEnv('PORT', 3000),
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || './data'),
  apifyToken: process.env.APIFY_TOKEN || '',
  apifyMode: process.env.APIFY_MODE || 'cache-first',
  apifySearchActor: process.env.APIFY_SEARCH_ACTOR || 'apify/rag-web-browser',
  // Primary structured discovery engine (highest precision). Verified best in testing.
  apifyProfileSearchActor: process.env.APIFY_PROFILE_SEARCH_ACTOR || 'harvestapi/linkedin-profile-search',
  apifyProfileSearchMode: process.env.APIFY_PROFILE_SEARCH_MODE || 'Short',
  apifyProfileSearchEnabled: (process.env.APIFY_PROFILE_SEARCH_ENABLED || 'true') !== 'false',
  // Deep surname sweep: for a company search, additionally run this many
  // harvestapi lastNames[] passes over the top Armenian surnames. This finds
  // Armenians who never write "Armenian" on their profile (the biggest recall
  // gap) but costs ~$0.10 per surname, so it is OFF (0) by default.
  apifySurnameSeedCount: intEnv('APIFY_SURNAME_SEED_COUNT', 0),
  apifyCompanyEmployeesActor:
    process.env.APIFY_COMPANY_EMPLOYEES_ACTOR || 'george.the.developer/linkedin-company-employees-scraper',
  apifyCompanyEmployeesEnabled: (process.env.APIFY_COMPANY_EMPLOYEES_ENABLED || 'false') !== 'false',
  apifyCompanySearchActor: process.env.APIFY_COMPANY_SEARCH_ACTOR || 'harvestapi/linkedin-company-search',
  // Profile enrichment: fetch full bios for top candidates so the judge has real evidence.
  apifyEnrichmentActor: process.env.APIFY_ENRICHMENT_ACTOR || 'anchor/linkedin-profile-enrichment',
  apifyEnrichEnabled: (process.env.APIFY_ENRICH_ENABLED || 'true') !== 'false',
  apifyEnrichMaxProfiles: intEnv('APIFY_ENRICH_MAX_PROFILES', 6),
  apifyMcpUrl:
    process.env.APIFY_MCP_URL ||
    'https://mcp.apify.com/?tools=actors,docs,apify/rag-web-browser,harvestapi/linkedin-profile-search',
  apifyMcpEnabled: (process.env.APIFY_MCP_ENABLED || 'false') !== 'false',
  apifyMaxResults: intEnv('APIFY_MAX_RESULTS', 12),
  apifyCompanyMaxEmployees: intEnv('APIFY_COMPANY_MAX_EMPLOYEES', 10),
  // LinkedIn scrapers legitimately take 60-120s; give them room (async job path
  // has no hard cap). Quality mode raises this further (see modes.js).
  apifyRequestTimeoutMs: intEnv('APIFY_REQUEST_TIMEOUT_MS', 90000),
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  // The strongest model for quality mode. Never use a "-lite" model here.
  geminiModelQuality: process.env.GEMINI_MODEL_QUALITY || process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  geminiApiBase: process.env.GEMINI_API_BASE || 'https://aiplatform.googleapis.com/v1/publishers/google/models',
  geminiEnabled: (process.env.GEMINI_ENABLED || 'true') !== 'false',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramDefaultMode: process.env.TELEGRAM_DEFAULT_MODE || 'agent',
  telegramDefaultLimit: intEnv('TELEGRAM_DEFAULT_LIMIT', 5),
};

export function publicConfig() {
  return {
    mode: config.apifyMode,
    hasApifyToken: Boolean(config.apifyToken),
    searchActor: config.apifySearchActor,
    profileSearchActor: config.apifyProfileSearchActor,
    profileSearchEnabled: config.apifyProfileSearchEnabled,
    companyEmployeesActor: config.apifyCompanyEmployeesActor,
    companyEmployeesEnabled: config.apifyCompanyEmployeesEnabled,
    enrichmentActor: config.apifyEnrichmentActor,
    enrichEnabled: config.apifyEnrichEnabled,
    apifyMcpEnabled: Boolean(config.apifyMcpUrl && config.apifyToken && config.apifyMcpEnabled),
    maxResults: config.apifyMaxResults,
    companyMaxEmployees: config.apifyCompanyMaxEmployees,
    hasGeminiKey: Boolean(config.geminiApiKey),
    geminiEnabled: config.geminiEnabled,
    geminiModel: config.geminiModel,
    geminiApiBase: config.geminiApiBase.replace(/^https?:\/\//, ''),
  };
}
