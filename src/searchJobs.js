import { searchPeople } from './agent.js';
import { config } from './config.js';
import { hashValue } from './store.js';

const DEFAULT_MAX_RETAINED_JOBS = 100;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;

export function createSearchJobManager({
  executeSearch = searchPeople,
  maxRetainedJobs = DEFAULT_MAX_RETAINED_JOBS,
  maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
} = {}) {
  const jobs = new Map();
  const queue = [];
  let runningJobs = 0;

  function findActive({ query, refresh = false, limit = config.apifyMaxResults, mode = 'quality' }, options = {}) {
    const ownerId = assertOwnerId(options.ownerId);
    const duplicate = [...jobs.values()].find(
      (candidate) =>
        candidate.ownerId === ownerId &&
        (candidate.status === 'queued' || candidate.status === 'running') &&
        candidate.query === query &&
        candidate.refresh === refresh &&
        candidate.limit === limit &&
        candidate.mode === mode,
    );
    return duplicate ? serializeJob(duplicate) : null;
  }

  function start({ query, refresh = false, limit = config.apifyMaxResults, mode = 'quality' }, options = {}) {
    const ownerId = assertOwnerId(options.ownerId);

    // Collapse duplicate button presses only for the same anonymous browser.
    // Sharing a job across owners would expose one visitor's query and results
    // to another visitor who happened to submit an identical request.
    const duplicate = findActive({ query, refresh, limit, mode }, { ownerId });
    if (duplicate) return duplicate;

    pruneJobs();
    if (jobs.size >= maxRetainedJobs) {
      throw Object.assign(new Error('Search queue is full. Try again after an existing job finishes.'), {
        statusCode: 429,
        expose: true,
      });
    }

    const job = {
      id: `job_${hashValue({ query, refresh, limit, mode, ownerId, startedAt: Date.now(), random: Math.random() })}`,
      ownerId,
      query,
      refresh,
      limit,
      mode,
      status: 'queued',
      result: null,
      error: '',
      onSettled: typeof options.onSettled === 'function' ? options.onSettled : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    jobs.set(job.id, job);
    queue.push(job);
    drainQueue();
    return serializeJob(job);
  }

  function get(id, options = {}) {
    const job = jobs.get(id);
    if (!job || !canAccess(job, options)) return null;
    return serializeJob(job);
  }

  function list(options = {}) {
    return [...jobs.values()]
      .filter((job) => canAccess(job, options))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 25)
      .map(serializeJob);
  }

  function remove(id, options = {}) {
    const job = jobs.get(id);
    if (!job || !canAccess(job, options)) return false;
    const index = queue.findIndex((candidate) => candidate.id === id);
    if (index !== -1) queue.splice(index, 1);
    job.dismissed = true;
    return jobs.delete(id);
  }

  async function runJob(job) {
    runningJobs += 1;
    updateJob(job, { status: 'running' });
    try {
      const result = await executeSearch({
        query: job.query,
        refresh: job.refresh,
        limit: job.limit,
        mode: job.mode,
      });
      // Search persistence is shared infrastructure, but private owner lead
      // status/notes must never be returned through an anonymous job endpoint.
      updateJob(job, { status: 'completed', result: publicSearchResult(result) });
    } catch (error) {
      console.error(`Search job ${job.id} failed:`, error);
      updateJob(job, { status: 'failed', error: publicJobError(error) });
    } finally {
      runningJobs -= 1;
      notifySettled(job);
      drainQueue();
    }
  }

  function drainQueue() {
    while (runningJobs < maxConcurrentJobs && queue.length) {
      const job = queue.shift();
      if (!jobs.has(job.id)) continue;
      void runJob(job);
    }
  }

  function pruneJobs() {
    if (jobs.size < maxRetainedJobs) return;
    const removable = [...jobs.values()]
      .filter((job) => job.status === 'completed' || job.status === 'failed')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    while (jobs.size >= maxRetainedJobs && removable.length) {
      jobs.delete(removable.shift().id);
    }
  }

  return Object.freeze({ findActive, start, get, list, remove });
}

const defaultManager = createSearchJobManager();

export function findActiveSearchJob(input, options) {
  return defaultManager.findActive(input, options);
}

export function startSearchJob(input, options) {
  return defaultManager.start(input, options);
}

export function getSearchJob(id, options) {
  return defaultManager.get(id, options);
}

export function listSearchJobs(options) {
  return defaultManager.list(options);
}

export function deleteSearchJob(id, options) {
  return defaultManager.remove(id, options);
}

function canAccess(job, { ownerId, isAdmin = false } = {}) {
  return Boolean(isAdmin || (ownerId && job.ownerId === ownerId));
}

function assertOwnerId(value) {
  const ownerId = String(value || '');
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(ownerId)) {
    throw Object.assign(new Error('A valid anonymous visitor is required to start a search.'), {
      statusCode: 400,
      expose: true,
    });
  }
  return ownerId;
}

function publicSearchResult(result) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    query: publicString(value.query),
    mode: publicString(value.mode),
    intent: publicIntent(value.intent),
    plan: publicPlan(value.plan),
    runs: publicArray(value.runs).map(publicRun),
    errors: publicArray(value.errors).map((error) => ({
      query: publicString(error?.query),
      message: 'A discovery source failed.',
    })),
    agent: publicAgent(value.agent),
    cached: Boolean(value.cached),
    results: publicArray(value.results).map(publicPerson),
  };
}

