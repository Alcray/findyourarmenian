import { config } from './config.js';
import { discoverCandidates } from './discovery.js';
import { validateCandidatesWithGemini } from './geminiClient.js';
import { buildSearchQueries, parseIntent } from './people.js';
import { hashValue, listLeads, saveSearch, upsertContactsFromProfiles, upsertProfiles } from './store.js';

export async function searchPeopleFast({ query, refresh = false, limit = config.apifyMaxResults, profile = {} }) {
  if (!query || query.trim().length < 3) {
    throw new Error('Please enter a more specific search query.');
  }

  const intent = parseIntent(query);
  const searchQueries = buildSearchQueries(intent);

  const { candidates, runs, errors } = await discoverCandidates(intent, { refresh, limit, profile });

  if (!candidates.length && errors.length) {
    throw new Error(`No candidates returned. Last Apify error: ${errors.at(-1).message}`);
  }

  const validation = await validateCandidatesWithGemini(intent, candidates, { model: profile.geminiModel });
  const savedProfiles = await upsertProfiles(validation.candidates);
  const uniqueProfiles = [...new Map(savedProfiles.map((profile) => [profile.id, profile])).values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  // Every person we surface joins the durable "ultimate list" of found Armenians,
  // just like the agent path does — so the contact DB grows with every search.
  await upsertContactsFromProfiles(uniqueProfiles, { query: intent.originalQuery });

  const search = {
    searchKey: hashValue({ query: intent.originalQuery, limit, mode: profile.name || 'fast', runAt: Date.now() }),
    mode: profile.name || 'fast',
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
