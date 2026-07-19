import assert from 'node:assert/strict';
import test from 'node:test';

import {
  armenianNameScore,
  armenianSurnameScore,
  buildSearchQueries,
  hasStrongArmenianNameSignal,
  normalizeCandidates,
  parseIntent,
} from '../src/people.js';

test('AI founders parses AI as a topic and founders as the role', () => {
  const intent = parseIntent('Find Armenian AI co-founders in San Francisco');

  assert.equal(intent.role, 'founder');
  assert.deepEqual(intent.topics, ['ai']);
  assert.equal(intent.location, 'San Francisco');
  assert.match(buildSearchQueries(intent)[0], /founder ai San Francisco/);

  assert.equal(parseIntent('Armenian founders in Yerevan').role, 'founder');
  assert.equal(parseIntent('Armenian entrepreneurs in Yerevan').role, 'founder');
  assert.equal(parseIntent('Armenian AI researchers').role, '');

  for (const query of [
    'Looking for Armenian founders in SF',
    'Search for Armenian engineers in London',
    'I need people for Armenian community outreach',
  ]) {
    assert.equal(parseIntent(query).company, '', query);
  }
});

test('candidate role and location are never copied from the search intent', () => {
  const intent = parseIntent('Find Armenian AI founders in San Francisco');
  const item = {
    firstName: 'Aram',
    lastName: 'Hakobyan',
    headline: 'Board advisor and investor',
    profileUrl: 'https://www.linkedin.com/in/aram-hakobyan',
  };
  const [candidate] = normalizeCandidates(
    [item],
    parseIntent('Find Armenians'),
    'fixture',
  );

  assert.equal(candidate.role, '');
  assert.deepEqual(candidate.topics, []);
  assert.equal(candidate.location, '');

  const constrained = normalizeCandidates(
    [item],
    intent,
    'fixture',
  );
  assert.deepEqual(constrained, []);
});

test('Armenian-script names are preserved and their surname suffix is strong', () => {
  assert.equal(armenianSurnameScore('Պետրոսյան', 'Տիգրան'), 30);
  assert.equal(hasStrongArmenianNameSignal('Տիգրան Պետրոսյան'), true);

  const [candidate] = normalizeCandidates(
    [
      {
        firstName: 'Տիգրան',
        lastName: 'Պետրոսյան',
        currentPositions: [{ title: 'Հիմնադիր', companyName: 'Example' }],
        profileUrl: 'https://www.linkedin.com/in/tigran-petrosyan',
      },
    ],
    parseIntent('Find Armenian people'),
    'fixture',
  );

  assert.equal(candidate.name, 'Տիգրան Պետրոսյան');
  assert.ok(candidate.armenianScore >= 30);
});

test('a distinctive first name alone is only a weak hint', () => {
  for (const name of ['Edgar Martinez', 'Ruben Garcia', 'Sona Patel']) {
    assert.equal(hasStrongArmenianNameSignal(name), false, name);
    assert.equal(armenianNameScore(name), 12, name);
  }
});

test('obvious Persian and Chinese -ian/-yan names are not Armenian signals', () => {
  assert.equal(armenianSurnameScore('Ghasemian', 'Shahram'), 0);
  assert.equal(armenianSurnameScore('Xiaoyan', 'Alice'), 0);
  assert.equal(hasStrongArmenianNameSignal('Shahram Ghasemian'), false);
  assert.equal(hasStrongArmenianNameSignal('Alice Xiaoyan'), false);
});

test('Archouniani is a strong Armenian surname', () => {
  assert.equal(armenianSurnameScore('Archouniani', 'Armen'), 30);
  assert.equal(hasStrongArmenianNameSignal('Armen Archouniani'), true);
});

