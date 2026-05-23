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
  apifyCompanyEmployeesActor:
    process.env.APIFY_COMPANY_EMPLOYEES_ACTOR || 'george.the.developer/linkedin-company-employees-scraper',
  apifyMaxResults: intEnv('APIFY_MAX_RESULTS', 8),
  apifyCompanyMaxEmployees: intEnv('APIFY_COMPANY_MAX_EMPLOYEES', 50),
  apifyRequestTimeoutMs: intEnv('APIFY_REQUEST_TIMEOUT_MS', 120000),
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiApiBase: process.env.GEMINI_API_BASE || 'https://aiplatform.googleapis.com/v1/publishers/google/models',
  geminiEnabled: (process.env.GEMINI_ENABLED || 'true') !== 'false',
};

export function publicConfig() {
  return {
    mode: config.apifyMode,
    hasApifyToken: Boolean(config.apifyToken),
    searchActor: config.apifySearchActor,
    companyEmployeesActor: config.apifyCompanyEmployeesActor,
    maxResults: config.apifyMaxResults,
    companyMaxEmployees: config.apifyCompanyMaxEmployees,
    hasGeminiKey: Boolean(config.geminiApiKey),
    geminiEnabled: config.geminiEnabled,
    geminiModel: config.geminiModel,
    geminiApiBase: config.geminiApiBase.replace(/^https?:\/\//, ''),
  };
}
