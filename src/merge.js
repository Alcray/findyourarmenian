const CONFIDENCE_LABEL_RANK = new Map([
  ['reject', 0],
  ['unknown', 1],
  ['low', 2],
  ['weak', 2],
  ['possible', 3],
  ['medium', 4],
  ['likely', 4],
  ['high', 5],
  ['strong', 5],
]);

const SOURCE_KIND_RANK = new Map([
  ['contact-cache', 1],
  ['web-search', 2],
  ['surname-seed', 3],
  ['company-employees', 4],
  ['profile-search', 5],
  ['enrichment', 6],
]);

const RICH_TEXT_FIELDS = ['name', 'headline', 'company', 'role', 'location'];
const RICH_SOURCE_FIELDS = ['title', 'snippet', 'context', 'targetCompany'];
const CURRENT_SOURCE_FIELDS = [
  'title',
  'snippet',
  'context',
  'targetCompany',
  'affiliationCompany',
  'affiliationEvidence',
  'affiliationVerified',
  'affiliationStructured',
  'sourceConfidence',
  'sourceType',
  'kind',
  'actorId',
  'query',
  'cached',
  'demo',
  'fixture',
  'shared',
  'observedAt',
];

/**
 * Return one stable LinkedIn profile URL, or an empty string when the input is
 * not an HTTP(S) linkedin.com profile URL. In particular, substring lookalikes
 * such as notlinkedin.com are never accepted as LinkedIn identities.
 */
export function canonicalLinkedInProfileUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return '';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'linkedin.com' && !hostname.endsWith('.linkedin.com')) return '';

  const match = parsed.pathname.match(/^\/in\/([^/]+)\/?$/i);
  if (!match) return '';

  let decodedSlug;
  try {
    decodedSlug = decodeURIComponent(match[1]);
  } catch {
    return '';
  }
  if (!decodedSlug || /[\s/?#]/u.test(decodedSlug)) return '';

  // Decode unreserved percent-encoding before re-encoding deterministically so
  // `/aram-hakobyan` and `/aram%2Dhakobyan` share one identity.
  const slug = encodeURIComponent(decodedSlug.normalize('NFKC').toLowerCase());
  return `https://www.linkedin.com/in/${slug}`;
}

export function canonicalSourceKey(source = {}) {
  const linkedInUrl = canonicalLinkedInProfileUrl(source.url);
  if (linkedInUrl) return linkedInUrl;

  const normalizedUrl = normalizeHttpUrl(source.url);
  if (normalizedUrl) return normalizedUrl;

  return [source.kind, source.actorId, source.title, source.query]
    .filter(Boolean)
    .map(normalizeKeyPart)
    .join(':');
}

/** Stable key used by agents and persistence, including migration of old keys. */
export function candidateMergeKey(candidate = {}) {
  const canonicalUrl = candidateLinkedInUrl(candidate);
  if (canonicalUrl) return canonicalUrl;

  const explicitProfileUrls = [candidate.profileUrl, candidate.linkedinUrl, candidate.linkedInUrl].filter(Boolean);
  const identity = String(candidate.identityKey || '').trim();
  if (identity) {
    // Older records used `linkedin.com/in/slug` without a scheme. Migrate those
    // only when there is no explicit invalid profile URL contradicting the key.
    const legacyLinkedIn = explicitProfileUrls.length ? '' : canonicalLegacyLinkedInIdentity(identity);
    if (legacyLinkedIn) return legacyLinkedIn;
    if (!/linkedin\.com\/in\//i.test(identity)) return normalizeKeyPart(identity);
  }

  const name = normalizeKeyPart(candidate.name);
  const company = normalizeKeyPart(candidate.company);
  if (name) return `${name}:${company}`;
  return normalizeKeyPart(candidate.id);
}

export function mergeSources(left = [], right = []) {
  const merged = new Map();

  for (const source of [...arrayOf(left), ...arrayOf(right)]) {
    if (!source || typeof source !== 'object') continue;
    const key = canonicalSourceKey(source);
    if (!key) continue;
    const previous = merged.get(key);
    merged.set(key, previous ? mergeSource(previous, source) : normalizeSource(source));
  }

  return [...merged.values()];
}

export function mergeEvidence(left = [], right = []) {
  const merged = new Map();

  for (const item of [...arrayOf(left), ...arrayOf(right)]) {
    if (!item) continue;
    const evidence = typeof item === 'string' ? { type: 'source', text: item } : item;
    const key = `${normalizeKeyPart(evidence.type)}:${normalizeKeyPart(evidence.text)}`;
    if (key === ':') continue;
    const previous = merged.get(key);
    merged.set(key, previous ? mergeObjectsMonotonically(previous, evidence) : { ...evidence });
  }

  return [...merged.values()];
}

/**
 * Field-level candidate merge. It is intentionally monotonic: confidence and
 * labels can only strengthen, arrays accumulate, and richer profile text wins
 * regardless of arrival order.
 */
export function mergeCandidates(left, right) {
  if (!left && !right) return {};
  if (!left) return normalizeCandidate(right);
  if (!right) return normalizeCandidate(left);

  const leftScore = candidateRichness(left);
  const rightScore = candidateRichness(right);
  const primary = rightScore > leftScore ? right : left;
  const secondary = primary === left ? right : left;
  const merged = { ...secondary, ...primary };

  for (const field of RICH_TEXT_FIELDS) {
    merged[field] = richerText(left[field], right[field]);
  }

  const canonicalUrl = candidateLinkedInUrl(left) || candidateLinkedInUrl(right);
  merged.profileUrl = canonicalUrl || richerText(left.profileUrl, right.profileUrl);
  merged.identityKey = canonicalUrl || preferredIdentityKey(left, right, merged);
  merged.sources = mergeSources(left.sources, right.sources);
  merged.evidence = mergeEvidence(left.evidence, right.evidence);
  merged.confidence = Math.max(numberOrZero(left.confidence), numberOrZero(right.confidence));
  merged.confidenceLabel = strongestLabel(left.confidenceLabel, right.confidenceLabel);
  merged.affiliationVerified = Boolean(left.affiliationVerified || right.affiliationVerified);

  for (const field of ['aliases', 'tags', 'concerns', 'topics']) {
    const values = mergeStrings(left[field], right[field]);
    if (values.length || left[field] || right[field]) merged[field] = values;
  }

  if (left.createdAt || right.createdAt) merged.createdAt = earliestIso(left.createdAt, right.createdAt);
  if (left.updatedAt || right.updatedAt) merged.updatedAt = latestIso(left.updatedAt, right.updatedAt);

  return merged;
}

/**
 * Merge a newly observed profile into persisted state. Historical sources stay
 * auditable, but current facts and confidence come from the new observation so
 * an employer/role/location correction is not blocked by an older longer bio.
 */
export function mergeStoredCandidate(existing, incoming) {
  const merged = mergeCandidates(existing, incoming);
  if (!existing || !incoming || !hasObservedSource(incoming)) return merged;

  // Sources sharing one LinkedIn URL are deduped, but the latest observation
  // must own scalar "current" facts. Otherwise a longer old OpenAI biography
  // can survive a fresh structured Meta result and contradict the candidate.
  // Historical companies/kinds/queries remain in the accumulated array fields.
  merged.sources = mergeSourcesWithCurrentFacts(existing.sources, incoming.sources);

  // Missing fields mean "not present in this result", not "known empty". Keep
  // richer durable facts unless the new source explicitly says the old company
  // or role is no longer current. Scores and Gemini output are query-specific;
  // current search snapshots carry those without rewriting the person record.
  for (const field of ['headline', 'company', 'role', 'location']) {
    if (hasMeaningfulValue(incoming[field])) merged[field] = cloneValue(incoming[field]);
  }
  if (Array.isArray(incoming.topics) && incoming.topics.length) merged.topics = [...incoming.topics];
  if (!incoming.company && explicitlyInvalidatesCompany(existing.company, incoming.sources)) {
    merged.company = '';
    merged.affiliationVerified = false;
  }
  if (!incoming.role && explicitlyInvalidatesRole(existing.role, incoming.sources)) merged.role = '';
  if (incoming.name) merged.name = incoming.name;
  return merged;
}

// Runtime cache + fresh discovery needs the latest query score/judgment, while
// durable person records keep their strongest historical score. This explicit
// split prevents one search from retroactively changing another search's rank.
export function mergeFreshCandidate(existing, incoming) {
  const merged = mergeStoredCandidate(existing, incoming);
  for (const field of [
    'armenianScore',
    'confidence',
    'confidenceLabel',
    'needsVerification',
    'displayBucket',
    'geminiJudgment',
    'outreachAngle',
  ]) {
    if (Object.hasOwn(incoming || {}, field)) merged[field] = cloneValue(incoming[field]);
  }
  return merged;
}

export function attachDurableIdentity(observedCandidates = [], persistedCandidates = []) {
  return observedCandidates.map((candidate, index) => {
    const persisted = persistedCandidates[index] || {};
    return {
      ...candidate,
      id: persisted.id || candidate.id,
      identityKey: persisted.identityKey || candidate.identityKey,
      createdAt: persisted.createdAt || candidate.createdAt,
      updatedAt: persisted.updatedAt || candidate.updatedAt,
    };
  });
}

function mergeSourcesWithCurrentFacts(existingSources, incomingSources) {
  const merged = mergeSources(existingSources, incomingSources);
  const indexByKey = new Map(merged.map((source, index) => [canonicalSourceKey(source), index]));

  for (const source of arrayOf(incomingSources)) {
    if (!source || typeof source !== 'object' || source.kind === 'contact-cache') continue;
    const index = indexByKey.get(canonicalSourceKey(source));
    if (index === undefined) continue;
    const current = { ...merged[index] };
    for (const field of CURRENT_SOURCE_FIELDS) {
      if (Object.hasOwn(source, field)) current[field] = cloneValue(source[field]);
    }
    merged[index] = current;
  }
  return merged;
}

export function mergeCandidatesByIdentity(candidates = []) {
  const merged = new Map();

  for (const candidate of arrayOf(candidates)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const key = candidateMergeKey(candidate);
    if (!key) continue;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, normalizeCandidate(candidate));
      continue;
    }
    // Cache candidates are intentionally added before fresh discovery. When a
    // later non-cache observation arrives, let it correct current facts while
    // preserving the historical source trail.
    const previousFromCache = hasContactCacheSource(previous);
    const candidateFromCache = hasContactCacheSource(candidate);
    merged.set(
      key,
      previousFromCache && !candidateFromCache
        ? mergeFreshCandidate(previous, candidate)
        : mergeCandidates(previous, candidate),
    );
  }

  return [...merged.values()];
}

