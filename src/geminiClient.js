import { config } from './config.js';
import { fetchWithRetry } from './http.js';
import { ARMENIAN_SURNAME_QUERY_BATCH } from './people.js';

const EXECUTABLE_TOOLS = [
  {
    tool: 'company_employee_search',
    description:
      'Use Apify LinkedIn Company Employees Scraper when the user names a target company. Best for "Armenians at OpenAI" or "Google sales".',
  },
  {
    tool: 'web_rag_search',
    description:
      'Use Apify RAG Web Browser for location, role, school, community, and open-ended people searches. Best for "Armenian founders in Santa Clara".',
  },
  {
    tool: 'profile_enrichment',
    description:
      'Planned tool for enriching known LinkedIn profile URLs. Use after search finds profile URLs. Execution is guarded until profile enrichment schema is enabled.',
  },
  {
    tool: 'company_search',
    description:
      'Planned tool for fuzzy company lookup. Use when a company name is ambiguous. Execution is guarded until company search schema is enabled.',
  },
];

const DEFAULT_ARMENIAN_MISSION =
  'The app always searches for Armenian people by nationality, identity, language, diaspora, community, or strong Armenian name evidence. The user does not need to type Armenian.';

export async function planSearchWithGemini(query, fallbackIntent, { model } = {}) {
  const useModel = model || config.geminiModel;
  const fallbackPlan = deterministicPlan(query, fallbackIntent);
  if (!config.geminiEnabled || !config.geminiApiKey) {
    return {
      plan: fallbackPlan,
      planning: {
        geminiUsed: false,
        model: useModel,
      },
    };
  }

  try {
    const plan = sanitizePlan(await requestSearchPlan(query, fallbackIntent, useModel), fallbackPlan);
    return {
      plan,
      planning: {
        geminiUsed: true,
        model: useModel,
        stepCount: plan.steps.length,
      },
    };
  } catch (error) {
    return {
      plan: fallbackPlan,
      planning: {
        geminiUsed: false,
        model: useModel,
        error: error.message,
      },
    };
  }
}

export async function validateCandidatesWithGemini(intent, candidates, { model } = {}) {
  const useModel = model || config.geminiModel;
  if (!config.geminiEnabled || !config.geminiApiKey || !candidates.length) {
    return {
      candidates,
      agent: {
        geminiUsed: false,
        model: useModel,
      },
    };
  }

  try {
    const judgments = await requestCandidateJudgments(intent, candidates, useModel);
    return {
      candidates: applyJudgments(intent, candidates, judgments),
      agent: {
        geminiUsed: true,
        model: useModel,
        judgedCandidates: judgments.length,
      },
    };
  } catch (error) {
    return {
      candidates,
      agent: {
        geminiUsed: false,
        model: useModel,
        error: error.message,
      },
    };
  }
}

async function requestCandidateJudgments(intent, candidates, model) {
  const judgments = [];
  for (let offset = 0; offset < candidates.length; offset += 16) {
    judgments.push(...await requestCandidateJudgmentBatch(intent, candidates.slice(offset, offset + 16), model));
  }
  return judgments;
}

