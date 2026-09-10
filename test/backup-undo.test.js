import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock Open Cloud: two stores, a handful of keys, one that does not exist.
// ---------------------------------------------------------------------------
const calls = [];
let versionCounter = 100;
let entriesRateLimited = false;

const mock = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const url = new URL(req.url, 'http://mock');
  calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers });

  const send = (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname.endsWith('/standard-datastores')) {
    return send({ datastores: [{ name: 'PlayerData' }, { name: 'Config/eu' }], nextPageCursor: '' });
  }

  if (url.pathname.endsWith('/datastore/entries')) {
    const store = url.searchParams.get('datastoreName');
    const keys = store === 'PlayerData' ? ['Player_1', 'Player_2'] : ['Setting_1'];
    return send({ keys: keys.map((key) => ({ key })), nextPageCursor: '' });
  }

  if (url.pathname.endsWith('/datastore/entries/entry/versions/version')) {
    return send({ coins: 1, restoredFrom: url.searchParams.get('versionId') });
  }

  if (url.pathname.endsWith('/datastore/entries/entry')) {
    const key = url.searchParams.get('entryKey');

    if (req.method === 'DELETE') return send({});

    if (req.method === 'POST') {
      versionCounter += 1;
      return send({ version: `v${versionCounter}` });
    }

    if (entriesRateLimited) return send({ message: 'Too many requests' }, 429);
    if (key === 'Missing_1') return send({ message: 'Not found' }, 404);
    if (key === 'Locked_1') return send({ message: 'Insufficient scope' }, 403);

    res.writeHead(200, {
      'content-type': 'application/json',
      'roblox-entry-version': `v-${key}`,
      'roblox-entry-version-created-time': '2026-01-02T10:00:00Z',
      'roblox-entry-userids': '[4242]',
    });
    return res.end(JSON.stringify({ coins: 10, key }));
  }

  send({});
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

process.env.ROBLOX_API_BASE = `http://127.0.0.1:${mock.address().port}/universes`;

const { DataStoreClient } = await import('../src/roblox.js');
const { backupConfig, listBackups, prune, runBackup, safeName, startScheduler } = await import('../src/backup.js');
const { importDataStore } = await import('../src/import.js');
const { listJournals, readJournal, undoImport } = await import('../src/undo.js');

const client = () => new DataStoreClient({ apiKey: 'k', universeId: '1' });

const tmpdirs = [];
async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storelens-'));
  tmpdirs.push(dir);
  return dir;
}

