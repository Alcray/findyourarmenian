import fs from 'node:fs/promises';
import { config } from './config.js';
import { demoItemsForQuery } from './demoData.js';
import { fetchWithRetry } from './http.js';
import { canonicalLinkedInProfileUrl } from './merge.js';
import { getRawRun, hashValue, saveRawRun } from './store.js';

const SUPPORTED_MODES = new Set(['cache-first', 'live', 'demo', 'fixture']);
const inFlightRuns = new Map();

// Avoid a paid company lookup for common targets. Harvest's people-search actor
// requires full LinkedIn company URLs, not display names.
const KNOWN_COMPANY_URLS = new Map(
  Object.entries({
    openai: 'https://www.linkedin.com/company/openai',
    anthropic: 'https://www.linkedin.com/company/anthropicresearch',
    google: 'https://www.linkedin.com/company/google',
    meta: 'https://www.linkedin.com/company/meta',
    apple: 'https://www.linkedin.com/company/apple',
    microsoft: 'https://www.linkedin.com/company/microsoft',
    amazon: 'https://www.linkedin.com/company/amazon',
    nvidia: 'https://www.linkedin.com/company/nvidia',
    apify: 'https://www.linkedin.com/company/apifytech',
    picsart: 'https://www.linkedin.com/company/picsart-photo-studio',
    servicetitan: 'https://www.linkedin.com/company/servicetitan',
  }),
);

function actorPath(actorId) {
  return encodeURIComponent(actorId.replace('/', '~'));
}

// A run-sync retry launches another actor run. Keep outer retries at zero for
// every actor so timeouts cannot silently multiply charges; actors may still use
// their own internal request retry settings.
function retriesForActor(actorId) {
  void actorId;
  return 0;
}

function inputForActor(actorId, query, limit, webMaxResults) {
  if (actorId.includes('rag-web-browser')) {
    return {
      query,
      // How many SERP results to scrape. Fast mode keeps this small (cost);
      // quality mode widens it a lot (recall). Capped at 50 for sanity.
      maxResults: Math.min(webMaxResults || 5, Math.max(limit, 1), 50),
      outputFormats: ['markdown', 'text'],
      requestTimeoutSecs: 30,
      htmlTransformer: 'readable-text',
    };
  }

  return {
    query,
    search: query,
    maxItems: limit,
    maxResults: limit,
  };
}

function companyEmployeesInput(intent, limit) {
  return {
    companies: [intent.companyUrl || intent.company],
    searchQuery: intent.wantsArmenian ? 'Armenian OR "Armenian language" OR "Armenian-American" OR Hayastan' : '',
    targetTitles: targetTitlesForRole(intent.role),
    location: intent.location || '',
    profileDepth: 'short',
    // maxEmployees is a COST CAP, not a floor: never scrape more than configured.
    maxEmployees: Math.min(Math.max(limit, 1), config.apifyCompanyMaxEmployees),
    maxConcurrency: 3,
  };
}

// harvestapi/linkedin-profile-search: structured LinkedIn people search. This is
// the highest-precision discovery engine — currentCompanies/locations/jobTitles
// filters plus a fuzzy searchQuery. "Short" mode bills ~$0.10 per 25-profile page.
function profileSearchInput(intent, limit, seedSurname = '', profileMode = '') {
  const input = {
    profileScraperMode: profileMode || config.apifyProfileSearchMode,
    maxItems: Math.min(Math.max(limit, 1), 25),
  };
  // Surname-seeded pass: filter by an Armenian surname instead of requiring the
  // literal word "Armenian" in the profile — catches Armenians who don't self-label.
  if (seedSurname) input.lastNames = [seedSurname];
  else input.searchQuery = intent.wantsArmenian ? 'Armenian' : intent.role || '';

  if (intent.companyUrl) input.currentCompanies = [intent.companyUrl];
  const titles = targetTitlesForRole(intent.role);
  if (titles.length) input.currentJobTitles = titles;
  const locations = [intent.location, ...(intent.locationAlternates || [])].filter(Boolean);
  if (locations.length) input.locations = [...new Set(locations)].slice(0, 3);
  return input;
}

