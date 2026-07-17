// Shared HTTP helper with timeout + retry/backoff.
//
// Both Apify (free plan) and the Gemini Vertex endpoint return transient failures
// under load: Gemini's free/express tier serves HTTP 404 HTML pages when rate
// limited, and Apify occasionally 429s or 5xxs. Retrying with jittered backoff
// turns those flaky failures into successes without changing call sites.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHtml(text) {
  return /^\s*<(?:!doctype|html)/i.test(text || '');
}

/**
 * fetch() wrapper that retries transient failures and returns the parsed body.
 *
 * Resolves to { ok, status, text, json } where json is null if the body was not
 * valid JSON. Throws only on network errors that persist past all retries or on
 * an abort/timeout.
 */
export async function fetchWithRetry(url, options = {}, config = {}) {
  const {
    retries = 3,
    baseDelayMs = 600,
    maxDelayMs = 8000,
    timeoutMs = 60000,
    label = 'request',
    // Treat an HTML body on a 2xx as a transient edge failure (seen on the
    // Gemini Vertex publisher endpoint when throttled).
    retryOnHtml = true,
  } = config;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      const htmlBody = retryOnHtml && isHtml(text);
      const retryable = RETRYABLE_STATUS.has(response.status) || htmlBody;

      if (!response.ok || htmlBody) {
        if (retryable && attempt < retries) {
          await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, response));
          continue;
        }
      }

      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: response.ok && !htmlBody, status: response.status, text, json };
    } catch (error) {
      lastError = normalizeError(error, timeoutMs, label);
      const abort = error.name === 'AbortError';
      // Never retry on timeout/abort: an aborted actor run may still be billing
      // server-side, so retrying risks double-charging, and stacked per-attempt
      // timeouts could blow the caller's overall deadline. Only transient
      // connection errors get another attempt.
      if (!abort && attempt < retries) {
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`${label} failed after ${retries + 1} attempts`);
}

function backoffDelay(attempt, baseDelayMs, maxDelayMs, response) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, maxDelayMs);
  }
  const exponential = baseDelayMs * 2 ** attempt;
  // Deterministic jitter (Math.random is unavailable in some sandboxes and adds
  // nondeterminism): spread by attempt index instead.
  const jitter = (attempt + 1) * 137;
  return Math.min(exponential + jitter, maxDelayMs);
}

function normalizeError(error, timeoutMs, label) {
  if (error.name === 'AbortError') {
    return new Error(`${label} timed out after ${timeoutMs}ms.`);
  }
  if (error.cause?.code) {
    return new Error(`Could not reach ${label} (${error.cause.code}). Check network/DNS access.`);
  }
  return error;
}
