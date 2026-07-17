import { hashValue } from './store.js';

// Distinctive Armenian given names. Ambiguous international names (David, Karen,
// Maria, Anna, Robert) are deliberately excluded so a first name alone never
// creates a false positive. Matching adds a small signal (+12), never decisive.
const ARMENIAN_FIRST_NAMES = new Set([
  'aram', 'armen', 'arman', 'artak', 'artur', 'ashot', 'davit', 'edgar', 'gagik', 'garik',
  'gevorg', 'gor', 'grigor', 'hakob', 'hayk', 'hovhannes', 'hovik', 'levon', 'mher', 'narek',
  'nver', 'poghos', 'rafayel', 'razmik', 'ruben', 'samvel', 'sargis', 'sarkis', 'sevak',
  'suren', 'tigran', 'vahagn', 'vahe', 'vahan', 'vardan', 'vazgen', 'vigen', 'zaven', 'arsen',
  'areg', 'tatul', 'ani', 'anahit', 'armine', 'arpine', 'astghik', 'gayane', 'gohar', 'hasmik',
  'hermine', 'lilit', 'lusine', 'mane', 'mariam', 'meline', 'nairi', 'nane', 'narine', 'nvard',
  'ruzan', 'satenik', 'shushan', 'siranush', 'sona', 'tatevik', 'zaruhi', 'nune',
]);

// Curated high-frequency Armenian surnames (Eastern + Western/diaspora spellings).
// These rarely collide with other ethnicities, so an exact match is a strong signal (+30).
const COMMON_ARMENIAN_SURNAMES = new Set([
  'hakobyan', 'sargsyan', 'harutyunyan', 'grigoryan', 'khachatryan', 'vardanyan', 'petrosyan',
  'karapetyan', 'manukyan', 'hovhannisyan', 'stepanyan', 'markaryan', 'mkrtchyan', 'sahakyan',
  'avetisyan', 'ghazaryan', 'minasyan', 'simonyan', 'gasparyan', 'davtyan', 'melkonyan',
  'arakelyan', 'galstyan', 'babayan', 'kirakosyan', 'martirosyan', 'poghosyan', 'sedrakyan',
  'tumanyan', 'asatryan', 'aslanyan', 'baghdasaryan', 'danielyan', 'mnatsakanyan', 'nersisyan',
  'gevorgyan', 'nazaryan', 'tonoyan', 'zokhrabyan', 'ambartsumyan', 'hambardzumyan',
  'kardashian', 'sarkisian', 'sarkissian', 'mardirosian', 'hovsepian', 'boghossian',
  'kasparian', 'arakelian', 'tashjian', 'ohanian', 'derderian', 'hagopian', 'manoogian',
  'mouradian', 'kevorkian', 'krikorian', 'bedrosian', 'gulbenkian', 'terzian', 'avakian',
]);

// Never treat these as Armenian even though they end in -ian/-yan.
const WESTERN_GIVEN_NAMES_ENDING_IAN = new Set([
  'brian', 'sebastian', 'julian', 'adrian', 'damian', 'dorian', 'killian', 'kilian', 'fabian',
  'florian', 'lucian', 'marian', 'gillian', 'lillian', 'vivian', 'cristian', 'kristian', 'christian',
  'maximilian', 'bastian', 'demian', 'aurelian', 'cyprian', 'bryan', 'ryan', 'yan', 'ian',
]);

// Persian given names: an -ian surname beside one of these is Persian, not Armenian.
const PERSIAN_FIRST_NAMES = new Set([
  'reza', 'ali', 'mohammad', 'mohammed', 'hossein', 'hosein', 'amir', 'mehdi', 'hassan', 'hasan',
  'kazem', 'ebrahim', 'ibrahim', 'saeed', 'said', 'majid', 'vahid', 'farhad', 'kamran', 'arash',
  'babak', 'siamak', 'nima', 'pouya', 'pedram', 'omid', 'nader', 'bahram', 'jamshid', 'kaveh',
  'dariush', 'maryam', 'fatemeh', 'zahra', 'shirin', 'nasrin', 'parisa', 'laleh',
]);

// Chinese pinyin surnames: an -ian/-yan token beside one is a Chinese given name.
const CHINESE_SURNAMES = new Set([
  'li', 'zhang', 'wang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'zhou', 'sun', 'zhu',
  'guo', 'lin', 'gao', 'luo', 'zheng', 'liang', 'xie', 'tang', 'deng', 'feng',
  'cao', 'peng', 'zeng', 'xiao', 'tian', 'dong', 'yuan', 'pan', 'cai', 'jiang',
  'chan', 'chang', 'yuen', 'yeung', 'shen', 'song', 'han', 'yao', 'ding', 'du',
  'wan', 'kong', 'fang', 'jin', 'cui', 'shi', 'qin', 'hou', 'bai', 'cheng',
  'wei', 'lu', 'yu', 'ye', 'ren', 'wu', 'he', 'ma', 'hu', 'guo',
]);

