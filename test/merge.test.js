import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateMergeKey,
  canonicalLinkedInProfileUrl,
  mergeCandidates,
  mergeCandidatesByIdentity,
  attachDurableIdentity,
  mergeStoredCandidate,
  mergeSources,
} from '../src/merge.js';

test('canonicalLinkedInProfileUrl canonicalizes genuine profile URLs', () => {
  const variants = [
    'http://linkedin.com/in/Aram-Hakobyan/',
    'https://www.linkedin.com/in/aram-hakobyan?trk=public_profile',
    'https://am.linkedin.com/in/ARAM-HAKOBYAN#experience',
    'https://m.linkedin.com/in/aram-hakobyan/',
    'https://www.linkedin.com/in/aram%2Dhakobyan',
  ];

  for (const variant of variants) {
    assert.equal(canonicalLinkedInProfileUrl(variant), 'https://www.linkedin.com/in/aram-hakobyan');
  }
});

test('canonicalLinkedInProfileUrl rejects lookalikes, unsafe schemes, and non-profile paths', () => {
  const rejected = [
    'https://notlinkedin.com/in/aram-hakobyan',
    'https://linkedin.com.evil.example/in/aram-hakobyan',
    'https://evil-linkedin.com/in/aram-hakobyan',
    'ftp://linkedin.com/in/aram-hakobyan',
    'linkedin.com/in/aram-hakobyan',
    'https://linkedin.com/company/openai',
    'https://linkedin.com/in/aram-hakobyan/posts',
  ];

  for (const value of rejected) assert.equal(canonicalLinkedInProfileUrl(value), '');
});

test('mergeSources keeps enrichment detail and accumulates provenance in either order', () => {
  const thinWeb = {
    url: 'https://am.linkedin.com/in/Aram-Hakobyan/?trk=search',
    title: 'Aram Hakobyan',
    snippet: 'Founder at Acme',
    context: 'Short result',
    kind: 'web-search',
    actorId: 'web-actor',
    query: 'Armenian founder',
    affiliationVerified: false,
    sourceConfidence: 'possible',
  };
  const richEnrichment = {
    url: 'https://www.linkedin.com/in/aram-hakobyan#about',
    title: 'Aram Hakobyan — Founder and CEO at Acme',
    snippet: 'Founder and CEO at Acme, building applied AI products in San Francisco.',
    context: 'Full profile context '.repeat(60),
    kind: 'enrichment',
    actorId: 'profile-actor',
    query: 'profile enrichment',
    affiliationVerified: true,
    sourceConfidence: 'strong',
  };

  for (const result of [mergeSources([richEnrichment], [thinWeb]), mergeSources([thinWeb], [richEnrichment])]) {
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://www.linkedin.com/in/aram-hakobyan');
    assert.equal(result[0].context, richEnrichment.context.trim());
    assert.equal(result[0].snippet, richEnrichment.snippet);
    assert.equal(result[0].kind, 'enrichment');
    assert.equal(result[0].sourceConfidence, 'strong');
    assert.equal(result[0].affiliationVerified, true);
    assert.deepEqual(new Set(result[0].actorIds), new Set(['web-actor', 'profile-actor']));
    assert.deepEqual(new Set(result[0].kinds), new Set(['web-search', 'enrichment']));
    assert.deepEqual(new Set(result[0].queries), new Set(['Armenian founder', 'profile enrichment']));
  }
});

