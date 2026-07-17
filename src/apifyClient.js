import { config } from './config.js';
import { demoItemsForQuery } from './demoData.js';
import { fetchWithRetry } from './http.js';
import { getRawRun, hashValue, saveRawRun } from './store.js';

function actorPath(actorId) {
  return encodeURIComponent(actorId.replace('/', '~'));
}

// How aggressively we retry a given actor. Cheap actors are safe to retry; a
// run-sync retry re-runs the actor, so expensive per-profile actors fail fast to
// avoid double-charging Apify credits.
function retriesForActor(actorId) {
  // Only the cheap rag-web-browser is safe to retry. run-sync bills for work
  // already done, so retrying a paid per-profile actor risks double-charging.
  if (actorId.includes('rag-web-browser')) return 2;
  return 0;
}

function inputForActor(actorId, query, limit, webMaxResults) {
  if (actorId.includes('rag-web-browser')) {
    return {
      query,
      // How many SERP results to scrape. Fast mode keeps this small (cost);
      // quality mode widens it a lot (recall). Capped at 50 for sanity.
      maxResults: Math.min(webMaxResults || Math.min(limit, 5), 50),
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
    companies: [intent.company],
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

  if (intent.company) input.currentCompanies = [intent.company];
  const titles = targetTitlesForRole(intent.role);
  if (titles.length) input.currentJobTitles = titles;
  const locations = [intent.location, ...(intent.locationAlternates || [])].filter(Boolean);
  if (locations.length) input.locations = [...new Set(locations)].slice(0, 3);
  return input;
}

async function runCached(actorId, input, limit, options, extra = {}) {
  const cacheKey = hashValue({ actorId, input, version: 2 });
  const mode = options.mode || config.apifyMode;

  if (!options.refresh && mode !== 'live') {
    const cached = await getRawRun(cacheKey);
    if (cached) {
      return { items: cached.items || [], cached: true, cacheKey, actorId, ...extra };
    }
  }

  if (mode === 'demo' || !config.apifyToken) {
    const items = demoItemsForQuery(options.demoQuery || input.query || input.searchQuery || '');
    await saveRawRun(cacheKey, { actorId, input, items, demo: true });
    return { items, cached: false, cacheKey, actorId, demo: true, ...extra };
  }

  // runActorSync throws on any non-2xx, so reaching here means the actor
  // completed. A 0-row result is a genuine empty — cache it (with a short TTL,
  // see getRawRun) so identical repeats don't re-bill the paid actor.
  const items = await runActorSync(actorId, input, limit, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  await saveRawRun(cacheKey, { actorId, input, items, empty: !items.length });
  return { items, cached: false, cacheKey, actorId, ...extra };
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
  const input = profileSearchInput(intent, limit, options.seedSurname, options.profileMode);
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

// Cost-guarded profile enrichment. Takes LinkedIn profile URLs and returns full
// bios so the LLM judge sees real evidence, not a 240-char SERP snippet.
export async function enrichProfilesWithApify(urls, options = {}) {
  const cleanUrls = [...new Set((urls || []).filter((url) => /linkedin\.com\/in\//i.test(url)))].slice(
    0,
    options.max || config.apifyEnrichMaxProfiles,
  );
  const enrichOpts = { timeoutMs: options.timeoutMs, retries: options.retries };
  if (!config.apifyEnrichEnabled || !cleanUrls.length) return { profiles: [], cached: false };

  const actorId = options.actorId || config.apifyEnrichmentActor;
  const input = { startUrls: cleanUrls.map((url) => ({ url })) };
  const mode = options.mode || config.apifyMode;
  const cacheKey = hashValue({ actorId, input, version: 2 });

  if (!options.refresh && mode !== 'live') {
    const cached = await getRawRun(cacheKey);
    if (cached) return { profiles: cached.items || [], cached: true, actorId };
  }
  if (mode === 'demo' || !config.apifyToken) return { profiles: [], cached: false, demo: true };

  const items = await runActorSync(actorId, input, cleanUrls.length, enrichOpts);
  await saveRawRun(cacheKey, { actorId, input, items, empty: !items.length });
  return { profiles: items, cached: false, actorId };
}

async function runActorSync(actorId, input, limit, opts = {}) {
  const url = new URL(`https://api.apify.com/v2/acts/${actorPath(actorId)}/run-sync-get-dataset-items`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));

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
      timeoutMs: opts.timeoutMs || config.apifyRequestTimeoutMs,
      // Quality mode passes retries to ride out the flaky LinkedIn scraper;
      // otherwise fall back to the per-actor default (cheap actors only).
      retries: opts.retries != null ? opts.retries : retriesForActor(actorId),
      retryOnHtml: false,
    },
  );

  if (!result.ok) {
    throw new Error(`Apify actor ${actorId} failed with HTTP ${result.status}: ${result.text.slice(0, 400)}`);
  }
  return Array.isArray(result.json) ? result.json : [];
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
