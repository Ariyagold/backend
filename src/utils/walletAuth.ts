/**
 * Wallet-signature authentication messages for buyer-facing payment routes.
 *
 * v1 (deprecated): `synapsvault-wallet-auth-v1\n{METHOD}\n{path}\n{timestamp}`
 *   Does not cover the query string, so filters and pagination arguments could
 *   be altered without invalidating the signature. The server only accepts v1
 *   for requests that carry no query string at all.
 *
 * v2: `synapsvault-wallet-auth-v2\n{METHOD}\n{path}\n{canonicalQuery}\n{timestamp}`
 *   `canonicalQuery` is the request's query parameters, decoded, sorted by
 *   key then value (UTF-16 code-unit order), re-encoded with RFC 3986 percent
 *   encoding and joined as `k=v&k=v`. An empty query yields an empty line.
 *
 * See docs/wallet-auth.md for the client migration guide.
 */

export const WALLET_AUTH_V1_PREFIX = "synapsvault-wallet-auth-v1";
export const WALLET_AUTH_V2_PREFIX = "synapsvault-wallet-auth-v2";

/** RFC 3986 unreserved-only encoding (encodeURIComponent leaves !'()* alone). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Raw query string (without the leading `?` or any fragment) of a request URL. */
export function rawQueryFromUrl(url: string): string {
  const hashIndex = url.indexOf("#");
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  return queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);
}

/**
 * Canonical form of a raw query string. Parameter order and encoding variants
 * (`%20` vs `+`, upper/lower-case hex) produce the same output; any change to a
 * key or value — including adding, removing, or duplicating one — does not.
 */
export function canonicalizeQuery(rawQuery: string): string {
  const pairs = [...new URLSearchParams(rawQuery)];
  pairs.sort(([ka, va], [kb, vb]) => compare(ka, kb) || compare(va, vb));
  return pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
}

export function buildWalletAuthMessageV1(params: {
  method: string;
  path: string;
  timestamp: string;
}): string {
  return [WALLET_AUTH_V1_PREFIX, params.method.toUpperCase(), params.path, params.timestamp].join("\n");
}

export function buildWalletAuthMessageV2(params: {
  method: string;
  path: string;
  rawQuery: string;
  timestamp: string;
}): string {
  return [
    WALLET_AUTH_V2_PREFIX,
    params.method.toUpperCase(),
    params.path,
    canonicalizeQuery(params.rawQuery),
    params.timestamp,
  ].join("\n");
}
