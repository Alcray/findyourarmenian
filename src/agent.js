import { config } from './config.js';
import { searchCompanyEmployeesWithApify, searchWithApify } from './apifyClient.js';
import { validateCandidatesWithGemini } from './geminiClient.js';
import { buildSearchQueries, normalizeCandidates, parseIntent } from './people.js';
import { getSearch, hashValue, listLeads, listProfiles, saveSearch, upsertProfiles } from './store.js';

export async function searchPeople({ query, refresh = false, limit = config.apifyMaxResults }) {
  if (!query || query.trim().length < 3) {
    throw new Error('Please enter a more specific search query.');
  }

  const intent = parseIntent(query);
  const searchQueries = buildSearchQueries(intent);
  const searchKey = hashValue({ query: intent.originalQuery, limit, version: 4 });

  if (!refresh && config.apifyMode !== 'live') {
    const cachedSearch = await getSearch(searchKey);
    if (cachedSearch) {
      const profiles = await listProfiles();
      const leads = await listLeads();
      return {
        ...cachedSearch,
        cached: true,
        results: hydrateResults(cachedSearch.resultIds, profiles, leads),
      };
    }
  }

  const runs = [];
  const errors = [];
  const candidates = [];

  if (intent.company) {
    try {
      const run = await searchCompanyEmployeesWithApify(intent, { refresh, limit });
      runs.push({
        actorId: run.actorId,
        cacheKey: run.cacheKey,
        cached: run.cached,
        demo: Boolean(run.demo),
        query: `company employees: ${intent.company}`,
        itemCount: run.items.length,
      });
      candidates.push(
        ...normalizeCandidates(run.items, intent, `company employees: ${intent.company}`, {
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

  // The web/RAG path is a fallback. It is useful when there is no company target
  // or when the company-employee actor finds nobody after strict filtering.
  if (!intent.company || !candidates.length) {
    for (const sourceQuery of searchQueries) {
      try {
        const run = await searchWithApify(sourceQuery, { refresh, limit });
        runs.push({
          actorId: run.actorId,
          cacheKey: run.cacheKey,
          cached: run.cached,
          demo: Boolean(run.demo),
          query: sourceQuery,
          itemCount: run.items.length,
        });
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
    searchKey,
    query: intent.originalQuery,
    intent,
    searchQueries,
    runs,
    errors,
    agent: validation.agent,
    resultIds: uniqueProfiles.map((profile) => profile.id),
    cached: false,
  };

  await saveSearch(search);

  const leads = await listLeads();
  return {
    ...search,
    results: withLeads(uniqueProfiles, leads),
  };
}

export async function savedLeadsWithProfiles() {
  const [profiles, leads] = await Promise.all([listProfiles(), listLeads()]);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return leads
    .map((lead) => ({ ...lead, person: byId.get(lead.personId) }))
    .filter((lead) => lead.person)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function hydrateResults(resultIds, profiles, leads) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return withLeads(
    resultIds.map((id) => byId.get(id)).filter(Boolean),
    leads,
  );
}

function withLeads(profiles, leads) {
  const leadByPerson = new Map(leads.map((lead) => [lead.personId, lead]));
  return profiles.map((profile) => ({
    ...profile,
    lead: leadByPerson.get(profile.id) || null,
  }));
}