test('mergeCandidates is monotonic when a thin web hit follows rich enrichment', () => {
  const rich = {
    id: 'person-rich',
    identityKey: 'linkedin.com/in/aram-hakobyan',
    name: 'Aram Hakobyan',
    headline: 'Founder and CEO at Acme, building applied AI infrastructure',
    company: 'Acme Artificial Intelligence',
    role: 'Founder and Chief Executive Officer',
    location: 'San Francisco Bay Area',
    profileUrl: 'https://www.linkedin.com/in/aram-hakobyan/',
    confidence: 88,
    confidenceLabel: 'strong',
    evidence: [{ type: 'name', text: 'Strong Armenian surname' }],
    sources: [{
      url: 'https://www.linkedin.com/in/aram-hakobyan/',
      context: 'Full enriched biography '.repeat(50),
      snippet: 'Founder and CEO at Acme, building applied AI infrastructure.',
      kind: 'enrichment',
      affiliationVerified: true,
    }],
  };
  const thin = {
    id: 'person-thin',
    identityKey: 'linkedin.com/in/aram-hakobyan',
    name: 'Aram Hakobyan',
    headline: 'Founder',
    company: 'Acme',
    role: 'Founder',
    location: 'SF',
    profileUrl: 'http://am.linkedin.com/in/ARAM-HAKOBYAN?trk=search',
    confidence: 45,
    confidenceLabel: 'possible',
    evidence: [{ type: 'role', text: 'Matches founder role' }],
    sources: [{
      url: 'http://am.linkedin.com/in/ARAM-HAKOBYAN?trk=search',
      context: 'Tiny',
      snippet: 'Founder',
      kind: 'web-search',
      affiliationVerified: false,
    }],
  };

  const merged = mergeCandidates(rich, thin);
  assert.equal(merged.identityKey, 'https://www.linkedin.com/in/aram-hakobyan');
  assert.equal(merged.profileUrl, 'https://www.linkedin.com/in/aram-hakobyan');
  assert.equal(merged.headline, rich.headline);
  assert.equal(merged.company, rich.company);
  assert.equal(merged.role, rich.role);
  assert.equal(merged.location, rich.location);
  assert.equal(merged.confidence, 88);
  assert.equal(merged.confidenceLabel, 'strong');
  assert.equal(merged.sources[0].context, rich.sources[0].context.trim());
  assert.equal(merged.sources[0].affiliationVerified, true);
  assert.deepEqual(new Set(merged.evidence.map((item) => item.type)), new Set(['name', 'role']));
});

test('mergeCandidatesByIdentity collapses URL variants but not lookalike domains', () => {
  const realVariants = [
    {
      id: 'a',
      name: 'Aram Hakobyan',
      profileUrl: 'https://linkedin.com/in/aram-hakobyan/',
      sources: [],
      evidence: [],
    },
    {
      id: 'b',
      name: 'Aram Hakobyan',
      profileUrl: 'https://am.linkedin.com/in/ARAM-HAKOBYAN?trk=x',
      sources: [],
      evidence: [],
    },
  ];
  const lookalike = {
    id: 'c',
    identityKey: 'linkedin.com/in/aram-hakobyan',
    name: 'Someone Else',
    profileUrl: 'https://notlinkedin.com/in/aram-hakobyan',
    sources: [],
    evidence: [],
  };

  assert.equal(candidateMergeKey(lookalike), 'someone else:');
  const merged = mergeCandidatesByIdentity([...realVariants, lookalike]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].identityKey, 'https://www.linkedin.com/in/aram-hakobyan');
  assert.equal(merged[1].profileUrl, lookalike.profileUrl);
});

