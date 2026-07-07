import { config } from './config.js';
import { searchPeopleFast } from './fastAgent.js';
import { runLangChainSearchAgent } from './langchainAgent.js';
import { hashValue, listLeads, listProfiles, saveSearch } from './store.js';

export async function searchPeople({ query, refresh = false, limit = config.apifyMaxResults, mode = 'fast' }) {
  if (mode !== 'agent') {
    return searchPeopleFast({ query, refresh, limit });
  }

  if (!query || query.trim().length < 3) {
    throw new Error('Please enter a more specific search query.');
  }

  const agentResult = await runLangChainSearchAgent({ query, refresh, limit });
  const uniqueProfiles = agentResult.profiles.slice(0, limit);

  const search = {
    searchKey: hashValue({ query: agentResult.query, limit, mode: 'agent', runAt: Date.now() }),
    mode: 'agent',
    query: agentResult.query,
    intent: agentResult.intent,
    searchQueries: agentResult.searchQueries,
    plan: agentResult.plan,
    runs: agentResult.runs,
    errors: agentResult.errors,
    agent: agentResult.agent,
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

export async function savedLeadsWithProfiles() {
  const [profiles, leads] = await Promise.all([listProfiles(), listLeads()]);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return leads
    .map((lead) => ({ ...lead, person: byId.get(lead.personId) }))
    .filter((lead) => lead.person)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function withLeads(profiles, leads) {
  const leadByPerson = new Map(leads.map((lead) => [lead.personId, lead]));
  return profiles.map((profile) => ({
    ...profile,
    lead: leadByPerson.get(profile.id) || null,
  }));
}
