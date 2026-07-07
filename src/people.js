import { hashValue } from './store.js';

const ARMENIAN_FIRST_NAMES = new Set([
  'ani',
  'aram',
  'armen',
  'armine',
  'armin',
  'artak',
  'artur',
  'davit',
  'gevorg',
  'gor',
  'hayk',
  'lilit',
  'lusine',
  'narek',
  'narine',
  'sargis',
  'tigran',
  'vahagn',
  'vahe',
]);

const ARMENIAN_IDENTITY_TERMS = [
  'armenian',
  'armenian-american',
  'armenian american',
  'armenian language',
  'speaks armenian',
  'native or bilingual armenian',
  'armenian community',
  'armenian diaspora',
  'hayastan',
];

const ARMENIAN_CONTEXT_TERMS = [
  'armenia',
  'yerevan',
  'gyumri',
  'artsakh',
  'aua',
  'american university of armenia',
  'tumo',
  'picsart',
  'synopsys armenia',
];

const NON_ARMENIAN_SURNAME_FALSE_POSITIVES = new Set([
  'yan',
  'ian',
  'chan',
  'chen',
  'yuan',
  'yang',
  'yeung',
  'ryan',
  'bryan',
  'christian',
]);

const ROLE_PATTERNS = [
  ['sales', /\b(sales|gtm|go.to.market|account executive|business development)\b/i],
  ['founder', /\b(founder|co-founder|startup|entrepreneur)\b/i],
  ['engineer', /\b(engineer|software|developer|technical|infra|platform)\b/i],
  ['ai', /\b(ai|ml|machine learning|research|llm|model)\b/i],
  ['product', /\b(product|pm|product manager)\b/i],
  ['design', /\b(design|designer|ux|ui)\b/i],
  ['recruiting', /\b(recruiter|recruiting|talent)\b/i],
];

export function parseIntent(query) {
  const clean = query.trim();
  const role = ROLE_PATTERNS.find(([, pattern]) => pattern.test(clean))?.[0] || '';
  const location = extractLocation(clean);
  const company = extractCompany(clean, role);

  return {
    originalQuery: clean,
    company,
    role,
    location,
    // This app always searches for Armenian people, even if the user only says
    // "find people at Google sales".
    wantsArmenian: true,
  };
}

export function buildSearchQueries(intent) {
  const parts = [intent.company, intent.role, intent.location].filter(Boolean);
  const target = parts.join(' ');
  const queries = [
    `site:linkedin.com/in ${target} Armenian "Armenian language"`,
    `${target} Armenian diaspora LinkedIn profile`,
    `${target} "Armenian-American" Armenian founder engineer sales`,
  ];

  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ').trim()))].slice(0, 3);
}

export function normalizeCandidates(items, intent, sourceQuery, metadata = {}) {
  return items
    .flatMap((item) => normalizeItem(item, intent, sourceQuery, metadata))
    .filter(Boolean)
    .map((candidate) => scoreCandidate(candidate, intent))
    .filter((candidate) => passesHardFilters(candidate, intent))
    .sort((a, b) => b.confidence - a.confidence);
}

