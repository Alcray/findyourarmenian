import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { config } from './config.js';
import { inspectApifyMcpTools } from './apifyMcpClient.js';
import { discoverCandidates } from './discovery.js';
import { planSearchWithGemini, validateCandidatesWithGemini } from './geminiClient.js';
import { parseIntent } from './people.js';
import { searchContacts, upsertContactsFromProfiles, upsertProfiles } from './store.js';

const AgentState = Annotation.Root({
  query: Annotation(),
  refresh: Annotation(),
  limit: Annotation(),
  profile: Annotation(),
  fallbackIntent: Annotation(),
  planning: Annotation(),
  intent: Annotation(),
  plan: Annotation(),
  mcp: Annotation(),
  cacheCandidates: Annotation(),
  candidates: Annotation({
    reducer: (left = [], right = []) => [...left, ...right],
    default: () => [],
  }),
  runs: Annotation({
    reducer: (left = [], right = []) => [...left, ...right],
    default: () => [],
  }),
  errors: Annotation({
    reducer: (left = [], right = []) => [...left, ...right],
    default: () => [],
  }),
  validation: Annotation(),
  profiles: Annotation(),
  contacts: Annotation(),
});

export async function runLangChainSearchAgent({ query, refresh = false, limit = config.apifyMaxResults, profile = {} }) {
  const graph = buildGraph();
  const state = await graph.invoke({ query, refresh, limit, profile });

  return {
    query: state.intent.originalQuery,
    intent: state.intent,
    searchQueries: (state.plan.steps || [])
      .map((step) => step.query || `company employees: ${step.company}`)
      .filter(Boolean),
    plan: state.plan,
    runs: state.runs || [],
    errors: state.errors || [],
    agent: {
      framework: 'langchain-langgraph',
      planning: state.planning,
      mcp: state.mcp,
      validation: state.validation,
      contactCache: {
        matched: state.cacheCandidates?.length || 0,
        saved: state.contacts?.length || 0,
      },
    },
    profiles: state.profiles || [],
  };
}

function buildGraph() {
  return new StateGraph(AgentState)
    .addNode('understand_request', understandRequest)
    .addNode('discover_mcp_tools', discoverMcpTools)
    .addNode('check_contact_cache', checkContactCache)
    .addNode('discover_candidates', discoverCandidatesNode)
    .addNode('judge_and_rank', judgeAndRank)
    .addNode('persist_contacts', persistContacts)
    .addEdge(START, 'understand_request')
    .addEdge('understand_request', 'discover_mcp_tools')
    .addEdge('discover_mcp_tools', 'check_contact_cache')
    .addEdge('check_contact_cache', 'discover_candidates')
    .addEdge('discover_candidates', 'judge_and_rank')
    .addEdge('judge_and_rank', 'persist_contacts')
    .addEdge('persist_contacts', END)
    .compile();
}

async function discoverMcpTools() {
  // MCP discovery is display-only. Keep it off the hot path unless explicitly
  // enabled, and never let it delay a search.
  if (!config.apifyMcpEnabled) {
    return { mcp: { available: false, toolCount: 0, toolNames: [], error: 'MCP discovery disabled (APIFY_MCP_ENABLED=false)' } };
  }
  try {
    const mcp = await withTimeout(inspectApifyMcpTools(), 5000, 'MCP discovery timed out');
    return {
      mcp: {
        available: mcp.available,
        toolCount: mcp.tools.length,
        toolNames: mcp.tools.map((t) => t.name).slice(0, 20),
        error: mcp.error || '',
      },
    };
  } catch (error) {
    return { mcp: { available: false, toolCount: 0, toolNames: [], error: error.message } };
  }
}

async function understandRequest(state) {
  const fallbackIntent = parseIntent(state.query);
  const planning = await planSearchWithGemini(state.query, fallbackIntent, { model: state.profile?.geminiModel });
  const intent = mergeIntent(fallbackIntent, planning.plan.intent);

  return {
    fallbackIntent,
    planning: planning.planning,
    intent,
    plan: planning.plan,
  };
}

async function checkContactCache(state) {
  const contacts = await searchContacts(state.intent);
  const cacheCandidates = contacts.slice(0, state.limit || config.apifyMaxResults).map(contactToCandidate);
  return {
    cacheCandidates,
    runs: [
      {
        actorId: 'contact-cache',
        query: 'contact cache lookup',
        cached: true,
        demo: false,
        itemCount: contacts.length,
      },
    ],
  };
}

async function discoverCandidatesNode(state) {
  // The Gemini plan informs intent + the visible trace; the actual discovery is
  // handled by the shared, cost-tuned pipeline (profile search + web + enrichment).
  const { candidates, runs, errors } = await discoverCandidates(state.intent, {
    refresh: state.refresh,
    limit: state.limit,
    profile: state.profile,
  });
  // Fold in verified contact-cache candidates so prior finds resurface.
  return { candidates: [...(state.cacheCandidates || []), ...candidates], runs, errors };
}

async function judgeAndRank(state) {
  const deduped = dedupeProfiles(state.candidates || []);
  const validation = await validateCandidatesWithGemini(state.intent, deduped, { model: state.profile?.geminiModel });
  return {
    candidates: [],
    validation: validation.agent,
    profiles: dedupeProfiles(validation.candidates).slice(0, state.limit),
  };
}

async function persistContacts(state) {
  const profiles = await upsertProfiles(state.profiles || []);
  const contacts = await upsertContactsFromProfiles(profiles, { query: state.query });
  return { profiles, contacts };
}

function contactToCandidate(contact) {
  return {
    ...contact,
    id: contact.id,
    identityKey: contact.identityKey,
    confidence: contact.confidence || Math.min(90, 45 + (contact.cacheScore || 0)),
    confidenceLabel: contact.confidenceLabel || 'possible',
    sources: [
      ...(contact.sources || []),
      {
        url: contact.profileUrl || '',
        title: contact.name,
        snippet: `Loaded from contact cache. Last matched: ${contact.lastMatchedQuery || 'unknown'}`,
        query: 'contact cache lookup',
        actorId: 'contact-cache',
        cached: true,
        kind: 'contact-cache',
      },
    ],
  };
}

function dedupeProfiles(profiles) {
  return [...new Map(profiles.map((profile) => [profile.identityKey || profile.id, profile])).values()].sort(
    (a, b) => b.confidence - a.confidence,
  );
}

function mergeIntent(base, override = {}) {
  return {
    ...base,
    ...override,
    originalQuery: base.originalQuery,
    company: normalizeValue(override.company) || normalizeValue(base.company),
    role: normalizeValue(override.role) || normalizeValue(base.role),
    location: normalizeValue(override.location) || normalizeValue(base.location),
    locationAlternates: override.locationAlternates || base.locationAlternates || [],
    wantsArmenian: override.wantsArmenian ?? base.wantsArmenian ?? true,
  };
}

function normalizeValue(value) {
  return value == null ? '' : String(value).trim();
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}
