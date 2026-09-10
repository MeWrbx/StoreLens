import { required, ValidationError } from './http.js';
import { journalId, undoDir, writeJournal } from './undo.js';

// Writes go one at a time. An import can touch thousands of live player saves,
// so being slow and predictable beats being fast.
const MAX_ROWS = 5000;

// Accepts what exportDataStore produced: either the whole dump or just its
// entries array.
function normalise(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.entries;

  if (!Array.isArray(rows)) {
    throw new ValidationError('Expected an export file with an "entries" array.');
  }
  if (rows.length === 0) {
    throw new ValidationError('That file has no entries.');
  }
  if (rows.length > MAX_ROWS) {
    throw new ValidationError(`That file has ${rows.length} entries, the limit is ${MAX_ROWS}.`);
  }

  return rows.map((row, i) => {
    if (!row || typeof row !== 'object') {
      throw new ValidationError(`Entry ${i + 1} is not an object.`);
    }
    if (typeof row.key !== 'string' || row.key === '') {
      throw new ValidationError(`Entry ${i + 1} has no "key".`);
    }
    if (row.value === undefined) {
      throw new ValidationError(`Entry "${row.key}" has no "value".`);
    }
    return row;
  });
}

// What is live at this key right now: its version id, or null if it is absent.
async function currentVersion(client, datastoreName, key, scope) {
  try {
    const { meta } = await client.getEntry(datastoreName, key, { scope });
    return { exists: true, version: meta?.version ?? null, userIds: meta?.userIds ?? [] };
  } catch (err) {
    if (err.status === 404) return { exists: false, version: null, userIds: [] };
    throw err;
  }
}

/**
 * Write an exported dump back into a data store.
 *
 * mode 'skip-existing' only creates keys that are missing - the safe default.
 * mode 'overwrite' replaces whatever is there.
 * dryRun reports what would happen without writing anything.
 *
 * Unless recordUndo is false, every write is noted first, so the whole import
 * can be put back later with undoImport().
 */
export async function importDataStore(client, datastoreName, payload, {
  scope, mode = 'skip-existing', dryRun = false, recordUndo = true, dir = undoDir(), now = new Date(),
} = {}) {
  required(datastoreName, 'datastore');

  if (mode !== 'skip-existing' && mode !== 'overwrite') {
    throw new ValidationError('"mode" must be "skip-existing" or "overwrite".');
  }

  const rows = normalise(payload);
  const written = [];
  const skipped = [];
  const failures = [];
  const journalRows = [];

  // The journal is opened before the first write and flushed as we go. Writing
  // it only at the end would mean a crash halfway through a 5000 row import
  // leaves live saves overwritten with no record of what they were.
  const journal = {
    id: journalId(datastoreName, now),
    universeId: client.universeId ?? null,
    datastore: datastoreName,
    scope: scope || null,
    mode,
    at: now.toISOString(),
    rows: journalRows,
  };
  const keepingJournal = !dryRun && recordUndo;
  let journalError = null;
  let sinceFlush = 0;

  const flush = async () => {
    sinceFlush = 0;
    try { await writeJournal(journal, dir); } catch (err) { journalError = err.message; }
  };

  if (keepingJournal) await flush();

  for (const row of rows) {
    const keyScope = row.scope ?? scope ?? undefined;

    try {
      // Both modes need to know what is there: one to decide whether to skip,
      // the other to be able to undo. Overwriting without recording is the only
      // case that can skip the read.
      const needsRead = mode === 'skip-existing' || recordUndo;
      const live = needsRead
        ? await currentVersion(client, datastoreName, row.key, keyScope)
        : { exists: null, version: null, userIds: [] };

      if (mode === 'skip-existing' && live.exists) {
        skipped.push({ key: row.key, reason: 'already exists' });
        continue;
      }

      if (!dryRun) {
        await client.setEntry(datastoreName, row.key, row.value, {
          scope: keyScope,
          userIds: row.userIds,
        });
      }

      written.push(row.key);
      journalRows.push({
        key: row.key,
        scope: keyScope ?? null,
        previousVersion: live.version,
        userIds: live.userIds,
      });

      if (keepingJournal && ++sinceFlush >= 25) await flush();
    } catch (err) {
      failures.push({ key: row.key, error: err.message });
    }
  }

  if (keepingJournal) await flush();

  const result = {
    datastore: datastoreName,
    scope: scope || null,
    mode,
    dryRun,
    total: rows.length,
    written: written.length,
    skipped: skipped.length,
    failed: failures.length,
    skippedKeys: skipped,
    failures,
    undoId: keepingJournal && journalRows.length && !journalError ? journal.id : null,
  };

  // Losing the journal must not fail an import that already went through.
  if (journalError) result.undoError = journalError;

  return result;
}