test.after(async () => {
  mock.close();
  for (const dir of tmpdirs) await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scheduled backups
// ---------------------------------------------------------------------------
test('a store name that is not a filename still becomes one', () => {
  assert.match(safeName('Config/eu'), /^Config_eu~[0-9a-f]{6}$/);
  assert.match(safeName('../../etc/passwd'), /^\.\._\.\._etc_passwd~[0-9a-f]{6}$/);
  assert.equal(safeName('PlayerData'), 'PlayerData', 'a clean name is left alone');
});

test('names that sanitise the same way do not share a file', () => {
  // Spaces are legal in Roblox store names, underscores obviously are. Without
  // the fingerprint both become "Player_Data" and one backup eats the other.
  assert.notEqual(safeName('Player Data'), safeName('Player_Data'));
  assert.equal(safeName('Player_Data'), 'Player_Data');
});

test('the scheduler is off unless an interval is set', () => {
  assert.equal(backupConfig({}).enabled, false);
  assert.equal(backupConfig({ BACKUP_INTERVAL_MIN: '0' }).enabled, false);
  assert.equal(backupConfig({ BACKUP_INTERVAL_MIN: '30' }).enabled, true);
  assert.equal(startScheduler(client, { config: backupConfig({}) }), null);
});

test('a suicidal interval is refused, and said so up front', () => {
  const config = backupConfig({ BACKUP_INTERVAL_MIN: '1' });
  assert.equal(config.enabled, false, 'not enabled...');
  assert.equal(config.requested, true, '...but clearly wanted');
  assert.match(config.errors[0], /at least 5/);
  assert.equal(startScheduler(client, { config }), null);
});

test('a cap the exporter would reject is caught at startup', () => {
  for (const bad of ['50000', '0', '2000.5', 'lots']) {
    const config = backupConfig({ BACKUP_INTERVAL_MIN: '30', BACKUP_MAX_ENTRIES: bad });
    assert.equal(config.enabled, false, `${bad} should not enable backups`);
    assert.match(config.errors.join(' '), /BACKUP_MAX_ENTRIES/);
  }
  assert.equal(backupConfig({ BACKUP_INTERVAL_MIN: '30' }).enabled, true);
});

test('keep is never allowed to reach zero', () => {
  assert.equal(backupConfig({ BACKUP_KEEP: '0' }).keep, 1);
  assert.equal(backupConfig({ BACKUP_KEEP: '-4' }).keep, 1);
  assert.equal(backupConfig({}).keep, 7);
});

test('a run writes one file per store', async () => {
  const dir = await tmp();
  const config = { ...backupConfig({}), dir, keep: 7 };

  const result = await runBackup(client(), { config, now: new Date('2026-09-07T12:00:00Z') });

  assert.equal(result.written.length, 2);
  assert.deepEqual(result.failures, []);

  const listed = await listBackups(config);
  const names = listed.files.map((f) => f.name).sort();
  assert.equal(names.length, 2);
  assert.match(names[0], /^Config_eu~[0-9a-f]{6}--2026-09-07T12-00-00-000Z\.json$/);
  assert.equal(names[1], 'PlayerData--2026-09-07T12-00-00-000Z.json');

  const dump = JSON.parse(await fs.readFile(path.join(dir, 'PlayerData--2026-09-07T12-00-00-000Z.json'), 'utf8'));
  assert.equal(dump.datastore, 'PlayerData');
  assert.equal(dump.count, 2);
});

test('only the named stores get backed up when BACKUP_STORES is set', async () => {
  const dir = await tmp();
  const config = { ...backupConfig({ BACKUP_STORES: 'PlayerData' }), dir };

  const result = await runBackup(client(), { config, now: new Date('2026-09-07T13:00:00Z') });
  assert.deepEqual(result.written.map((w) => w.store), ['PlayerData']);
});

test('retention keeps the newest files and drops the rest', async () => {
  const dir = await tmp();
  const config = { ...backupConfig({}), dir, keep: 2 };

  for (const hour of ['10', '11', '12', '13']) {
    await fs.writeFile(path.join(dir, `PlayerData--2026-09-07T${hour}-00-00-000Z.json`), '{}');
  }
  await fs.writeFile(path.join(dir, 'Other--2026-09-07T10-00-00-000Z.json'), '{}');

  const removed = await prune(config);

  assert.deepEqual(removed, [
    'PlayerData--2026-09-07T10-00-00-000Z.json',
    'PlayerData--2026-09-07T11-00-00-000Z.json',
  ]);

  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, [
    'Other--2026-09-07T10-00-00-000Z.json',
    'PlayerData--2026-09-07T12-00-00-000Z.json',
    'PlayerData--2026-09-07T13-00-00-000Z.json',
  ], 'retention is per store, not global');
});

test('listing a directory that does not exist is empty, not an error', async () => {
  const listed = await listBackups({ ...backupConfig({}), dir: path.join(os.tmpdir(), 'storelens-nope-' + Date.now()) });
  assert.deepEqual(listed.files, []);
});

// ---------------------------------------------------------------------------
// Import journal
// ---------------------------------------------------------------------------
const dump = (keys) => ({ entries: keys.map((key) => ({ key, value: { coins: 1 } })) });

test('an overwrite records the version it replaced', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1', 'Player_2']), {
    mode: 'overwrite', dir, now: new Date('2026-09-07T14:00:00Z'),
  });

  assert.equal(r.written, 2);
  assert.match(r.undoId, /^PlayerData--2026-09-07T14-00-00-000Z-[a-z0-9]{4}$/);

  const journal = await readJournal(r.undoId, dir);
  assert.deepEqual(journal.rows, [
    { key: 'Player_1', scope: null, previousVersion: 'v-Player_1', userIds: [4242] },
    { key: 'Player_2', scope: null, previousVersion: 'v-Player_2', userIds: [4242] },
  ]);
});

