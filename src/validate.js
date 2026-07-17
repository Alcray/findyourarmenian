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
const { armenianSurnameScore, buildSearchQueries, normalizeCandidates, parseIntent } = await import('./people.js');
const { searchPeople } = await import('./agent.js');
const { planSearchWithGemini } = await import('./geminiClient.js');

const intent = parseIntent(query);
assert.equal(intent.company, 'OpenAI');
assert.equal(intent.location, 'San Francisco');

// Surname model: curated Armenian surnames score strong; -ian/-yan words that are
// actually Western/Persian/Chinese names must not be treated as Armenian.
assert.ok(armenianSurnameScore('hakobyan', 'aram') >= 30, 'curated Armenian surname should score strong');
assert.ok(armenianSurnameScore('kardashian', 'kim') >= 20, 'diaspora -ian surname should score');
assert.ok(armenianSurnameScore('sanasaryantz', 'davit') >= 30, 'transliteration -yantz variant should score');
assert.equal(armenianSurnameScore('julian', 'brian'), 0, 'Julian is not an Armenian surname');
assert.equal(armenianSurnameScore('sebastian', 'marco'), 0, 'Sebastian is not an Armenian surname');
assert.equal(armenianSurnameScore('hosseinian', 'reza'), 0, 'Persian -ian beside a Persian first name is not Armenian');
assert.equal(armenianSurnameScore('yang', 'wei'), 0, 'Chinese name is not Armenian');

const searchQueries = buildSearchQueries(intent);
assert.ok(searchQueries.length >= 2);
assert.ok(searchQueries[0].includes('site:linkedin.com/in'));
// The winning query form is simple and unquoted — no "Armenian language" phrase stacking.
assert.ok(searchQueries.every((query) => !query.includes('"Armenian language"')));
assert.ok(searchQueries[0].includes('OpenAI') && searchQueries[0].includes('Armenian'));

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

const yanFalsePositiveCandidates = normalizeCandidates(
  [
    {
      searchResult: {
        title: 'Anna Yan - Anthropic',
        description: 'Experience: Anthropic · Location: San Francisco Bay Area.',
        url: 'https://www.linkedin.com/in/annayan20',
      },
      text: 'Anna Yan San Francisco Bay Area Anthropic New York University.',
    },
  ],
  { ...intent, company: 'Anthropic', location: '' },
  'site:linkedin.com/in Anthropic Armenian',
  { actorId: 'apify/rag-web-browser' },
);
assert.equal(yanFalsePositiveCandidates.length, 1);
assert.ok(yanFalsePositiveCandidates[0].confidence < 40);

const unverifiedCompanyActorCandidates = normalizeCandidates(
  [
    {
      fullName: 'Stefan Papp',
      headline: 'Data Professional and Strategy',
      company: 'Anthropic',
      source: 'google-serp-unverified',
      confidence: 'low',
      snippet: 'Stefan Papp - Data Professional and Strategy LinkedIn',
      profileUrl: 'https://www.linkedin.com/in/stefanpapp/',
    },
  ],
  { ...intent, company: 'Anthropic', location: '' },
  'company employees: Anthropic',
  {
    actorId: 'george.the.developer/linkedin-company-employees-scraper',
    kind: 'company-employees',
    targetCompany: 'Anthropic',
  },
);
assert.equal(unverifiedCompanyActorCandidates.length, 0);

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

const santaClaraIntent = parseIntent('find Armenian AI founders in Santa Clara');
assert.equal(santaClaraIntent.location, 'Santa Clara');
const santaClaraPlan = await planSearchWithGemini('find Armenian AI founders in Santa Clara', santaClaraIntent);
assert.equal(santaClaraPlan.plan.intent.searchType, 'location');
assert.ok(santaClaraPlan.plan.steps.some((step) => step.query.includes('Santa Clara')));
assert.ok(santaClaraPlan.plan.steps.some((step) => step.query.includes('Bay Area')));

const implicitArmenianIntent = parseIntent('find people who work at Google in Bay Area');
assert.equal(implicitArmenianIntent.wantsArmenian, true);
const implicitQueries = buildSearchQueries(implicitArmenianIntent).join(' ');
assert.ok(implicitQueries.includes('Armenian'));
// Armenian identity is always injected even when the user never typed it.
assert.ok(implicitQueries.includes('site:linkedin.com/in'));

const firstSearch = await searchPeople({ query, limit: 5 });
const secondSearch = await searchPeople({ query, limit: 5 });
assert.equal(firstSearch.cached, false);
assert.equal(secondSearch.cached, false);
assert.equal(secondSearch.queryCacheEnabled, false);
assert.ok(secondSearch.runs.some((run) => run.cached));
assert.equal(firstSearch.results.length, secondSearch.results.length);

console.log('Validation passed: parser, query builder, normalization, scoring, and cache reuse are working.');
