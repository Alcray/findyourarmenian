import { config } from './config.js';
import { demoItemsForQuery } from './demoData.js';
import { getRawRun, hashValue, saveRawRun } from './store.js';

function actorPath(actorId) {
  return encodeURIComponent(actorId.replace('/', '~'));
}

function inputForActor(actorId, query, limit) {
  if (actorId.includes('rag-web-browser')) {
    return {
      query,
      maxResults: limit,
      outputFormats: ['markdown', 'text'],
      requestTimeoutSecs: 35,
      htmlTransformer: 'readable-text',
    };
  }

  return {
    query,
    search: query,
    maxItems: limit,
    maxResults: limit,
  };
}

function companyEmployeesInput(intent, limit) {
  return {
    companies: [intent.company],
    searchQuery: intent.wantsArmenian ? 'Armenian OR "Armenian language" OR "Armenian-American" OR Hayastan' : '',
    targetTitles: targetTitlesForRole(intent.role),
    location: intent.location || '',
    profileDepth: 'short',
    maxEmployees: Math.max(limit, config.apifyCompanyMaxEmployees),
    maxConcurrency: 3,
  };
}

export async function searchWithApify(query, options = {}) {
  const actorId = options.actorId || config.apifySearchActor;
  const limit = options.limit || config.apifyMaxResults;
  const input = inputForActor(actorId, query, limit);
  const cacheKey = hashValue({ actorId, input, version: 1 });
  const mode = options.mode || config.apifyMode;

  if (!options.refresh && mode !== 'live') {
    const cached = await getRawRun(cacheKey);
    if (cached) {
      return {
        items: cached.items || [],
        cached: true,
        cacheKey,
        actorId,
      };
    }
  }

  if (mode === 'demo' || !config.apifyToken) {
    const items = demoItemsForQuery(query);
    await saveRawRun(cacheKey, { actorId, input, items, demo: true });
    return { items, cached: false, cacheKey, actorId, demo: true };
  }

  const items = await runActorSync(actorId, input, limit);
  await saveRawRun(cacheKey, { actorId, input, items });
  return { items, cached: false, cacheKey, actorId };
}

export async function searchCompanyEmployeesWithApify(intent, options = {}) {
  const actorId = options.actorId || config.apifyCompanyEmployeesActor;
  const limit = options.limit || config.apifyMaxResults;
  const input = companyEmployeesInput(intent, limit);
  const cacheKey = hashValue({ actorId, input, version: 1 });
  const mode = options.mode || config.apifyMode;

  if (!options.refresh && mode !== 'live') {
    const cached = await getRawRun(cacheKey);
    if (cached) {
      return {
        items: cached.items || [],
        cached: true,
        cacheKey,
        actorId,
        input,
      };
    }
  }

  if (mode === 'demo' || !config.apifyToken) {
    const items = demoItemsForQuery(`employees at ${intent.company}`);
    await saveRawRun(cacheKey, { actorId, input, items, demo: true });
    return { items, cached: false, cacheKey, actorId, input, demo: true };
  }

  const items = await runActorSync(actorId, input, input.maxEmployees);
  await saveRawRun(cacheKey, { actorId, input, items });
  return { items, cached: false, cacheKey, actorId, input };
}

async function runActorSync(actorId, input, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apifyRequestTimeoutMs);

  try {
    const url = new URL(
      `https://api.apify.com/v2/acts/${actorPath(actorId)}/run-sync-get-dataset-items`,
    );
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.apifyToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Apify actor failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    return body ? JSON.parse(body) : [];
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Apify actor timed out after ${config.apifyRequestTimeoutMs}ms.`);
    }
    if (error.cause?.code) {
      throw new Error(`Could not reach Apify (${error.cause.code}). Check DNS/network access from this machine.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function targetTitlesForRole(role) {
  const titles = {
    sales: ['Sales', 'Account Executive', 'GTM', 'Business Development', 'Partnerships'],
    founder: ['Founder', 'Co-Founder'],
    engineer: ['Engineer', 'Software Engineer', 'Engineering', 'Developer'],
    ai: ['AI', 'Machine Learning', 'ML', 'Research', 'Applied AI'],
    product: ['Product', 'Product Manager'],
    design: ['Design', 'Designer'],
    recruiting: ['Recruiter', 'Recruiting', 'Talent'],
  };

  return titles[role] || [];
}
