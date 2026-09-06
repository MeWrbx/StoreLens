import { apiRequest, required, ValidationError } from './http.js';

// Ordered DataStores are a separate Open Cloud service from standard ones:
// integer values only, kept sorted, which is what leaderboards are built on.
const BASE = process.env.ROBLOX_ORDERED_API_BASE
  || 'https://apis.roblox.com/ordered-data-stores/v1/universes';

const seg = (s) => encodeURIComponent(String(s));

function asInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`"${name}" must be a whole number (ordered stores hold integers only).`);
  }
  return n;
}

export class OrderedDataStoreClient {
  constructor({ apiKey, universeId }) {
    if (!apiKey) throw new Error('ROBLOX_API_KEY is not set');
    if (!universeId) throw new Error('ROBLOX_UNIVERSE_ID is not set');
    this.apiKey = apiKey;
    this.universeId = String(universeId);
  }

  // Ordered stores have no "list all stores" endpoint - you have to know the name.
  entriesRoot(store, scope = 'global') {
    required(store, 'store');
    return `${BASE}/${seg(this.universeId)}/orderedDataStores/${seg(store)}`
      + `/scopes/${seg(scope || 'global')}/entries`;
  }

  async #json(url, opts) {
    const { text } = await apiRequest(url, { apiKey: this.apiKey, ...opts });
    return text ? JSON.parse(text) : null;
  }

  // order_by 'desc' gives the classic top-scores view.
  listEntries(store, { scope, limit = 50, pageToken, ascending = false } = {}) {
    return this.#json(this.entriesRoot(store, scope), {
      query: {
        max_page_size: limit,
        page_token: pageToken,
        order_by: ascending ? 'asc' : 'desc',
      },
    });
  }

  getEntry(store, entryId, { scope } = {}) {
    required(entryId, 'entry');
    return this.#json(`${this.entriesRoot(store, scope)}/${seg(entryId)}`);
  }

  createEntry(store, entryId, value, { scope } = {}) {
    required(entryId, 'entry');
    return this.#json(this.entriesRoot(store, scope), {
      method: 'POST',
      query: { id: entryId },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: asInteger(value, 'value') }),
    });
  }

  updateEntry(store, entryId, value, { scope, allowMissing = false } = {}) {
    required(entryId, 'entry');
    return this.#json(`${this.entriesRoot(store, scope)}/${seg(entryId)}`, {
      method: 'PATCH',
      query: { allow_missing: allowMissing ? 'true' : 'false' },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: asInteger(value, 'value') }),
    });
  }

  // Atomic on Roblox's side, which is what you want for a live leaderboard.
  incrementEntry(store, entryId, amount, { scope } = {}) {
    required(entryId, 'entry');
    return this.#json(`${this.entriesRoot(store, scope)}/${seg(entryId)}:increment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: asInteger(amount, 'amount') }),
    });
  }

  async deleteEntry(store, entryId, { scope } = {}) {
    required(entryId, 'entry');
    return (await this.#json(`${this.entriesRoot(store, scope)}/${seg(entryId)}`, {
      method: 'DELETE',
    })) ?? { ok: true };
  }
}