test('a key the import created is recorded as having no previous version', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Missing_1']), { dir });

  const journal = await readJournal(r.undoId, dir);
  assert.deepEqual(journal.rows, [{ key: 'Missing_1', scope: null, previousVersion: null, userIds: [] }]);
});

test('a dry run leaves no journal behind', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Missing_1']), { dir, dryRun: true });

  assert.equal(r.undoId, null);
  assert.deepEqual((await listJournals(dir)).imports, []);
});

test('recordUndo false skips the read entirely on overwrite', async () => {
  const dir = await tmp();
  const before = calls.filter((c) => c.method === 'GET' && c.path.endsWith('/entry')).length;

  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1']), {
    mode: 'overwrite', recordUndo: false, dir,
  });

  const after = calls.filter((c) => c.method === 'GET' && c.path.endsWith('/entry')).length;
  assert.equal(after, before, 'no read went out');
  assert.equal(r.written, 1);
  assert.equal(r.undoId, null);
});

test('a key that cannot be read is reported, not written blindly', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Locked_1']), { mode: 'overwrite', dir });

  assert.equal(r.written, 0);
  assert.equal(r.failed, 1);
  assert.match(r.failures[0].error, /Insufficient scope/);
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
test('undo writes the replaced values back', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1', 'Player_2']), {
    mode: 'overwrite', dir,
  });

  const undone = await undoImport(client(), r.undoId, { dir });

  assert.equal(undone.restored, 2);
  assert.equal(undone.removed, 0);
  assert.equal(undone.failed, 0);

  const versionReads = calls.filter((c) => c.path.endsWith('/versions/version'));
  assert.equal(versionReads.at(-1).query.get('versionId'), 'v-Player_2');
});

test('undo deletes keys the import created', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Missing_1']), { dir });

  const before = calls.filter((c) => c.method === 'DELETE').length;
  const undone = await undoImport(client(), r.undoId, { dir });

  assert.equal(undone.removed, 1);
  assert.equal(undone.restored, 0);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, before + 1);
});

test('a dry undo touches nothing but still reports the plan', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1', 'Missing_1']), {
    mode: 'overwrite', dir,
  });

  const posts = calls.filter((c) => c.method === 'POST').length;
  const deletes = calls.filter((c) => c.method === 'DELETE').length;

  const undone = await undoImport(client(), r.undoId, { dir, dryRun: true });

  assert.equal(undone.restored, 1);
  assert.equal(undone.removed, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, posts, 'no writes');
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, deletes, 'no deletes');
});

test('a finished undo is stamped so you can see it already ran', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1']), { mode: 'overwrite', dir });

  assert.equal((await listJournals(dir)).imports[0].undoneAt, null);
  await undoImport(client(), r.undoId, { dir });

  const after = (await listJournals(dir)).imports[0];
  assert.ok(after.undoneAt, 'undoneAt is set');
  assert.equal(after.rows, 1);
  assert.equal(after.datastore, 'PlayerData');
});

test('an unknown import id says so instead of throwing something cryptic', async () => {
  const dir = await tmp();
  await assert.rejects(async () => undoImport(client(), 'nope', { dir }), /No record of import/);
});

test('an import id cannot climb out of the undo directory', async () => {
  const dir = await tmp();
  await assert.rejects(
    async () => undoImport(client(), '../../etc/passwd', { dir }),
    /not allowed/,
  );
  await assert.rejects(async () => undoImport(client(), '', { dir }), /"id" is required/);
});