function normalizeItem(item, intent, sourceQuery, metadata) {
  const title = textOf(
    item.title ||
      item.jobTitle ||
      item.position ||
      item.headline ||
      item.name ||
      item.fullName ||
      item.heading ||
      item.searchResult?.title ||
      item.metadata?.title ||
      '',
  );
  const employeeName = textOf(item.name || item.fullName || item.profileName || item.employeeName || '');
  const url = bestUrl(item);
  const searchSummary = [
    item.searchResult?.title,
    item.searchResult?.description,
    item.metadata?.title,
    item.metadata?.description,
  ]
    .filter(Boolean)
    .map(textOf)
    .join('\n');
  const profileContent = trimProfileNoise([
    title,
    item.description,
    item.jobTitle,
    item.position,
    item.headline,
    item.company,
    item.companyName,
    item.location,
    item.profileUrl,
    item.linkedinUrl,
    item.text,
    item.markdown,
    item.content,
    item.snippet,
  ]
    .filter(Boolean)
    .map(textOf)
    .join('\n'));
  const content = [searchSummary, profileContent].filter(Boolean).join('\n');

  const linkedInUrls = [...content.matchAll(/https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[A-Za-z0-9_%/-]+/gi)]
    .map((match) => match[0].replace(/[),.\]]+$/, ''));
  const primaryUrl = linkedInUrls[0] || url;
  const name = looksLikeName(employeeName) ? employeeName : extractName(title, primaryUrl);
  if (!name || isLowQualityTitle(name)) return [];

  const explicitCompany = extractCompanyFromText(title, content);
  const itemCompany = companyFromEmployeeItem(item, metadata, content);
  const company = explicitCompany || itemCompany;
  const affiliationVerified = Boolean(explicitCompany) || hasVerifiedCompanyItem(item, metadata, content);
  const headline = cleanHeadline(title, content);
  const location = extractLocation(content) || intent.location || '';

  return [
    {
      identityKey: identityKey(name, company, primaryUrl),
      name,
      headline,
      company,
      role: inferRole(headline, intent.role),
      location,
      profileUrl: primaryUrl,
      needsVerification: item.source === 'google-serp-unverified' && item.confidence === 'low',
      sources: [
        {
          url: primaryUrl,
          title: title || name,
          snippet: firstSentence(searchSummary || profileContent),
          context: contextWindow(searchSummary || profileContent),
          query: sourceQuery,
          actorId: metadata.actorId,
          cached: metadata.cached,
          demo: Boolean(item.demo || metadata.demo),
          kind: metadata.kind || 'web-search',
          targetCompany: metadata.targetCompany || '',
          affiliationVerified,
          sourceConfidence: item.confidence || '',
          sourceType: item.source || '',
        },
      ],
      evidence: [],
    },
  ];
}

function scoreCandidate(candidate, intent) {
  const evidence = [];
  const hayScore = armenianEvidence(candidate, evidence);
  let score = hayScore;

  if (intent.company && hasTargetCompanyEvidence(candidate, intent.company)) {
    score += 25;
    evidence.push({ type: 'company', text: `Matches target company: ${intent.company}` });
  }

  if (intent.role && mentions(candidate, intent.role)) {
    score += 15;
    evidence.push({ type: 'role', text: `Matches target role: ${intent.role}` });
  }

  if (intent.location && mentions(candidate, intent.location)) {
    score += 10;
    evidence.push({ type: 'location', text: `Matches target location: ${intent.location}` });
  }

  if (candidate.profileUrl) score += 5;

  const confidence = Math.min(100, score);
  return {
    ...candidate,
    id: `person_${hashValue(candidate.identityKey)}`,
    confidence,
    confidenceLabel: confidence >= 70 ? 'strong' : confidence >= 45 ? 'possible' : 'weak',
    evidence: dedupeEvidence([...candidate.evidence, ...evidence]),
  };
}

function passesHardFilters(candidate, intent) {
  if (!intent.company) return true;
  return hasTargetCompanyEvidence(candidate, intent.company);
}

function armenianEvidence(candidate, evidence) {
  const searchable = searchableText(candidate);
  const nameParts = candidate.name.toLowerCase().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.at(-1) || '';
  let score = 0;

  if (ARMENIAN_FIRST_NAMES.has(firstName)) {
    score += 12;
    evidence.push({ type: 'name', text: `First name has Armenian signal: ${candidate.name}` });
  }

  if (hasArmenianSurnameSignal(lastName)) {
    score += 24;
    evidence.push({ type: 'name', text: `Surname has common Armenian ending: ${candidate.name}` });
  }

  for (const term of ARMENIAN_IDENTITY_TERMS) {
    if (searchable.includes(term)) {
      score += 28;
      evidence.push({ type: 'source', text: `Source mentions ${term}` });
      break;
    }
  }

  if (!evidence.some((item) => item.type === 'source')) {
    for (const term of ARMENIAN_CONTEXT_TERMS) {
      if (searchable.includes(term)) {
        score += 10;
        evidence.push({ type: 'source', text: `Source has Armenia-linked context: ${term}` });
        break;
      }
    }
  }

  return score;
}

