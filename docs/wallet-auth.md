# Wallet signature authentication

Buyer-facing payment routes (`GET /buyers/{address}/payments`,
`GET /payments/{id}/receipt`) authenticate the caller with an Ed25519
signature from their Stellar wallet.

| Header               | Value                                              |
| -------------------- | -------------------------------------------------- |
| `X-Wallet-Address`   | Stellar public key (receipt route only)            |
| `X-Wallet-Timestamp` | Unix seconds; must be within 5 minutes of server   |
| `X-Wallet-Signature` | Base64 Ed25519 signature of the message below      |

## Message format (v2)

```
synapsvault-wallet-auth-v2
{METHOD}
{path}
{canonical query}
{timestamp}
```

Lines are joined with `\n` (no trailing newline).

- `METHOD` — upper-case HTTP method, e.g. `GET`.
- `path` — request path without the query string, e.g. `/buyers/GABC.../payments`.
- `canonical query` — built from the request's query string:
  1. Decode every `key=value` pair (`application/x-www-form-urlencoded` rules, so `+` is a space).
  2. Sort pairs by key, then by value, comparing UTF-16 code units (JavaScript's default `<` ordering).
  3. Re-encode each key and value with RFC 3986 percent-encoding (`encodeURIComponent`, plus `!'()*` → `%21 %27 %28 %29 %2A`).
  4. Join as `key=value` pairs separated by `&`.

  If the request has no query parameters this line is empty, but it is still present.
- `timestamp` — the exact `X-Wallet-Timestamp` value.

Because every query parameter is part of the signed message, changing,
adding, removing or duplicating a filter or pagination argument (for example
`limit`, `cursor`, `from`) invalidates the signature and the server responds
with `401 UNAUTHORIZED`.

### Reference implementation (JavaScript)

```js
import { Keypair } from "@stellar/stellar-sdk";

function canonicalQuery(search) {
  const enc = (v) =>
    encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...new URLSearchParams(search)]
    .sort(([ka, va], [kb, vb]) => cmp(ka, kb) || cmp(va, vb))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");
}

function walletAuthHeaders(keypair, method, url) {
  const { pathname, search } = new URL(url);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = ["synapsvault-wallet-auth-v2", method.toUpperCase(), pathname, canonicalQuery(search), timestamp].join("\n");
  return {
    "X-Wallet-Address": keypair.publicKey(),
    "X-Wallet-Timestamp": timestamp,
    "X-Wallet-Signature": keypair.sign(Buffer.from(message, "utf8")).toString("base64"),
  };
}
```

## Migrating from v1

The v1 message (`synapsvault-wallet-auth-v1\n{METHOD}\n{path}\n{timestamp}`)
did not cover the query string.

- **v1 is deprecated.** The server still accepts a v1 signature, but **only when
  the request has no query string**. Any request with query parameters must be
  signed with v2.
- To migrate, change the prefix to `synapsvault-wallet-auth-v2` and insert the
  canonical query line between the path and the timestamp. For a request
  without query parameters that line is empty, e.g.

  ```
  synapsvault-wallet-auth-v2\nGET\n/buyers/GABC.../payments\n\n1767225600
  ```
- No header changes are required; the server tries v2 first and falls back to
  v1 only for query-less requests.
- v1 support will be removed in a future release; new filters and pagination
  parameters on payment history are v2-only by construction.
