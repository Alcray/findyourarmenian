import { config } from './config.js';
import { hasStrongArmenianNameSignal } from './people.js';

export function isFreshTrustedContact(contact, intent, now = Date.now()) {
  const updatedAt = Date.parse(contact.lastObservedAt || contact.updatedAt || contact.createdAt || '');
  const maxAgeMs = config.contactCacheMaxAgeDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(updatedAt) || now - updatedAt > maxAgeMs) return false;
  if (!matchesIntent(contact, intent)) return false;
  if (!isLocalDataMode() && !hasLiveProvenance(contact)) return false;
  return hasTrustedArmenianSignal(contact);
}

export function shouldPersistAsContact(candidate) {
  if (isLocalDataMode()) return false;
  if (hasTrustedArmenianSignal(candidate)) return true;
  const geminiConfidence = candidate.geminiJudgment?.armenianConfidence;
  return geminiConfidence === 'high' || geminiConfidence === 'medium';
}

function hasLiveProvenance(candidate) {
  return (candidate.sources || []).some((source) => {
    if (source.kind === 'contact-cache') return false;
    if ((source.provenances || []).includes('live')) return true;
    return !source.demo && !source.fixture;
  });
}

function isLocalDataMode() {
  return config.apifyMode === 'demo' || config.apifyMode === 'fixture';
}

export function contactToCandidate(contact) {
  return {
    ...contact,
    confidence: contact.confidence || Math.min(90, 45 + (contact.cacheScore || 0)),
    confidenceLabel: contact.confidenceLabel || 'possible',
    sources: [
      ...(contact.sources || []),
      {
        url: contact.profileUrl || '',
        title: contact.name,
        snippet: `Loaded from contact cache. Last matched: ${contact.lastMatchedQuery || 'unknown'}`,
        query: 'contact cache lookup',
        actorId: 'contact-cache',
        cached: true,
        kind: 'contact-cache',
      },
    ],
  };
}

function hasTrustedArmenianSignal(candidate) {
  if ((candidate.armenianScore || 0) >= 20) return true;
  if (hasStrongArmenianNameSignal(candidate.name)) return true;
  return (candidate.evidence || []).some(
    (item) =>
      item.type === 'source' &&
      /^Source mentions (?:armenian(?:-american)?|armenian diaspora|armenian (?:identity|language|community))\b/i.test(
        String(item.text || ''),
      ),
  );
}

function matchesIntent(candidate, intent) {
  if (intent.company && normalize(candidate.company) !== normalize(intent.company)) return false;
  if (intent.role && normalize(candidate.role) !== normalize(intent.role)) return false;

  const topics = new Set((candidate.topics || []).map(normalize));
  if ((intent.topics || []).some((topic) => !topics.has(normalize(topic)))) return false;

  const requestedLocations = [intent.location, ...(intent.locationAlternates || [])].filter(Boolean);
  if (requestedLocations.length && !requestedLocations.some((location) => locationsMatch(candidate.location, location))) {
    return false;
  }
  return true;
}

function locationsMatch(actual, requested) {
  const left = normalize(actual);
  const right = normalize(requested);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const bayArea = new Set(['san francisco', 'san francisco bay area', 'bay area', 'silicon valley']);
  return bayArea.has(left) && bayArea.has(right);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}