test('open searches enforce Armenian, role, topic, and location constraints', () => {
  const intent = parseIntent('Find Armenian AI founders in San Francisco');
  const good = {
    firstName: 'Armen',
    lastName: 'Archouniani',
    headline: 'AI founder',
    location: 'San Francisco Bay Area',
    profileUrl: 'https://www.linkedin.com/in/armen-archouniani',
  };
  assert.equal(normalizeCandidates([good], intent, 'fixture').length, 1);

  assert.deepEqual(
    normalizeCandidates([{ ...good, headline: 'AI engineer' }], intent, 'fixture'),
    [],
  );
  assert.deepEqual(
    normalizeCandidates([{ ...good, headline: 'Founder' }], intent, 'fixture'),
    [],
  );
  assert.deepEqual(
    normalizeCandidates([{ ...good, location: 'London' }], intent, 'fixture'),
    [],
  );
  assert.deepEqual(
    normalizeCandidates(
      [{ ...good, location: 'London', summary: 'Previously lived in San Francisco' }],
      intent,
      'fixture',
    ),
    [],
  );
  assert.deepEqual(
    normalizeCandidates(
      [{ ...good, firstName: 'Edgar', lastName: 'Martinez' }],
      intent,
      'fixture',
    ),
    [],
  );

  for (const headline of ['CEO building AI', 'Founder and GTM for AI', 'Co-Founder and Sales, AI']) {
    const [candidate] = normalizeCandidates([{ ...good, headline }], intent, 'fixture');
    assert.equal(candidate.role, 'founder', headline);
  }
  assert.deepEqual(
    normalizeCandidates(
      [{ firstName: 'Aram', lastName: 'Hakobyan', headline: 'Ex-Founder', profileUrl: good.profileUrl }],
      parseIntent('Find Armenian founders'),
      'fixture',
    ),
    [],
  );
});

test('structured current-company fields and explicit current profile headers are accepted', () => {
  const intent = parseIntent('Find Armenians at OpenAI');

  const structured = normalizeCandidates(
    [
      {
        firstName: 'Aram',
        lastName: 'Hakobyan',
        headline: 'Member of technical staff',
        currentPositions: [{ title: 'Member of technical staff', companyName: 'OpenAI' }],
        profileUrl: 'https://www.linkedin.com/in/aram-hakobyan',
      },
    ],
    intent,
    'fixture',
  );
  assert.equal(structured.length, 1);
  assert.equal(structured[0].company, 'OpenAI');

  const enrichmentSchema = normalizeCandidates(
    [
      {
        first_name: 'David',
        last_name: 'Zokhrabyan',
        full_name: 'David Zokhrabyan',
        headline: 'Growth at OpenAI | ex-Meta, ex-founder',
        company_name: 'OpenAI',
        city: 'London',
        experiences: [
          { title: 'Growth', company: 'OpenAI', starts_at: '2026' },
          { title: 'Co-Founder', company: 'Example', starts_at: '2013', ends_at: '2016' },
        ],
        url: 'https://www.linkedin.com/in/david-zokhrabyan',
      },
    ],
    intent,
    'fixture',
  );
  assert.equal(enrichmentSchema[0].name, 'David Zokhrabyan');
  assert.equal(enrichmentSchema[0].company, 'OpenAI');
  assert.equal(enrichmentSchema[0].role, '');

  const searchHeader = normalizeCandidates(
    [
      {
        searchResult: {
          title: 'Narine Petrosyan - Research engineer at OpenAI | LinkedIn',
          description: 'Narine Petrosyan is a research engineer at OpenAI.',
          url: 'https://www.linkedin.com/in/narine-petrosyan',
        },
      },
    ],
    intent,
    'fixture',
  );
  assert.equal(searchHeader.length, 1);
  assert.equal(searchHeader[0].company, 'OpenAI');

  const harvestFullSchema = normalizeCandidates(
    [
      {
        firstName: 'Vahe',
        lastName: 'Hovsepian',
        headline: 'Research Engineer',
        currentPosition: [
          {
            position: 'Research Engineer',
            companyName: 'OpenAI',
            endDate: { text: 'Present' },
          },
        ],
        linkedinUrl: 'https://www.linkedin.com/in/vahe-hovsepian',
      },
    ],
    intent,
    'fixture',
  );
  assert.equal(harvestFullSchema.length, 1);
  assert.equal(harvestFullSchema[0].company, 'OpenAI');

  const explicitCurrentExperience = normalizeCandidates(
    [
      {
        full_name: 'Aram Hakobyan',
        experiences: [{ title: 'Researcher', company: 'OpenAI', ends_at: null }],
        url: 'https://www.linkedin.com/in/aram-hakobyan-current',
      },
    ],
    intent,
    'fixture',
  );
  assert.equal(explicitCurrentExperience.length, 1);
  assert.equal(explicitCurrentExperience[0].company, 'OpenAI');
});