async function runCached(actorId, input, limit, options, extra = {}) {
  const mode = options.mode || config.apifyMode;
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`Unsupported APIFY_MODE "${mode}". Use cache-first, live, demo, or fixture.`);
  }

  // Benchmarks and tests use an immutable, tracked fixture catalog. A miss is a
  // hard failure: never fall through to demo data, disk cache, or the network.
  if (mode === 'fixture') {
    const fixture = await loadFixtureRun(actorId, input);
    return {
      items: fixture.items,
      cached: true,
      fixture: true,
      cacheKey: fixture.cacheKey,
      actorId,
      observedAt: fixture.observedAt || '',
      ...extra,
    };
  }

  // Demo and live results deliberately occupy different namespaces. Otherwise
  // a synthetic demo run can silently reappear during a real search (and cached
  // demo responses used to lose their `demo` provenance flag).
  const namespace = mode === 'demo' ? 'demo' : 'live';
  const cacheKey = hashValue({ actorId, input, namespace, version: 3 });

  if (!options.refresh && mode !== 'live') {
    const cached = await getRawRun(cacheKey);
    if (cached) {
      return {
        items: cached.items || [],
        cached: true,
        cacheKey,
        actorId,
        demo: Boolean(cached.demo),
        observedAt: cached.observedAt || cached.cachedAt || '',
        ...extra,
      };
    }
  }

  if (mode === 'demo') {
    const items = options.demoItems ?? demoItemsForQuery(options.demoQuery || input.query || input.searchQuery || '');
    const observedAt = new Date().toISOString();
    await saveRawRun(cacheKey, { actorId, input, items, demo: true, observedAt });
    return { items, cached: false, cacheKey, actorId, demo: true, observedAt, ...extra };
  }

  if (!config.apifyToken) {
    throw new Error(
      'APIFY_TOKEN is required for this uncached search. Set APIFY_MODE=demo for synthetic local data.',
    );
  }

  // runActorSync throws on any non-2xx, so reaching here means the actor
  // completed. A 0-row result is a genuine empty — cache it (with a short TTL,
  // see getRawRun) so identical repeats don't re-bill the paid actor.
  const existingRun = inFlightRuns.get(cacheKey);
  if (existingRun) {
    const sharedRun = await existingRun;
    return { ...sharedRun, cached: false, shared: true, cacheKey, actorId, ...extra };
  }

  const pendingRun = (async () => {
    const items = await runActorSync(actorId, input, limit, {
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });
    const observedAt = new Date().toISOString();
    await saveRawRun(cacheKey, { actorId, input, items, empty: !items.length, demo: false, observedAt });
    return { items, observedAt };
  })();
  inFlightRuns.set(cacheKey, pendingRun);
  try {
    const run = await pendingRun;
    return { ...run, cached: false, cacheKey, actorId, ...extra };
  } finally {
    if (inFlightRuns.get(cacheKey) === pendingRun) inFlightRuns.delete(cacheKey);
  }
}

export async function searchWithApify(query, options = {}) {
  const actorId = options.actorId || config.apifySearchActor;
  const limit = options.limit || config.apifyMaxResults;
  const input = inputForActor(actorId, query, limit, options.webMaxResults);
  return runCached(actorId, input, input.maxResults || limit, { ...options, demoQuery: query });
}

export async function searchProfilesWithApify(intent, options = {}) {
  const actorId = options.actorId || config.apifyProfileSearchActor;
  const limit = options.limit || config.apifyMaxResults;
  let resolvedIntent = intent;
  if (intent.company && !intent.companyUrl) {
    const resolution = await resolveCompanyLinkedInUrl(intent.company, options);
    if (!resolution.url) {
      throw new Error(`Could not resolve a LinkedIn company URL for "${intent.company}".`);
    }
    resolvedIntent = { ...intent, companyUrl: resolution.url };
  }
  const input = profileSearchInput(resolvedIntent, limit, options.seedSurname, options.profileMode);
  return runCached(actorId, input, input.maxItems, {
    ...options,
    demoQuery: `${intent.company || intent.location || intent.role || ''} ${options.seedSurname || 'Armenian'}`,
  });
}

export async function searchCompanyEmployeesWithApify(intent, options = {}) {
  const actorId = options.actorId || config.apifyCompanyEmployeesActor;
  const limit = options.limit || config.apifyMaxResults;
  const input = companyEmployeesInput(intent, limit);
  return runCached(actorId, input, input.maxEmployees, {
    ...options,
    demoQuery: `employees at ${intent.company}`,
    input,
  });
}

export async function searchCompaniesWithApify(query, options = {}) {
  const actorId = options.actorId || config.apifyCompanySearchActor;
  const input = {
    searchQuery: String(query || '').trim(),
    scraperMode: 'short',
    maxItems: Math.min(Math.max(options.limit || 5, 1), 10),
  };
  return runCached(actorId, input, input.maxItems, {
    ...options,
    demoQuery: query,
    // Company-resolution demo data would be misleading; known demo companies
    // are handled by the local map above.
    demoItems: [],
  });
}

export async function resolveCompanyLinkedInUrl(company, options = {}) {
  const raw = String(company || '').trim();
  if (!raw) return { url: '', run: null };

  const direct = canonicalLinkedInCompanyUrl(raw);
  if (direct) return { url: direct, run: null };

  const known = KNOWN_COMPANY_URLS.get(normalizeCompanyName(raw));
  if (known) return { url: known, run: null };

  const run = await searchCompaniesWithApify(raw, options);
  return { url: pickCompanyLinkedInUrl(run.items, raw), run };
}

export function pickCompanyLinkedInUrl(items, company) {
  const ranked = (items || [])
    .map((item) => ({
      item,
      url: canonicalLinkedInCompanyUrl(companyUrlFromItem(item)),
      score: companyNameScore(company, companyNameFromItem(item)),
    }))
    .filter((entry) => entry.url && entry.score >= 75)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.url || '';
}

