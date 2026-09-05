import crypto from 'node:crypto';

// Override for tests against a local mock.
const BASE = process.env.ROBLOX_API_BASE || 'https://apis.roblox.com/datastores/v1/universes';

export class RobloxApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'RobloxApiError';
    this.status = status;
    this.body = body;
  }
}

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

  async #request(path, { method = 'GET', query = {}, body, headers = {} } = {}) {
    const url = new URL(this.root + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      method,
      headers: { 'x-api-key': this.apiKey, ...headers },
      body,
    });

    const text = await res.text();

    if (!res.ok) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      throw new RobloxApiError(
        res.status,
        parsed?.message || parsed?.error || `Open Cloud returned ${res.status}`,
        parsed,
      );
    }

    return { text, headers: res.headers };
  }

  async #json(path, opts) {
    const { text } = await this.#request(path, opts);
    return text ? JSON.parse(text) : null;
  }

  listDataStores({ prefix, cursor, limit = 50 } = {}) {
    return this.#json('', { query: { prefix, cursor, limit } });
  }

  listKeys(datastoreName, { scope, allScopes, prefix, cursor, limit = 100 } = {}) {
    return this.#json('/datastore/entries', {
      query: { datastoreName, scope, allScopes, prefix, cursor, limit },
    });
  }

  // The value comes back as a raw body, metadata sits in response headers.
  async getEntry(datastoreName, entryKey, { scope } = {}) {
    const { text, headers } = await this.#request('/datastore/entries/entry', {
      query: { datastoreName, entryKey, scope },
    });

    let value;
    try { value = JSON.parse(text); } catch { value = text; }

    return {
      value,
      meta: {
        version: headers.get('roblox-entry-version'),
        createdTime: headers.get('roblox-entry-created-time'),
        versionCreatedTime: headers.get('roblox-entry-version-created-time'),
        attributes: safeJson(headers.get('roblox-entry-attributes')),
        userIds: safeJson(headers.get('roblox-entry-userids')),
      },
    };
  }

  // Open Cloud requires a content-md5 over the exact body it receives.
  setEntry(datastoreName, entryKey, value, { scope, matchVersion, userIds = [], attributes = {} } = {}) {
    const body = JSON.stringify(value);
    const md5 = crypto.createHash('md5').update(body, 'utf8').digest('base64');

    return this.#json('/datastore/entries/entry', {
      method: 'POST',
      query: { datastoreName, entryKey, scope, matchVersion },
      headers: {
        'content-type': 'application/json',
        'content-md5': md5,
        'roblox-entry-userids': JSON.stringify(userIds),
        'roblox-entry-attributes': JSON.stringify(attributes),
      },
      body,
    });
  }

  // Soft delete - previous versions stay retrievable.
  deleteEntry(datastoreName, entryKey, { scope } = {}) {
    return this.#json('/datastore/entries/entry', {
      method: 'DELETE',
      query: { datastoreName, entryKey, scope },
    });
  }

  listVersions(datastoreName, entryKey, { scope, sortOrder = 'Descending', cursor, limit = 25 } = {}) {
    return this.#json('/datastore/entries/entry/versions', {
      query: { datastoreName, entryKey, scope, sortOrder, cursor, limit },
    });
  }

  async getVersion(datastoreName, entryKey, versionId, { scope } = {}) {
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