test('posts, generic search labels, former jobs, and acquisition news do not prove current employment', () => {
  const intent = parseIntent('Find Armenians at OpenAI');
  const rejected = [
    {
      searchResult: {
        title: 'Aram Hakobyan - Founder | LinkedIn',
        description: 'Armenian founder and investor.',
        url: 'https://www.linkedin.com/in/aram-hakobyan',
      },
      content: 'A recent post discusses OpenAI and its newest model.',
    },
    {
      searchResult: {
        title: 'Levon Grigoryan - OpenAI | LinkedIn',
        description: 'Armenian technology leader.',
        url: 'https://www.linkedin.com/in/levon-grigoryan',
      },
    },
    {
      searchResult: {
        title: 'Serine Nazaryan - Ex - OpenAI | LinkedIn',
        description: 'Founder; neptune.ai was acquired by OpenAI.',
        url: 'https://www.linkedin.com/in/serine-nazaryan',
      },
    },
    {
      searchResult: {
        title: 'Ani Martirosyan - Formerly at OpenAI | LinkedIn',
        description: 'Now building a new company.',
        url: 'https://www.linkedin.com/in/ani-martirosyan',
      },
    },
    {
      firstName: 'Mariam',
      lastName: 'Manukyan',
      headline: 'Founder | Ex - OpenAI',
      companyName: 'OpenAI',
      profileUrl: 'https://www.linkedin.com/in/mariam-manukyan',
      searchResult: { title: 'Mariam Manukyan - Ex - OpenAI | LinkedIn' },
    },
    {
      full_name: 'Aram Hakobyan',
      experiences: [{ title: 'Engineer', company: 'OpenAI' }],
      url: 'https://www.linkedin.com/in/aram-hakobyan-ambiguous-experience',
    },
    {
      fullName: 'Aram Hakobyan',
      headline: 'Founder and investor',
      companyName: 'OpenAI',
      url: 'https://www.linkedin.com/in/aram-hakobyan-generic-company-field',
    },
    ...[
      'is not at OpenAI',
      'is not currently working at OpenAI',
      'not working at OpenAI',
      'never worked at OpenAI',
      'does not work at OpenAI',
    ].map((description, index) => ({
      searchResult: {
        title: `Aram Hakobyan - ${description} | LinkedIn`,
        description: `Aram Hakobyan ${description}.`,
        url: `https://www.linkedin.com/in/aram-hakobyan-negated-${index}`,
      },
    })),
    {
      firstName: 'Aram',
      lastName: 'Hakobyan',
      headline: 'Departed from OpenAI',
      companyName: 'OpenAI',
      profileUrl: 'https://www.linkedin.com/in/aram-hakobyan-departed',
    },
  ];

  for (const item of rejected) {
    assert.deepEqual(
      normalizeCandidates([item], intent, 'fixture'),
      [],
      item.searchResult?.title || item.headline,
    );
  }
});

test('explicit identity negation and non-person titles are rejected', () => {
  const founderIntent = parseIntent('Find Armenian founders');
  for (const summary of ['I am not Armenian', 'Non-Armenian founder', 'No Armenian heritage or identity']) {
    assert.deepEqual(
      normalizeCandidates(
        [{ fullName: 'Taylor Smith', headline: 'Founder', summary, profileUrl: 'https://www.linkedin.com/in/taylor-smith' }],
        founderIntent,
        'fixture',
      ),
      [],
      summary,
    );
  }

  for (const title of ['Founder at Acme', 'Software Engineer', 'Senior Product Manager', 'Armenian Founder']) {
    const candidates = normalizeCandidates(
      [{ title, description: 'Armenian community member', url: 'https://www.linkedin.com/in/aram-hakobyan' }],
      parseIntent('Find Armenian people'),
      'fixture',
    );
    assert.equal(candidates[0]?.name, 'Aram Hakobyan', title);
  }
});

test('direct LinkedIn URL wins over related profiles and lookalikes never share IDs', () => {
  const intent = parseIntent('Find Armenian people');
  const [direct] = normalizeCandidates(
    [
      {
        fullName: 'Aram Hakobyan',
        profileUrl: 'https://www.linkedin.com/in/aram-real',
        content: 'Related profile: https://www.linkedin.com/in/levon-other',
      },
    ],
    intent,
    'fixture',
  );
  assert.equal(direct.profileUrl, 'https://www.linkedin.com/in/aram-real');

  const [lookalike] = normalizeCandidates(
    [{ fullName: 'Levon Petrosyan', profileUrl: 'https://notlinkedin.com/in/aram-real' }],
    intent,
    'fixture',
  );
  assert.equal(lookalike.profileUrl, '');
  assert.notEqual(lookalike.id, direct.id);

  const [unsafe] = normalizeCandidates(
    [{ fullName: 'Narine Hovsepian', profileUrl: 'javascript:alert(1)' }],
    intent,
    'fixture',
  );
  assert.equal(unsafe.profileUrl, '');
});
