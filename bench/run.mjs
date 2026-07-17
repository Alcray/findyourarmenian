#!/usr/bin/env node
// Metrics harness for the Find Your Armenian pipeline.
//
//   node bench/run.mjs             # run all metrics, compare to baseline
//   node bench/run.mjs --save      # run, then save the result as the new baseline
//   node bench/run.mjs --capture   # run golden queries LIVE once to populate the fixture cache
//   node bench/run.mjs --gate      # exit 1 if composite score dropped vs baseline (for CI)
//
// Two layers:
//   1. Detector — labeled name set (bench/labels-names.json) scored by the name
//      model. Deterministic, free, no network. This is the regression gate.
//   2. Pipeline — golden queries (bench/golden-queries.json) run cache-first with
//      Gemini disabled, so it is deterministic and free once fixtures are cached.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const SAVE = args.has('--save');
const CAPTURE = args.has('--capture');
const GATE = args.has('--gate');

// Deterministic + free by default so before/after comparisons are apples-to-apples:
//   - cache-first (reuse fixtures, no live discovery)
//   - Gemini off (its reranking is nondeterministic) unless --gemini
//   - enrichment off (adds live variability) unless --enrich
// --capture does one live run to seed the fixture cache.
process.env.APIFY_MODE = CAPTURE ? 'live' : 'cache-first';
process.env.GEMINI_ENABLED = args.has('--gemini') ? 'true' : 'false';
process.env.APIFY_ENRICH_ENABLED = args.has('--enrich') || CAPTURE ? 'true' : 'false';

const { armenianNameScore } = await import('../src/people.js');
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
    const guess = armenianNameScore(row.name) > 0;
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
      result = await searchPeople({ query: q.query, mode: q.mode || 'fast', limit: 10, refresh: CAPTURE });
    } catch (error) {
      perQuery.push({ id: q.id, error: error.message });
      continue;
    }
    const people = result.results || [];
    const names = people.map((p) => (p.name || '').toLowerCase());
    const found = (q.knownArmenianSurnames || []).filter((sn) => names.some((n) => n.includes(sn)));
    const knownRecall = q.knownArmenianSurnames?.length ? found.length / q.knownArmenianSurnames.length : null;
    const precisionByName = people.length
      ? people.filter((p) => armenianNameScore(p.name) > 0).length / people.length
      : 0;
    const companyMatchRate =
      q.type === 'company' && people.length
        ? people.filter((p) => (p.company || '').toLowerCase().includes((q.expectCompany || '').toLowerCase())).length /
          people.length
        : null;
    const topConf = people.slice(0, 3).map((p) => p.confidence || 0);
    perQuery.push({
      id: q.id,
      resultCount: people.length,
      meetsMinResults: people.length >= (q.minResults || 0),
      knownRecall,
      foundKnown: found,
      precisionByName,
      companyMatchRate,
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
  const avgCompany = mean(pipeline.map((q) => q.companyMatchRate));
  return Math.round(100 * (0.35 * detector.f1 + 0.25 * avgRecall + 0.25 * avgPrecision + 0.15 * avgCompany));
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
const score = composite(detector, pipeline);

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

console.log('\n=== PIPELINE (golden queries, cache-first) ===');
for (const q of pipeline) {
  if (q.error) {
    console.log(`  ${q.id}: ERROR ${q.error}`);
    continue;
  }
  console.log(
    `  ${q.id.padEnd(18)} results ${String(q.resultCount).padStart(2)}  recall ${pct(q.knownRecall)}  nameP ${pct(q.precisionByName)}  companyMatch ${pct(q.companyMatchRate)}  topConf ${q.avgTopConfidence.toFixed(0)}  ${q.latencyMs}ms`,
  );
}

console.log('\n=== COMPOSITE ===');
console.log(`  score: ${score}/100${baseline ? `  (baseline ${baseline.composite}${score > baseline.composite ? ` ▲ +${score - baseline.composite}` : score < baseline.composite ? ` ▼ ${score - baseline.composite}` : ' ='})` : ' (no baseline yet)'}`);

const snapshot = {
  savedAt: new Date().toISOString(),
  composite: score,
  detector: { precision: detector.precision, recall: detector.recall, f1: detector.f1, accuracy: detector.accuracy },
  pipeline: pipeline.map((q) => ({
    id: q.id,
    resultCount: q.resultCount,
    knownRecall: q.knownRecall,
    precisionByName: q.precisionByName,
    companyMatchRate: q.companyMatchRate,
  })),
};

if (SAVE) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`\n  saved baseline -> bench/baseline.json`);
}

console.log('');
if (GATE && baseline && score < baseline.composite) {
  console.error(`GATE FAILED: composite ${score} < baseline ${baseline.composite}`);
  process.exit(1);
}
