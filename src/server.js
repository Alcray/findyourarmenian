import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchPeople, savedLeadsWithProfiles } from './agent.js';
import { config, publicConfig } from './config.js';
import { upsertLead } from './store.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || 'Unexpected server error',
    });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Find Your Armenian running on http://0.0.0.0:${config.port}`);
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, config: publicConfig() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, publicConfig());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    const body = await readBody(req);
    const result = await searchPeople({
      query: body.query,
      refresh: Boolean(body.refresh),
      limit: Number.parseInt(body.limit, 10) || config.apifyMaxResults,
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/leads') {
    sendJson(res, 200, { leads: await savedLeadsWithProfiles() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/leads') {
    const body = await readBody(req);
    if (!body.personId) throw Object.assign(new Error('personId is required'), { statusCode: 400 });
    sendJson(res, 200, { lead: await upsertLead(body) });
    return;
  }

  throw Object.assign(new Error('Not found'), { statusCode: 404 });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    throw Object.assign(new Error('Not found'), { statusCode: 404 });
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': contentType(filePath) });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const fallback = await fs.readFile(path.join(publicDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fallback);
      return;
    }
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function contentType(filePath) {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}
