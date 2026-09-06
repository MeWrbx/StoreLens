import crypto from 'node:crypto';

// Override for tests against a local mock.
const BASE = process.env.ROBLOX_API_BASE || 'https://apis.roblox.com/datastores/v1/universes';

// Open Cloud can stall. Without a deadline a single hung request leaves the
// dashboard stuck on "Loading..." forever.
const TIMEOUT_MS = Number(process.env.ROBLOX_TIMEOUT_MS) > 0
  ? Number(process.env.ROBLOX_TIMEOUT_MS)
  : 15000;

export class RobloxApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'RobloxApiError';
    this.status = status;
    this.body = body;
  }
}

// Bad input from the caller, caught before a pointless round trip to Open Cloud.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(`"${name}" is required.`);
  }
  return value;
}

// HTTP headers are ByteStrings. JSON.stringify leaves non-ASCII characters as
// they are, so an attribute holding an umlaut or an emoji would otherwise throw
// deep inside fetch with an unreadable ByteString error.
function headerJson(value) {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
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

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'x-api-key': this.apiKey, ...headers },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new RobloxApiError(504, `Open Cloud did not answer within ${TIMEOUT_MS} ms.`, null);
      }
      throw new RobloxApiError(502, `Could not reach Open Cloud: ${err?.message || err}`, null);
    }

    const text = await res.text();

    if (!res.ok) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

      let message = parsed?.message || parsed?.error || `Open Cloud returned ${res.status}`;
      if (res.status === 429) {
        const retry = res.headers.get('retry-after');
        message = `Rate limited by Open Cloud${retry ? `, retry in ${retry}s` : ''}.`;
      }

      throw new RobloxApiError(res.status, message, parsed);
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
