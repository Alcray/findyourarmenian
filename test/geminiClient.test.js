import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Gemini judges every candidate in chunks and explicit mismatches are rejected', () => {
  const script = `
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      const prompt = request.contents[0].parts[0].text;
      const json = prompt.match(/Candidates:\\n([\\s\\S]*?)\\n\\nReturn only valid JSON/)[1];
      const candidates = JSON.parse(json);
      const results = candidates.map((candidate) => ({
        id: candidate.id,
        matches_request: candidate.id !== 'candidate-0',
        works_at_target_company: candidate.id === 'open-candidate' ? false : true,
        armenian_confidence: 'high',
        display_bucket: 'likely',
        overall_score: 85,
        evidence: [],
        concerns: [],
        outreach_angle: null,
      }));
      const body = {
        candidates: [{ content: { parts: [{ text: JSON.stringify({ results }) }] } }],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { validateCandidatesWithGemini } = await import('./src/geminiClient.js');
    const candidates = Array.from({ length: 17 }, (_, index) => ({
      id: 'candidate-' + index,
      name: 'Aram Hakobyan ' + index,
      company: 'OpenAI',
      sources: [],
      evidence: [],
      confidence: 50,
    }));
    const result = await validateCandidatesWithGemini({ company: 'OpenAI' }, candidates);
    const open = await validateCandidatesWithGemini(
      { company: '', role: 'founder' },
      [{
        id: 'open-candidate',
        name: 'Ani Petrosyan',
        role: 'founder',
        sources: [],
        evidence: Array.from({ length: 30 }, (_, index) => ({ text: 'evidence-' + index })),
        confidence: 50,
      }],
    );
    console.log(JSON.stringify({
      calls,
      judged: result.agent.judgedCandidates,
      ids: result.candidates.map((candidate) => candidate.id),
      openIds: open.candidates.map((candidate) => candidate.id),
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GEMINI_ENABLED: 'true',
      GEMINI_API_KEY: 'test-key-never-sent',
      GEMINI_MODEL: 'test-model',
      GEMINI_MODEL_QUALITY: 'test-model',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout.trim());
  assert.equal(audit.calls, 3);
  assert.equal(audit.judged, 17);
  assert.equal(audit.ids.length, 16);
  assert.equal(audit.ids.includes('candidate-0'), false);
  assert.equal(audit.ids.includes('candidate-16'), true);
  assert.deepEqual(audit.openIds, ['open-candidate']);
});
