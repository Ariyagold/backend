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
