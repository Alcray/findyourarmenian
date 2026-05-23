import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const query = 'Find Armenians who work at OpenAI in San Francisco';
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'find-your-armenian-validate-'));
process.env.APIFY_MODE = 'demo';
process.env.DATA_DIR = tempDir;
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_CLOUD_API_KEY = '';
process.env.GEMINI_ENABLED = 'false';

const { demoItemsForQuery } = await import('./demoData.js');
const { buildSearchQueries, normalizeCandidates, parseIntent } = await import('./people.js');
const { searchPeople } = await import('./agent.js');

const intent = parseIntent(query);
assert.equal(intent.company, 'OpenAI');
assert.equal(intent.location, 'San Francisco');

const searchQueries = buildSearchQueries(intent);
assert.ok(searchQueries.length >= 2);
assert.ok(searchQueries[0].includes('site:linkedin.com/in'));

const candidates = normalizeCandidates(demoItemsForQuery(query), intent, searchQueries[0], {
  actorId: 'demo',
});
assert.ok(candidates.length >= 2);
assert.ok(candidates[0].confidence > 40);
assert.ok(candidates[0].evidence.length >= 2);

const falseOpenAiCandidates = normalizeCandidates(
  [
    {
      searchResult: {
        title: 'Samson Avetian - eqwefy',
        description:
          'Armenian founded startups across all layers, except the Foundation Layer (OpenAI, Anthropic, Google, Mistral).',
        url: 'https://am.linkedin.com/in/samson-avetian-126983190',
      },
      text: 'Samson Avetian eqwefy. Agree & Join LinkedIn.',
    },
  ],
  intent,
  searchQueries[0],
  { actorId: 'regression' },
);
assert.equal(falseOpenAiCandidates.length, 0);

const employeeActorCandidates = normalizeCandidates(
  [
    {
      name: 'David Zokhrabyan',
      jobTitle: 'Product & growth leader',
      companyName: 'OpenAI',
      location: 'San Francisco Bay Area',
      profileUrl: 'https://www.linkedin.com/in/davidzokhrabyan',
    },
  ],
  intent,
  'company employees: OpenAI',
  {
    actorId: 'george.the.developer/linkedin-company-employees-scraper',
    kind: 'company-employees',
    targetCompany: 'OpenAI',
  },
);
assert.equal(employeeActorCandidates.length, 1);
assert.equal(employeeActorCandidates[0].company, 'OpenAI');

const firstSearch = await searchPeople({ query, limit: 5 });
const secondSearch = await searchPeople({ query, limit: 5 });
assert.equal(firstSearch.cached, false);
assert.equal(secondSearch.cached, true);
assert.equal(firstSearch.results.length, secondSearch.results.length);

console.log('Validation passed: parser, query builder, normalization, scoring, and cache reuse are working.');
