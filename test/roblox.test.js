import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DataStoreClient, RobloxApiError } from '../src/roblox.js';
import { loadEnv } from '../src/env.js';

test('client requires credentials', () => {
  assert.throws(() => new DataStoreClient({ universeId: '1' }), /ROBLOX_API_KEY/);
  assert.throws(() => new DataStoreClient({ apiKey: 'k' }), /ROBLOX_UNIVERSE_ID/);
});

test('builds the datastore base url', () => {
  const c = new DataStoreClient({ apiKey: 'k', universeId: 42 });
  assert.equal(c.root, 'https://apis.roblox.com/datastores/v1/universes/42/standard-datastores');
});

test('api errors carry the http status', () => {
  const e = new RobloxApiError(404, 'not found', {});
  assert.equal(e.status, 404);
  assert.ok(e instanceof Error);
});

test('env parser handles comments, quotes and blank values', async () => {
  const p = `${os.tmpdir()}/env-test-${Date.now()}`;
  await fs.writeFile(p, '# comment\nFOO="bar"\nEMPTY=\nBAZ=qux\n');

  process.env.ALREADY_SET = 'keep me';
  const parsed = await loadEnv(p);

  assert.equal(parsed.FOO, 'bar');
  assert.equal(parsed.BAZ, 'qux');
  assert.equal(parsed.EMPTY, '');
  assert.equal(process.env.ALREADY_SET, 'keep me');
  await fs.unlink(p);
});

test('a missing .env is not an error', async () => {
  assert.deepEqual(await loadEnv('/nope/does/not/exist/.env'), {});
});