// ---------------------------------------------------------------------------
// Regressions found auditing v1.1.0
// ---------------------------------------------------------------------------
test('a store whose name contains -- keeps its own retention bucket', async () => {
  const dir = await tmp();
  const config = { ...backupConfig({}), dir, keep: 2 };

  for (const hour of ['10', '11', '12']) {
    await fs.writeFile(path.join(dir, `Player--Data--2026-09-10T${hour}-00-00-000Z.json`), '{}');
  }
  for (const hour of ['09', '13']) {
    await fs.writeFile(path.join(dir, `Player--2026-09-10T${hour}-00-00-000Z.json`), '{}');
  }

  await prune(config);
  const left = (await fs.readdir(dir)).sort();

  assert.equal(left.filter((n) => n.startsWith('Player--Data')).length, 2);
  assert.equal(left.filter((n) => /^Player--2026/.test(n)).length, 2,
    '"Player" must not lose files to "Player--Data"');
});

test('files that are not ours are left alone', async () => {
  const dir = await tmp();
  const config = { ...backupConfig({}), dir, keep: 1 };

  await fs.writeFile(path.join(dir, 'notes.json'), '{}');
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  for (const hour of ['10', '11']) {
    await fs.writeFile(path.join(dir, `PlayerData--2026-09-10T${hour}-00-00-000Z.json`), '{}');
  }

  const removed = await prune(config);
  const left = (await fs.readdir(dir)).sort();

  assert.deepEqual(removed, ['PlayerData--2026-09-10T10-00-00-000Z.json']);
  assert.ok(left.includes('notes.json') && left.includes('package.json'));
  assert.deepEqual((await listBackups(config)).files.map((f) => f.name),
    ['PlayerData--2026-09-10T11-00-00-000Z.json'], 'the listing hides them too');
});

test('the newest import is the one offered, whatever the store is called', async () => {
  const dir = await tmp();

  await importDataStore(client(), 'ZStore', dump(['Player_1']), {
    mode: 'overwrite', dir, now: new Date('2026-09-10T10:00:00Z'),
  });
  const newer = await importDataStore(client(), 'AStore', dump(['Player_1']), {
    mode: 'overwrite', dir, now: new Date('2026-09-10T18:00:00Z'),
  });

  const { imports } = await listJournals(dir);
  assert.equal(imports[0].id, newer.undoId, 'sorted by when it ran, not by filename');
  assert.equal(imports.find((i) => !i.undoneAt).datastore, 'AStore');
});

test('an import records which universe it touched', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1']), {
    mode: 'overwrite', dir,
  });

  assert.equal((await readJournal(r.undoId, dir)).universeId, '1');
  assert.equal((await listJournals(dir)).imports[0].universeId, '1');
});

test('undo refuses a journal from a different universe', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1']), {
    mode: 'overwrite', dir,
  });

  const other = new DataStoreClient({ apiKey: 'k', universeId: '999' });
  await assert.rejects(
    async () => undoImport(other, r.undoId, { dir }),
    /universe 1, but this is 999/,
  );
});

test('the listing only offers imports from the universe you are looking at', async () => {
  const dir = await tmp();
  await importDataStore(client(), 'PlayerData', dump(['Player_1']), { mode: 'overwrite', dir });

  assert.equal((await listJournals(dir, { universeId: '1' })).imports.length, 1);
  assert.equal((await listJournals(dir, { universeId: '999' })).imports.length, 0);
  assert.equal((await listJournals(dir)).imports.length, 1, 'no filter means show everything');
});

test('undo puts the user ids back with the value', async () => {
  const dir = await tmp();
  const r = await importDataStore(client(), 'PlayerData', dump(['Player_1']), {
    mode: 'overwrite', dir,
  });

  const before = calls.length;
  await undoImport(client(), r.undoId, { dir });

  const write = calls.slice(before).find((c) => c.method === 'POST');
  assert.ok(write, 'a write went out');
  assert.deepEqual(JSON.parse(write.headers['roblox-entry-userids']), [4242],
    'the restored entry keeps its user ids');
});

