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

export async function listJournals(dir = undoDir(), { universeId = null } = {}) {
  let names;
  try { names = await fs.readdir(dir); } catch { return { dir, imports: [] }; }

  const imports = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      imports.push({
        id: j.id,
        universeId: j.universeId ?? null,
        datastore: j.datastore,
        scope: j.scope ?? null,
        mode: j.mode,
        at: j.at,
        rows: Array.isArray(j.rows) ? j.rows.length : 0,
        undoneAt: j.undoneAt ?? null,
      });
    } catch { /* half-written or hand-edited, skip it */ }
  }

  // Sort by when the import ran, not by filename. The id starts with the store
  // name, so filename order would offer you an import into "AStore" ahead of a
  // newer one into "ZStore".
  imports.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // A journal from another universe must not be offered as "the last import".
  // Journals written before universes were recorded have null and stay visible.
  const wanted = universeId == null ? null : String(universeId);
  const filtered = wanted === null
    ? imports
    : imports.filter((i) => i.universeId === null || i.universeId === wanted);

  return { dir, imports: filtered };
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
 *
 * There is no matchVersion here on purpose: undo is what you reach for when the
 * import was wrong, and it should not fail because the bad value was written
 * again afterwards. That does mean it overwrites anything newer, so undo soon.
 */
export async function undoImport(client, id, { dir = undoDir(), dryRun = false } = {}) {
  const journal = await readJournal(id, dir);
  const scope = journal.scope ?? undefined;

  // Writing one universe's old values into another one would be a bad day.
  if (journal.universeId && String(client.universeId) !== String(journal.universeId)) {
    throw new ValidationError(
      `That import was made against universe ${journal.universeId}, but this is ${client.universeId}.`,
    );
  }

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
          // Carry the user ids back too, or the restored entry loses the
          // association Roblox needs for right-to-erasure requests.
          await client.setEntry(journal.datastore, row.key, value, {
            scope, userIds: row.userIds,
          });
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
