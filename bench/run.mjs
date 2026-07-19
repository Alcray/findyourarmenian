#!/usr/bin/env node
// Metrics harness for the Find Your Armenian pipeline.
//
//   node bench/run.mjs             # run all metrics, compare to baseline
//   node bench/run.mjs --save      # run, then save the result as the new baseline
//   node bench/run.mjs --live      # explicit live diagnostic (never used by CI)
//   node bench/run.mjs --gate      # exit 1 if composite score dropped vs baseline (for CI)
//
// Two layers:
//   1. Detector — labeled name set (bench/labels-names.json) scored by the name
//      model. Deterministic, free, no network. This is the regression gate.
//   2. Pipeline — golden queries run against a tracked immutable fixture catalog.
//      Fixture misses fail closed: no disk cache, demo fallback, or network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const SAVE = args.has('--save');
const GATE = args.has('--gate');
if (args.has('--capture')) throw new Error('--capture was removed. Use --live for an intentional paid diagnostic.');
const LIVE = args.has('--live');
if (LIVE && SAVE) throw new Error('Refusing to save a nondeterministic live run as the offline benchmark baseline.');
if (LIVE && GATE) throw new Error('A live diagnostic cannot be used as the deterministic regression gate.');
const fixturePath = path.join(benchDir, 'fixtures', 'apify.json');
const fixtureHash = fs.existsSync(fixturePath)
  ? crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex')
  : '';
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-your-armenian-bench-'));
process.on('exit', () => fs.rmSync(tempDataDir, { recursive: true, force: true }));

// Deterministic + free by default so before/after comparisons are apples-to-apples:
//   - strict fixture mode (a miss throws; network is impossible)
//   - Gemini off (its reranking is nondeterministic) unless --gemini
//   - enrichment off (adds live variability) unless --enrich
process.env.APIFY_MODE = LIVE ? 'live' : 'fixture';
process.env.APIFY_FIXTURE_FILE = fixturePath;
process.env.DATA_DIR = tempDataDir;
if (!LIVE) process.env.APIFY_TOKEN = '';
process.env.GEMINI_ENABLED = args.has('--gemini') ? 'true' : 'false';
process.env.APIFY_ENRICH_ENABLED = args.has('--enrich') || LIVE ? 'true' : 'false';
process.env.APIFY_SURNAME_SEED_COUNT = '0';
process.env.APIFY_COMPANY_EMPLOYEES_ENABLED = 'false';
process.env.APIFY_PROFILE_SEARCH_ENABLED = 'true';
process.env.APIFY_PROFILE_SEARCH_ACTOR = 'harvestapi/linkedin-profile-search';
process.env.APIFY_PROFILE_SEARCH_MODE = 'Short';
process.env.APIFY_COMPANY_SEARCH_ACTOR = 'harvestapi/linkedin-company-search';
process.env.APIFY_SEARCH_ACTOR = 'apify/rag-web-browser';
process.env.APIFY_MCP_ENABLED = 'false';
process.env.APIFY_DISCOVERY_CONCURRENCY = '3';

const { hasStrongArmenianNameSignal } = await import('../src/people.js');
const { searchPeople } = await import('../src/agent.js');

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(benchDir, p), 'utf8'));

function evalDetector() {
  const { names } = readJson('labels-names.json');
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const misses = [];
  for (const row of names) {
    const guess = hasStrongArmenianNameSignal(row.name);
    if (guess && row.armenian) tp += 1;
    else if (guess && !row.armenian) {
      fp += 1;
      misses.push(`FALSE POSITIVE: "${row.name}" scored Armenian (${row.note})`);
    } else if (!guess && row.armenian) {
      fn += 1;
      misses.push(`FALSE NEGATIVE: "${row.name}" missed (${row.note})`);
    } else tn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + tn) / names.length;
  return { total: names.length, tp, fp, fn, tn, precision, recall, f1, accuracy, misses };
}