function mentions(candidate, value) {
  if (!value) return false;
  return searchableText(candidate).includes(value.toLowerCase());
}

function hasTargetCompanyEvidence(candidate, company) {
  const target = company.toLowerCase();
  if (
    candidate.company &&
    candidate.company.toLowerCase() === target &&
    (candidate.sources || []).some((source) => source.affiliationVerified)
  ) {
    return true;
  }

  const sourceText = (candidate.sources || [])
    .map((source) => `${source.title || ''}\n${source.snippet || ''}`)
    .join('\n');
  const escaped = escapeRegExp(company);
  return [
    new RegExp(`\\b(?:experience|current|works?|working)\\s*:?\\s*(?:at|@)?\\s*${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:at|@)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b${escaped}\\s*[·|,-]\\s*(?:engineering|sales|product|research|gtm|ai|ml|software)\\b`, 'i'),
    new RegExp(`\\b[A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){1,3}\\s+-\\s+${escaped}\\b`, 'i'),
  ].some((pattern) => pattern.test(sourceText));
}

function searchableText(candidate) {
  return [
    candidate.name,
    candidate.headline,
    candidate.company,
    candidate.role,
    candidate.location,
    ...(candidate.sources || []).map((source) => `${source.title} ${source.snippet}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function extractCompany(query, role) {
  const match = query.match(/\b(?:at|inside|from|works at|working at|for)\s+([a-z0-9][a-z0-9 .&-]+)/i);
  if (!match) return knownCompany(query);

  return tidyCompany(match[1], role);
}

function knownCompany(query) {
  const known = ['OpenAI', 'Google', 'Meta', 'Apple', 'Microsoft', 'Amazon', 'NVIDIA', 'ScaleKit', 'Apify'];
  return known.find((company) => new RegExp(`\\b${company}\\b`, 'i').test(query)) || '';
}

function tidyCompany(value, role) {
  let company = value
    .replace(/[?.!,].*$/, '')
    .replace(/\b(?:in|near|around)\s+(?:sf|san francisco|bay area|silicon valley|yerevan|armenia|new york|nyc|london)\b.*$/i, '')
    .replace(/\b(who|that|with|and|or|near|around)\b.*$/i, '')
    .replace(/\b(people|person|someone|anyone|armenian|armenians|works|work)\b/gi, '')
    .trim();

  if (role) company = company.replace(new RegExp(`\\b${role}\\b`, 'gi'), '').trim();
  return company.split(/\s+/).slice(0, 4).join(' ');
}

function extractCompanyFromText(title, content) {
  const source = `${title}\n${content}`;
  const match =
    source.match(/\bExperience:\s*([^·\n|]+)/i) ||
    source.match(/\b(?:at|@)\s+([A-Z][A-Za-z0-9 .&-]{1,40})/) ||
    title.match(/^[^-|]+-\s*([^|·\n]{2,40})(?:\s*\||$)/);
  return tidyCompany(match?.[1] || '', '');
}

function extractLocation(text) {
  const locations = [
    ['San Francisco', /\b(sf|san francisco)\b/i],
    ['Bay Area', /\b(bay area|silicon valley)\b/i],
    ['Santa Clara', /\bsanta clara\b/i],
    ['San Jose', /\bsan jose\b/i],
    ['Palo Alto', /\bpalo alto\b/i],
    ['Mountain View', /\bmountain view\b/i],
    ['Sunnyvale', /\bsunnyvale\b/i],
    ['Cupertino', /\bcupertino\b/i],
    ['Yerevan', /\byerevan\b/i],
    ['Armenia', /\barmenia\b/i],
    ['New York', /\b(new york|nyc)\b/i],
    ['London', /\blondon\b/i],
  ];
  return locations.find(([, pattern]) => pattern.test(text))?.[0] || '';
}

function extractName(title, url) {
  const fromTitle = title
    .replace(/\s+\|\s+LinkedIn.*$/i, '')
    .replace(/\s+-\s+LinkedIn.*$/i, '')
    .split(/\s[-|]\s/)[0]
    .replace(/\b(profile|people|search|result)\b/gi, '')
    .trim();

  if (looksLikeName(fromTitle)) return fromTitle;

  const slug = url?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] || '';
  const fromSlug = slug
    .replace(/-[a-z]?\d[a-z0-9-]*$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\d+/g, '')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return looksLikeName(fromSlug) ? fromSlug : '';
}

function looksLikeName(value) {
  const words = value.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-Za-z'.-]+$/.test(word));
}

function isLowQualityTitle(value) {
  return /linkedin|google search|sign in|directory|profiles|people results/i.test(value);
}

function bestUrl(item) {
  return (
    item.profileUrl ||
    item.linkedinUrl ||
    item.linkedInUrl ||
    item.linkedinProfileUrl ||
    item.url ||
    item.link ||
    item.href ||
    item.pageUrl ||
    item.loadedUrl ||
    item.searchResult?.url ||
    item.metadata?.url ||
    ''
  );
}

function cleanHeadline(title, content) {
  if (title && !isLowQualityTitle(title)) return title;
  return firstSentence(content);
}

function inferRole(headline, fallback) {
  return ROLE_PATTERNS.find(([, pattern]) => pattern.test(headline))?.[0] || fallback || '';
}

function firstSentence(value) {
  return textOf(value).replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]?.slice(0, 240) || '';
}

function contextWindow(value) {
  return textOf(value).replace(/\s+/g, ' ').slice(0, 1800);
}

function identityKey(name, company, url) {
  const linkedIn = url?.match(/linkedin\.com\/in\/[^/?#]+/i)?.[0].toLowerCase();
  return linkedIn || `${name}:${company}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((item) => {
    const key = `${item.type}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function trimProfileNoise(value) {
  return textOf(value)
    .split(/\n(?:Other similar profiles|Explore more posts|Explore collaborative articles|Add new skills with these courses)\b/i)[0]
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function companyFromEmployeeItem(item, metadata, content) {
  const value =
    item.companyName ||
    item.company ||
    item.currentCompany ||
    item.organization ||
    '';
  if (!value) return '';

  // Some Apify employee actors fall back to Google SERP and return low-confidence
  // profiles that merely mention the target company. Do not turn that target
  // company into a verified current employer unless the profile text supports it.
  if (item.source === 'google-serp-unverified' && item.confidence === 'low') {
    const target = metadata.targetCompany || value;
    return hasCompanyTextEvidence(content, target) ? tidyCompany(textOf(value), '') : '';
  }

  return tidyCompany(textOf(value), '');
}

function hasVerifiedCompanyItem(item, metadata, content) {
  const value = item.companyName || item.company || item.currentCompany || item.organization || '';
  if (!value) return false;
  if (item.source === 'google-serp-unverified' && item.confidence === 'low') {
    return hasCompanyTextEvidence(content, metadata.targetCompany || value);
  }
  return true;
}

function hasCompanyTextEvidence(content, company) {
  if (!company) return false;
  const escaped = escapeRegExp(company);
  return [
    new RegExp(`\\b(?:experience|current|works?|working)\\s*:?\\s*(?:at|@)?\\s*${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:at|@)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b${escaped}\\s*[·|,-]\\s*(?:engineering|sales|product|research|gtm|ai|ml|software|labs?)\\b`, 'i'),
    new RegExp(`\\b[A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){1,3}\\s+-\\s+${escaped}\\b`, 'i'),
  ].some((pattern) => pattern.test(content));
}

function hasArmenianSurnameSignal(lastName) {
  const normalized = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.length < 5 || NON_ARMENIAN_SURNAME_FALSE_POSITIVES.has(normalized)) return false;
  return /(ian|yan|uni|ents|yants)$/.test(normalized);
}
