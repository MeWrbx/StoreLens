import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataStoreClient, RobloxApiError, ValidationError } from './src/roblox.js';
import { OrderedDataStoreClient } from './src/ordered.js';
import { exportDataStore, searchEntries } from './src/export.js';
import { importDataStore } from './src/import.js';
import { backupConfig, listBackups, runBackup, startScheduler } from './src/backup.js';
import { listJournals, undoImport } from './src/undo.js';
import { loadEnv } from './src/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadEnv(path.join(__dirname, '.env'));

const PORT = Number.isFinite(Number(process.env.PORT)) ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST || '127.0.0.1';
const READ_ONLY = process.env.READ_ONLY === 'true';
const BACKUP = backupConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// The universe id may come from the UI, the API key never leaves this process.
function clientFrom(q, body = {}) {
  const universeId = q.get('universeId') || body.universeId || process.env.ROBLOX_UNIVERSE_ID;

  if (!process.env.ROBLOX_API_KEY) {
    throw new HttpError(400, 'ROBLOX_API_KEY is not set. Copy .env.example to .env and add your Open Cloud key.');
  }
  if (!universeId) {
    throw new HttpError(400, 'No universe id. Type one into the header field or set ROBLOX_UNIVERSE_ID in .env.');
  }

  return new DataStoreClient({ apiKey: process.env.ROBLOX_API_KEY, universeId });
}

function orderedClientFrom(q, body = {}) {
  const universeId = q.get('universeId') || body.universeId || process.env.ROBLOX_UNIVERSE_ID;

  if (!process.env.ROBLOX_API_KEY) {
    throw new HttpError(400, 'ROBLOX_API_KEY is not set. Copy .env.example to .env and add your Open Cloud key.');
  }
  if (!universeId) {
    throw new HttpError(400, 'No universe id. Type one into the header field or set ROBLOX_UNIVERSE_ID in .env.');
  }

  return new OrderedDataStoreClient({ apiKey: process.env.ROBLOX_API_KEY, universeId });
}

function requireWrite() {
  if (READ_ONLY) throw new HttpError(403, 'Server is in read-only mode (READ_ONLY=true).');
}

