import { config } from './config.js';
import {
  enrichProfilesWithApify,
  resolveCompanyLinkedInUrl,
  searchCompanyEmployeesWithApify,
  searchProfilesWithApify,
  searchWithApify,
} from './apifyClient.js';
import { mergeCandidatesByIdentity } from './merge.js';
import { ARMENIAN_SURNAME_QUERY_BATCH, buildSearchQueries, normalizeCandidates } from './people.js';

// Shared discovery used by both the fast pipeline and the LangGraph agent.
// Strategy (tuned from live testing):
//   1. harvestapi/linkedin-profile-search — structured, highest precision.
//   2. apify/rag-web-browser — simple "<terms> Armenian" Google queries; strong
//      for company affiliation and recovers people the structured search missed.
//   3. company-employees scraper — optional broad roster (off by default; costly).
// Results are deduped by identity, and borderline candidates are enriched with
// full LinkedIn bios before the LLM judge runs.
export async function discoverCandidates(intent, options = {}) {
  const { refresh = false, limit = config.apifyMaxResults, profile = {} } = options;
  // Per-mode overrides (quality vs fast). See modes.js.
  const profileMode = profile.profileMode;
  const surnameSeedCount = profile.surnameSeedCount ?? config.apifySurnameSeedCount;
  const paidActorOpts = { timeoutMs: profile.apifyTimeoutMs, retries: 0 };
  const webActorOpts = { timeoutMs: profile.apifyTimeoutMs, retries: profile.webRetries ?? 0 };
  const runs = [];
  const errors = [];
  const candidates = [];

  const push = (run, sourceQuery, metadata) => {
    runs.push(runSummary(run, sourceQuery));
    candidates.push(...normalizeCandidates(run.items, intent, sourceQuery, metadata));
  };

  // Resolve the display name once. Harvest's currentCompanies filter requires a
  // full LinkedIn company URL; sending "OpenAI" or another plain name silently
  // broadens the search and destroys precision.
  let effectiveIntent = intent;
  const needsCompanyResolution = Boolean(
    intent.company && (config.apifyProfileSearchEnabled || config.apifyCompanyEmployeesEnabled),
  );
  let companyResolved = !needsCompanyResolution;
  if (needsCompanyResolution) {
    try {
      const resolution = await resolveCompanyLinkedInUrl(intent.company, { refresh, ...paidActorOpts });
      companyResolved = Boolean(resolution.url);
      effectiveIntent = { ...intent, companyUrl: resolution.url };
      if (resolution.run) runs.push(runSummary(resolution.run, `company resolution: ${intent.company}`));
      if (!companyResolved) {
        errors.push({
          query: `company resolution: ${intent.company}`,
          message: `No exact LinkedIn company match was found for "${intent.company}"; using web discovery only.`,
        });
      }
    } catch (error) {
      errors.push({ query: `company resolution: ${intent.company}`, message: error.message });
    }
  }

  // Build a deterministic task list, then execute it with bounded concurrency.
  // The old fully-sequential quality path could take many minutes; this keeps
  // ordering stable while allowing independent actor calls to overlap.
  const tasks = [];
  if (config.apifyProfileSearchEnabled && companyResolved) {
    const label = `profile search: ${[intent.company, intent.role, intent.location].filter(Boolean).join(' ') || 'Armenian'}`;
    tasks.push({
      label,
      metadata: { kind: 'profile-search', targetCompany: intent.company },
      run: () => searchProfilesWithApify(effectiveIntent, { refresh, limit, profileMode, ...paidActorOpts }),
    });
  }

  // Surname-seeded passes are explicitly opt-in because every surname is a
  // separate paid profile-search page.
  if (surnameSeedCount > 0 && intent.company && config.apifyProfileSearchEnabled && companyResolved) {
    for (const surname of ARMENIAN_SURNAME_QUERY_BATCH.slice(0, surnameSeedCount)) {
      tasks.push({
        label: `surname seed: ${surname} @ ${intent.company}`,
        metadata: { kind: 'surname-seed', targetCompany: intent.company },
        run: () =>
          searchProfilesWithApify(effectiveIntent, {
            refresh,
            limit,
            seedSurname: surname,
            profileMode,
            ...paidActorOpts,
          }),
      });
    }
  }

  const queries = buildSearchQueries(intent).slice(0, profile.webQueryCount ?? 2);
  for (const sourceQuery of queries) {
    tasks.push({
      label: sourceQuery,
      metadata: { kind: 'web-search', targetCompany: intent.company },
      run: () =>
        searchWithApify(sourceQuery, {
          refresh,
          limit,
          webMaxResults: profile.webMaxResults,
          ...webActorOpts,
        }),
    });
  }

  const outcomes = await mapLimit(tasks, config.apifyDiscoveryConcurrency, async (task) => {
    try {
      return { task, run: await task.run() };
    } catch (error) {
      return { task, error };
    }
  });
  for (const outcome of outcomes) {
    if (outcome.error) {
      errors.push({ query: outcome.task.label, message: outcome.error.message });
      continue;
    }
    const run = outcome.run;
    push(run, outcome.task.label, {
      ...outcome.task.metadata,
      actorId: run.actorId,
      cached: run.cached,
      demo: run.demo,
      fixture: run.fixture,
      shared: run.shared,
      observedAt: run.observedAt,
    });
  }

  // 3) Optional company-employees roster (off by default).
  if (intent.company && companyResolved && config.apifyCompanyEmployeesEnabled && uniqueCount(candidates) < limit) {
    const label = `company employees: ${intent.company}`;
    try {
      const run = await searchCompanyEmployeesWithApify(effectiveIntent, { refresh, limit, ...paidActorOpts });
      push(run, label, {
        actorId: run.actorId,
        cached: run.cached,
        demo: run.demo,
        fixture: run.fixture,
        shared: run.shared,
        observedAt: run.observedAt,
        kind: 'company-employees',
        targetCompany: intent.company,
      });
    } catch (error) {
      errors.push({ query: label, message: error.message });
    }
  }

  if (config.apifyMode === 'fixture' && errors.length) {
    throw new Error(`Strict fixture discovery failed: ${errors.map((error) => `${error.query}: ${error.message}`).join('; ')}`);
  }

  const deduped = dedupeByIdentity(candidates);
  const enrichment = await enrichBorderline(deduped, intent, {
    refresh,
    enrich: profile.enrich ?? config.apifyEnrichEnabled,
    max: profile.enrichMaxProfiles,
    ...paidActorOpts,
  });
  if (enrichment.run) runs.push(runSummary(enrichment.run, 'profile enrichment'));
  if (enrichment.error) errors.push({ query: 'profile enrichment', message: enrichment.error.message });
  return { candidates: enrichment.candidates, runs, errors };
}

