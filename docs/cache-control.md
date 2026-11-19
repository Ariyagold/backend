# Cache-Control policy for sensitive responses

Responses that contain credentials or private financial data must never be
stored by browsers, shared proxies or CDNs. These routes send:

```
Cache-Control: no-store
Pragma: no-cache
Expires: 0
```

`no-store` forbids any cache from keeping a copy (unlike `no-cache` or
`private`, which still allow storage). `Pragma` and `Expires` cover legacy
HTTP/1.0 intermediaries.

| Route                                        | Why                                        |
| -------------------------------------------- | ------------------------------------------ |
| `POST /publishers`                           | Returns the one-time API key and signing secret |
| `POST /publishers/me/api-keys/rotate`        | Returns a newly issued API key             |
| `POST /publishers/me/signing-secret/rotate`  | Returns a newly issued HMAC signing secret |
| `GET /buyers/{address}/payments`             | Wallet-authorized buyer payment history    |
| `GET /payments/{id}/receipt`                 | Wallet/API-key-authorized payment receipt  |

The headers come from the `noStore` middleware in `src/middleware/security.ts`.
It is mounted **before** rate limiting, authentication and validation, so error
responses (400/401/403/404/409/429/500) on these routes carry the same policy.

When you add a route that returns credentials or per-user financial data, put
`noStore` first in its middleware chain and add a case to
`src/routes/noStore.test.ts`.

## Cross-replica catalog invalidation

The resource catalog and metadata entries are cached in-process by
`src/services/resourceService.ts`. Because the API can run as multiple backend
replicas, a mutation handled by one replica must not leave stale catalog or
metadata entries visible on another replica until their TTL expires.

### Shared version token

Invalidation is coordinated through a **shared catalog version token** stored in
the shared backing store (not in process memory). Every replica reads the same
token. The token is a monotonically increasing counter that is bumped whenever a
catalog or metadata entry is mutated (created, updated, deleted, or otherwise
invalidated).

Each cached entry records the version token value that was current when it was
populated. A cached entry is considered fresh only while the shared token still
matches the value recorded with it. When a mutation bumps the token, entries
cached under the previous value are treated as stale on **every** replica, so a
mutation on one replica invalidates the corresponding entries on all replicas.

`invalidateReads()` therefore does two things:

1. Bumps the shared version token (publishing the invalidation to all replicas).
2. Clears the local process caches for the calling replica.

### Freshness guarantee

After a mutation completes (the shared token has been bumped and the mutation
response has been returned), any subsequent read served by **any** replica
observes the mutation. Concretely:

- A read that begins after the mutation response is returned will not return a
  catalog or metadata entry cached under a pre-mutation version token.
- The freshness bound is therefore **immediate on the next read** for entries
  guarded by the shared token; there is no window in which a remote replica can
  serve stale catalog or metadata content until TTL expiry.
- TTLs remain in effect as an upper bound on cache lifetime for entries that are
  not explicitly invalidated, but they are no longer the mechanism that
  determines cross-replica freshness after a mutation.

The two-instance test (`src/services/resourceService.replicas.test.ts`) starts
two independent service instances sharing the same backing store, performs a
mutation on one instance, and asserts that the other instance observes the
mutation on its next read rather than serving the stale cached entry.

## Paid range-request protocol for large media

Large audio/video resources are delivered with HTTP byte-range support so
clients can stream and resume downloads. Range handling lives in
`src/routes/resources.ts` and `src/storage/supabaseStorage.ts`.

### Single-range behavior

- Only a **single** byte range is supported. A request with multiple ranges
  (e.g. `bytes=0-99,200-299`) is not satisfied with a multipart response.
- A satisfiable single range returns **`206 Partial Content`** with a
  `Content-Range: bytes <start>-<end>/<complete-length>` header and a
  `Content-Length` equal to the length of the returned range.
- A syntactically valid but unsatisfiable range (start at or beyond the resource
  length) returns **`416 Range Not Satisfiable`** with
  `Content-Range: bytes */<complete-length>`.
- A request without a `Range` header returns the full resource with
  `200 OK`.
- A malformed `Range` header is ignored and the full resource is returned with
  `200 OK`, per standard HTTP behavior.

### Authorization and idempotent retries

Range requests do **not** change the payment model. Authorization is evaluated
on every request, including range retries:

- A range request is served only if the caller is authorized for the resource
  (purchase/entitlement check). Range headers cannot be used to bypass payment
  authorization; an unauthorized range request is rejected before any bytes are
  read.
- Serving a range (or retrying a range, or resuming a download) **does not
  charge again**. Payment is tied to the purchase/entitlement, not to individual
  byte-range requests. Retries and resumes are idempotent with respect to
  billing: they re-validate the existing entitlement and never create a new
  charge.
- Because authorization is re-checked per request, a client that retries a range
  after its entitlement is revoked is denied, and a client that retries a range
  while entitled is served without an additional charge.