const ARMENIAN_SURNAME_STRONG = 30;
const ARMENIAN_SURNAME_MEDIUM = 20;
const ARMENIAN_SURNAME_WEAK = 12;

// Surname batches used to build recall-boosting search queries (site: ... (A OR B ...)).
// Each batch becomes one web query; quality mode runs several to widen coverage.
// Batch 0 is kept stable (order + members) so cached fixtures / the bench still hit.
export const ARMENIAN_SURNAME_QUERY_BATCHES = [
  ['Hakobyan', 'Sargsyan', 'Grigoryan', 'Harutyunyan', 'Petrosyan', 'Karapetyan',
    'Vardanyan', 'Manukyan', 'Hovhannisyan', 'Khachatryan', 'Ghazaryan', 'Sarkisian'],
  ['Martirosyan', 'Avetisyan', 'Stepanyan', 'Gevorgyan', 'Sahakyan', 'Melkonyan',
    'Simonyan', 'Galstyan', 'Baghdasaryan', 'Nazaryan', 'Arakelyan', 'Minasyan'],
  ['Mkrtchyan', 'Danielyan', 'Asatryan', 'Kirakosyan', 'Poghosyan', 'Tumanyan',
    'Nersisyan', 'Gasparyan', 'Davtyan', 'Aslanyan', 'Babayan', 'Sedrakyan'],
];

// Flat list for the harvestapi surname sweep (iterates individual surnames).
// First 12 match the old order so existing sweep cache keys still hit.
export const ARMENIAN_SURNAME_QUERY_BATCH = ARMENIAN_SURNAME_QUERY_BATCHES.flat();

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

// Weaker, Armenia-linked context (place, school, employer, org). Supporting evidence,
// not proof of nationality on its own.
const ARMENIAN_CONTEXT_TERMS = [
  'armenia',
  'yerevan',
  'gyumri',
  'artsakh',
  'nagorno',
  'aua',
  'american university of armenia',
  'yerevan state university',
  'tumo',
  'picsart',
  'servicetitan',
  'synopsys armenia',
  'agbu',
  'birthright armenia',
  'homenetmen',
  'armenian apostolic',
  'armenian church',
];

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

