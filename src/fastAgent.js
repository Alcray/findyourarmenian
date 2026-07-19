import { config } from './config.js';
import { contactToCandidate, isFreshTrustedContact, shouldPersistAsContact } from './candidatePolicy.js';
import { discoverCandidates } from './discovery.js';
import { validateCandidatesWithGemini } from './geminiClient.js';
import { attachDurableIdentity, mergeCandidatesByIdentity } from './merge.js';
import { buildSearchQueries, parseIntent } from './people.js';
import {
  hashValue,
  listLeads,
  saveSearch,
  searchContacts,
  upsertContactsFromProfiles,
  upsertProfiles,
} from './store.js';

export async function searchPeopleFast({ query, refresh = false, limit = config.apifyMaxResults, profile = {} }) {
  if (!query || query.trim().length < 3) {
    throw new Error('Please enter a more specific search query.');
  }

  const intent = parseIntent(query);
  const searchQueries = buildSearchQueries(intent);

  const bypassContactCache = refresh || config.apifyMode === 'live';
  const cachedContacts = bypassContactCache
    ? []
    : (await searchContacts(intent)).filter((contact) => isFreshTrustedContact(contact, intent));
  const cacheCandidates = mergeCandidatesByIdentity(cachedContacts.map(contactToCandidate)).slice(0, limit);
  const cacheRun = {
    actorId: 'contact-cache',
    query: 'contact cache lookup',
    cached: true,
    demo: false,
    itemCount: cacheCandidates.length,
  };

  let candidates = cacheCandidates;
  let runs = [cacheRun];
  let errors = [];
  if (bypassContactCache || cacheCandidates.length < limit) {
    const discovery = await discoverCandidates(intent, { refresh, limit, profile });
    candidates = mergeCandidatesByIdentity([...cacheCandidates, ...discovery.candidates]);
    runs = [cacheRun, ...discovery.runs];
    errors = discovery.errors;
  }

  if (!candidates.length && errors.length) {
    throw new Error(`No candidates returned. Last Apify error: ${errors.at(-1).message}`);
  }

  const validation = await validateCandidatesWithGemini(intent, candidates, { model: profile.geminiModel });
  const savedProfiles = await upsertProfiles(validation.candidates);
  const currentProfiles = attachDurableIdentity(validation.candidates, savedProfiles);
  const uniqueProfiles = mergeCandidatesByIdentity(currentProfiles)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  // Keep uncertain identity guesses reviewable in profiles/search history, but
  // only add trusted Armenian matches to the reusable contact database.
  await upsertContactsFromProfiles(uniqueProfiles.filter(shouldPersistAsContact), { query: intent.originalQuery });

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
    resultSnapshots: uniqueProfiles,
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
