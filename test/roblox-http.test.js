import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const seen = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://mock');
  seen.push({
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    md5: crypto.createHash('md5').update(body).digest('base64'),
  });

  if (url.pathname.includes('rate') || url.searchParams.get('datastoreName') === 'rate') {
    res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' });
    return res.end('{"message":"Too many requests"}');
  }
  res.writeHead(200, {
    'content-type': 'application/json',
    'roblox-entry-version': '2',
    'roblox-entry-userids': '[12345]',
  });
  res.end('{"version":"2"}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

// Read once at import time, so this must be set before roblox.js loads.
process.env.ROBLOX_API_BASE = `http://127.0.0.1:${mock.address().port}/universes`;
process.env.ROBLOX_TIMEOUT_MS = '1200';

const { DataStoreClient, RobloxApiError, ValidationError } = await import('../src/roblox.js');
const client = () => new DataStoreClient({ apiKey: 'k', universeId: '1' });

test.after(() => mock.close());

test('missing parameters fail before any network call', async () => {
  const before = seen.length;

  await assert.rejects(async () => client().getEntry(undefined, 'K'), ValidationError);
  await assert.rejects(async () => client().getEntry('D', ''), /"key" is required/);
  await assert.rejects(async () => client().listKeys(null), /"datastore" is required/);
  await assert.rejects(async () => client().getVersion('D', 'K', undefined), /"versionId" is required/);
  await assert.rejects(async () => client().setEntry('D', 'K', undefined), /"value" is required/);

  assert.equal(seen.length, before, 'no request may leave for an invalid call');
  await assert.rejects(async () => client().getEntry(undefined, 'K'), (e) => e.status === 400);
});

test('non-ASCII attributes are escaped instead of crashing fetch', async () => {
  await client().setEntry('D', 'Unicode', { a: 1 }, {
    attributes: { note: 'umlaut ü, kanji 日本, emoji 🎮' },
    userIds: [1, 2],
  });

  const req = seen.find((s) => s.query.get('entryKey') === 'Unicode');
  const header = req.headers['roblox-entry-attributes'];
  assert.ok(/^[\x00-\x7F]*$/.test(header), 'the header must be pure ASCII');
  assert.deepEqual(JSON.parse(header), {
    note: 'umlaut ü, kanji 日本, emoji 🎮',
  }, 'and must still decode to the original text');
});

test('content-md5 matches the bytes actually sent', async () => {
  await client().setEntry('D', 'Md5', { name: 'Müller', emoji: '🎮' });
  const req = seen.find((s) => s.query.get('entryKey') === 'Md5');
  assert.equal(req.headers['content-md5'], req.md5);
});

test('a bad userIds type does not reach the header', async () => {
  await client().setEntry('D', 'BadIds', { a: 1 }, { userIds: 'not-an-array' });
  const req = seen.find((s) => s.query.get('entryKey') === 'BadIds');
  assert.equal(req.headers['roblox-entry-userids'], '[]');
});

test('userIds metadata is always an array', async () => {
  const { meta } = await client().getEntry('D', 'K');
  assert.deepEqual(meta.userIds, [12345]);
});

test('rate limiting says how long to wait', async () => {
  await assert.rejects(async () => client().listKeys('rate'), (e) => {
    assert.ok(e instanceof RobloxApiError);
    assert.equal(e.status, 429);
    assert.match(e.message, /retry in 30s/);
    return true;
  });
});

test('a hanging Open Cloud times out instead of freezing', async () => {
  const hang = http.createServer(() => { /* never answers */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));

  // A fresh module instance so it picks up the hanging base url.
  process.env.ROBLOX_API_BASE = `http://127.0.0.1:${hang.address().port}/universes`;
  const mod = await import('../src/roblox.js?hang');
  const c = new mod.DataStoreClient({ apiKey: 'k', universeId: '1' });

  const started = Date.now();
  await assert.rejects(async () => c.listDataStores(), (e) => {
    assert.equal(e.status, 504);
    assert.match(e.message, /did not answer/);
    return true;
  });
  assert.ok(Date.now() - started < 5000, 'must give up quickly');
  hang.close();
});

test('an unreachable Open Cloud is a 502, not a raw crash', async () => {
  process.env.ROBLOX_API_BASE = 'http://127.0.0.1:1/universes';
  const mod = await import('../src/roblox.js?down');
  const c = new mod.DataStoreClient({ apiKey: 'k', universeId: '1' });

  await assert.rejects(async () => c.listDataStores(), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /Could not reach Open Cloud/);
    return true;
  });
});
