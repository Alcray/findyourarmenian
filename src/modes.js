import { config } from './config.js';

// Search modes are quality/cost profiles threaded through the whole pipeline.
//
//   quality — best possible results, cost is NOT a constraint: full LinkedIn
//     bios, a deep surname sweep (finds Armenians who don't self-label),
//     enrichment, more results, generous timeouts + retries, LLM planning, and
//     the strongest model. This is the default.
//   fast — cheap: short profiles, no surname sweep, tighter timeouts, no planning.
export function resolveMode(mode) {
  const isFast = mode === 'fast';
  if (isFast) {
    return {
      name: 'fast',
      planning: false,
      profileMode: config.apifyProfileSearchMode, // 'Short'
      surnameSeedCount: config.apifySurnameSeedCount,
      enrich: false, // fast = cheap preview; skip paid enrichment
      enrichMaxProfiles: config.apifyEnrichMaxProfiles,
      maxResults: config.apifyMaxResults,
      webQueryCount: 2, // self-label + one surname batch
      webMaxResults: 5, // SERP results scraped per web query
      apifyTimeoutMs: Math.min(config.apifyRequestTimeoutMs, 60000),
      apifyRetries: 0,
      geminiModel: config.geminiModel,
    };
  }
  // quality (default). Legacy 'agent' maps here too.
  return {
    name: 'quality',
    planning: true,
    profileMode: 'Full', // full LinkedIn bios → richer evidence for the judge
    surnameSeedCount: Math.max(config.apifySurnameSeedCount, 10),
    enrich: true,
    enrichMaxProfiles: Math.max(config.apifyEnrichMaxProfiles, 12),
    maxResults: Math.max(config.apifyMaxResults, 20),
    webQueryCount: 4, // self-label + all 3 surname batches — widen recall
    webMaxResults: 25, // scrape many more SERP results per web query
    apifyTimeoutMs: Math.max(config.apifyRequestTimeoutMs, 180000),
    apifyRetries: 2, // reliability over cost — retry the flaky LinkedIn scraper
    geminiModel: config.geminiModelQuality,
  };
}

export function normalizeMode(mode) {
  return mode === 'fast' ? 'fast' : 'quality';
}