// Fetch full LinkedIn bios for borderline candidates so the judge sees real
// evidence. Cost-guarded: only borderline candidates with a real /in/ URL, capped.
async function enrichBorderline(candidates, intent, options = {}) {
  const { refresh, enrich = config.apifyEnrichEnabled, max = config.apifyEnrichMaxProfiles } = options;
  if (!enrich) return { candidates };

  const targets = candidates.filter(
    (c) =>
      c.confidence >= 20 &&
      c.confidence <= 78 &&
      !(c.sources || []).some((source) => source.kind === 'enrichment' || (source.context || '').length >= 700) &&
      // Tolerate underscores and a trailing slash — common LinkedIn URL shapes.
      /linkedin\.com\/in\/[a-z0-9_%-]+\/?$/i.test(c.profileUrl || ''),
  );
  const urls = targets.map((c) => c.profileUrl).slice(0, max);
  if (!urls.length) return { candidates };

  let enrichedItems = [];
  let enrichmentMetadata = {};
  let enrichmentRun;
  try {
    const result = await enrichProfilesWithApify(urls, { refresh, max, timeoutMs: options.timeoutMs, retries: options.retries });
    enrichmentRun = result.actorId ? result : undefined;
    enrichedItems = result.profiles || [];
    enrichmentMetadata = {
      cached: result.cached,
      demo: result.demo,
      fixture: result.fixture,
      shared: result.shared,
      observedAt: result.observedAt,
    };
  } catch (error) {
    if (config.apifyMode === 'fixture') throw error;
    return { candidates, error }; // best-effort, but keep the failed paid call visible
  }
  if (!enrichedItems.length) return { candidates, run: enrichmentRun };

  // Re-normalize the enriched profiles (rich bios), then merge by identity so the
  // richer evidence and higher score win.
  const enrichedCandidates = normalizeCandidates(enrichedItems, intent, 'profile enrichment', {
    actorId: enrichmentRun?.actorId || 'profile-enrichment',
    kind: 'enrichment',
    targetCompany: intent.company,
    ...enrichmentMetadata,
  });

  return {
    candidates: dedupeByIdentity([...candidates, ...enrichedCandidates]),
    run: enrichmentRun,
  };
}

function dedupeByIdentity(candidates) {
  return mergeCandidatesByIdentity(candidates).sort((a, b) => b.confidence - a.confidence);
}

function uniqueCount(candidates) {
  return new Set(candidates.map((c) => c.identityKey || c.id)).size;
}

function runSummary(run, query) {
  return {
    actorId: run.actorId,
    cacheKey: run.cacheKey,
    cached: run.cached,
    demo: Boolean(run.demo),
    fixture: Boolean(run.fixture),
    shared: Boolean(run.shared),
    observedAt: run.observedAt || '',
    query,
    itemCount: run.items?.length ?? run.profiles?.length ?? 0,
  };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
