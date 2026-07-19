import { config } from './config.js';

// Search modes are quality/cost profiles threaded through the whole pipeline.
//
//   quality — full LinkedIn bios, wider discovery, enrichment,
//     generous timeouts, LLM planning, and the strongest model. An optional
//     surname sweep finds people who do not self-label, but remains cost-gated.
//   fast — cheap: short profiles, no surname sweep, tighter timeouts, no planning.
export function resolveMode(mode) {
  const isFast = mode === 'fast';
  if (isFast) {
    return {
      name: 'fast',
      planning: false,
      profileMode: config.apifyProfileSearchMode, // 'Short'
      surnameSeedCount: 0,
      enrich: false, // fast = cheap preview; skip paid enrichment
      enrichMaxProfiles: config.apifyEnrichMaxProfiles,
      maxResults: config.apifyMaxResults,
      webQueryCount: 2, // self-label + one surname batch
      webMaxResults: 5, // SERP results scraped per web query
      apifyTimeoutMs: Math.min(config.apifyRequestTimeoutMs, 60000),
      apifyRetries: 0,
      webRetries: 0,
      geminiModel: config.geminiModel,
    };
  }
  // quality (default). Legacy 'agent' maps here too.
  return {
    name: 'quality',
    planning: true,
    profileMode: 'Full', // full LinkedIn bios → richer evidence for the judge
    // Each surname is a separately billed profile-search page. Keep the sweep
    // opt-in instead of surprising every quality search with 10 paid runs.
    surnameSeedCount: config.apifySurnameSeedCount,
    // Selecting quality mode must not override the operator's paid-run switch
    // or silently expand the configured per-search enrichment cap.
    enrich: config.apifyEnrichEnabled,
    enrichMaxProfiles: config.apifyEnrichMaxProfiles,
    // APIFY_MAX_RESULTS is an operator cap/default in both modes. Quality
    // widens evidence collection, but must not silently expand result spend.
    maxResults: config.apifyMaxResults,
    webQueryCount: 4, // self-label + all 3 surname batches — widen recall
    webMaxResults: 25, // scrape many more SERP results per web query
    apifyTimeoutMs: Math.max(config.apifyRequestTimeoutMs, 180000),
    apifyRetries: 0,
    webRetries: 0,
    geminiModel: config.geminiModelQuality,
  };
}

export function normalizeMode(mode) {
  return mode === 'fast' ? 'fast' : 'quality';
}
