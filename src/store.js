import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const paths = {
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

export async function getSearch(searchKey) {
  const searches = await readJson(paths.searches, []);
  return searches.find((search) => search.searchKey === searchKey) || null;
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
