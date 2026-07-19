import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { candidateMergeKey, mergeStoredCandidate } from './merge.js';

// Synthetic demo and deterministic fixture state must never share durable files
// with live people. Namespacing the entire store prevents same-name/no-URL demo
// records from merging into real profiles or searches.
const storeDataDir = ['demo', 'fixture'].includes(config.apifyMode)
  ? path.join(config.dataDir, '.sandbox', config.apifyMode)
  : config.dataDir;

const paths = {
  contacts: path.join(storeDataDir, 'contacts.json'),
  profiles: path.join(storeDataDir, 'profiles.json'),
  searches: path.join(storeDataDir, 'searches.json'),
  leads: path.join(storeDataDir, 'leads.json'),
  rawRuns: path.join(storeDataDir, 'raw-runs'),
};

export function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

async function ensureStore() {
  await fs.mkdir(storeDataDir, { recursive: true });
  await fs.mkdir(paths.rawRuns, { recursive: true });
}

async function readJson(filePath, fallback) {
  await ensureStore();
  try {
    const body = await fs.readFile(filePath, 'utf8');
    return JSON.parse(body);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

let writeSeq = 0;

async function writeJson(filePath, value) {
  await ensureStore();
  // Unique temp name so concurrent writers never collide on the same tmp file.
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${writeSeq++}.tmp`;
  // Profiles contain inferred ethnicity, contact evidence, and private lead
  // notes. Keep new files readable only by the account running the app.
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

// Per-file promise chain: serializes read-modify-write cycles so two concurrent
// searches can't both read a JSON file and clobber each other's appended records.
const fileLocks = new Map();

function withFileLock(filePath, fn) {
  const prior = fileLocks.get(filePath) || Promise.resolve();
  const next = prior.then(fn, fn);
  fileLocks.set(
    filePath,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

const RAW_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Genuine zero-result runs are cached too (so repeats don't re-bill paid actors),
// but expire quickly since data may appear later.
const EMPTY_RUN_TTL_MS = 60 * 60 * 1000;

export async function getRawRun(cacheKey, maxAgeMs = RAW_RUN_TTL_MS) {
  const filePath = path.join(paths.rawRuns, `${cacheKey}.json`);
  try {
    const run = JSON.parse(await fs.readFile(filePath, 'utf8'));
    // Expire stale cache entries so results refresh over time.
    const ttl = run.empty || !(run.items || []).length ? Math.min(maxAgeMs, EMPTY_RUN_TTL_MS) : maxAgeMs;
    if (run.cachedAt && Date.now() - Date.parse(run.cachedAt) > ttl) return null;
    return run;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveRawRun(cacheKey, payload) {
  const filePath = path.join(paths.rawRuns, `${cacheKey}.json`);
  await writeJson(filePath, {
    ...payload,
    cachedAt: nowIso(),
  });
  await pruneRawRunCache();
}

async function pruneRawRunCache() {
  const lockPath = path.join(paths.rawRuns, '.prune-lock');
  return withFileLock(lockPath, async () => {
    const entries = (await fs.readdir(paths.rawRuns, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    const files = (await Promise.all(entries.map(async (entry) => {
      const filePath = path.join(paths.rawRuns, entry.name);
      try {
        const stat = await fs.stat(filePath);
        return { filePath, modifiedAt: stat.mtimeMs };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }))).filter(Boolean);
    const cutoff = Date.now() - RAW_RUN_TTL_MS;
    const expired = files.filter((file) => file.modifiedAt < cutoff);
    const retained = files
      .filter((file) => file.modifiedAt >= cutoff)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const overflow = retained.slice(config.rawRunCacheMaxFiles);
    await Promise.all([...expired, ...overflow].map((file) => fs.rm(file.filePath, { force: true })));
  });
}

export async function listProfiles() {
  return readJson(paths.profiles, []);
}

export async function listContacts() {
  return readJson(paths.contacts, []);
}

export async function searchContacts(intent) {
  const contacts = await listContacts();
  const queryParts = [
    intent.company,
    intent.role,
    intent.location,
    ...(intent.locationAlternates || []),
    intent.originalQuery,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return contacts
    .map((contact) => ({
      ...contact,
      cacheScore: contactCacheScore(contact, queryParts, intent),
    }))
    .filter((contact) => contact.cacheScore > 0)
    .sort((a, b) => b.cacheScore - a.cacheScore)
    .slice(0, 20);
}

// The full accumulated "ultimate list" of everyone we've ever found, merged with
// any saved lead status/notes, newest first. Optional free-text filter q.
export async function listContactsWithLeads(q = '') {
  const [contacts, leads] = await Promise.all([listContacts(), listLeads()]);
  const leadByPerson = new Map(leads.map((lead) => [lead.personId, lead]));
  const needle = String(q || '').trim().toLowerCase();

  return contacts
    .map((contact) => ({ ...contact, lead: leadByPerson.get(contact.id) || null }))
    .filter((contact) => {
      if (!needle) return true;
      const haystack = [
        contact.name,
        contact.headline,
        contact.company,
        contact.role,
        contact.location,
        ...(contact.tags || []),
        ...(contact.aliases || []),
        contact.lastMatchedQuery,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    })
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

export async function upsertContactsFromProfiles(profiles, context = {}) {
  return withFileLock(paths.contacts, async () => upsertContactsFromProfilesLocked(profiles, context));
}

async function upsertContactsFromProfilesLocked(profiles, context = {}) {
  const contacts = await listContacts();
  const saved = [];

  for (const profile of profiles) {
    const key = candidateMergeKey(profile) || profile.identityKey;
    const indexes = matchingRecordIndexes(contacts, key);
    const targets = indexes.length ? indexes : [contacts.length];
    let primary;

    for (const index of targets) {
      const existing = contacts[index];
      const combined = mergeStoredCandidate(existing, profile);
      const timestamp = nowIso();
      const contact = {
        ...combined,
        // Preserve every existing durable ID. URL-variant duplicates may be
        // referenced by leads/search history, so collapsing them here would
        // orphan those references.
        id: existing?.id || profile.id || `contact_${hashValue(key)}`,
        identityKey: combined.identityKey || key,
        aliases: mergeStrings(combined.aliases || [], [profile.name]),
        tags: mergeStrings(combined.tags || [], [
          profile.company,
          profile.role,
          profile.location,
          context.query,
        ]),
        lastMatchedQuery: context.query || existing?.lastMatchedQuery || '',
        // Record freshness comes from the underlying actor observation, not the
        // time this cached contact happened to be read again.
        lastObservedAt:
          latestSourceObservation(profile.sources) ||
          existing?.lastObservedAt ||
          existing?.updatedAt ||
          timestamp,
        updatedAt: timestamp,
        createdAt: existing?.createdAt || timestamp,
      };
      contacts[index] = contact;
      primary ||= contact;
    }

    saved.push(primary);
  }

  await writeJson(paths.contacts, contacts);
  return saved;
}

export async function upsertProfiles(candidates) {
  return withFileLock(paths.profiles, async () => upsertProfilesLocked(candidates));
}

async function upsertProfilesLocked(candidates) {
  const profiles = await listProfiles();
  const saved = [];

  for (const candidate of candidates) {
    const key = candidateMergeKey(candidate) || candidate.identityKey;
    const indexes = matchingRecordIndexes(profiles, key);
    const targets = indexes.length ? indexes : [profiles.length];
    let primary;

    for (const index of targets) {
      const existing = profiles[index];
      const combined = mergeStoredCandidate(existing, candidate);
      const timestamp = nowIso();
      const merged = {
        ...combined,
        id: existing?.id || candidate.id || `person_${hashValue(key)}`,
        identityKey: combined.identityKey || key,
        createdAt: existing?.createdAt || candidate.createdAt || timestamp,
        updatedAt: timestamp,
      };
      profiles[index] = merged;
      primary ||= merged;
    }

    saved.push(primary);
  }

  await writeJson(paths.profiles, profiles);
  return saved;
}

function matchingRecordIndexes(records, key) {
  const indexes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const recordKey = candidateMergeKey(record) || record.identityKey || record.id;
    if (recordKey === key) indexes.push(index);
  }
  return indexes;
}

function mergeStrings(left, right) {
  return [...new Set([...left, ...right].filter(Boolean).map((value) => String(value)))];
}

function contactCacheScore(contact, queryParts, intent) {
  if (intent.company && contact.company?.toLowerCase() !== String(intent.company).toLowerCase()) {
    return 0;
  }
  if (intent.company && !hasVerifiedContactCompanyEvidence(contact, intent.company)) {
    return 0;
  }

  const haystack = [
    contact.name,
    contact.headline,
    contact.company,
    contact.role,
    contact.location,
    ...(contact.aliases || []),
    ...(contact.tags || []),
    ...(contact.evidence || []).map((item) => item.text),
    ...(contact.sources || []).map((source) => `${source.title} ${source.snippet}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const part of queryParts) {
    if (part && haystack.includes(part)) score += 10;
  }
  if (intent.company && contact.company?.toLowerCase() === String(intent.company).toLowerCase()) score += 30;
  if (intent.location && contact.location?.toLowerCase().includes(String(intent.location).toLowerCase())) score += 15;
  // Word-boundary identity match only. The old /(...|yan|ian)/ substring test
  // matched Ryan, Brian, median, and Australian, corrupting cache ranking.
  if (/\b(armenian|armenian-american|armenia|yerevan|hayastan)\b/i.test(haystack)) score += 10;
  return score;
}

function hasVerifiedContactCompanyEvidence(contact, company) {
  const target = normalizeCompany(company);
  if (normalizeCompany(contact.company) !== target) return false;

  return (contact.sources || []).some((source) => {
    if (source.kind === 'contact-cache') return false;
    const text = `${source.title || ''} ${source.snippet || ''} ${source.affiliationEvidence || ''}`;
    if (hasHistoricalOrNegatedCompanyCue(text, company)) return false;

    const affiliations = [source.affiliationCompany, ...(source.affiliationCompanies || [])]
      .map(normalizeCompany)
      .filter(Boolean);
    if (source.affiliationVerified && affiliations.length) return affiliations.includes(target);

    const escaped = escapeRegExp(company);
    return [
      new RegExp(`\\bExperience\\s*:\\s*${escaped}\\b`, 'i'),
      new RegExp(`\\b(?:works?|working|employed|currently)\\s+(?:at|with|for)\\s+${escaped}\\b`, 'i'),
      new RegExp(`\\b(?:at|@)\\s+${escaped}\\b`, 'i'),
    ].some((pattern) => pattern.test(text));
  });
}

function hasHistoricalOrNegatedCompanyCue(text, company) {
  const escaped = escapeRegExp(company);
  return [
    new RegExp(`\\b(?:ex|former(?:ly)?|previously)\\s*[-–—,:|]?(?:\\s+(?:at|with|for))?\\s*${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:(?:left|departed)(?:\\s+from)?|departing\\s+from)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bno\\s+longer\\s+(?:at|with|working\\s+(?:at|with|for))\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:is|am|are|was|were)?\\s*(?:not|never)\\s+(?:currently\\s+)?(?:(?:working|employed)\\s+)?(?:at|with|for)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:do|does|did)\\s+not\\s+(?:work|working)\\s+(?:at|with|for)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bnever\\s+(?:worked|working|employed)\\s+(?:at|with|for|by)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bnot\\s+employed\\s+(?:at|with|for|by)\\s+${escaped}\\b`, 'i'),
  ].some((pattern) => pattern.test(text));
}

function latestSourceObservation(sources) {
  const timestamps = (sources || [])
    .flatMap((source) => [
      source?.observedAt,
      ...(source?.observations || []).map((observation) => observation?.observedAt),
    ])
    .filter((value) => Number.isFinite(Date.parse(value)))
    .map(String)
    .sort();
  return timestamps.at(-1) || '';
}

function normalizeCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:incorporated|inc|llc|ltd|corp|corporation)\.?$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getSearch(searchKey) {
  const searches = await readJson(paths.searches, []);
  return searches.find((search) => search.searchKey === searchKey) || null;
}

export async function listSearches() {
  const searches = await readJson(paths.searches, []);
  return searches
    .slice()
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

export async function saveSearch(search) {
  return withFileLock(paths.searches, async () => {
    const searches = await readJson(paths.searches, []);
    const next = [
      ...searches.filter((entry) => entry.searchKey !== search.searchKey),
      {
        ...search,
        updatedAt: nowIso(),
        createdAt: search.createdAt || nowIso(),
      },
    ].slice(-config.searchHistoryMaxEntries);
    await writeJson(paths.searches, next);
  });
}

export async function listLeads() {
  return readJson(paths.leads, []);
}

export async function upsertLead({ personId, status = 'saved', notes = '' }) {
  return withFileLock(paths.leads, async () => {
    const leads = await listLeads();
    const existing = leads.find((lead) => lead.personId === personId);
    const lead = {
      personId,
      status,
      notes,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    await writeJson(paths.leads, [...leads.filter((entry) => entry.personId !== personId), lead]);

    return lead;
  });
}
