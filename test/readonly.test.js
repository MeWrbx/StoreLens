import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// READ_ONLY is read once at startup, so this mode needs its own test file.
const hits = [];
const mock = http.createServer((req, res) => {
  hits.push(req.method);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

process.env.ROBLOX_API_BASE = `http://127.0.0.1:${mock.address().port}/universes`;
process.env.ROBLOX_API_KEY = 'test-key';
process.env.ROBLOX_UNIVERSE_ID = '9';
process.env.READ_ONLY = 'true';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const { default: server } = await import('../server.js');
if (!server.listening) await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); mock.close(); });

test('read-only mode is announced', async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).readOnly, true);
});

test('read-only mode blocks writes and deletes', async () => {
  const write = await fetch(`${base}/api/entry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datastore: 'D', key: 'K', value: 1 }),
  });
  assert.equal(write.status, 403);

  const del = await fetch(`${base}/api/entry?datastore=D&key=K`, { method: 'DELETE' });
  assert.equal(del.status, 403);

  assert.deepEqual(hits, [], 'nothing may reach Open Cloud in read-only mode');
});

test('reads still work in read-only mode', async () => {
  assert.equal((await fetch(`${base}/api/datastores`)).status, 200);
});
