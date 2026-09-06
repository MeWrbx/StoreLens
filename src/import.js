import { required, ValidationError } from './http.js';

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

/**
 * Write an exported dump back into a data store.
 *
 * mode 'skip-existing' only creates keys that are missing - the safe default.
 * mode 'overwrite' replaces whatever is there.
 * dryRun reports what would happen without writing anything.
 */
export async function importDataStore(client, datastoreName, payload, {
  scope, mode = 'skip-existing', dryRun = false,
} = {}) {
  required(datastoreName, 'datastore');

  if (mode !== 'skip-existing' && mode !== 'overwrite') {
    throw new ValidationError('"mode" must be "skip-existing" or "overwrite".');
  }

  const rows = normalise(payload);
  const written = [];
  const skipped = [];
  const failures = [];

  for (const row of rows) {
    const keyScope = row.scope ?? scope ?? undefined;

    try {
      if (mode === 'skip-existing') {
        let exists = true;
        try {
          await client.getEntry(datastoreName, row.key, { scope: keyScope });
        } catch (err) {
          if (err.status === 404) exists = false;
          else throw err;
        }

        if (exists) {
          skipped.push({ key: row.key, reason: 'already exists' });
          continue;
        }
      }

      if (!dryRun) {
        await client.setEntry(datastoreName, row.key, row.value, {
          scope: keyScope,
          userIds: row.userIds,
        });
      }
      written.push(row.key);
    } catch (err) {
      failures.push({ key: row.key, error: err.message });
    }
  }

  return {
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
  };
}
