import { required, ValidationError } from './http.js';

// Open Cloud rate limits per universe, so a few requests in flight is plenty.
const CONCURRENCY = 4;

function checkCap(maxEntries, name = 'max') {
  const cap = Number(maxEntries);
  if (!Number.isInteger(cap) || cap < 1 || cap > 20000) {
    throw new ValidationError(`"${name}" must be a whole number between 1 and 20000.`);
  }
  return cap;
}

// Page through the key list until the cap is hit.
async function collectKeys(client, datastoreName, { scope, prefix, cap }) {
  const keys = [];
  let cursor;

  do {
    const page = await client.listKeys(datastoreName, { scope, prefix, cursor, limit: 100 });
    cursor = page?.nextPageCursor || null;

    for (const k of page?.keys || []) {
      if (keys.length >= cap) { cursor = null; break; }
      keys.push({ key: k.key, scope: k.scope ?? scope ?? null });
    }
  } while (cursor);

  return keys;
}

// Read every key with a small worker pool. `onEntry` decides what to keep.
async function readEntries(client, datastoreName, keys, onEntry) {
  const failures = [];
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const { key, scope } = keys[i];

      try {
        const { value, meta } = await client.getEntry(datastoreName, key, { scope });
        onEntry(i, {
          key,
          scope,
          value,
          version: meta.version,
          updated: meta.versionCreatedTime,
          userIds: meta.userIds,
        });
      } catch (err) {
        // One unreadable key must not throw away a long run.
        failures.push({ key, scope, error: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));
  return failures;
}

// Walk every key in a data store and pull its value. Bounded on purpose: a
// runaway export would burn the universe's rate limit budget for everyone.
export async function exportDataStore(client, datastoreName, {
  scope, prefix, maxEntries = 2000,
} = {}) {
  required(datastoreName, 'datastore');
  const cap = checkCap(maxEntries);

  const keys = await collectKeys(client, datastoreName, { scope, prefix, cap });
  const entries = new Array(keys.length);
  const failures = await readEntries(client, datastoreName, keys, (i, row) => { entries[i] = row; });
  const rows = entries.filter(Boolean);

  return {
    datastore: datastoreName,
    scope: scope || null,
    prefix: prefix || null,
    exportedAt: new Date().toISOString(),
    count: rows.length,
    truncated: keys.length >= cap,
    failures,
    entries: rows,
  };
}

// Find keys by what is *inside* them. Open Cloud can only filter by key prefix,
// so this reads the entries and matches locally - same cost as an export.
export async function searchEntries(client, datastoreName, {
  scope, prefix, contains, caseSensitive = false, maxEntries = 2000,
} = {}) {
  required(datastoreName, 'datastore');
  required(contains, 'contains');
  const cap = checkCap(maxEntries);

  const needle = caseSensitive ? String(contains) : String(contains).toLowerCase();
  const keys = await collectKeys(client, datastoreName, { scope, prefix, cap });

  const matches = new Array(keys.length);
  const failures = await readEntries(client, datastoreName, keys, (i, row) => {
    const text = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
    const hay = caseSensitive ? text : text.toLowerCase();
    if (hay.includes(needle)) matches[i] = row;
  });

  const rows = matches.filter(Boolean);

  return {
    datastore: datastoreName,
    scope: scope || null,
    prefix: prefix || null,
    contains,
    caseSensitive,
    scanned: keys.length,
    count: rows.length,
    truncated: keys.length >= cap,
    failures,
    entries: rows,
  };
}
