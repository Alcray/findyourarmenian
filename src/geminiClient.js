import { config } from './config.js';

export async function validateCandidatesWithGemini(intent, candidates) {
  if (!config.geminiEnabled || !config.geminiApiKey || !candidates.length) {
    return {
      candidates,
      agent: {
        geminiUsed: false,
        model: config.geminiModel,
      },
    };
  }

  try {
    const judgments = await requestCandidateJudgments(intent, candidates);
    return {
      candidates: applyJudgments(candidates, judgments),
      agent: {
        geminiUsed: true,
        model: config.geminiModel,
        judgedCandidates: judgments.length,
      },
    };
  } catch (error) {
    return {
      candidates,
      agent: {
        geminiUsed: false,
        model: config.geminiModel,
        error: error.message,
      },
    };
  }
}

async function requestCandidateJudgments(intent, candidates) {
  const compactCandidates = candidates.slice(0, 16).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    headline: candidate.headline,
    company: candidate.company,
    role: candidate.role,
    location: candidate.location,
    confidence: candidate.confidence,
    sources: (candidate.sources || []).slice(0, 2).map((source) => ({
      title: source.title,
      snippet: source.snippet,
      url: source.url,
      kind: source.kind,
      targetCompany: source.targetCompany,
    })),
    evidence: (candidate.evidence || []).map((item) => item.text),
  }));

  const prompt = `You are validating people-search candidates for an Armenian founder network app.

User intent:
${JSON.stringify(intent, null, 2)}

Candidates:
${JSON.stringify(compactCandidates, null, 2)}

Return only valid JSON with this exact shape:
{
  "results": [
    {
      "id": "candidate id",
      "matches_request": true,
      "works_at_target_company": true,
      "armenian_confidence": "high | medium | low | unknown",
      "overall_score": 0,
      "evidence": ["short evidence strings based only on provided candidate text"],
      "concerns": ["short uncertainty strings"],
      "outreach_angle": "one sentence warm outreach angle, or null"
    }
  ]
}

Rules:
- Be strict. If the target company is present, matches_request must be false unless the candidate text supports current work at that company.
- Do not infer facts from world knowledge. Use only the candidate text.
- Armenian confidence should be high for explicit Armenian/Armenia/Yerevan evidence.
- Armenian confidence should be medium for strong Armenian name or surname evidence when company match is supported.
- This app returns likely Armenian matches, not identity claims. Keep uncertain but plausible company-confirmed candidates with lower scores and concerns.
- Prefer false when company evidence is missing or Armenian evidence is absent.`;

  const response = await fetch(
    `${config.geminiApiBase}/${config.geminiModel}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    },
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = JSON.parse(body);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  const parsed = JSON.parse(stripJsonFences(text));
  return Array.isArray(parsed.results) ? parsed.results : [];
}

function applyJudgments(candidates, judgments) {
  const byId = new Map(judgments.map((judgment) => [judgment.id, judgment]));

  return candidates
    .map((candidate) => {
      const judgment = byId.get(candidate.id);
      if (!judgment) return candidate;

      const score = clampScore(Number(judgment.overall_score));
      return {
        ...candidate,
        confidence: score,
        confidenceLabel: score >= 70 ? 'strong' : score >= 45 ? 'possible' : 'weak',
        outreachAngle: judgment.outreach_angle || '',
        geminiJudgment: {
          matchesRequest: Boolean(judgment.matches_request),
          worksAtTargetCompany: judgment.works_at_target_company,
          armenianConfidence: judgment.armenian_confidence || 'unknown',
          concerns: Array.isArray(judgment.concerns) ? judgment.concerns : [],
        },
        evidence: [
          ...(candidate.evidence || []),
          ...asEvidence(judgment.evidence),
          ...asEvidence(judgment.concerns, 'concern'),
        ],
      };
    })
    .filter((candidate) => {
      const judgment = candidate.geminiJudgment;
      if (!judgment) return true;
      if (judgment.worksAtTargetCompany === false) return false;
      if (judgment.matchesRequest === false && judgment.armenianConfidence === 'unknown') return false;
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence);
}

function asEvidence(values, type = 'gemini') {
  if (!Array.isArray(values)) return [];
  return values
    .filter(Boolean)
    .slice(0, 4)
    .map((text) => ({ type, text: `Gemini: ${text}` }));
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function stripJsonFences(value) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
}
