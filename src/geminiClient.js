import { config } from './config.js';

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

export async function planSearchWithGemini(query, fallbackIntent) {
  const fallbackPlan = deterministicPlan(query, fallbackIntent);
  if (!config.geminiEnabled || !config.geminiApiKey) {
    return {
      plan: fallbackPlan,
      planning: {
        geminiUsed: false,
        model: config.geminiModel,
      },
    };
  }

  try {
    const plan = sanitizePlan(await requestSearchPlan(query, fallbackIntent), fallbackPlan);
    return {
      plan,
      planning: {
        geminiUsed: true,
        model: config.geminiModel,
        stepCount: plan.steps.length,
      },
    };
  } catch (error) {
    return {
      plan: fallbackPlan,
      planning: {
        geminiUsed: false,
        model: config.geminiModel,
        error: error.message,
      },
    };
  }
}

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
      context: source.context,
      url: source.url,
      kind: source.kind,
      targetCompany: source.targetCompany,
      affiliationVerified: source.affiliationVerified,
      sourceType: source.sourceType,
      sourceConfidence: source.sourceConfidence,
    })),
    evidence: (candidate.evidence || []).map((item) => item.text),
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

Rules:
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

  const parsed = await requestGeminiJson(prompt, { temperature: 0.1 });
  return Array.isArray(parsed.results) ? parsed.results : [];
}

async function requestSearchPlan(query, fallbackIntent) {
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
- Every web query must include LinkedIn/person context and strong Armenian identity terms such as Armenian, Armenian-American, Armenian language, Armenian diaspora, Armenian community, or Hayastan. Do not rely on Armenia/Yerevan alone and do not use bare "ian" or "yan" as standalone web-search terms because they create false positives like Ian or Yan.
- For founder/topic requests, use web_rag_search against LinkedIn profiles, founder pages, GitHub, Crunchbase-style pages, and personal websites.
- If a specific person name appears, plan a precise web_rag_search for that name and optionally profile_enrichment if a LinkedIn URL is known.
- Do not choose tools outside the executable tool list.
- Limit to 4 steps. Prefer high-precision searches over broad scraping.`;

  return requestGeminiJson(prompt, { temperature: 0.2 });
}

async function requestGeminiJson(prompt, { temperature }) {
  const response = await fetch(`${config.geminiApiBase}/${config.geminiModel}:generateContent`, {
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
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = JSON.parse(body);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return JSON.parse(stripJsonFences(text));
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
        needsVerification:
          candidate.needsVerification ||
          (candidate.sources || []).some((source) => source.sourceType === 'google-serp-unverified' && source.sourceConfidence === 'low'),
        displayBucket: displayBucketFor(judgment),
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
      if (candidate.needsVerification && judgment.worksAtTargetCompany !== true) return false;
      if (judgment.matchesRequest === false && candidate.company === '') return false;
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
  if (judgment.display_bucket === 'reject') return 'reject';
  if (judgment.display_bucket === 'likely') return 'likely';
  if (judgment.display_bucket === 'possible') return 'possible';

  if (judgment.works_at_target_company === false || judgment.matches_request === false) return 'reject';
  if (judgment.armenian_confidence === 'high' || judgment.armenian_confidence === 'medium') return 'likely';
  return 'possible';
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
    reason: company ? 'Fallback search with public evidence.' : 'Open-ended people search.',
    company,
    query: `site:linkedin.com/in ${target} Armenian "Armenian language" "Armenian-American"`.replace(/\s+/g, ' ').trim(),
    role,
    location,
    maxResults: config.apifyMaxResults,
  });

  if (!company && locationAlternates[0]) {
    steps.push({
      tool: 'web_rag_search',
      reason: 'Broaden nearby location to improve recall.',
      company,
      query: `site:linkedin.com/in ${role || ''} Armenian "Armenian language" "Armenian-American" founder engineer ${locationAlternates[0]}`.replace(/\s+/g, ' ').trim(),
      role,
      location: locationAlternates[0],
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
    .replace(/\(\s*Armenian\s*\)/gi, 'Armenian')
    .replace(/\bArmenia\s+Yerevan\b/gi, 'Armenian "Armenian language"')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
