import assert from 'node:assert/strict';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createSearchJobManager } from '../src/searchJobs.js';

const OWNER_A = 'visitor_A_1234567890abcd';
const OWNER_B = 'visitor_B_1234567890abcd';

test('jobs are isolated by anonymous owner and duplicate suppression never crosses owners', async () => {
  const manager = createSearchJobManager({
    executeSearch: async ({ query }) => ({ query, results: [] }),
    maxConcurrentJobs: 1,
  });
  const input = { query: 'Armenian founders', refresh: false, limit: 5, mode: 'fast' };

  const first = manager.start(input, { ownerId: OWNER_A });
  const duplicate = manager.start(input, { ownerId: OWNER_A });
  const otherOwner = manager.start(input, { ownerId: OWNER_B });

  assert.equal(duplicate.id, first.id);
  assert.notEqual(otherOwner.id, first.id);
  assert.equal(manager.get(first.id, { ownerId: OWNER_B }), null);
  assert.equal(manager.get(first.id, { ownerId: OWNER_A }).id, first.id);
  assert.deepEqual(manager.list({ ownerId: OWNER_A }).map((job) => job.id), [first.id]);
  assert.deepEqual(manager.list({ ownerId: OWNER_B }).map((job) => job.id), [otherOwner.id]);
  assert.equal(manager.list({ isAdmin: true }).length, 2);
  assert.equal(JSON.stringify(manager.list({ isAdmin: true })).includes('ownerId'), false);

  assert.equal(manager.remove(first.id, { ownerId: OWNER_B }), false);
  assert.equal(manager.remove(first.id, { ownerId: OWNER_A }), true);
  assert.equal(manager.get(first.id, { isAdmin: true }), null);

  await waitForImmediate();
});

test('completed public job DTOs recursively strip private lead and owner fields', async () => {
  const manager = createSearchJobManager({
    executeSearch: async () => ({
      query: 'Armenians at Example',
      mode: 'fast',
      results: [{
        id: 'person_1',
        name: 'Example Person',
        displayBucket: 'likely',
        lastMatchedQuery: 'private earlier founder search',
        tags: ['private earlier founder search'],
        lead: { status: 'contacted', notes: 'private warm introduction' },
        sources: [{
          url: 'https://www.linkedin.com/in/example-person',
          kind: 'contact-cache',
          snippet: 'Loaded from contact cache. Last matched: private earlier founder search',
          query: 'private earlier founder search',
        }],
      }],
      nested: { ownerId: 'must-not-leak', safe: true },
    }),
  });

  const started = manager.start({ query: 'Armenians at Example', mode: 'fast' }, { ownerId: OWNER_A });
  await waitForImmediate();
  const completed = manager.get(started.id, { ownerId: OWNER_A });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.results[0].name, 'Example Person');
  assert.equal('lead' in completed.result.results[0], false);
  assert.equal('lastMatchedQuery' in completed.result.results[0], false);
  assert.equal('tags' in completed.result.results[0], false);
  assert.equal('query' in completed.result.results[0].sources[0], false);
  assert.equal(completed.result.results[0].sources[0].snippet, 'Loaded from the reusable contact cache.');
  assert.equal('nested' in completed.result, false);
  assert.equal(JSON.stringify(completed).includes('private warm introduction'), false);
  assert.equal(JSON.stringify(completed).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(completed).includes('private earlier founder search'), false);
});

test('settled hook receives only an aggregate outcome', async () => {
  const payloads = [];
  const manager = createSearchJobManager({
    executeSearch: async () => ({ results: [] }),
  });

  manager.start({ query: 'No matching people', mode: 'fast' }, {
    ownerId: OWNER_A,
    onSettled: (payload) => payloads.push(payload),
  });
  await waitForImmediate();
  assert.deepEqual(payloads, [{ outcome: 'no_results' }]);
});

test('reject-only results count as no-results rather than a successful search', async () => {
  const outcomes = [];
  const manager = createSearchJobManager({
    executeSearch: async () => ({
      results: [{ id: 'person_rejected', name: 'Rejected Person', displayBucket: 'reject' }],
    }),
  });

  manager.start({ query: 'Reject-only search', mode: 'fast' }, {
    ownerId: OWNER_A,
    onSettled: ({ outcome }) => outcomes.push(outcome),
  });
  await waitForImmediate();
  assert.deepEqual(outcomes, ['no_results']);
});
