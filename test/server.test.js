import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

// A stand-in for Open Cloud so the tests never touch the real API.
const hits = [];
const mock = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url.split('?')[0]}`);
  res.writeHead(200, { 'content-type': 'application/json', 'roblox-entry-version': '2' });
  res.end(JSON.stringify({ datastores: [{ name: 'PlayerData' }], version: '2' }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

process.env.ROBLOX_API_BASE = `http://127.0.0.1:${mock.address().port}/universes`;
process.env.ROBLOX_API_KEY = 'test-key';
process.env.ROBLOX_UNIVERSE_ID = '';
process.env.READ_ONLY = 'false';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const { default: server } = await import('../server.js');
if (!server.listening) await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); mock.close(); });

const post = (body, headers = {}) => fetch(`${base}/api/entry`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('health reports config without leaking the key', async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.hasApiKey, true);
  assert.equal(body.readOnly, false);
  assert.ok(!JSON.stringify(body).includes('test-key'));
});

test('a foreign Origin cannot write', async () => {
  const before = hits.length;
  const res = await post(
    { universeId: '1', datastore: 'PlayerData', key: 'Player_1', value: { coins: 999999 } },
    { origin: 'https://evil.example' },
  );
  assert.equal(res.status, 403);
  assert.equal(hits.length, before, 'blocked request must not reach Open Cloud');
});

test('sec-fetch-site cross-site cannot write', async () => {
  const before = hits.length;
  const res = await post(
    { universeId: '1', datastore: 'PlayerData', key: 'Player_1', value: {} },
    { 'sec-fetch-site': 'cross-site' },
  );
  assert.equal(res.status, 403);
  assert.equal(hits.length, before);
});

test('a non-JSON content type cannot write', async () => {
  const before = hits.length;
  const res = await post(
    { universeId: '1', datastore: 'PlayerData', key: 'Player_1', value: {} },
    { 'content-type': 'text/plain' },
  );
  assert.equal(res.status, 415);
  assert.equal(hits.length, before);
});

test('a same-origin write goes through', async () => {
  const res = await post({
    universeId: '1', datastore: 'PlayerData', key: 'Player_1', value: { coins: 5 },
  }, { origin: base });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, '2');
  assert.ok(hits.includes('POST /universes/1/standard-datastores/datastore/entries/entry'));
});

test('a write without a value is a 400', async () => {
  const res = await post({ universeId: '1', datastore: 'PlayerData', key: 'Player_1' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /value/);
});

test('a missing universe id is a 400, not a 500', async () => {
  const res = await fetch(`${base}/api/datastores`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /universe id/i);
});

test('a universe id from the query is used', async () => {
  const res = await fetch(`${base}/api/datastores?universeId=77`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).datastores, [{ name: 'PlayerData' }]);
});

test('a malformed body is a 400, not a 500', async () => {
  const res = await fetch(`${base}/api/entry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Invalid JSON/);
});

test('the dashboard is served and is branded StoreLens', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /<title>StoreLens<\/title>/);
});

test('static serving stays inside public/', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
    const res = await fetch(base + p);
    assert.ok(res.status === 403 || res.status === 404, `${p} returned ${res.status}`);
    assert.ok(!(await res.text()).includes('"storelens"'), `${p} leaked a file`);
  }
});

test('an unknown non-GET route is a 405', async () => {
  const res = await fetch(`${base}/api/nope`, { method: 'PUT' });
  assert.equal(res.status, 405);
});

// A rebinding attack controls both Origin and Host, so they agree and the
// same-origin comparison passes. Pinning Host to loopback is what stops it.
const rawGet = (headers, path = '/api/datastores?universeId=77') => new Promise((resolve, reject) => {
  const socket = net.connect(server.address().port, '127.0.0.1', () => {
    socket.write(`GET ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`);
  });
  let buf = '';
  socket.on('data', (d) => { buf += d; });
  socket.on('end', () => resolve(Number(buf.split(' ')[1])));
  socket.on('error', reject);
});

test('a request addressed to someone else\'s hostname is refused', async () => {
  const before = hits.length;

  assert.equal(await rawGet([
    'Host: evil.example:1234',
    'Origin: http://evil.example:1234',
    'Sec-Fetch-Site: same-origin',
  ]), 403, 'matching Origin and Host is not enough');

  assert.equal(await rawGet(['Host: evil.example:1234']), 403);
  assert.equal(hits.length, before, 'nothing reached Open Cloud');
});

test('the loopback names people actually use still work', async () => {
  const port = server.address().port;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    assert.equal(await rawGet([`Host: ${host}`]), 200, host);
  }
});
