import assert from 'node:assert/strict';
import test from 'node:test';

import { contactToCandidate, isFreshTrustedContact, shouldPersistAsContact } from '../src/candidatePolicy.js';
import { parseIntent } from '../src/people.js';

const now = Date.parse('2026-07-19T12:00:00.000Z');

test('fresh trusted contacts can satisfy an identical search without paid discovery', () => {
  const intent = parseIntent('Armenian AI founders in San Francisco');
  const contact = {
    name: 'Aram Hakobyan',
    role: 'founder',
    topics: ['ai'],
    location: 'Bay Area',
    armenianScore: 30,
    updatedAt: '2026-07-18T12:00:00.000Z',
    sources: [{ kind: 'profile-search', demo: false, fixture: false }],
  };

  assert.equal(isFreshTrustedContact(contact, intent, now), true);
  assert.equal(
    isFreshTrustedContact({ ...contact, sources: [{ kind: 'web-search', demo: true }] }, intent, now),
    false,
  );
  assert.equal(isFreshTrustedContact({ ...contact, role: 'engineer' }, intent, now), false);
  assert.equal(isFreshTrustedContact({ ...contact, updatedAt: '2026-01-01T00:00:00.000Z' }, intent, now), false);
});

test('weak identity guesses are surfaced as possible but not auto-persisted as contacts', () => {
  assert.equal(shouldPersistAsContact({ name: 'Edgar Martinez', armenianScore: 12 }), false);
  assert.equal(
    shouldPersistAsContact({
      name: 'Leah Belsky',
      armenianScore: 0,
      evidence: [{ type: 'concern', text: 'Gemini: No Armenian identity signals were found' }],
    }),
    false,
  );
  assert.equal(shouldPersistAsContact({ name: 'Aram Hakobyan', armenianScore: 30 }), true);
  assert.equal(
    shouldPersistAsContact({
      name: 'Taylor Smith',
      armenianScore: 0,
      geminiJudgment: { armenianConfidence: 'medium' },
    }),
    true,
  );
});

test('reusable contact candidates do not carry a previous user query or query-specific judgment', () => {
  const candidate = contactToCandidate({
    id: 'contact_1',
    name: 'Aram Hakobyan',
    profileUrl: 'https://www.linkedin.com/in/aram-hakobyan',
    lastMatchedQuery: 'private earlier founder search',
    tags: ['OpenAI', 'private earlier founder search'],
    outreachAngle: 'Mention the private earlier founder search',
    geminiJudgment: { armenianConfidence: 'medium', rationale: 'Old query-specific judgment' },
    sources: [{
      kind: 'contact-cache',
      snippet: 'Loaded from contact cache. Last matched: private earlier founder search',
      query: 'private earlier founder search',
    }],
  });

  assert.equal('lastMatchedQuery' in candidate, false);
  assert.equal('tags' in candidate, false);
  assert.equal('outreachAngle' in candidate, false);
  assert.equal('geminiJudgment' in candidate, false);
  assert.equal(candidate.sources[0].snippet, 'Loaded from the reusable contact cache.');
  assert.equal(candidate.sources[0].query, 'contact cache lookup');
  assert.equal(JSON.stringify(candidate).includes('private earlier founder search'), false);
});