const json = (res, status, data) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 32 * 1024 * 1024) throw new HttpError(413, 'Body too large (32 MB max).');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// This server has no login and holds a live Open Cloud key, so a page the user
// visits in the same browser must never be able to drive it. Browsers always
// attach Origin to cross-site writes, and a JSON content-type forces a preflight
// that the missing OPTIONS route rejects.
function guardCrossSite(req) {
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* malformed, treat as foreign */ }
    if (originHost !== req.headers.host) {
      throw new HttpError(403, 'Cross-origin request blocked.');
    }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site request blocked.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type && type !== 'application/json') {
      throw new HttpError(415, 'Content-Type must be application/json.');
    }
  }
}

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    readOnly: READ_ONLY,
    hasApiKey: Boolean(process.env.ROBLOX_API_KEY),
    defaultUniverseId: process.env.ROBLOX_UNIVERSE_ID || null,
    backups: { enabled: BACKUP.enabled, everyMinutes: BACKUP.enabled ? BACKUP.intervalMin : null },
  }),

  'GET /api/datastores': (q) => clientFrom(q).listDataStores({
    prefix: q.get('prefix'), cursor: q.get('cursor'), limit: q.get('limit'),
  }),

  'GET /api/keys': (q) => clientFrom(q).listKeys(q.get('datastore'), {
    scope: q.get('scope'), prefix: q.get('prefix'),
    cursor: q.get('cursor'), limit: q.get('limit'), allScopes: q.get('allScopes'),
  }),

  'GET /api/entry': (q) => clientFrom(q).getEntry(q.get('datastore'), q.get('key'), {
    scope: q.get('scope'),
  }),

  'POST /api/entry': (q, body) => {
    requireWrite();
    if (body.value === undefined) throw new HttpError(400, 'Missing "value".');
    return clientFrom(q, body).setEntry(body.datastore, body.key, body.value, {
      scope: body.scope, matchVersion: body.matchVersion,
      userIds: body.userIds, attributes: body.attributes,
    });
  },

  'DELETE /api/entry': async (q) => {
    requireWrite();
    return (await clientFrom(q).deleteEntry(q.get('datastore'), q.get('key'), {
      scope: q.get('scope'),
    })) ?? { ok: true };
  },

  'GET /api/versions': (q) => clientFrom(q).listVersions(q.get('datastore'), q.get('key'), {
    scope: q.get('scope'), cursor: q.get('cursor'), limit: q.get('limit'),
  }),

  'GET /api/version': (q) => clientFrom(q).getVersion(
    q.get('datastore'), q.get('key'), q.get('versionId'), { scope: q.get('scope') },
  ),

  // Ordered data stores - the integer, always-sorted ones behind leaderboards.
  'GET /api/ordered/entries': (q) => orderedClientFrom(q).listEntries(q.get('store'), {
    scope: q.get('scope'), limit: q.get('limit'), pageToken: q.get('pageToken'),
    ascending: q.get('ascending') === 'true',
  }),

  'GET /api/ordered/entry': (q) => orderedClientFrom(q).getEntry(q.get('store'), q.get('entry'), {
    scope: q.get('scope'),
  }),

  'POST /api/ordered/entry': (q, body) => {
    requireWrite();
    const client = orderedClientFrom(q, body);
    const opts = { scope: body.scope };

    if (body.increment !== undefined) {
      return client.incrementEntry(body.store, body.entry, body.increment, opts);
    }
    if (body.value === undefined) throw new HttpError(400, 'Missing "value" or "increment".');
    if (body.create) return client.createEntry(body.store, body.entry, body.value, opts);
    return client.updateEntry(body.store, body.entry, body.value, opts);
  },

  'DELETE /api/ordered/entry': (q) => {
    requireWrite();
    return orderedClientFrom(q).deleteEntry(q.get('store'), q.get('entry'), {
      scope: q.get('scope'),
    });
  },

  // Whole-store export. Reads only, so it stays allowed in read-only mode.
  'GET /api/export': (q) => exportDataStore(clientFrom(q), q.get('datastore'), {
    scope: q.get('scope'), prefix: q.get('prefix'),
    maxEntries: q.get('max') ? Number(q.get('max')) : 2000,
  }),

  // Search inside values. Same cost as an export - it has to read every entry.
  'GET /api/search': (q) => searchEntries(clientFrom(q), q.get('datastore'), {
    scope: q.get('scope'), prefix: q.get('prefix'),
    contains: q.get('contains'), caseSensitive: q.get('caseSensitive') === 'true',
    maxEntries: q.get('max') ? Number(q.get('max')) : 2000,
  }),

  // Bulk import from a previous export.
  'POST /api/import': (q, body) => {
    requireWrite();
    return importDataStore(clientFrom(q, body), body.datastore, body.payload ?? body, {
      scope: body.scope, mode: body.mode, dryRun: Boolean(body.dryRun),
    });
  },

  // What each import replaced, newest first.
  'GET /api/imports': (q) => listJournals(undefined, {
    universeId: q.get('universeId') || process.env.ROBLOX_UNIVERSE_ID || null,
  }),

  // Put an import back. This writes, so read-only blocks it.
  'POST /api/import/undo': (q, body) => {
    requireWrite();
    return undoImport(clientFrom(q, body), body.id, { dryRun: Boolean(body.dryRun) });
  },

  // Backups only read from Open Cloud, so they stay allowed in read-only mode.
  'GET /api/backups': () => listBackups(BACKUP),

  'POST /api/backups/run': (q, body) => runBackup(clientFrom(q, body), { config: BACKUP }),
};

async function serveStatic(pathname, res) {
  const root = path.join(__dirname, 'public');

  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Bad path' }); }
  rel = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');

  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return json(res, 403, { error: 'Forbidden' });
  }

  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    guardCrossSite(req);

    const handler = routes[`${req.method} ${url.pathname}`];

    if (!handler) {
      if (req.method === 'GET') return serveStatic(url.pathname, res);
      return json(res, 405, { error: 'Method not allowed' });
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    json(res, 200, await handler(url.searchParams, body));
  } catch (err) {
    if (err instanceof RobloxApiError) return json(res, err.status, { error: err.message, details: err.body });
    if (err instanceof HttpError || err instanceof ValidationError) {
      return json(res, err.status, { error: err.message });
    }
    if (err instanceof SyntaxError) return json(res, 400, { error: 'Invalid JSON in request body.' });
    console.error(err);
    json(res, 500, { error: err.message || 'Internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`StoreLens listening on http://${HOST}:${server.address().port}`);
  if (READ_ONLY) console.log('read-only mode: writes and deletes are disabled');
  if (!process.env.ROBLOX_API_KEY) console.warn('ROBLOX_API_KEY is not set, see .env.example');

  if (BACKUP.enabled) {
    try {
      startScheduler(() => new DataStoreClient({
        apiKey: process.env.ROBLOX_API_KEY,
        universeId: process.env.ROBLOX_UNIVERSE_ID,
      }), { config: BACKUP });
      const which = BACKUP.stores.length ? BACKUP.stores.join(', ') : 'every store';
      console.log(`backups: ${which} every ${BACKUP.intervalMin} min -> ${BACKUP.dir}/ (keeping ${BACKUP.keep})`);
      if (!process.env.ROBLOX_UNIVERSE_ID) {
        console.warn('backups need ROBLOX_UNIVERSE_ID in .env, the header field is not enough');
      }
    } catch (err) {
      console.error(`backups disabled: ${err.message}`);
    }
  }
});

export default server;
