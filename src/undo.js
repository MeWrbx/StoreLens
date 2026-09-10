import fs from 'node:fs/promises';
import path from 'node:path';
import { required, ValidationError } from './http.js';
import { safeName, stamp } from './backup.js';

// An import overwrites live player saves. Before each write we note which
// version was there, and that note is what undo replays.
//
// Undo does not rewind history - it writes the old value back as a new version.
// Keys the import created are deleted instead, which on Open Cloud is a soft
// delete, so they stay recoverable from the version list either way.

export function undoDir(env = process.env) {
  return env.UNDO_DIR || path.join(env.BACKUP_DIR || 'backups', 'undo');
}

export function journalId(datastore, now = new Date()) {
  return `${safeName(datastore)}--${stamp(now)}`;
}

export async function writeJournal(journal, dir = undoDir()) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${journal.id}.json`);
  await fs.writeFile(file, JSON.stringify(journal, null, 2));
  return file;
}

export async function listJournals(dir = undoDir()) {
  let names;
  try { names = await fs.readdir(dir); } catch { return { dir, imports: [] }; }

  const imports = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse()) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      imports.push({
        id: j.id,
        datastore: j.datastore,
        scope: j.scope ?? null,
        mode: j.mode,
        at: j.at,
        rows: Array.isArray(j.rows) ? j.rows.length : 0,
        undoneAt: j.undoneAt ?? null,
      });
    } catch { /* half-written or hand-edited, skip it */ }
  }
  return { dir, imports };
}

export async function readJournal(id, dir = undoDir()) {
  required(id, 'id');

  // The id becomes a filename, so it must not be able to climb out of the dir.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new ValidationError('That import id has characters that are not allowed.');
  }

  let raw;
  try {
    raw = await fs.readFile(path.join(dir, `${id}.json`), 'utf8');
  } catch {
    throw new ValidationError(`No record of import "${id}". It may have been cleaned up.`);
  }

  const journal = JSON.parse(raw);
  if (!Array.isArray(journal.rows)) {
    throw new ValidationError(`The record for "${id}" is unreadable.`);
  }
  return journal;
}

/**
 * Put back whatever the import replaced.
 *
 * Rows carrying a `previousVersion` get that version's value written back.
 * Rows without one were created by the import, so they get deleted.
 */
export async function undoImport(client, id, { dir = undoDir(), dryRun = false } = {}) {
  const journal = await readJournal(id, dir);
  const scope = journal.scope ?? undefined;

  const restored = [];
  const removed = [];
  const failures = [];

  for (const row of journal.rows) {
    try {
      if (row.previousVersion) {
        const { value } = await client.getVersion(
          journal.datastore, row.key, row.previousVersion, { scope },
        );
        if (!dryRun) {
          await client.setEntry(journal.datastore, row.key, value, { scope });
        }
        restored.push(row.key);
      } else {
        if (!dryRun) {
          await client.deleteEntry(journal.datastore, row.key, { scope });
        }
        removed.push(row.key);
      }
    } catch (err) {
      failures.push({ key: row.key, error: err.message });
    }
  }

  if (!dryRun && failures.length === 0) {
    journal.undoneAt = new Date().toISOString();
    await writeJournal(journal, dir).catch(() => { /* the undo already happened */ });
  }

  return {
    id,
    datastore: journal.datastore,
    scope: journal.scope ?? null,
    dryRun,
    total: journal.rows.length,
    restored: restored.length,
    removed: removed.length,
    failed: failures.length,
    restoredKeys: restored,
    removedKeys: removed,
    failures,
  };
}
