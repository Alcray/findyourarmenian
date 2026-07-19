import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('strict fixture mode fails closed on an untracked actor input', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-fixture-test-'));
  try {
    const script = `
      const { searchPeople } = await import('./src/agent.js');
      await searchPeople({ query: 'Find Armenians at OpenAI', mode: 'fast', limit: 2 });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        APIFY_MODE: 'fixture',
        APIFY_FIXTURE_FILE: path.join(repoDir, 'test', 'fixtures', 'empty-apify.json'),
        APIFY_TOKEN: '',
        DATA_DIR: dataDir,
        GEMINI_ENABLED: 'false',
        APIFY_ENRICH_ENABLED: 'false',
        APIFY_SURNAME_SEED_COUNT: '0',
        APIFY_COMPANY_EMPLOYEES_ENABLED: 'false',
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Strict fixture discovery failed.*Fixture miss/s);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('demo contacts and raw runs cannot satisfy a later live/cache-first search', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-demo-isolation-'));
  const liveProfile = {
    id: 'real-ani',
    identityKey: 'ani martirosyan:openai',
    name: 'Ani Martirosyan',
    company: 'OpenAI',
    headline: 'Real profile without a LinkedIn URL',
    sources: [{ kind: 'profile-search', demo: false }],
  };
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), `${JSON.stringify([liveProfile], null, 2)}\n`);
  const script = `
    const { searchPeople } = await import('./src/agent.js');
    await searchPeople({ query: 'Find Armenians at OpenAI', mode: 'fast', limit: 1 });
  `;
  try {
    const demo = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        APIFY_MODE: 'demo',
        APIFY_TOKEN: '',
        DATA_DIR: dataDir,
        GEMINI_ENABLED: 'false',
        APIFY_ENRICH_ENABLED: 'false',
      },
    });
    assert.equal(demo.status, 0, demo.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8')), [liveProfile]);
    assert.equal(fs.existsSync(path.join(dataDir, '.sandbox', 'demo', 'profiles.json')), true);

    const live = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        APIFY_MODE: 'cache-first',
        APIFY_TOKEN: '',
        DATA_DIR: dataDir,
        GEMINI_ENABLED: 'false',
        APIFY_ENRICH_ENABLED: 'false',
      },
    });
    assert.notEqual(live.status, 0);
    assert.match(`${live.stdout}\n${live.stderr}`, /APIFY_TOKEN is required/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('identical live actor calls share one run and malformed datasets fail closed', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-single-flight-'));
  const script = `
    let calls = 0;
    const urls = [];
    globalThis.fetch = async (url) => {
      calls += 1;
      urls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const body = calls === 1 ? [] : { error: 'not a dataset' };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { searchWithApify } = await import('./src/apifyClient.js');
    const shared = await Promise.all([
      searchWithApify('same query', { limit: 3 }),
      searchWithApify('same query', { limit: 3 }),
    ]);
    let malformed = '';
    try {
      await searchWithApify('different query', { limit: 2 });
    } catch (error) {
      malformed = error.message;
    }
    const params = new URL(urls[0]).searchParams;
    console.log(JSON.stringify({
      calls,
      shared: shared.map((run) => Boolean(run.shared)),
      malformed,
      cap: params.get('maxTotalChargeUsd'),
      maxItems: params.get('maxItems'),
      restartOnError: params.get('restartOnError'),
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        APIFY_MODE: 'live',
        APIFY_TOKEN: 'test-token-never-sent',
        APIFY_MAX_TOTAL_CHARGE_USD: '0.17',
        DATA_DIR: dataDir,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const audit = JSON.parse(result.stdout.trim());
    assert.equal(audit.calls, 2);
    assert.deepEqual(audit.shared, [false, true]);
    assert.match(audit.malformed, /malformed dataset response/);
    assert.equal(audit.cap, '0.17');
    assert.equal(audit.maxItems, '3');
    assert.equal(audit.restartOnError, 'false');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('quality mode respects the operator enrichment switch and cap', () => {
  const script = `
    const { resolveMode } = await import('./src/modes.js');
    const mode = resolveMode('quality');
    const { config } = await import('./src/config.js');
    console.log(JSON.stringify({
      enrich: mode.enrich,
      max: mode.enrichMaxProfiles,
      profileSearch: config.apifyProfileSearchEnabled,
      employees: config.apifyCompanyEmployeesEnabled,
      gemini: config.geminiEnabled,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      APIFY_ENRICH_ENABLED: 'FALSE',
      APIFY_ENRICH_MAX_PROFILES: '-1',
      APIFY_PROFILE_SEARCH_ENABLED: '0',
      APIFY_COMPANY_EMPLOYEES_ENABLED: 'no',
      GEMINI_ENABLED: 'off',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    enrich: false,
    max: 0,
    profileSearch: false,
    employees: false,
    gemini: false,
  });
});