function publicIntent(intent) {
  return {
    searchType: publicString(intent?.searchType),
    company: publicString(intent?.company),
    role: publicString(intent?.role),
    topics: publicStrings(intent?.topics),
    location: publicString(intent?.location),
    locationAlternates: publicStrings(intent?.locationAlternates),
    wantsArmenian: intent?.wantsArmenian !== false,
  };
}

function publicPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    intent: publicIntent(plan.intent),
    steps: publicArray(plan.steps).map((step) => ({
      tool: publicString(step?.tool),
      reason: publicString(step?.reason),
      query: publicString(step?.query),
      company: publicString(step?.company),
    })),
  };
}

function publicRun(run) {
  return {
    actorId: publicString(run?.actorId),
    query: publicString(run?.query),
    itemCount: publicCount(run?.itemCount),
    cached: Boolean(run?.cached),
    demo: Boolean(run?.demo),
    fixture: Boolean(run?.fixture),
    shared: Boolean(run?.shared),
  };
}

function publicAgent(agent) {
  return {
    framework: publicString(agent?.framework),
    planning: {
      geminiUsed: Boolean(agent?.planning?.geminiUsed),
      model: publicString(agent?.planning?.model),
      stepCount: publicCount(agent?.planning?.stepCount),
    },
    validation: {
      geminiUsed: Boolean(agent?.validation?.geminiUsed),
      model: publicString(agent?.validation?.model),
      judgedCandidates: publicCount(agent?.validation?.judgedCandidates),
    },
    mcp: {
      available: Boolean(agent?.mcp?.available),
      toolCount: publicCount(agent?.mcp?.toolCount),
      toolNames: publicStrings(agent?.mcp?.toolNames).slice(0, 50),
    },
    contactCache: {
      matched: publicCount(agent?.contactCache?.matched),
      saved: publicCount(agent?.contactCache?.saved),
    },
  };
}

function publicPerson(person) {
  return {
    id: publicString(person?.id),
    name: publicString(person?.name),
    headline: publicString(person?.headline),
    company: publicString(person?.company),
    role: publicString(person?.role),
    location: publicString(person?.location),
    topics: publicStrings(person?.topics),
    profileUrl: publicString(person?.profileUrl),
    confidence: publicCount(person?.confidence),
    confidenceLabel: publicString(person?.confidenceLabel),
    armenianScore: Number.isFinite(Number(person?.armenianScore)) ? Number(person.armenianScore) : 0,
    displayBucket: publicString(person?.displayBucket),
    needsVerification: Boolean(person?.needsVerification),
    affiliationVerified: Boolean(person?.affiliationVerified),
    concerns: publicStrings(person?.concerns),
    evidence: publicArray(person?.evidence).slice(0, 20).map((item) => ({
      type: publicString(typeof item === 'string' ? 'source' : item?.type),
      text: publicString(typeof item === 'string' ? item : item?.text),
    })),
    sources: publicArray(person?.sources).slice(0, 20).map(publicSource),
    outreachAngle: publicString(person?.outreachAngle),
    geminiJudgment: {
      armenianConfidence: publicString(person?.geminiJudgment?.armenianConfidence),
    },
  };
}

function publicSource(source) {
  return {
    url: publicString(source?.url),
    title: publicString(source?.title),
    snippet: source?.kind === 'contact-cache'
      ? 'Loaded from the reusable contact cache.'
      : publicString(source?.snippet),
    kind: publicString(source?.kind),
    cached: Boolean(source?.cached),
    demo: Boolean(source?.demo),
    fixture: Boolean(source?.fixture),
    shared: Boolean(source?.shared),
    observedAt: publicString(source?.observedAt),
  };
}

function publicStrings(value) {
  return publicArray(value).map(publicString).filter(Boolean).slice(0, 100);
}

function publicArray(value) {
  return Array.isArray(value) ? value : [];
}

function publicString(value) {
  return typeof value === 'string' ? value.slice(0, 10_000) : '';
}

function publicCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function notifySettled(job) {
  const callback = job.onSettled;
  job.onSettled = null;
  if (!callback) return;
  const outcome = job.status === 'completed'
    ? (job.result?.results?.some((person) => person.displayBucket !== 'reject') ? 'success' : 'no_results')
    : 'failed';
  Promise.resolve(callback({ outcome })).catch((error) => {
    console.error(`Search job ${job.id} analytics hook failed:`, error);
  });
}

function publicJobError(error) {
  const message = String(error?.message || '');
  const safePrefix = /^(?:APIFY_TOKEN is required|No candidates returned|Please enter a more specific search query|Unsupported APIFY_MODE|Strict fixture discovery failed|Could not resolve a LinkedIn company URL)/;
  return safePrefix.test(message) ? message.slice(0, 500) : 'Search failed. Check the server logs for details.';
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function serializeJob(job) {
  return {
    id: job.id,
    query: job.query,
    refresh: job.refresh,
    limit: job.limit,
    mode: job.mode,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
  };
}