async function evalPipeline() {
  const { queries } = readJson('golden-queries.json');
  const perQuery = [];
  for (const q of queries) {
    const started = Date.now();
    let result;
    try {
      result = await searchPeople({ query: q.query, mode: q.mode || 'fast', limit: q.limit || 10, refresh: LIVE });
    } catch (error) {
      perQuery.push({ id: q.id, error: error.message });
      continue;
    }
    const people = result.results || [];
    const names = people.map((p) => normalizeName(p.name));
    const expected = LIVE ? [] : (q.expectedPeople || []).map(normalizeName);
    const rejected = LIVE ? [] : (q.rejectedPeople || []).map(normalizeName);
    const found = expected.filter((name) => names.includes(name));
    const knownRecall = expected.length ? found.length / expected.length : null;
    const precisionByName = people.length
      ? people.filter((p) => hasStrongArmenianNameSignal(p.name)).length / people.length
      : 0;
    const semanticPrecision = LIVE
      ? null
      : people.length
        ? names.filter((name) => expected.includes(name)).length / people.length
        : 0;
    const rejectedSurfaced = rejected.filter((name) => names.includes(name));
    const companyMatchRate =
      q.type === 'company' && people.length
        ? people.filter((p) => (p.company || '').toLowerCase().includes((q.expectCompany || '').toLowerCase())).length /
          people.length
        : null;
    const roleMatchRate = q.expectRole && people.length
      ? people.filter((p) => String(p.role || '').toLowerCase() === String(q.expectRole).toLowerCase()).length / people.length
      : null;
    const locationMatchRate = q.expectLocations?.length && people.length
      ? people.filter((p) => q.expectLocations.some((location) => String(p.location || '').toLowerCase().includes(location.toLowerCase()))).length / people.length
      : null;
    const topConf = people.slice(0, 3).map((p) => p.confidence || 0);
    perQuery.push({
      id: q.id,
      resultCount: people.length,
      meetsMinResults: people.length >= (q.minResults || 0),
      knownRecall,
      foundExpected: found,
      precisionByName,
      semanticPrecision,
      rejectedSurfaced,
      companyMatchRate,
      roleMatchRate,
      locationMatchRate,
      avgTopConfidence: topConf.length ? topConf.reduce((a, b) => a + b, 0) / topConf.length : 0,
      latencyMs: Date.now() - started,
    });
  }
  return perQuery;
}