// Cost-guarded profile enrichment. Takes LinkedIn profile URLs and returns full
// bios so the LLM judge sees real evidence, not a 240-char SERP snippet.
export async function enrichProfilesWithApify(urls, options = {}) {
  const cleanUrls = [...new Set((urls || []).map(canonicalLinkedInProfileUrl).filter(Boolean))].slice(
    0,
    options.max || config.apifyEnrichMaxProfiles,
  );
  if (!config.apifyEnrichEnabled || !cleanUrls.length) return { profiles: [], cached: false };

  const actorId = options.actorId || config.apifyEnrichmentActor;
  const input = { startUrls: cleanUrls.map((url) => ({ url })) };
  const run = await runCached(
    actorId,
    input,
    cleanUrls.length,
    { ...options, demoItems: [] },
    { kind: 'profile-enrichment' },
  );
  return { ...run, profiles: run.items };
}

async function runActorSync(actorId, input, limit, opts = {}) {
  const url = new URL(`https://api.apify.com/v2/acts/${actorPath(actorId)}/run-sync-get-dataset-items`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('maxItems', String(limit));
  url.searchParams.set('maxTotalChargeUsd', String(config.apifyMaxTotalChargeUsd));
  url.searchParams.set('restartOnError', 'false');
  const timeoutMs = opts.timeoutMs || config.apifyRequestTimeoutMs;
  // Leave a small margin for the HTTP response to arrive before our client-side
  // AbortController fires. Apify caps synchronous actor runs at 300 seconds.
  url.searchParams.set('timeout', String(Math.min(295, Math.max(1, Math.floor((timeoutMs - 5000) / 1000)))));

  const result = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.apifyToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    },
    {
      label: `Apify actor ${actorId}`,
      timeoutMs,
      // Never automatically rerun an actor: a timed-out synchronous call may
      // still have incurred charges.
      retries: actorId.includes('rag-web-browser')
        ? opts.retries != null
          ? opts.retries
          : retriesForActor(actorId)
        : 0,
      retryOnHtml: false,
    },
  );

  if (!result.ok) {
    throw new Error(`Apify actor ${actorId} failed with HTTP ${result.status}.`);
  }
  if (!Array.isArray(result.json)) {
    throw new Error(`Apify actor ${actorId} returned a malformed dataset response.`);
  }
  return result.json;
}

let fixtureCatalogPromise;

async function loadFixtureRun(actorId, input) {
  if (!config.apifyFixtureFile) {
    throw new Error('APIFY_MODE=fixture requires APIFY_FIXTURE_FILE.');
  }
  fixtureCatalogPromise ||= fs
    .readFile(config.apifyFixtureFile, 'utf8')
    .then((body) => JSON.parse(body));
  const catalog = await fixtureCatalogPromise;
  const cacheKey = hashValue({ actorId, input });
  const run = (catalog.runs || []).find(
    (entry) => entry.cacheKey === cacheKey || hashValue({ actorId: entry.actorId, input: entry.input }) === cacheKey,
  );
  if (!run) {
    throw new Error(
      `Fixture miss for ${actorId} (${cacheKey}). Add this exact input: ${JSON.stringify(input)}`,
    );
  }
  if (!Array.isArray(run.items)) {
    throw new Error(`Invalid fixture catalog entry for ${actorId} (${cacheKey}): items must be an array.`);
  }
  return { items: run.items, cacheKey, observedAt: run.observedAt || catalog.capturedAt || '' };
}

function canonicalLinkedInCompanyUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const host = url.hostname.toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
    const match = url.pathname.match(/^\/company\/([^/]+)\/?$/i);
    if (!match) return '';
    const slug = decodeURIComponent(match[1]).normalize('NFKC').toLowerCase();
    if (!slug || /[\s/?#]/u.test(slug)) return '';
    return `https://www.linkedin.com/company/${encodeURIComponent(slug)}`;
  } catch {
    return '';
  }
}

function companyUrlFromItem(item) {
  return (
    item.linkedinUrl ||
    item.linkedInUrl ||
    item.companyLinkedinUrl ||
    item.companyLinkedInUrl ||
    item.url ||
    item.link ||
    ''
  );
}

function companyNameFromItem(item) {
  return String(item.name || item.companyName || item.title || '').trim();
}

function normalizeCompanyName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:incorporated|inc|llc|ltd|limited|corp|corporation|company|co)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function companyNameScore(target, candidate) {
  const left = normalizeCompanyName(target);
  const right = normalizeCompanyName(candidate);
  if (!left || !right) return 0;
  if (left === right) return 100;
  return 0;
}

function targetTitlesForRole(role) {
  const titles = {
    sales: ['Sales', 'Account Executive', 'GTM', 'Business Development', 'Partnerships'],
    founder: ['Founder', 'Co-Founder', 'CEO'],
    engineer: ['Engineer', 'Software Engineer', 'Engineering', 'Developer'],
    ai: ['AI', 'Machine Learning', 'ML', 'Research', 'Applied AI'],
    product: ['Product', 'Product Manager'],
    design: ['Design', 'Designer'],
    recruiting: ['Recruiter', 'Recruiting', 'Talent'],
  };

  return titles[role] || [];
}