function normalizeCandidate(candidate) {
  const normalized = { ...candidate };
  const canonicalUrl = candidateLinkedInUrl(candidate);
  if (canonicalUrl) {
    normalized.profileUrl = canonicalUrl;
    normalized.identityKey = canonicalUrl;
  }
  normalized.sources = mergeSources([], candidate.sources);
  normalized.evidence = mergeEvidence([], candidate.evidence);
  return normalized;
}

function normalizeSource(source) {
  const normalized = { ...source };
  const canonicalUrl = canonicalLinkedInProfileUrl(source.url);
  if (canonicalUrl) normalized.url = canonicalUrl;
  normalized.queries = mergeStrings(source.queries, source.query);
  normalized.actorIds = mergeStrings(source.actorIds, source.actorId);
  normalized.kinds = mergeStrings(source.kinds, source.kind);
  normalized.affiliationCompanies = mergeStrings(source.affiliationCompanies, source.affiliationCompany);
  normalized.provenances = mergeStrings(
    source.provenances,
    source.fixture ? 'fixture' : source.demo ? 'demo' : 'live',
  );
  normalized.observations = mergeSourceObservations(source.observations, [sourceObservation(source)]);
  return normalized;
}

function mergeSource(left, right) {
  const primary = sourceRichness(right) > sourceRichness(left) ? right : left;
  const secondary = primary === left ? right : left;
  const merged = { ...secondary, ...primary };

  for (const field of RICH_SOURCE_FIELDS) {
    merged[field] = richerText(left[field], right[field]);
  }

  merged.url = canonicalLinkedInProfileUrl(left.url) || canonicalLinkedInProfileUrl(right.url) || primary.url || secondary.url || '';
  merged.kind = strongestSourceKind(left.kind, right.kind);
  merged.sourceConfidence = strongestLabel(left.sourceConfidence, right.sourceConfidence);
  merged.affiliationVerified = Boolean(left.affiliationVerified || right.affiliationVerified);
  merged.queries = mergeStrings([...(arrayOf(left.queries)), left.query], [...(arrayOf(right.queries)), right.query]);
  merged.actorIds = mergeStrings([...(arrayOf(left.actorIds)), left.actorId], [...(arrayOf(right.actorIds)), right.actorId]);
  merged.kinds = mergeStrings([...(arrayOf(left.kinds)), left.kind], [...(arrayOf(right.kinds)), right.kind]);
  merged.affiliationCompanies = mergeStrings(
    [...arrayOf(left.affiliationCompanies), left.affiliationCompany],
    [...arrayOf(right.affiliationCompanies), right.affiliationCompany],
  );
  merged.provenances = mergeStrings(
    [...arrayOf(left.provenances), left.fixture ? 'fixture' : left.demo ? 'demo' : 'live'],
    [...arrayOf(right.provenances), right.fixture ? 'fixture' : right.demo ? 'demo' : 'live'],
  );
  merged.observations = mergeSourceObservations(
    left.observations,
    right.observations,
    [sourceObservation(left), sourceObservation(right)],
  );

  return merged;
}