// Query strategy is empirically tuned: the simple unquoted `site:linkedin.com/in
// <target> Armenian` form returns real Armenians at the target company, while the
// old multi-quoted form ("Armenian language" "Armenian-American") returned mostly
// non-Armenians at the wrong company. Surname-OR batches only help open/location
// recall, where there is no company to anchor affiliation.
export function buildSearchQueries(intent) {
  const target = [intent.company, intent.role, intent.location].filter(Boolean).join(' ').trim();
  // One surname-OR query per batch. Google ORs surnames natively, so these catch
  // Armenians who never write "Armenian" on their profile. The self-label query
  // comes first; discovery runs as many of the rest as the mode allows.
  const surnameBatches = ARMENIAN_SURNAME_QUERY_BATCHES.map((batch) => `(${batch.join(' OR ')})`);
  const prefix = intent.company
    ? `site:linkedin.com/in ${intent.company} ${[intent.role, intent.location].filter(Boolean).join(' ').trim()}`.trim()
    : `site:linkedin.com/in ${target}`;

  const queries = [`${prefix} Armenian`, ...surnameBatches.map((sb) => `${prefix} ${sb}`)];

  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ').trim()))].filter(Boolean).slice(0, 8);
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
  // Structured actors (harvestapi/linkedin-profile-search, enrichment) return
  // firstName/lastName + currentPositions[] instead of a flat title.
  const structuredName = joinName(item.firstName, item.lastName);
  const positions = Array.isArray(item.currentPositions) ? item.currentPositions : [];
  const topPosition = positions[0] || {};
  const positionTitle = textOf(topPosition.title || topPosition.position || topPosition.jobTitle || '');
  const positionCompany = textOf(topPosition.companyName || topPosition.company || '');

  const title = textOf(
    item.title ||
      item.jobTitle ||
      item.position ||
      item.headline ||
      positionTitle ||
      item.name ||
      item.fullName ||
      structuredName ||
      item.heading ||
      item.searchResult?.title ||
      item.metadata?.title ||
      '',
  );
  const employeeName = textOf(
    item.name || item.fullName || structuredName || item.profileName || item.employeeName || '',
  );
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
    item.summary,
    item.about,
    item.jobTitle,
    item.position,
    item.headline,
    positionTitle,
    item.company,
    item.companyName,
    positionCompany,
    typeof item.location === 'object' ? item.location?.linkedinText || item.location?.name : item.location,
    ...positions.map((p) => [p.title, p.companyName || p.company].filter(Boolean).map(textOf).join(' at ')),
    ...(Array.isArray(item.experience) ? item.experience.map((e) => textOf(e.title || e.company || e)) : []),
    ...(Array.isArray(item.education) ? item.education.map((e) => textOf(e.schoolName || e.school || e)) : []),
    ...(Array.isArray(item.skills) ? item.skills.map(textOf) : []),
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
    score += ARMENIAN_SURNAME_WEAK;
    evidence.push({ type: 'name', text: `First name is distinctively Armenian: ${candidate.name}` });
  }

  const surnameScore = armenianSurnameScore(lastName, firstName);
  if (surnameScore > 0) {
    score += surnameScore;
    const strength =
      surnameScore >= ARMENIAN_SURNAME_STRONG ? 'strong' : surnameScore >= ARMENIAN_SURNAME_MEDIUM ? 'likely' : 'possible';
    evidence.push({ type: 'name', text: `Surname is a ${strength} Armenian signal: ${candidate.name}` });
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
    .map((source) => `${source.title || ''}\n${source.snippet || ''}\n${(source.context || '').slice(0, 1200)}`)
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
    // Include the scraped/enriched body (context), capped to bound regex cost.
    // Without this, the only evidence was a <=240-char snippet.
    ...(candidate.sources || []).map(
      (source) => `${source.title || ''} ${source.snippet || ''} ${(source.context || '').slice(0, 1200)}`,
    ),
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
    item.currentPositions?.[0]?.companyName ||
    item.currentPositions?.[0]?.company ||
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
  const value =
    item.companyName ||
    item.company ||
    item.currentCompany ||
    item.organization ||
    item.currentPositions?.[0]?.companyName ||
    item.currentPositions?.[0]?.company ||
    '';
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

// Tiered Armenian surname signal with disambiguation. Returns points, not a
// boolean, so a curated surname (Hakobyan) outweighs a bare -ian ending (which
// also appears in Persian, some Greek, and Western given names like "Julian").
export function armenianSurnameScore(lastName, firstName = '') {
  const s = String(lastName).toLowerCase().replace(/[^a-z]/g, '');
  const first = String(firstName).toLowerCase().replace(/[^a-z]/g, '');
  if (s.length < 5) return 0;

  // Curated exact match always wins.
  if (COMMON_ARMENIAN_SURNAMES.has(s)) return ARMENIAN_SURNAME_STRONG;

  // The token itself is a Western given name or a Chinese surname → not Armenian.
  if (WESTERN_GIVEN_NAMES_ENDING_IAN.has(s) || CHINESE_SURNAMES.has(s)) return 0;

  // Persian surnames: -ian patronymics on Persian stems, and -zadeh/-nejad/-pour/-abadi roots.
  if (/(hossein|hosein|bahram|tehran|rahim|karim|akbar|kazem|reza|mahmoud|ahmad|abdol|gholam|mirza|sultan|mohammad|mohamed)ian$/.test(s)) {
    return 0;
  }
  if (/(zadeh|nejad|nezhad|pour|pur|abadi)$/.test(s)) return 0;

  // Base tier from the suffix. -yan and its transliterations are the strongest
  // Armenian signal; a bare -ian is more ambiguous; -ouni/-[iy]ents are weak.
  let tier = 0;
  if (/(yan|[iy]ants|[iy]antz|tsyan|dzyan)$/.test(s)) tier = ARMENIAN_SURNAME_STRONG;
  else if (/ian$/.test(s)) tier = ARMENIAN_SURNAME_MEDIUM;
  else if (/(ouni|[iy]ents)$/.test(s)) tier = ARMENIAN_SURNAME_WEAK;
  if (!tier) return 0;

  const armenianFirst = ARMENIAN_FIRST_NAMES.has(first);
  if (armenianFirst) return tier;

  // A bare (non-curated) -yan next to a Chinese given/family name is Chinese
  // pinyin, e.g. "Li Xiaoyan" — kill it even at the strong tier. Persian first
  // names do NOT trigger this: "Reza Aznavuryan" may be an Iranian-Armenian, so a
  // strong -yan ending survives (only its weaker/ambiguous forms get downgraded).
  if (CHINESE_SURNAMES.has(first)) return 0;
  if (PERSIAN_FIRST_NAMES.has(first) && tier < ARMENIAN_SURNAME_STRONG) return 0;
  return tier;
}

function joinName(first, last) {
  return [first, last].map((part) => textOf(part).trim()).filter(Boolean).join(' ');
}

// Name-only Armenian signal (surname tier + distinctive first name), independent
// of any profile/context text. Used by the metrics harness as a detector score.
export function armenianNameScore(fullName) {
  const parts = String(fullName || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 0;
  const first = parts[0];
  const last = parts.at(-1);
  let score = armenianSurnameScore(last, first);
  if (ARMENIAN_FIRST_NAMES.has(first)) score += ARMENIAN_SURNAME_WEAK;
  return score;
}
