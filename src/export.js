import { required, ValidationError } from './http.js';

// Open Cloud rate limits per universe, so a few requests in flight is plenty.
const CONCURRENCY = 4;

// Walk every key in a data store and pull its value. Bounded on purpose: a
// runaway export would burn the universe's rate limit budget for everyone.
export async function exportDataStore(client, datastoreName, {
  scope, prefix, maxEntries = 2000,
} = {}) {
  required(datastoreName, 'datastore');

  const cap = Number(maxEntries);
  if (!Number.isInteger(cap) || cap < 1 || cap > 20000) {
    throw new ValidationError('"max" must be a whole number between 1 and 20000.');
  }

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

  const entries = new Array(keys.length);
  const failures = [];
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const { key, scope: keyScope } = keys[i];

      try {
        const { value, meta } = await client.getEntry(datastoreName, key, { scope: keyScope });
        entries[i] = {
          key,
          scope: keyScope,
          value,
          version: meta.version,
          updated: meta.versionCreatedTime,
          userIds: meta.userIds,
        };
      } catch (err) {
        // One unreadable key must not throw away a long export.
        failures.push({ key, scope: keyScope, error: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));

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