test('fresh observations can correct persisted current facts without losing history', () => {
  const oldProfile = {
    id: 'person-1',
    identityKey: 'https://www.linkedin.com/in/aram-hakobyan',
    name: 'Aram Hakobyan',
    company: 'OpenAI',
    role: 'engineer',
    topics: [],
    confidence: 90,
    confidenceLabel: 'strong',
    profileUrl: 'https://www.linkedin.com/in/aram-hakobyan',
    sources: [{
      url: 'https://www.linkedin.com/in/aram-hakobyan',
      kind: 'enrichment',
      context: 'Old but very long OpenAI biography. '.repeat(50),
      targetCompany: 'OpenAI',
      affiliationVerified: true,
      affiliationCompany: 'OpenAI',
    }],
  };
  const freshProfile = {
    ...oldProfile,
    company: 'Meta',
    role: 'founder',
    topics: ['ai'],
    confidence: 60,
    confidenceLabel: 'possible',
    sources: [{
      url: 'https://www.linkedin.com/in/aram-hakobyan',
      kind: 'profile-search',
      context: 'Current profile',
      targetCompany: 'Meta',
      affiliationVerified: true,
      affiliationStructured: true,
      affiliationCompany: 'Meta',
    }],
  };

  const stored = mergeStoredCandidate(oldProfile, freshProfile);
  assert.equal(stored.company, 'Meta');
  assert.equal(stored.role, 'founder');
  assert.deepEqual(stored.topics, ['ai']);
  assert.equal(stored.confidence, 90);
  assert.deepEqual(new Set(stored.sources[0].affiliationCompanies), new Set(['OpenAI', 'Meta']));
  assert.equal(stored.sources[0].affiliationCompany, 'Meta');
  assert.equal(stored.sources[0].targetCompany, 'Meta');
  assert.equal(stored.sources[0].context, 'Current profile');
  assert.equal(stored.sources[0].kind, 'profile-search');
  assert.equal(stored.sources[0].observations.length, 2);
  assert.match(stored.sources[0].observations[0].context, /Old but very long OpenAI biography/);

  const fromCache = {
    ...oldProfile,
    sources: [...oldProfile.sources, { kind: 'contact-cache', title: 'cached' }],
  };
  const [runtimeMerged] = mergeCandidatesByIdentity([fromCache, freshProfile]);
  assert.equal(runtimeMerged.company, 'Meta');
  assert.equal(runtimeMerged.confidence, 60);
  assert.equal(runtimeMerged.sources[0].affiliationCompany, 'Meta');
  assert.equal(runtimeMerged.sources[0].context, 'Current profile');
});

test('current search snapshots keep current scores while reusing durable IDs', () => {
  const [snapshot] = attachDurableIdentity(
    [{ id: 'new-id', identityKey: 'same', confidence: 60, displayBucket: 'possible' }],
    [{ id: 'durable-id', identityKey: 'same', confidence: 90, displayBucket: 'likely', createdAt: 'old' }],
  );
  assert.equal(snapshot.id, 'durable-id');
  assert.equal(snapshot.confidence, 60);
  assert.equal(snapshot.displayBucket, 'possible');
  assert.equal(snapshot.createdAt, 'old');
});

test('thin observations do not erase durable facts or replace them with query-specific scores', () => {
  const existing = {
    id: 'person-1',
    name: 'Aram Hakobyan',
    company: 'OpenAI',
    role: 'engineer',
    location: 'San Francisco',
    topics: ['ai'],
    confidence: 90,
    confidenceLabel: 'strong',
    displayBucket: 'likely',
    sources: [{
      url: 'https://www.linkedin.com/in/aram-hakobyan',
      kind: 'profile-search',
      affiliationCompany: 'OpenAI',
      affiliationVerified: true,
      context: 'Rich current profile',
    }],
  };
  const thin = {
    ...existing,
    company: '',
    role: '',
    location: '',
    topics: [],
    confidence: 35,
    confidenceLabel: 'weak',
    displayBucket: 'possible',
    sources: [{
      url: 'https://www.linkedin.com/in/aram-hakobyan',
      kind: 'web-search',
      affiliationCompany: '',
      affiliationVerified: false,
      context: 'Thin result',
    }],
  };
  const merged = mergeStoredCandidate(existing, thin);
  assert.equal(merged.company, 'OpenAI');
  assert.equal(merged.role, 'engineer');
  assert.equal(merged.location, 'San Francisco');
  assert.deepEqual(merged.topics, ['ai']);
  assert.equal(merged.confidence, 90);
  assert.equal(merged.displayBucket, 'likely');

  const departed = mergeStoredCandidate(existing, {
    ...thin,
    sources: [{
      ...thin.sources[0],
      title: 'Aram Hakobyan — no longer at OpenAI',
      affiliationEvidence: 'No longer at OpenAI',
    }],
  });
  assert.equal(departed.company, '');
  assert.equal(departed.affiliationVerified, false);
});