// ---------------------------------------------------------------------------
// Regressions found auditing v1.1.1
// ---------------------------------------------------------------------------
test('a rate limited run does not replace good backups with empty ones', async () => {
  const dir = await tmp();
  const config = { ...backupConfig({ BACKUP_INTERVAL_MIN: '30' }), dir, keep: 2, stores: ['PlayerData'] };

  for (const day of ['01', '02']) {
    await runBackup(client(), { config, now: new Date(`2026-01-${day}T00:00:00Z`) });
  }

  entriesRateLimited = true;
  const bad = await runBackup(client(), { config, now: new Date('2026-01-03T00:00:00Z') });
  entriesRateLimited = false;

  assert.deepEqual(bad.written, [], 'nothing was written');
  assert.equal(bad.failures.length, 1);
  assert.match(bad.failures[0].error, /read none of/);
  assert.deepEqual(bad.pruned, [], 'and nothing was pruned to make room for it');

  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, [
    'PlayerData--2026-01-01T00-00-00-000Z.json',
    'PlayerData--2026-01-02T00-00-00-000Z.json',
  ], 'both real backups survive');
});

test('retention only touches stores that got a fresh file', async () => {
  const dir = await tmp();
  const config = { ...backupConfig({ BACKUP_INTERVAL_MIN: '30' }), dir, keep: 1, stores: ['PlayerData'] };

  // An old backup of a store this run does not cover.
  await fs.writeFile(path.join(dir, 'Retired--2026-01-01T00-00-00-000Z.json'), '{}');
  await fs.writeFile(path.join(dir, 'Retired--2026-01-02T00-00-00-000Z.json'), '{}');

  await runBackup(client(), { config, now: new Date('2026-01-03T00:00:00Z') });

  const left = (await fs.readdir(dir)).sort();
  assert.ok(left.includes('Retired--2026-01-01T00-00-00-000Z.json'));
  assert.ok(left.includes('Retired--2026-01-02T00-00-00-000Z.json'));
});

test('undo follows the scope the import actually wrote to', async () => {
  const dir = await tmp();

  // The file carries its own scope, which beats the run's scope on the write.
  const payload = { entries: [{ key: 'Player_1', scope: 'global', value: { coins: 1 } }] };
  const r = await importDataStore(client(), 'PlayerData', payload, {
    mode: 'overwrite', scope: 'beta', dir,
  });

  const journal = await readJournal(r.undoId, dir);
  assert.equal(journal.rows[0].scope, 'global', 'the row remembers where it went');
  assert.equal(journal.scope, 'beta', 'the run scope is still recorded separately');

  const before = calls.length;
  await undoImport(client(), r.undoId, { dir });

  const restore = calls.slice(before).find((c) => c.method === 'POST');
  assert.equal(restore.query.get('scope'), 'global', 'undo goes back to the same scope');
});

test('two imports in the same millisecond keep separate records', async () => {
  const dir = await tmp();
  const now = new Date('2026-09-10T10:00:00Z');

  const a = await importDataStore(client(), 'PlayerData', dump(['Player_1']), { mode: 'overwrite', dir, now });
  const b = await importDataStore(client(), 'PlayerData', dump(['Player_2']), { mode: 'overwrite', dir, now });

  assert.notEqual(a.undoId, b.undoId);
  assert.equal((await listJournals(dir)).imports.length, 2);
});

test('the journal is on disk before the writes finish', async () => {
  const dir = await tmp();
  const seen = [];

  // Peek at the journal directory from inside the write path. A plain delegate,
  // not a Proxy: DataStoreClient uses private fields, which a Proxy breaks.
  const real = client();
  const spy = {
    universeId: real.universeId,
    getEntry: (...a) => real.getEntry(...a),
    getVersion: (...a) => real.getVersion(...a),
    deleteEntry: (...a) => real.deleteEntry(...a),
    setEntry: async (...a) => {
      seen.push((await fs.readdir(dir).catch(() => [])).length);
      return real.setEntry(...a);
    },
  };

  await importDataStore(spy, 'PlayerData', dump(['Player_1', 'Player_2']), { mode: 'overwrite', dir });

  assert.deepEqual(seen, [1, 1], 'a journal file existed before the first write went out');
});