async function requestCandidateJudgmentBatch(intent, candidates, model) {
  const compactCandidates = candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    headline: candidate.headline,
    company: candidate.company,
    role: candidate.role,
    location: candidate.location,
    // Named heuristicPrior (not "confidence") so the model treats it as a weak
    // prior, not evidence, and reasons from the source text instead.
    heuristicPrior: candidate.confidence,
    sources: (candidate.sources || []).slice(0, 2).map((source) => ({
      title: source.title,
      snippet: source.snippet,
      context: (source.context || '').slice(0, 1400),
      url: source.url,
      kind: source.kind,
      targetCompany: source.targetCompany,
      affiliationVerified: source.affiliationVerified,
      sourceType: source.sourceType,
      sourceConfidence: source.sourceConfidence,
    })),
    // Evidence is retained in full on disk, but prompt size must stay bounded as
    // the same person accumulates observations across searches.
    evidence: (candidate.evidence || [])
      .map((item) => String(item?.text || '').trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((text) => text.slice(0, 500)),
    needsVerification: Boolean(candidate.needsVerification),
  }));

  const prompt = `You are validating people-search candidates for an Armenian founder network app.

Mission:
${DEFAULT_ARMENIAN_MISSION}

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
      "display_bucket": "likely | possible | reject",
      "overall_score": 0,
      "evidence": ["short evidence strings based only on provided candidate text"],
      "concerns": ["short uncertainty strings"],
      "outreach_angle": "one sentence warm outreach angle, or null"
    }
  ]
}

Scoring rubric for overall_score (0-100):
- 80-100: explicit Armenian identity/nationality/language/community/diaspora evidence AND the request (company/role/location) is supported.
- 60-79: strong Armenian surname/name evidence with request supported, or explicit identity with weaker request match.
- 40-59: request supported (e.g. confirmed at target company) but Armenian evidence is only a surname or context signal.
- 20-39: weak or ambiguous on both dimensions.
- 0-19: wrong company/role/location, non-person, or no Armenian signal.

Rules:
- heuristicPrior is a rough local score. Treat it as a weak prior only; base your judgment on the candidate name and source text.
- Be strict. If the target company is present, matches_request must be false unless the candidate text supports current work at that company.
- For web/RAG candidates, do not trust the search query itself as evidence. Only use the candidate title/snippet/context.
- If a candidate was found by a company query but the profile context only mentions the company in posts, likes, reposts, related profiles, or generic search text, works_at_target_company must be false.
- Do not infer facts from world knowledge. Use only the candidate text.
- Armenian confidence should be high for explicit Armenian identity, Armenian nationality, Armenian-American, Armenian language, Armenian community, or Armenian diaspora evidence.
- Armenia/Yerevan location or school evidence is useful context, but it is not the same as nationality. Use it as supporting evidence, not the only reason for a high score.
- Armenian confidence should be medium for strong Armenian name or surname evidence when company/role/location match is supported. Do not treat "Yan", "Ian", "Chan", "Yang", or a first name "Ian" as Armenian evidence.
- This app optimizes for recall. Keep company-confirmed candidates even when Armenian evidence is weak or unknown; assign lower scores and concerns instead of dropping them.
- display_bucket should be likely for strong Armenian evidence, possible for company-confirmed but weak Armenian evidence, and reject for wrong company or obvious non-person/non-match.
- Only set matches_request false when the target company/role/location clearly does not match, or the record is obviously not a person.`;

  const parsed = await requestGeminiJson(prompt, { temperature: 0.1, model });
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const expectedIds = new Set(compactCandidates.map((candidate) => candidate.id));
  const byId = new Map(
    results
      .filter((result) => result && expectedIds.has(result.id))
      .map((result) => [result.id, result]),
  );
  const missing = [...expectedIds].filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(`Gemini omitted ${missing.length} candidate judgment${missing.length === 1 ? '' : 's'}.`);
  }
  return [...byId.values()];
}

async function requestSearchPlan(query, fallbackIntent, model) {
  const prompt = `You are the planning layer for "Find Your Armenian", a people-discovery app for likely Armenian professionals.

Mission:
${DEFAULT_ARMENIAN_MISSION}

User request:
${query}

Current deterministic parse:
${JSON.stringify(fallbackIntent, null, 2)}

Executable tools:
${JSON.stringify(EXECUTABLE_TOOLS, null, 2)}

Return only valid JSON with this exact shape:
{
  "intent": {
    "originalQuery": "string",
    "company": "string or null",
    "role": "string or null",
    "location": "string or null",
    "locationAlternates": ["string"],
    "wantsArmenian": true,
    "searchType": "company | location | role | open"
  },
  "steps": [
    {
      "tool": "company_employee_search | web_rag_search | profile_enrichment | company_search",
      "reason": "short reason",
      "company": "string or null",
      "query": "string",
      "role": "string or null",
      "location": "string or null",
      "maxResults": 8
    }
  ]
}

Planning rules:
- Always search for Armenian identity/nationality evidence even if the user does not say "Armenian".
- Use company_employee_search when there is a specific company.
- For company-only queries, prefer a single company_employee_search step. Do not add web_rag_search unless the user asks for a location, school, founder/topic research, or named person verification.
- Use web_rag_search for location searches like Santa Clara, San Francisco, Bay Area, Palo Alto, Mountain View, or San Jose.
- For location-only searches, include one precise step and one broadened step if helpful, e.g. Santa Clara then Bay Area.
- Web queries must use the SHORT form: "site:linkedin.com/in <company or terms> Armenian". Never stack quoted phrases like "Armenian language" or "Armenian-American" in a query — they surface non-Armenians at the wrong company and destroy result quality.
- For location/role/open searches (no company), you may add ONE surname-OR batch step, e.g. site:linkedin.com/in <terms> (Hakobyan OR Sargsyan OR Grigoryan OR Harutyunyan OR Petrosyan). Do not use a bare "ian" or "yan" token; they create false positives like Ian or Yan.
- For founder/topic requests, use web_rag_search against LinkedIn profiles, founder pages, GitHub, Crunchbase-style pages, and personal websites.
- If a specific person name appears, plan a precise web_rag_search for that name and optionally profile_enrichment if a LinkedIn URL is known.
- Do not choose tools outside the executable tool list.
- Limit to 4 steps. Prefer high-precision searches over broad scraping.`;

  return requestGeminiJson(prompt, { temperature: 0.2, model });
}

