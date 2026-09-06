import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---------------------------------------------------------------------------
// One mock standing in for both Open Cloud services.
// ---------------------------------------------------------------------------
const calls = [];

const KEYS = Array.from({ length: 250 }, (_, i) => `Player_${i + 1}`);

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://mock');
  calls.push({ method: req.method, path: url.pathname, query: url.searchParams });

  const send = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // --- ordered data stores ---
  if (url.pathname.includes('/orderedDataStores/')) {
    if (url.pathname.endsWith(':increment')) return send({ id: 'p1', value: 43 });
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && url.searchParams.get('id')) return send({ id: 'p1', value: 10 });
    if (req.method === 'PATCH') return send({ id: 'p1', value: 99 });
    if (url.pathname.endsWith('/entries')) {
      return send({
        entries: [{ id: 'p1', value: 42 }, { id: 'p2', value: 7 }],
        nextPageToken: '',
      });
    }
    return send({ id: 'p1', value: 42 });
  }

  // --- standard data stores, enough for an export walk ---
  if (url.pathname.endsWith('/datastore/entries')) {
    const cursor = Number(url.searchParams.get('cursor') || 0);
    const page = KEYS.slice(cursor, cursor + 100);
    const nextPageCursor = cursor + 100 < KEYS.length ? String(cursor + 100) : '';
    return send({ keys: page.map((key) => ({ key })), nextPageCursor });
  }

  if (url.pathname.endsWith('/datastore/entries/entry')) {
    const key = url.searchParams.get('entryKey');
    if (key === 'Player_7') return send({ message: 'Not found' }, 404);
    res.writeHead(200, {
      'content-type': 'application/json',
      'roblox-entry-version': '3',
      'roblox-entry-version-created-time': '2026-01-02T10:00:00Z',
      'roblox-entry-userids': '[12345]',
    });
    return res.end(JSON.stringify({ coins: 10, key }));
  }

  send({});
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

const port = mock.address().port;
process.env.ROBLOX_API_BASE = `http://127.0.0.1:${port}/universes`;
process.env.ROBLOX_ORDERED_API_BASE = `http://127.0.0.1:${port}/ordered/universes`;

const { OrderedDataStoreClient } = await import('../src/ordered.js');
const { DataStoreClient } = await import('../src/roblox.js');
const { exportDataStore } = await import('../src/export.js');
const { ValidationError } = await import('../src/http.js');

const ordered = () => new OrderedDataStoreClient({ apiKey: 'k', universeId: '1' });
const standard = () => new DataStoreClient({ apiKey: 'k', universeId: '1' });

test.after(() => mock.close());

// ---------------------------------------------------------------------------
// Ordered data stores
// ---------------------------------------------------------------------------
test('ordered entries come back highest first by default', async () => {
  const data = await ordered().listEntries('Leaderboard');
  assert.deepEqual(data.entries, [{ id: 'p1', value: 42 }, { id: 'p2', value: 7 }]);

  const call = calls.at(-1);
  assert.equal(call.query.get('order_by'), 'desc');
  assert.match(call.path, /\/orderedDataStores\/Leaderboard\/scopes\/global\/entries$/);
});

test('a scope and an ascending sort reach the url', async () => {
  await ordered().listEntries('Leaderboard', { scope: 'eu', ascending: true, limit: 10 });
  const call = calls.at(-1);
  assert.match(call.path, /\/scopes\/eu\/entries$/);
  assert.equal(call.query.get('order_by'), 'asc');
  assert.equal(call.query.get('max_page_size'), '10');
});

