import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('contact evidence stays company-specific and persisted duplicate IDs remain valid', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-store-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  process.env.DATA_DIR = dataDir;

  const legacyCurrent = {
    id: 'contact_legacy',
    name: 'Aram Hakobyan',
    company: 'OpenAI',
    profileUrl: 'https://www.linkedin.com/in/aram-hakobyan',
    lastObservedAt: '2026-01-01T00:00:00.000Z',
    sources: [{ title: 'Aram Hakobyan works at OpenAI', affiliationVerified: true }],
  };
  const staleCues = [
    'formerly at OpenAI',
    'no longer at OpenAI',
    'not currently working at OpenAI',
    'left OpenAI',
    'departed from OpenAI',
  ].map((title, index) => ({
    id: `contact_stale_${index}`,
    name: `Ani Petrosyan ${index}`,
    company: 'OpenAI',
    profileUrl: `https://www.linkedin.com/in/ani-petrosyan-${index}`,
    sources: [{
      title: `Ani Petrosyan ${title}`,
      affiliationVerified: true,
      affiliationCompany: 'OpenAI',
    }],
  }));
  const wrongAffiliation = {
    id: 'contact_wrong_company',
    name: 'Narek Sargsyan',
    company: 'OpenAI',
    profileUrl: 'https://www.linkedin.com/in/narek-sargsyan',
    sources: [{
      title: 'Narek Sargsyan at OpenAI',
      affiliationVerified: true,
      affiliationCompany: 'Meta',
    }],
  };
  fs.writeFileSync(
    path.join(dataDir, 'contacts.json'),
    `${JSON.stringify([legacyCurrent, ...staleCues, wrongAffiliation], null, 2)}\n`,
  );

  const duplicateProfiles = [
    {
      id: 'person_old_a',
      name: 'Mariam Vardanyan',
      company: 'OpenAI',
      profileUrl: 'https://linkedin.com/in/mariam-vardanyan/',
      sources: [{
        url: 'https://linkedin.com/in/mariam-vardanyan/',
        kind: 'profile-search',
        affiliationVerified: true,
        affiliationCompany: 'OpenAI',
      }],
    },
    {
      id: 'person_old_b',
      name: 'Mariam Vardanyan',
      company: 'OpenAI',
      profileUrl: 'https://am.linkedin.com/in/MARIAM-VARDANYAN?trk=old',
      sources: [{
        url: 'https://am.linkedin.com/in/MARIAM-VARDANYAN?trk=old',
        kind: 'web-search',
        affiliationVerified: true,
        affiliationCompany: 'OpenAI',
      }],
    },
  ];
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), `${JSON.stringify(duplicateProfiles, null, 2)}\n`);

  const {
    listContacts,
    listProfiles,
    listSearches,
    saveRawRun,
    saveSearch,
    searchContacts,
    upsertContactsFromProfiles,
    upsertProfiles,
  } = await import('../src/store.js');
  const matches = await searchContacts({
    company: 'OpenAI',
    role: '',
    location: '',
    locationAlternates: [],
    originalQuery: 'Find Armenians at OpenAI',
  });
  assert.deepEqual(matches.map((contact) => contact.id), ['contact_legacy']);

  await upsertContactsFromProfiles([{
    ...legacyCurrent,
    sources: [
      ...legacyCurrent.sources,
      { kind: 'contact-cache', title: 'Loaded from contact cache' },
    ],
  }], { query: 'Find Armenians at OpenAI' });
  const reread = (await listContacts()).find((contact) => contact.id === 'contact_legacy');
  assert.equal(reread.lastObservedAt, '2026-01-01T00:00:00.000Z');

  await upsertProfiles([{
    id: 'person_new',
    name: 'Mariam Vardanyan',
    company: 'Meta',
    role: 'engineer',
    profileUrl: 'https://www.linkedin.com/in/mariam-vardanyan',
    confidence: 65,
    sources: [{
      url: 'https://www.linkedin.com/in/mariam-vardanyan',
      kind: 'profile-search',
      affiliationVerified: true,
      affiliationCompany: 'Meta',
      context: 'Current structured profile',
    }],
  }]);

  const persisted = await listProfiles();
  assert.deepEqual(new Set(persisted.map((profile) => profile.id)), new Set(['person_old_a', 'person_old_b']));
  assert.deepEqual(new Set(persisted.map((profile) => profile.company)), new Set(['Meta']));
  for (const profile of persisted) {
    assert.deepEqual(new Set(profile.sources[0].affiliationCompanies), new Set(['OpenAI', 'Meta']));
  }
  assert.equal(fs.statSync(path.join(dataDir, 'profiles.json')).mode & 0o777, 0o600);

  const { config } = await import('../src/config.js');
  const previousHistoryLimit = config.searchHistoryMaxEntries;
  const previousRawRunLimit = config.rawRunCacheMaxFiles;
  try {
    config.searchHistoryMaxEntries = 2;
    await saveSearch({ searchKey: 'search_1', query: 'first' });
    await saveSearch({ searchKey: 'search_2', query: 'second' });
    await saveSearch({ searchKey: 'search_3', query: 'third' });
    assert.deepEqual((await listSearches()).map((search) => search.searchKey), ['search_3', 'search_2']);

    config.rawRunCacheMaxFiles = 2;
    await saveRawRun('run_1', { items: [{ id: 1 }] });
    await saveRawRun('run_2', { items: [{ id: 2 }] });
    await saveRawRun('run_3', { items: [{ id: 3 }] });
    const rawRunFiles = fs.readdirSync(path.join(dataDir, 'raw-runs')).filter((file) => file.endsWith('.json'));
    assert.equal(rawRunFiles.length, 2);
  } finally {
    config.searchHistoryMaxEntries = previousHistoryLimit;
    config.rawRunCacheMaxFiles = previousRawRunLimit;
  }
});
