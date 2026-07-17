import { searchPeople } from './agent.js';
import { config } from './config.js';
import { hashValue } from './store.js';

const jobs = new Map();

export function startSearchJob({ query, refresh = false, limit = config.apifyMaxResults, mode = 'quality' }) {
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
  runJob(job);
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
  return jobs.delete(id);
}

async function runJob(job) {
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
    updateJob(job, { status: 'failed', error: error.message || 'Search failed' });
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  jobs.set(job.id, job);
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
