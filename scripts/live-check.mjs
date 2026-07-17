// Throwaway live end-to-end check. Usage: node scripts/live-check.mjs "query" [mode]
process.env.APIFY_MODE = process.env.APIFY_MODE || 'live';
const query = process.argv[2] || 'Find Armenians who work at OpenAI';
const mode = process.argv[3] || 'fast';

const { searchPeople } = await import('../src/agent.js');
const started = Date.now();
const result = await searchPeople({ query, mode, limit: 8, refresh: false });
const ms = Date.now() - started;

console.log(`\n=== "${query}" [${mode}] in ${ms}ms ===`);
console.log('runs:', (result.runs || []).map((r) => `${r.actorId.split('/').pop()}:${r.cached ? 'cache' : r.demo ? 'demo' : 'live'}(${r.itemCount})`).join('  '));
if (result.errors?.length) console.log('errors:', result.errors.map((e) => `${e.query} -> ${e.message}`).join(' | '));
console.log('validation:', JSON.stringify(result.agent?.validation || {}));
console.log(`\nresults: ${result.results.length}`);
for (const p of result.results) {
  const armenian = p.geminiJudgment?.armenianConfidence || '?';
  console.log(`\n• ${p.name}  [conf ${p.confidence} | armenian:${armenian} | bucket:${p.displayBucket || '-'}]`);
  console.log(`  ${p.headline || p.role || ''}  @ ${p.company || '?'}  ${p.location || ''}`);
  console.log(`  url: ${p.profileUrl || '(none)'}`);
  console.log(`  evidence: ${(p.evidence || []).slice(0, 3).map((e) => e.text).join(' | ')}`);
  if (p.outreachAngle) console.log(`  outreach: ${p.outreachAngle}`);
}
