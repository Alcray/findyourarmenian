import { searchPeople } from './agent.js';
import { config } from './config.js';
import { hashValue } from './store.js';

const jobs = new Map();
const queue = [];
const MAX_RETAINED_JOBS = 100;
const MAX_CONCURRENT_JOBS = 2;
let runningJobs = 0;

export function startSearchJob({ query, refresh = false, limit = config.apifyMaxResults, mode = 'quality' }) {
  // Collapse duplicate button presses while an equivalent search is already in
  // flight. Besides improving UX, this prevents accidental duplicate actor spend.
  const duplicate = [...jobs.values()].find(
    (candidate) =>
      (candidate.status === 'queued' || candidate.status === 'running') &&
      candidate.query === query &&
      candidate.refresh === refresh &&
      candidate.limit === limit &&
      candidate.mode === mode,
  );
  if (duplicate) return serializeJob(duplicate);

  pruneJobs();
  if (jobs.size >= MAX_RETAINED_JOBS) {
    throw Object.assign(new Error('Search queue is full. Try again after an existing job finishes.'), {
      statusCode: 429,
      expose: true,
    });
  }

  const job = {
    id: `job_${hashValue({ query, refresh, limit, mode, startedAt: Date.now(), random: Math.random() })}`,
    query,
    refresh,
    limit,
    mode,
    status: 'queued',
    result: null,
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  jobs.set(job.id, job);
  queue.push(job);
  drainQueue();
  return serializeJob(job);
}

export function getSearchJob(id) {
  const job = jobs.get(id);
  return job ? serializeJob(job) : null;
}

export function listSearchJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 25)
    .map(serializeJob);
}

export function deleteSearchJob(id) {
  const index = queue.findIndex((job) => job.id === id);
  if (index !== -1) queue.splice(index, 1);
  const job = jobs.get(id);
  if (job) job.dismissed = true;
  return jobs.delete(id);
}

async function runJob(job) {
  runningJobs += 1;
  updateJob(job, { status: 'running' });
  try {
    const result = await searchPeople({
      query: job.query,
      refresh: job.refresh,
      limit: job.limit,
      mode: job.mode,
    });
    updateJob(job, { status: 'completed', result });
  } catch (error) {
    console.error(`Search job ${job.id} failed:`, error);
    updateJob(job, { status: 'failed', error: publicJobError(error) });
  } finally {
    runningJobs -= 1;
    drainQueue();
  }
}

function publicJobError(error) {
  const message = String(error?.message || '');
  const safePrefix = /^(?:APIFY_TOKEN is required|No candidates returned|Please enter a more specific search query|Unsupported APIFY_MODE|Strict fixture discovery failed|Could not resolve a LinkedIn company URL)/;
  return safePrefix.test(message) ? message.slice(0, 500) : 'Search failed. Check the server logs for details.';
}

function drainQueue() {
  while (runningJobs < MAX_CONCURRENT_JOBS && queue.length) {
    const job = queue.shift();
    if (!jobs.has(job.id)) continue;
    void runJob(job);
  }
}

function pruneJobs() {
  if (jobs.size < MAX_RETAINED_JOBS) return;
  const removable = [...jobs.values()]
    .filter((job) => job.status === 'completed' || job.status === 'failed')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (jobs.size >= MAX_RETAINED_JOBS && removable.length) {
    jobs.delete(removable.shift().id);
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  if (!job.dismissed) jobs.set(job.id, job);
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
