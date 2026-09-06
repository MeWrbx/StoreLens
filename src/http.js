// Shared plumbing for the two Open Cloud APIs this project talks to:
// standard DataStores (src/roblox.js) and ordered DataStores (src/ordered.js).

// Open Cloud can stall. Without a deadline a single hung request leaves the
// dashboard stuck on "Loading..." forever.
export const TIMEOUT_MS = Number(process.env.ROBLOX_TIMEOUT_MS) > 0
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

export function required(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(`"${name}" is required.`);
  }
  return value;
}

// HTTP headers are ByteStrings. JSON.stringify leaves non-ASCII characters as
// they are, so an attribute holding an umlaut or an emoji would otherwise throw
// deep inside fetch with an unreadable ByteString error.
export function headerJson(value) {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

export async function apiRequest(baseUrl, {
  apiKey, method = 'GET', query = {}, body, headers = {},
} = {}) {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'x-api-key': apiKey, ...headers },
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
