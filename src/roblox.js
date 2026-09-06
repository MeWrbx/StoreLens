import crypto from 'node:crypto';
import { apiRequest, headerJson, required, RobloxApiError, ValidationError } from './http.js';

// Override for tests against a local mock.
const BASE = process.env.ROBLOX_API_BASE || 'https://apis.roblox.com/datastores/v1/universes';

// Re-exported so callers keep importing their errors from one place.
export { RobloxApiError, ValidationError };

export class DataStoreClient {
  constructor({ apiKey, universeId }) {
    if (!apiKey) throw new Error('ROBLOX_API_KEY is not set');
    if (!universeId) throw new Error('ROBLOX_UNIVERSE_ID is not set');
    this.apiKey = apiKey;
    this.universeId = String(universeId);
  }

  get root() {
    return `${BASE}/${this.universeId}/standard-datastores`;
  }

  #request(path, opts = {}) {
    return apiRequest(this.root + path, { apiKey: this.apiKey, ...opts });
  }

  async #json(path, opts) {
    const { text } = await this.#request(path, opts);
    return text ? JSON.parse(text) : null;
  }

  listDataStores({ prefix, cursor, limit = 50 } = {}) {
    return this.#json('', { query: { prefix, cursor, limit } });
  }

  listKeys(datastoreName, { scope, allScopes, prefix, cursor, limit = 100 } = {}) {
    required(datastoreName, 'datastore');
    return this.#json('/datastore/entries', {
      query: { datastoreName, scope, allScopes, prefix, cursor, limit },
    });
  }

  // The value comes back as a raw body, metadata sits in response headers.
  async getEntry(datastoreName, entryKey, { scope } = {}) {
    required(datastoreName, 'datastore');
    required(entryKey, 'key');

    const { text, headers } = await this.#request('/datastore/entries/entry', {
      query: { datastoreName, entryKey, scope },
    });

    let value;
    try { value = JSON.parse(text); } catch { value = text; }

    const userIds = safeJson(headers.get('roblox-entry-userids'));

    return {
      value,
      meta: {
        version: headers.get('roblox-entry-version'),
        createdTime: headers.get('roblox-entry-created-time'),
        versionCreatedTime: headers.get('roblox-entry-version-created-time'),
        attributes: safeJson(headers.get('roblox-entry-attributes')),
        userIds: Array.isArray(userIds) ? userIds : [],
      },
    };
  }

  // Open Cloud requires a content-md5 over the exact body it receives.
  setEntry(datastoreName, entryKey, value, { scope, matchVersion, userIds = [], attributes = {} } = {}) {
    required(datastoreName, 'datastore');
    required(entryKey, 'key');
    if (value === undefined) throw new ValidationError('"value" is required.');

    const body = JSON.stringify(value);
    const md5 = crypto.createHash('md5').update(body, 'utf8').digest('base64');

    return this.#json('/datastore/entries/entry', {
      method: 'POST',
      query: { datastoreName, entryKey, scope, matchVersion },
      headers: {
        'content-type': 'application/json',
        'content-md5': md5,
        'roblox-entry-userids': headerJson(Array.isArray(userIds) ? userIds : []),
        'roblox-entry-attributes': headerJson(
          attributes && typeof attributes === 'object' ? attributes : {},
        ),
      },
      body,
    });
  }

  // Soft delete - previous versions stay retrievable.
  deleteEntry(datastoreName, entryKey, { scope } = {}) {
    required(datastoreName, 'datastore');
    required(entryKey, 'key');
    return this.#json('/datastore/entries/entry', {
      method: 'DELETE',
      query: { datastoreName, entryKey, scope },
    });
  }

  listVersions(datastoreName, entryKey, { scope, sortOrder = 'Descending', cursor, limit = 25 } = {}) {
    required(datastoreName, 'datastore');
    required(entryKey, 'key');
    return this.#json('/datastore/entries/entry/versions', {
      query: { datastoreName, entryKey, scope, sortOrder, cursor, limit },
    });
  }

  async getVersion(datastoreName, entryKey, versionId, { scope } = {}) {
    required(datastoreName, 'datastore');
    required(entryKey, 'key');
    required(versionId, 'versionId');

    const { text } = await this.#request('/datastore/entries/entry/versions/version', {
      query: { datastoreName, entryKey, versionId, scope },
    });
    try { return { value: JSON.parse(text) }; } catch { return { value: text }; }
  }
}

function safeJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}
