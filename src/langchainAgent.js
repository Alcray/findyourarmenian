import { tool } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { config } from './config.js';
import { inspectApifyMcpTools } from './apifyMcpClient.js';
import { searchCompanyEmployeesWithApify, searchWithApify } from './apifyClient.js';
import { planSearchWithGemini, validateCandidatesWithGemini } from './geminiClient.js';
import { buildSearchQueries, normalizeCandidates, parseIntent } from './people.js';
import { searchContacts, upsertContactsFromProfiles, upsertProfiles } from './store.js';

const AgentState = Annotation.Root({
  query: Annotation(),
  refresh: Annotation(),
  limit: Annotation(),
  fallbackIntent: Annotation(),
  planning: Annotation(),
  intent: Annotation(),
  plan: Annotation(),
  mcp: Annotation(),
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

export async function runLangChainSearchAgent({ query, refresh = false, limit = config.apifyMaxResults }) {
  const graph = buildGraph();
  const state = await graph.invoke({ query, refresh, limit });

  return {
    query: state.intent.originalQuery,
    intent: state.intent,
    searchQueries: (state.plan.steps || []).map((step) => step.query || `company employees: ${step.company}`).filter(Boolean),
    plan: state.plan,
    runs: state.runs || [],
    errors: state.errors || [],
    agent: {
      framework: 'langchain-langgraph',
      planning: state.planning,
      mcp: state.mcp,
      validation: state.validation,
      contactCache: {
        matched: state.runs?.find((run) => run.actorId === 'contact-cache')?.itemCount || 0,
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
    .addNode('execute_allowed_tools', executeAllowedTools)
    .addNode('fallback_search', fallbackSearch)
    .addNode('judge_and_rank', judgeAndRank)
    .addNode('persist_contacts', persistContacts)
    .addEdge(START, 'understand_request')
    .addEdge('understand_request', 'discover_mcp_tools')
    .addEdge('discover_mcp_tools', 'check_contact_cache')
    .addEdge('check_contact_cache', 'execute_allowed_tools')
    .addEdge('execute_allowed_tools', 'fallback_search')
    .addEdge('fallback_search', 'judge_and_rank')
    .addEdge('judge_and_rank', 'persist_contacts')
    .addEdge('persist_contacts', END)
    .compile();
}

async function discoverMcpTools() {
  const mcp = await inspectApifyMcpTools();
  return {
    mcp: {
      available: mcp.available,
      toolCount: mcp.tools.length,
      toolNames: mcp.tools.map((tool) => tool.name).slice(0, 20),
      error: mcp.error || '',
    },
  };
}

async function understandRequest(state) {
  const fallbackIntent = parseIntent(state.query);
  const planning = await planSearchWithGemini(state.query, fallbackIntent);
  const intent = mergeIntent(fallbackIntent, planning.plan.intent);

  return {
    fallbackIntent,
    planning: planning.planning,
    intent,
    plan: planning.plan,
  };
}

async function checkContactCache(state) {
  const contactCacheTool = createContactCacheTool();
  const result = await contactCacheTool.invoke({
    intent: state.intent,
    limit: state.limit,
  });

  return {
    candidates: result.candidates,
    runs: [result.run],
  };
}

async function executeAllowedTools(state) {
  const tools = createExecutableTools({
    refresh: state.refresh,
    limit: state.limit,
  });
  const candidates = [];
  const runs = [];
  const errors = [];

  for (const step of state.plan.steps || []) {
    const toolToRun = tools[step.tool];
    if (!toolToRun) {
      errors.push({ query: step.query || step.tool, message: `Tool is not allowed: ${step.tool}` });
      continue;
    }

    try {
      const result = await withTimeout(
        toolToRun.invoke({
          step,
          intent: mergeIntent(state.intent, step),
        }),
        65000,
        `Tool timed out: ${step.tool}`,
      );
      candidates.push(...result.candidates);
      runs.push(result.run);
    } catch (error) {
      errors.push({ query: step.query || step.company || step.tool, message: error.message });
    }
  }

  return { candidates, runs, errors };
}

async function fallbackSearch(state) {
  if ((state.candidates || []).length || state.errors?.length === 0) return {};

  const webTool = createExecutableTools({ refresh: state.refresh, limit: state.limit }).web_rag_search;
  const candidates = [];
  const runs = [];
  const errors = [];

  for (const query of buildSearchQueries(state.intent)) {
    try {
      const result = await withTimeout(
        webTool.invoke({
          step: {
            tool: 'web_rag_search',
            query,
            maxResults: state.limit,
          },
          intent: state.intent,
        }),
        65000,
        `Tool timed out: web_rag_search`,
      );
      candidates.push(...result.candidates);
      runs.push(result.run);
    } catch (error) {
      errors.push({ query, message: error.message });
    }
  }

  return { candidates, runs, errors };
}

async function judgeAndRank(state) {
  const validation = await validateCandidatesWithGemini(state.intent, state.candidates || []);
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

function createContactCacheTool() {
  return tool(
    async ({ intent, limit }) => {
      const contacts = await searchContacts(intent);
      // Use verified contact memory as candidates. Company-qualified searches
      // are safe only after searchContacts has filtered exact company matches.
      const canHydrateContacts = true;
      const candidates = canHydrateContacts ? contacts.slice(0, limit || config.apifyMaxResults).map(contactToCandidate) : [];
      return {
        candidates,
        run: {
          actorId: 'contact-cache',
          query: 'contact cache lookup',
          cached: true,
          demo: false,
          itemCount: contacts.length,
          usedAsCandidates: canHydrateContacts ? candidates.length : 0,
        },
      };
    },
    {
      name: 'contact_cache_lookup',
      description: 'Search durable contact/evidence cache before spending Apify credits.',
      schema: objectSchema({
        intent: { type: 'object' },
        limit: { type: 'number' },
      }),
    },
  );
}

function createExecutableTools({ refresh, limit }) {
  return {
    company_employee_search: tool(
      async ({ step, intent }) => {
        const stepIntent = mergeIntent(intent, step);
        const run = await searchCompanyEmployeesWithApify(stepIntent, {
          refresh,
          limit: step.maxResults || limit,
        });
        const runQuery = `company employees: ${stepIntent.company}`;
        return {
          candidates: normalizeCandidates(run.items, stepIntent, runQuery, {
            actorId: run.actorId,
            cached: run.cached,
            demo: run.demo,
            kind: 'company-employees',
            targetCompany: stepIntent.company,
          }),
          run: runSummary(run, runQuery),
        };
      },
      {
        name: 'company_employee_search',
        description: 'Apify LinkedIn company employees search for a specific target company.',
        schema: stepSchema(),
      },
    ),
    web_rag_search: tool(
      async ({ step, intent }) => {
        const stepIntent = mergeIntent(intent, step);
        const run = await searchWithApify(step.query, {
          refresh,
          limit: step.maxResults || limit,
        });
        return {
          candidates: normalizeCandidates(run.items, stepIntent, step.query, {
            actorId: run.actorId,
            cached: run.cached,
            demo: run.demo,
          }),
          run: runSummary(run, step.query),
        };
      },
      {
        name: 'web_rag_search',
        description: 'Apify RAG browser search for open-ended people discovery.',
        schema: stepSchema(),
      },
    ),
  };
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

function stepSchema() {
  return objectSchema({
    step: { type: 'object' },
    intent: { type: 'object' },
  });
}

function objectSchema(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: true,
  };
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