test('store and entry names with slashes stay inside their path segment', async () => {
  await ordered().getEntry('a/b', 'c/d');
  const call = calls.at(-1);
  assert.match(call.path, /orderedDataStores\/a%2Fb\//);
  assert.match(call.path, /entries\/c%2Fd$/);
});

test('ordered stores reject non-integer values before sending anything', async () => {
  const before = calls.length;
  await assert.rejects(async () => ordered().updateEntry('L', 'p1', 1.5), ValidationError);
  await assert.rejects(async () => ordered().createEntry('L', 'p1', 'abc'), /whole number/);
  await assert.rejects(async () => ordered().incrementEntry('L', 'p1', 2.5), /whole number/);
  assert.equal(calls.length, before);
});

test('a missing store or entry name is caught locally', async () => {
  const before = calls.length;
  await assert.rejects(async () => ordered().listEntries(''), /"store" is required/);
  await assert.rejects(async () => ordered().getEntry('L', ''), /"entry" is required/);
  assert.equal(calls.length, before);
});

test('increment posts to the :increment endpoint', async () => {
  const r = await ordered().incrementEntry('Leaderboard', 'p1', 1);
  assert.equal(r.value, 43);
  assert.match(calls.at(-1).path, /entries\/p1:increment$/);
  assert.equal(calls.at(-1).method, 'POST');
});

test('deleting an entry survives an empty 204 body', async () => {
  assert.deepEqual(await ordered().deleteEntry('Leaderboard', 'p1'), { ok: true });
});

// ---------------------------------------------------------------------------
// Whole-store export
// ---------------------------------------------------------------------------
test('export walks every page of keys', async () => {
  const dump = await exportDataStore(standard(), 'PlayerData');

  assert.equal(dump.datastore, 'PlayerData');
  assert.equal(dump.count, 249, 'all keys except the one that 404s');
  assert.equal(dump.truncated, false);
  assert.ok(!dump.entries.some((e) => e.key === 'Player_7'));
  assert.deepEqual(dump.entries[0], {
    key: 'Player_1',
    scope: null,
    value: { coins: 10, key: 'Player_1' },
    version: '3',
    updated: '2026-01-02T10:00:00Z',
    userIds: [12345],
  });
});

test('a key that cannot be read is reported, not fatal', async () => {
  const dump = await exportDataStore(standard(), 'PlayerData');
  assert.equal(dump.failures.length, 1);
  assert.equal(dump.failures[0].key, 'Player_7');
  assert.match(dump.failures[0].error, /Not found/);
});

test('the export cap is honoured and flagged', async () => {
  const dump = await exportDataStore(standard(), 'PlayerData', { maxEntries: 30 });
  assert.equal(dump.truncated, true);
  assert.ok(dump.count <= 30);
});

test('a silly cap is rejected before any request', async () => {
  const before = calls.length;
  await assert.rejects(async () => exportDataStore(standard(), 'D', { maxEntries: 0 }), /between 1 and 20000/);
  await assert.rejects(async () => exportDataStore(standard(), 'D', { maxEntries: 999999 }), /between 1 and 20000/);
  await assert.rejects(async () => exportDataStore(standard(), ''), /"datastore" is required/);
  assert.equal(calls.length, before);
});

// ---------------------------------------------------------------------------
// Value search
// ---------------------------------------------------------------------------
const { searchEntries } = await import('../src/export.js');

test('search matches on the value, not the key', async () => {
  const hit = await searchEntries(standard(), 'PlayerData', { contains: 'Player_42' });
  assert.equal(hit.count, 1);
  assert.equal(hit.entries[0].key, 'Player_42');
  assert.equal(hit.scanned, 250);
});

test('search is case-insensitive by default and can be made strict', async () => {
  assert.equal((await searchEntries(standard(), 'PlayerData', { contains: 'player_42' })).count, 1);
  assert.equal(
    (await searchEntries(standard(), 'PlayerData', { contains: 'player_42', caseSensitive: true })).count,
    0,
  );
});

test('search needs something to look for', async () => {
  const before = calls.length;
  await assert.rejects(async () => searchEntries(standard(), 'PlayerData'), /"contains" is required/);
  await assert.rejects(async () => searchEntries(standard(), '', { contains: 'x' }), /"datastore" is required/);
  assert.equal(calls.length, before);
});

test('search reports when it hit the scan cap', async () => {
  const hit = await searchEntries(standard(), 'PlayerData', { contains: 'coins', maxEntries: 20 });
  assert.equal(hit.truncated, true);
  assert.equal(hit.scanned, 20);
});

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------
const { importDataStore } = await import('../src/import.js');

const dump = (keys) => ({ entries: keys.map((key) => ({ key, value: { coins: 1 } })) });

test('a dry run writes nothing', async () => {
  const before = calls.filter((c) => c.method === 'POST').length;
  const r = await importDataStore(standard(), 'PlayerData', dump(['Player_7', 'Player_1']), { dryRun: true });

  assert.equal(r.dryRun, true);
  assert.equal(r.written, 1, 'only the key that 404s counts as new');
  assert.equal(r.skipped, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, before, 'no writes went out');
});

test('skip-existing leaves live keys alone', async () => {
  const r = await importDataStore(standard(), 'PlayerData', dump(['Player_1', 'Player_2']));
  assert.equal(r.written, 0);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.skippedKeys.map((s) => s.reason), ['already exists', 'already exists']);
});

test('overwrite writes every row', async () => {
  const r = await importDataStore(standard(), 'PlayerData', dump(['Player_1', 'Player_2']), { mode: 'overwrite' });
  assert.equal(r.written, 2);
  assert.equal(r.skipped, 0);
  assert.equal(r.failed, 0);
});

test('a bare entries array is accepted too', async () => {
  const r = await importDataStore(standard(), 'PlayerData', dump(['Player_1']).entries, { dryRun: true });
  assert.equal(r.total, 1);
});

test('a broken file is rejected with a readable reason', async () => {
  await assert.rejects(async () => importDataStore(standard(), 'D', {}), /"entries" array/);
  await assert.rejects(async () => importDataStore(standard(), 'D', { entries: [] }), /no entries/);
  await assert.rejects(async () => importDataStore(standard(), 'D', { entries: [{ value: 1 }] }), /no "key"/);
  await assert.rejects(async () => importDataStore(standard(), 'D', { entries: [{ key: 'a' }] }), /no "value"/);
  await assert.rejects(async () => importDataStore(standard(), 'D', dump(['a']), { mode: 'nuke' }), /"mode" must be/);
});