async function requestGeminiJson(prompt, { temperature, model }) {
  const useModel = model || config.geminiModel;
  // The Vertex free/express tier serves transient 404 HTML pages under load;
  // fetchWithRetry treats those (and 429/5xx) as retryable with backoff.
  const result = await fetchWithRetry(
    `${config.geminiApiBase}/${useModel}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
        },
      }),
    },
    // Keep the total budget (retries x timeout + backoff) well under the 120s
    // server cap so a hung endpoint degrades to heuristics instead of a 504.
    { label: 'Gemini', timeoutMs: 20000, retries: 2, retryOnHtml: true },
  );

  if (!result.ok) {
    throw new Error(`Gemini failed with HTTP ${result.status}.`);
  }

  const payload = result.json ?? JSON.parse(result.text);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return JSON.parse(stripJsonFences(text));
}

function applyJudgments(intent, candidates, judgments) {
  const companyGated = Boolean(intent.company);
  const byId = new Map(judgments.map((judgment) => [judgment.id, judgment]));

  return candidates
    .map((candidate) => {
      const judgment = byId.get(candidate.id);
      if (!judgment) return candidate;

      const score = clampScore(Number(judgment.overall_score));
      const matchesRequest = modelBoolean(judgment.matches_request);
      const worksAtTargetCompany = companyGated
        ? modelBoolean(judgment.works_at_target_company)
        : null;
      return {
        ...candidate,
        confidence: score,
        confidenceLabel: score >= 70 ? 'strong' : score >= 45 ? 'possible' : 'weak',
        needsVerification:
          candidate.needsVerification ||
          (candidate.sources || []).some((source) => source.sourceType === 'google-serp-unverified' && source.sourceConfidence === 'low'),
        displayBucket: displayBucketFor({
          ...judgment,
          matches_request: matchesRequest,
          works_at_target_company: worksAtTargetCompany,
        }),
        outreachAngle: judgment.outreach_angle || '',
        geminiJudgment: {
          matchesRequest,
          worksAtTargetCompany,
          armenianConfidence: enumValue(judgment.armenian_confidence, ['high', 'medium', 'low', 'unknown'], 'unknown'),
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
      // Only enforce company affiliation when the user actually asked for a
      // company. On location/role/open searches there is no target company, so
      // works_at_target_company is meaningless and must not drop candidates.
      if (companyGated && judgment.worksAtTargetCompany === false) return false;
      if (companyGated && candidate.needsVerification && judgment.worksAtTargetCompany !== true) return false;
      if (judgment.matchesRequest === false) return false;
      if (candidate.displayBucket === 'reject') return false;
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

function displayBucketFor(judgment) {
  // Explicit mismatch flags are authoritative. A contradictory free-form
  // bucket must never keep a model-confirmed wrong company/role/location.
  if (judgment.works_at_target_company === false || judgment.matches_request === false) return 'reject';
  if (judgment.display_bucket === 'reject') return 'reject';
  if (judgment.display_bucket === 'likely') return 'likely';
  if (judgment.display_bucket === 'possible') return 'possible';

  if (judgment.armenian_confidence === 'high' || judgment.armenian_confidence === 'medium') return 'likely';
  return 'possible';
}

function modelBoolean(value) {
  if (value === true || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value).toLowerCase() === 'false') return false;
  return null;
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || '').toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function stripJsonFences(value) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
}

function deterministicPlan(query, intent) {
  const company = intent.company || null;
  const role = intent.role || null;
  const location = intent.location || null;
  const steps = [];

  if (company) {
    steps.push({
      tool: 'company_employee_search',
      reason: 'Target company is explicit.',
      company,
      query: `employees at ${company}`,
      role,
      location,
      maxResults: config.apifyMaxResults,
    });
  }

  const locationAlternates = locationAlternatesFor(location);
  const target = [company, role, location].filter(Boolean).join(' ');
  steps.push({
    tool: 'web_rag_search',
    reason: company ? 'Public web evidence for the target company.' : 'Open-ended people search.',
    company,
    // Simple unquoted form — empirically returns real Armenians at the target,
    // unlike the old multi-quoted form which surfaced non-Armenians elsewhere.
    query: `site:linkedin.com/in ${target} Armenian`.replace(/\s+/g, ' ').trim(),
    role,
    location,
    maxResults: config.apifyMaxResults,
  });

  if (!company) {
    const broadLocation = locationAlternates[0] || location || '';
    steps.push({
      tool: 'web_rag_search',
      reason: 'Surname-OR batch to improve recall on open/location searches.',
      company,
      query: `site:linkedin.com/in ${[role, broadLocation].filter(Boolean).join(' ')} (${ARMENIAN_SURNAME_QUERY_BATCH.join(' OR ')})`
        .replace(/\s+/g, ' ')
        .trim(),
      role,
      location: broadLocation || null,
      maxResults: config.apifyMaxResults,
    });
  }

  return {
    intent: {
      originalQuery: intent.originalQuery || query,
      company,
      role,
      location,
      locationAlternates,
      wantsArmenian: true,
      searchType: company ? 'company' : location ? 'location' : role ? 'role' : 'open',
    },
    steps: steps.slice(0, 4),
  };
}

function sanitizePlan(plan, fallbackPlan) {
  const intent = {
    ...fallbackPlan.intent,
    ...(plan.intent || {}),
    originalQuery: fallbackPlan.intent.originalQuery,
    wantsArmenian: true,
  };
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const allowed = new Set(['company_employee_search', 'web_rag_search']);
  const cleanSteps = steps
    .filter((step) => allowed.has(step.tool))
    .slice(0, 4)
    .map((step) => ({
      tool: step.tool,
      reason: String(step.reason || '').slice(0, 160),
      company: emptyToNull(step.company ?? intent.company),
      query: sanitizeSearchQuery(String(step.query || '').trim()),
      role: emptyToNull(step.role ?? intent.role),
      location: emptyToNull(step.location ?? intent.location),
      maxResults: clampStepLimit(step.maxResults),
    }))
    .filter((step) => step.query || step.company);
  const companyOnly =
    intent.company &&
    !intent.location &&
    !intent.role &&
    cleanSteps.some((step) => step.tool === 'company_employee_search');
  const finalSteps = companyOnly
    ? cleanSteps.filter((step) => step.tool === 'company_employee_search').slice(0, 1)
    : cleanSteps;

  return {
    intent: {
      originalQuery: intent.originalQuery,
      company: emptyToNull(intent.company),
      role: emptyToNull(intent.role),
      location: emptyToNull(intent.location),
      locationAlternates: Array.isArray(intent.locationAlternates) ? intent.locationAlternates.filter(Boolean).slice(0, 3) : [],
      wantsArmenian: true,
      searchType: ['company', 'location', 'role', 'open'].includes(intent.searchType) ? intent.searchType : fallbackPlan.intent.searchType,
    },
    steps: finalSteps.length ? finalSteps : fallbackPlan.steps,
  };
}

function locationAlternatesFor(location) {
  if (!location) return [];
  const normalized = location.toLowerCase();
  if (['santa clara', 'san jose', 'palo alto', 'mountain view', 'sunnyvale', 'cupertino'].includes(normalized)) {
    return ['Bay Area', 'Silicon Valley', 'San Francisco'];
  }
  if (normalized === 'san francisco') return ['Bay Area', 'Silicon Valley'];
  if (normalized === 'bay area') return ['San Francisco', 'Silicon Valley'];
  return [];
}

function emptyToNull(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function clampStepLimit(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return config.apifyMaxResults;
  return Math.max(1, Math.min(25, number));
}

function sanitizeSearchQuery(query) {
  return query
    .replace(/\bOR\s+ian\b/gi, '')
    .replace(/\bian\s+OR\b/gi, '')
    .replace(/\bOR\s+yan\b/gi, '')
    .replace(/\byan\s+OR\b/gi, '')
    // Strip quoted identity phrases if the model adds them back — the short
    // unquoted form is what actually finds Armenians at the target.
    .replace(/"armenian language"/gi, '')
    .replace(/"armenian[- ]american"/gi, '')
    .replace(/"speaks armenian"/gi, '')
    .replace(/\(\s*Armenian\s*\)/gi, 'Armenian')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
