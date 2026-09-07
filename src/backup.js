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

  return {
    enabled: Number.isFinite(intervalMin) && intervalMin > 0,
    intervalMin,
    dir: env.BACKUP_DIR || 'backups',
    // Empty means every store the key can see.
    stores: String(env.BACKUP_STORES || '').split(',').map((s) => s.trim()).filter(Boolean),
    keep: Number.isFinite(keep) ? Math.max(1, Math.trunc(keep)) : 7,
    maxEntries: Number.isFinite(maxEntries) ? maxEntries : 2000,
  };
}

// Store names may contain slashes and other things a filename cannot. Keep the
// readable part so a human can still tell the files apart.
export function safeName(store) {
  const cleaned = String(store).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return cleaned || 'store';
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

async function pickStores(client, cfg) {
  if (cfg.stores.length) return cfg.stores;

  const page = await client.listDataStores({ limit: 100 });
  const list = page?.datastores || page?.dataStores || [];
  return list.map((d) => d?.name).filter(Boolean);
}

// Keep the newest `keep` files per store. The timestamp sorts lexically, so
// plain string order is chronological order.
export async function prune(cfg = backupConfig()) {
  let names;
  try { names = await fs.readdir(cfg.dir); } catch { return []; }

  const byStore = new Map();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const store = name.split('--')[0];
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

  for (const store of stores) {
    try {
      const dump = await exportDataStore(client, store, { maxEntries: cfg.maxEntries });
      const file = path.join(cfg.dir, `${safeName(store)}--${stamp(now)}.json`);
      await fs.writeFile(file, JSON.stringify(dump, null, 2));
      written.push({ store, file, count: dump.count, truncated: dump.truncated });
    } catch (err) {
      // One unreadable store must not cost you the rest of the run.
      failures.push({ store, error: err.message });
    }
  }

  return { at: now.toISOString(), dir: cfg.dir, written, failures, pruned: await prune(cfg) };
}

export async function listBackups(cfg = backupConfig()) {
  let names;
  try { names = await fs.readdir(cfg.dir); } catch { return { dir: cfg.dir, files: [] }; }

  const files = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse()) {
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
