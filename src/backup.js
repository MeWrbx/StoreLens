import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exportDataStore } from './export.js';
import { ValidationError } from './http.js';

// A backup is an export written to disk on a timer. Same cost and the same caps
// as clicking Export - the point is that it happens without anyone remembering.
//
// Backups only read from Open Cloud, so they stay allowed in read-only mode.

const MIN_INTERVAL_MIN = 5;

export function backupConfig(env = process.env) {
  const intervalMin = Number(env.BACKUP_INTERVAL_MIN || 0);
  const keep = Number(env.BACKUP_KEEP || 7);
  const maxEntries = Number(env.BACKUP_MAX_ENTRIES || 2000);
  const errors = [];

  if (!Number.isFinite(intervalMin)) errors.push('BACKUP_INTERVAL_MIN must be a number.');
  else if (intervalMin > 0 && intervalMin < MIN_INTERVAL_MIN) {
    errors.push(`BACKUP_INTERVAL_MIN must be at least ${MIN_INTERVAL_MIN}.`);
  }
  // exportDataStore enforces the same range. Catching it here means you are told
  // at startup instead of watching every run fail with an empty backup list.
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 20000) {
    errors.push('BACKUP_MAX_ENTRIES must be a whole number between 1 and 20000.');
  }

  return {
    enabled: Number.isFinite(intervalMin) && intervalMin > 0 && errors.length === 0,
    requested: Number.isFinite(intervalMin) && intervalMin > 0,
    errors,
    intervalMin,
    dir: env.BACKUP_DIR || 'backups',
    // Empty means every store the key can see.
    stores: String(env.BACKUP_STORES || '').split(',').map((s) => s.trim()).filter(Boolean),
    keep: Number.isFinite(keep) ? Math.max(1, Math.trunc(keep)) : 7,
    maxEntries,
  };
}

// Store names may contain slashes and other things a filename cannot. Keep the
// readable part so a human can still tell the files apart, and add a short
// fingerprint whenever sanitising changed something - otherwise "Player Data"
// and "Player_Data" would both become Player_Data and quietly share one file.
export function safeName(store) {
  const raw = String(store);
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  const base = cleaned || 'store';
  if (cleaned === raw) return base;
  return `${base}~${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 6)}`;
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

async function pickStores(client, cfg) {
  if (cfg.stores.length) return cfg.stores;

  const page = await client.listDataStores({ limit: 100 });
  const list = page?.datastores || page?.dataStores || [];
  return list.map((d) => d?.name).filter(Boolean);
}

// Our own files look like `<store>--<stamp>.json`. Anchoring on the stamp at
// the end matters: splitting on the first `--` would put "Player--Data" and
// "Player" in the same bucket and delete one store's backups to make room for
// the other's. It also means anything else living in the directory is left
// alone rather than counted and pruned.
const BACKUP_FILE = /^(.+)--(\d{4}-\d{2}-\d{2}T[0-9-]+Z)\.json$/;

// Keep the newest `keep` files per store. The timestamp sorts lexically, so
// plain string order is chronological order.
export async function prune(cfg = backupConfig(), { only = null } = {}) {
  let names;
  try { names = await fs.readdir(cfg.dir); } catch { return []; }

  const byStore = new Map();
  for (const name of names) {
    const match = BACKUP_FILE.exec(name);
    if (!match) continue;
    const store = match[1];
    // `only` limits retention to stores that got a fresh, usable file just now.
    // Deleting yesterday's good backup to make room for today's failed one is
    // exactly the trade nobody wants.
    if (only && !only.has(store)) continue;
    if (!byStore.has(store)) byStore.set(store, []);
    byStore.get(store).push(name);
  }

  const removed = [];
  for (const files of byStore.values()) {
    files.sort();
    while (files.length > cfg.keep) {
      const old = files.shift();
      await fs.rm(path.join(cfg.dir, old), { force: true });
      removed.push(old);
    }
  }
  return removed;
}

export async function runBackup(client, { config = backupConfig(), now = new Date() } = {}) {
  const cfg = config;
  await fs.mkdir(cfg.dir, { recursive: true });

  const stores = await pickStores(client, cfg);
  const written = [];
  const failures = [];

  const refreshed = new Set();

  for (const store of stores) {
    try {
      const dump = await exportDataStore(client, store, { maxEntries: cfg.maxEntries });

      // exportDataStore reports unreadable keys instead of throwing, so a store
      // that is merely rate limited comes back looking like an empty store. It
      // must never be written over a real backup.
      if (dump.count === 0 && dump.failures.length > 0) {
        failures.push({
          store,
          error: `read none of ${dump.failures.length} keys (${dump.failures[0].error})`,
        });
        continue;
      }

      const name = `${safeName(store)}--${stamp(now)}.json`;
      await fs.writeFile(path.join(cfg.dir, name), JSON.stringify(dump, null, 2));

      refreshed.add(safeName(store));
      written.push({
        store,
        file: path.join(cfg.dir, name),
        count: dump.count,
        truncated: dump.truncated,
        unreadable: dump.failures.length,
      });
    } catch (err) {
      // One unreadable store must not cost you the rest of the run.
      failures.push({ store, error: err.message });
    }
  }

  return {
    at: now.toISOString(),
    dir: cfg.dir,
    written,
    failures,
    pruned: await prune(cfg, { only: refreshed }),
  };
}

export async function listBackups(cfg = backupConfig()) {
  let names;
  try { names = await fs.readdir(cfg.dir); } catch { return { dir: cfg.dir, files: [] }; }

  const files = [];
  for (const name of names.filter((n) => BACKUP_FILE.test(n)).sort().reverse()) {
    try {
      const st = await fs.stat(path.join(cfg.dir, name));
      files.push({ name, bytes: st.size, at: st.mtime.toISOString() });
    } catch { /* vanished between readdir and stat */ }
  }
  return { dir: cfg.dir, files };
}

/**
 * Run a backup every `intervalMin` minutes.
 *
 * Deliberately does not fire on boot: `node --watch` would then hammer Open
 * Cloud on every save. The first run happens one interval in.
 */
export function startScheduler(makeClient, { config = backupConfig(), log = console } = {}) {
  const cfg = config;
  if (!cfg.enabled) return null;

  if (cfg.intervalMin < MIN_INTERVAL_MIN) {
    throw new ValidationError(`BACKUP_INTERVAL_MIN must be at least ${MIN_INTERVAL_MIN}.`);
  }

  let running = false;

  const tick = async () => {
    // A slow export must not stack up behind itself.
    if (running) return null;
    running = true;
    try {
      const result = await runBackup(makeClient(), { config: cfg });
      const failed = result.failures.length ? `, ${result.failures.length} failed` : '';
      log.log(`[backup] ${result.written.length} store(s) -> ${cfg.dir}${failed}`);
      return result;
    } catch (err) {
      log.error(`[backup] ${err.message}`);
      return null;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, cfg.intervalMin * 60_000);
  timer.unref();

  return { tick, stop: () => clearInterval(timer) };
}
