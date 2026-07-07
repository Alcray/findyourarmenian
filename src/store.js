import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const paths = {
  contacts: path.join(config.dataDir, 'contacts.json'),
  profiles: path.join(config.dataDir, 'profiles.json'),
  searches: path.join(config.dataDir, 'searches.json'),
  leads: path.join(config.dataDir, 'leads.json'),
  rawRuns: path.join(config.dataDir, 'raw-runs'),
};

export function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

async function ensureStore() {
  await fs.mkdir(config.dataDir, { recursive: true });
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

async function writeJson(filePath, value) {
  await ensureStore();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

export async function getRawRun(cacheKey) {
  const filePath = path.join(paths.rawRuns, `${cacheKey}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
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

export async function upsertContactsFromProfiles(profiles, context = {}) {
  const contacts = await listContacts();
  const byKey = new Map(contacts.map((contact) => [contact.identityKey, contact]));
  const saved = [];

  for (const profile of profiles) {
    const existing = byKey.get(profile.identityKey);
    const contact = {
      ...(existing || {}),
      id: existing?.id || profile.id || `contact_${hashValue(profile.identityKey)}`,
      identityKey: profile.identityKey,
      name: profile.name,
      headline: profile.headline || existing?.headline || '',
      company: profile.company || existing?.company || '',
      role: profile.role || existing?.role || '',
      location: profile.location || existing?.location || '',
      profileUrl: profile.profileUrl || existing?.profileUrl || '',
      aliases: mergeStrings(existing?.aliases || [], [profile.name]),
      tags: mergeStrings(existing?.tags || [], [
        profile.company,
        profile.role,
        profile.location,
        context.query,
      ]),
      sources: mergeByUrl(existing?.sources || [], profile.sources || []),
      evidence: mergeEvidence(existing?.evidence || [], profile.evidence || []),
      confidence: Math.max(existing?.confidence || 0, profile.confidence || 0),
      confidenceLabel: profile.confidenceLabel || existing?.confidenceLabel || '',
      lastMatchedQuery: context.query || existing?.lastMatchedQuery || '',
      updatedAt: nowIso(),
      createdAt: existing?.createdAt || nowIso(),
    };

    byKey.set(contact.identityKey, contact);
    saved.push(contact);
  }

  await writeJson(paths.contacts, [...byKey.values()]);
  return saved;
}

export async function upsertProfiles(candidates) {
  const profiles = await listProfiles();
  const byKey = new Map(profiles.map((profile) => [profile.identityKey, profile]));
  const saved = [];

  for (const candidate of candidates) {
    const existing = byKey.get(candidate.identityKey);
    const merged = existing
      ? {
          ...existing,
          ...candidate,
          sources: mergeByUrl(existing.sources || [], candidate.sources || []),
          evidence: mergeEvidence(existing.evidence || [], candidate.evidence || []),
          updatedAt: nowIso(),
        }
      : {
          ...candidate,
          id: candidate.id || `person_${hashValue(candidate.identityKey)}`,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

    byKey.set(merged.identityKey, merged);
    saved.push(merged);
  }

  await writeJson(paths.profiles, [...byKey.values()]);
  return saved;
}

function mergeByUrl(left, right) {
  const merged = new Map();
  for (const item of [...left, ...right]) {
    const key = item.url || hashValue(item);
    merged.set(key, { ...merged.get(key), ...item });
  }
  return [...merged.values()];
}

function mergeEvidence(left, right) {
  const seen = new Set();
  return [...left, ...right].filter((item) => {
    const key = `${item.type}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  if (/(armenian|armenia|yerevan|yan|ian)/i.test(haystack)) score += 10;
  return score;
}

function hasVerifiedContactCompanyEvidence(contact, company) {
  const target = String(company).toLowerCase();
  if (contact.company?.toLowerCase() !== target) return false;

  return (contact.sources || []).some((source) => {
    if (source.kind === 'contact-cache') return false;
    if (source.affiliationVerified) return true;
    const text = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
    return text.includes(target);
  });
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
  const searches = await readJson(paths.searches, []);
  const next = [
    ...searches.filter((entry) => entry.searchKey !== search.searchKey),
    {
      ...search,
      updatedAt: nowIso(),
      createdAt: search.createdAt || nowIso(),
    },
  ];
  await writeJson(paths.searches, next);
}

export async function listLeads() {
  return readJson(paths.leads, []);
}

export async function upsertLead({ personId, status = 'saved', notes = '' }) {
  const leads = await listLeads();
  const existing = leads.find((lead) => lead.personId === personId);
  const lead = {
    personId,
    status,
    notes,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };

  await writeJson(paths.leads, [
    ...leads.filter((entry) => entry.personId !== personId),
    lead,
  ]);

  return lead;
}