function sourceObservation(source = {}) {
  const observation = {};
  for (const field of CURRENT_SOURCE_FIELDS) {
    if (Object.hasOwn(source, field) && source[field] !== '' && source[field] != null) {
      observation[field] = cloneValue(source[field]);
    }
  }
  if (source.url) observation.url = canonicalLinkedInProfileUrl(source.url) || source.url;
  return observation;
}

function mergeSourceObservations(...groups) {
  const seen = new Set();
  const observations = [];
  for (const observation of groups.flatMap(arrayOf)) {
    if (!observation || typeof observation !== 'object' || !Object.keys(observation).length) continue;
    const key = JSON.stringify(observation);
    if (seen.has(key)) continue;
    seen.add(key);
    observations.push({ ...observation });
  }
  return observations.slice(-50);
}

function candidateLinkedInUrl(candidate) {
  const urls = [
    candidate.profileUrl,
    candidate.linkedinUrl,
    candidate.linkedInUrl,
    ...arrayOf(candidate.sources).map((source) => source?.url),
  ];
  for (const url of urls) {
    const canonical = canonicalLinkedInProfileUrl(url);
    if (canonical) return canonical;
  }
  return '';
}

function canonicalLegacyLinkedInIdentity(identity) {
  if (!/^linkedin\.com\/in\/[^/?#]+\/?$/i.test(identity)) return '';
  return canonicalLinkedInProfileUrl(`https://${identity}`);
}

function preferredIdentityKey(left, right, merged) {
  for (const candidate of [left, right]) {
    const identity = String(candidate.identityKey || '').trim();
    if (identity && !/linkedin\.com\/in\//i.test(identity)) return normalizeKeyPart(identity);
  }

  const name = normalizeKeyPart(merged.name);
  const company = normalizeKeyPart(merged.company);
  return name ? `${name}:${company}` : normalizeKeyPart(merged.id);
}

function sourceRichness(source = {}) {
  const kindRank = SOURCE_KIND_RANK.get(normalizeKeyPart(source.kind)) || 0;
  return (
    stringLength(source.context) * 4 +
    stringLength(source.snippet) * 2 +
    stringLength(source.title) +
    kindRank * 200 +
    (source.affiliationVerified ? 400 : 0) +
    populatedFieldCount(source) * 8
  );
}

function candidateRichness(candidate = {}) {
  return (
    stringLength(candidate.headline) * 3 +
    stringLength(candidate.company) * 2 +
    stringLength(candidate.location) * 2 +
    arrayOf(candidate.sources).reduce((total, source) => total + sourceRichness(source), 0) +
    arrayOf(candidate.evidence).length * 30 +
    populatedFieldCount(candidate) * 5
  );
}

function strongestSourceKind(left, right) {
  const leftRank = SOURCE_KIND_RANK.get(normalizeKeyPart(left)) || 0;
  const rightRank = SOURCE_KIND_RANK.get(normalizeKeyPart(right)) || 0;
  return rightRank > leftRank ? right || left || '' : left || right || '';
}

function strongestLabel(left, right) {
  const leftRank = CONFIDENCE_LABEL_RANK.get(normalizeKeyPart(left)) || 0;
  const rightRank = CONFIDENCE_LABEL_RANK.get(normalizeKeyPart(right)) || 0;
  return rightRank > leftRank ? right || left || '' : left || right || '';
}

function richerText(left, right) {
  const leftText = typeof left === 'string' ? left.trim() : '';
  const rightText = typeof right === 'string' ? right.trim() : '';
  if (!leftText) return rightText;
  if (!rightText) return leftText;
  return informationScore(rightText) > informationScore(leftText) ? rightText : leftText;
}

function informationScore(value) {
  const words = value.split(/\s+/u).filter(Boolean).length;
  return value.length + words * 8;
}

function mergeObjectsMonotonically(left, right) {
  const merged = { ...left, ...right };
  for (const [key, value] of Object.entries(left)) {
    if (typeof value === 'boolean' && typeof right[key] === 'boolean') merged[key] = value || right[key];
    if (typeof value === 'string' && typeof right[key] === 'string') merged[key] = richerText(value, right[key]);
  }
  return merged;
}

function mergeStrings(left, right) {
  const values = [...arrayOf(left), ...arrayOf(right)].filter(Boolean).map((value) => String(value));
  const seen = new Set();
  return values.filter((value) => {
    const key = normalizeKeyPart(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeKeyPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hasObservedSource(candidate) {
  return arrayOf(candidate.sources).some((source) => source && source.kind !== 'contact-cache');
}

function hasContactCacheSource(candidate) {
  return arrayOf(candidate.sources).some(
    (source) => source?.kind === 'contact-cache' || arrayOf(source?.kinds).includes('contact-cache'),
  );
}

function cloneValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return { ...value };
  return value;
}

function hasMeaningfulValue(value) {
  return typeof value === 'string' ? Boolean(value.trim()) : value != null;
}

function explicitlyInvalidatesCompany(company, sources) {
  if (!company) return false;
  const escaped = escapeRegExp(company);
  const text = sourceFactText(sources);
  return [
    new RegExp(`\\b(?:ex|former(?:ly)?|previously)\\s*[-–—,:|]?(?:\\s+(?:at|with|for))?\\s*${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:(?:left|departed)(?:\\s+from)?|departing\\s+from)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bno\\s+longer\\s+(?:at|with|working\\s+(?:at|with|for))\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:not|never)\\s+(?:currently\\s+)?(?:(?:working|employed)\\s+)?(?:at|with|for)\\s+${escaped}\\b`, 'i'),
  ].some((pattern) => pattern.test(text));
}

function explicitlyInvalidatesRole(role, sources) {
  if (!role) return false;
  const escaped = escapeRegExp(role);
  return new RegExp(`\\b(?:ex|former(?:ly)?|previously|past)\\s*[-–—,:|]?\\s*(?:co[-\\s]?)?${escaped}\\b`, 'i')
    .test(sourceFactText(sources));
}

function sourceFactText(sources) {
  return arrayOf(sources)
    .map((source) => `${source?.title || ''} ${source?.snippet || ''} ${source?.affiliationEvidence || ''}`)
    .join(' ');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringLength(value) {
  return typeof value === 'string' ? value.trim().length : 0;
}

function populatedFieldCount(value) {
  return Object.values(value || {}).filter((item) => item !== '' && item != null).length;
}

function arrayOf(value) {
  if (Array.isArray(value)) return value;
  return value == null || value === '' ? [] : [value];
}

function earliestIso(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left) <= String(right) ? left : right;
}

function latestIso(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left) >= String(right) ? left : right;
}
