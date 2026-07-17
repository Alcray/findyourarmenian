import { config } from './config.js';
import {
  enrichProfilesWithApify,
  searchCompanyEmployeesWithApify,
  searchProfilesWithApify,
  searchWithApify,
} from './apifyClient.js';
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
  const actorOpts = { timeoutMs: profile.apifyTimeoutMs, retries: profile.apifyRetries };
  const runs = [];
  const errors = [];
  const candidates = [];

  const push = (run, sourceQuery, metadata) => {
    runs.push(runSummary(run, sourceQuery));
    candidates.push(...normalizeCandidates(run.items, intent, sourceQuery, metadata));
  };

  // 1) Structured profile search (primary) — the self-label pass (searchQuery:"Armenian").
  if (config.apifyProfileSearchEnabled) {
    const label = `profile search: ${[intent.company, intent.role, intent.location].filter(Boolean).join(' ') || 'Armenian'}`;
    try {
      const run = await searchProfilesWithApify(intent, { refresh, limit, profileMode, ...actorOpts });
      push(run, label, {
        actorId: run.actorId,
        cached: run.cached,
        demo: run.demo,
        kind: 'profile-search',
        targetCompany: intent.company,
      });
    } catch (error) {
      errors.push({ query: label, message: error.message });
    }
  }

  // 1b) Surname-seed pass (opt-in, cost-gated): finds Armenians who never write
  // "Armenian" on their profile by filtering harvestapi on lastNames[] instead.
  if (surnameSeedCount > 0 && intent.company && config.apifyProfileSearchEnabled) {
    for (const surname of ARMENIAN_SURNAME_QUERY_BATCH.slice(0, surnameSeedCount)) {
      try {
        const run = await searchProfilesWithApify(intent, { refresh, limit, seedSurname: surname, profileMode, ...actorOpts });
        push(run, `surname seed: ${surname} @ ${intent.company}`, {
          actorId: run.actorId,
          cached: run.cached,
          demo: run.demo,
          kind: 'surname-seed',
          targetCompany: intent.company,
        });
      } catch (error) {
        errors.push({ query: `surname seed: ${surname}`, message: error.message });
      }
    }
  }

  // 2) Web fan-out: the self-label query AND the cheap surname-OR query (which the
  // SERP ORs natively). Both run — the surname query is the recall lever.
  const queries = buildSearchQueries(intent).slice(0, profile.webQueryCount ?? 2);
  for (const sourceQuery of queries) {
    try {
      const run = await searchWithApify(sourceQuery, { refresh, limit, webMaxResults: profile.webMaxResults, ...actorOpts });
      push(run, sourceQuery, {
        actorId: run.actorId,
        cached: run.cached,
        demo: run.demo,
        kind: 'web-search',
        targetCompany: intent.company,
      });
    } catch (error) {
      errors.push({ query: sourceQuery, message: error.message });
    }
  }

  // 3) Optional company-employees roster (off by default).
  if (intent.company && config.apifyCompanyEmployeesEnabled && uniqueCount(candidates) < limit) {
    const label = `company employees: ${intent.company}`;
    try {
      const run = await searchCompanyEmployeesWithApify(intent, { refresh, limit, ...actorOpts });
      push(run, label, {
        actorId: run.actorId,
        cached: run.cached,
        demo: run.demo,
        kind: 'company-employees',
        targetCompany: intent.company,
      });
    } catch (error) {
      errors.push({ query: label, message: error.message });
    }
  }

  const deduped = dedupeByIdentity(candidates);
  const enriched = await enrichBorderline(deduped, intent, {
    refresh,
    enrich: profile.enrich ?? config.apifyEnrichEnabled,
    max: profile.enrichMaxProfiles,
    ...actorOpts,
  });
  return { candidates: enriched, runs, errors };
}

// Fetch full LinkedIn bios for borderline candidates so the judge sees real
// evidence. Cost-guarded: only borderline candidates with a real /in/ URL, capped.
async function enrichBorderline(candidates, intent, options = {}) {
  const { refresh, enrich = config.apifyEnrichEnabled, max = config.apifyEnrichMaxProfiles } = options;
  if (!enrich) return candidates;

  const targets = candidates.filter(
    (c) =>
      c.confidence >= 20 &&
      c.confidence <= 78 &&
      // Tolerate underscores and a trailing slash — common LinkedIn URL shapes.
      /linkedin\.com\/in\/[a-z0-9_%-]+\/?$/i.test(c.profileUrl || ''),
  );
  const urls = targets.map((c) => c.profileUrl).slice(0, max);
  if (!urls.length) return candidates;

  let enrichedItems = [];
  try {
    const result = await enrichProfilesWithApify(urls, { refresh, max, timeoutMs: options.timeoutMs, retries: options.retries });
    enrichedItems = result.profiles || [];
  } catch {
    return candidates; // enrichment is best-effort; never fail the search over it
  }
  if (!enrichedItems.length) return candidates;

  // Re-normalize the enriched profiles (rich bios), then merge by identity so the
  // richer evidence and higher score win.
  const enrichedCandidates = normalizeCandidates(enrichedItems, intent, 'profile enrichment', {
    actorId: 'profile-enrichment',
    kind: 'enrichment',
    targetCompany: intent.company,
  });

  return dedupeByIdentity([...candidates, ...enrichedCandidates]);
}

function dedupeByIdentity(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = candidate.identityKey || candidate.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    // Merge sources/evidence; keep the higher-confidence, richer record.
    const primary = candidate.confidence >= existing.confidence ? candidate : existing;
    const other = primary === candidate ? existing : candidate;
    byKey.set(key, {
      ...primary,
      company: primary.company || other.company,
      headline: primary.headline || other.headline,
      location: primary.location || other.location,
      sources: mergeByUrl(primary.sources, other.sources),
      evidence: dedupeEvidence([...(primary.evidence || []), ...(other.evidence || [])]),
    });
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence);
}

function mergeByUrl(left = [], right = []) {
  const merged = new Map();
  for (const source of [...left, ...right]) {
    const key = source.url || `${source.title}:${source.kind}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...source });
      continue;
    }
    // Field-level merge that never loses evidence: keep the longer scraped body,
    // OR the affiliation flag, and prefer any non-empty value. This is why a
    // short SERP snippet can't clobber a full enriched bio for the same URL.
    merged.set(key, {
      ...prev,
      ...source,
      context: longer(prev.context, source.context),
      snippet: prev.snippet && prev.snippet.length >= (source.snippet || '').length ? prev.snippet : source.snippet,
      affiliationVerified: Boolean(prev.affiliationVerified || source.affiliationVerified),
    });
  }
  return [...merged.values()];
}

function longer(a = '', b = '') {
  return (a || '').length >= (b || '').length ? a || b : b || a;
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((item) => {
    const key = `${item.type}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    query,
    itemCount: run.items.length,
  };
}
