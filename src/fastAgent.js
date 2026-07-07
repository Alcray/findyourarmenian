import { config } from './config.js';
import { searchCompanyEmployeesWithApify, searchWithApify } from './apifyClient.js';
import { validateCandidatesWithGemini } from './geminiClient.js';
import { buildSearchQueries, normalizeCandidates, parseIntent } from './people.js';
import { hashValue, listLeads, saveSearch, upsertProfiles } from './store.js';

export async function searchPeopleFast({ query, refresh = false, limit = config.apifyMaxResults }) {
  if (!query || query.trim().length < 3) {
    throw new Error('Please enter a more specific search query.');
  }

  const intent = parseIntent(query);
  const searchQueries = buildSearchQueries(intent);

  const runs = [];
  const errors = [];
  const candidates = [];

  if (intent.company) {
    try {
      const run = await searchCompanyEmployeesWithApify(intent, { refresh, limit });
      const runQuery = `company employees: ${intent.company}`;
      runs.push(runSummary(run, runQuery));
      candidates.push(
        ...normalizeCandidates(run.items, intent, runQuery, {
          actorId: run.actorId,
          cached: run.cached,
          demo: run.demo,
          kind: 'company-employees',
          targetCompany: intent.company,
        }),
      );
    } catch (error) {
      errors.push({ query: `company employees: ${intent.company}`, message: error.message });
    }
  }

  if (!intent.company || !candidates.length) {
    for (const sourceQuery of searchQueries) {
      try {
        const run = await searchWithApify(sourceQuery, { refresh, limit });
        runs.push(runSummary(run, sourceQuery));
        candidates.push(
          ...normalizeCandidates(run.items, intent, sourceQuery, {
            actorId: run.actorId,
            cached: run.cached,
            demo: run.demo,
          }),
        );
      } catch (error) {
        errors.push({ query: sourceQuery, message: error.message });
      }
    }
  }

  if (!candidates.length && errors.length) {
    throw new Error(`No candidates returned. Last Apify error: ${errors.at(-1).message}`);
  }

  const validation = await validateCandidatesWithGemini(intent, candidates);
  const savedProfiles = await upsertProfiles(validation.candidates);
  const uniqueProfiles = [...new Map(savedProfiles.map((profile) => [profile.id, profile])).values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  const search = {
    searchKey: hashValue({ query: intent.originalQuery, limit, mode: 'fast', runAt: Date.now() }),
    mode: 'fast',
    query: intent.originalQuery,
    intent,
    searchQueries,
    runs,
    errors,
    agent: {
      framework: 'fast-pipeline',
      validation: validation.agent,
    },
    resultIds: uniqueProfiles.map((profile) => profile.id),
    cached: false,
    queryCacheEnabled: false,
  };

  await saveSearch(search);

  const leads = await listLeads();
  return {
    ...search,
    results: withLeads(uniqueProfiles, leads),
  };
}

function withLeads(profiles, leads) {
  const leadByPerson = new Map(leads.map((lead) => [lead.personId, lead]));
  return profiles.map((profile) => ({
    ...profile,
    lead: leadByPerson.get(profile.id) || null,
  }));
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