function mean(values) {
  const nums = values.filter((v) => typeof v === 'number');
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function composite(detector, pipeline) {
  const avgRecall = mean(pipeline.map((q) => q.knownRecall));
  const avgPrecision = mean(pipeline.map((q) => q.precisionByName));
  const avgSemanticPrecision = mean(pipeline.map((q) => q.semanticPrecision));
  const avgCompany = mean(pipeline.map((q) => q.companyMatchRate));
  const avgConstraints = mean(pipeline.flatMap((q) => [q.roleMatchRate, q.locationMatchRate]));
  return Math.round(
    100 *
      (0.3 * detector.f1 +
        0.2 * avgRecall +
        0.15 * avgPrecision +
        0.15 * avgSemanticPrecision +
        0.1 * avgCompany +
        0.1 * avgConstraints),
  );
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function pct(v) {
  return v == null ? '  n/a' : `${(v * 100).toFixed(0).padStart(3)}%`;
}

function arrow(cur, base) {
  if (base == null || cur == null) return '';
  const d = cur - base;
  if (Math.abs(d) < 1e-9) return ' =';
  return d > 0 ? ` ▲ +${(d * 100).toFixed(0)}pt` : ` ▼ ${(d * 100).toFixed(0)}pt`;
}

const detector = evalDetector();
const pipeline = await evalPipeline();
const score = LIVE ? null : composite(detector, pipeline);

const baselinePath = path.join(benchDir, 'baseline.json');
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;

console.log('\n=== DETECTOR (labeled names, deterministic) ===');
console.log(`  precision ${pct(detector.precision)}   recall ${pct(detector.recall)}   F1 ${pct(detector.f1)}   accuracy ${pct(detector.accuracy)}   (${detector.total} names)`);
if (baseline) {
  console.log(`  vs baseline: F1${arrow(detector.f1, baseline.detector?.f1)}  precision${arrow(detector.precision, baseline.detector?.precision)}  recall${arrow(detector.recall, baseline.detector?.recall)}`);
}
if (detector.misses.length) {
  console.log('  misclassified:');
  detector.misses.forEach((m) => console.log(`    - ${m}`));
}

console.log(`\n=== PIPELINE (golden queries, ${LIVE ? 'LIVE' : `fixture ${fixtureHash.slice(0, 12)}`}) ===`);
for (const q of pipeline) {
  if (q.error) {
    console.log(`  ${q.id}: ERROR ${q.error}`);
    continue;
  }
  console.log(
    `  ${q.id.padEnd(18)} results ${String(q.resultCount).padStart(2)}  recall ${pct(q.knownRecall)}  nameP ${pct(q.precisionByName)}  labelP ${pct(q.semanticPrecision)}  company ${pct(q.companyMatchRate)}  role ${pct(q.roleMatchRate)}  location ${pct(q.locationMatchRate)}  rejected ${q.rejectedSurfaced.length}  ${q.latencyMs}ms`,
  );
}

console.log('\n=== COMPOSITE ===');
if (LIVE) {
  console.log('  live diagnostic only — synthetic fixture labels and baseline score are intentionally disabled');
} else {
  console.log(`  score: ${score}/100${baseline ? `  (baseline ${baseline.composite}${score > baseline.composite ? ` ▲ +${score - baseline.composite}` : score < baseline.composite ? ` ▼ ${score - baseline.composite}` : ' ='})` : ' (no baseline yet)'}`);
}

const snapshot = {
  savedAt: new Date().toISOString(),
  fixtureSha256: LIVE ? null : fixtureHash,
  composite: score,
  detector: { precision: detector.precision, recall: detector.recall, f1: detector.f1, accuracy: detector.accuracy },
  pipeline: pipeline.map((q) => ({
    id: q.id,
    resultCount: q.resultCount,
    knownRecall: q.knownRecall,
    precisionByName: q.precisionByName,
    semanticPrecision: q.semanticPrecision,
    companyMatchRate: q.companyMatchRate,
    roleMatchRate: q.roleMatchRate,
    locationMatchRate: q.locationMatchRate,
    rejectedSurfaced: q.rejectedSurfaced,
  })),
};

console.log('');
const hardFailures = pipeline.filter((q) =>
  LIVE
    ? q.error
    : q.error || !q.meetsMinResults || q.rejectedSurfaced?.length || (q.semanticPrecision ?? 0) < 1,
);
const fixtureChanged = !LIVE && baseline?.fixtureSha256 && baseline.fixtureSha256 !== fixtureHash;
if (hardFailures.length && !GATE) {
  console.error(
    LIVE
      ? `LIVE DIAGNOSTIC FAILED: ${hardFailures.length} query error(s).`
      : `BENCH FAILED: ${hardFailures.length} offline query contract failure(s).`,
  );
  process.exit(1);
}
if (SAVE) {
  if (!fixtureHash || hardFailures.length) {
    console.error('REFUSING TO SAVE: the fixture catalog is missing or a query contract failed.');
    process.exit(1);
  }
  fs.writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`  saved baseline -> bench/baseline.json\n`);
}
if (GATE && (hardFailures.length || fixtureChanged || (baseline && score < baseline.composite))) {
  console.error(
    `GATE FAILED:${hardFailures.length ? ` ${hardFailures.length} query contract failure(s);` : ''}${fixtureChanged ? ' fixture hash changed without a new baseline;' : ''}${baseline && score < baseline.composite ? ` composite ${score} < baseline ${baseline.composite};` : ''}`,
  );
  process.exit(1);
}
