# Backend Service

A Node.js/TypeScript backend service with PostgreSQL, Drizzle ORM, and Docker-based deployment.

## Getting Started

```bash
git clone https://github.com/SynapsVault/backend SynapsVault-backend
cd SynapsVault-backend
npm ci

cp .env.example .env
# Fill in the required values (marked "required" in .env.example). The server
# validates config on boot and exits listing anything missing.

npm run db:migrate   # apply drizzle migrations
npm run db:check-schema # compare the migrated database with src/db/schema.ts
# Use a dedicated, disposable database for this Postgres-backed suite.
npm run test:integration # run against the migrated database in DATABASE_URL
npm run audit:storage-integrity -- --limit 500 --dry-run # report missing or changed stored files
npm run dev          # dev server with hot reload (default port 4021)

npm run typecheck
npm test
npm run build && npm start
```

## Docker

```bash
# Single container (listens on 3000; run migrations first)
docker build -t synapsvault-backend .
docker run --env-file .env -p 3000:3000 synapsvault-backend

# Full stack (API + Postgres), using values from .env
docker compose up
```

## API reference

The OpenAPI 3 spec is served at `/openapi.json`, with Swagger UI at `/docs`.

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/health`, `/health/ready` | — | Liveness / readiness (DB + Soroban RPC) |
| `GET` | `/metrics` | Bearer `METRICS_TOKEN` | Prometheus metrics |
| `GET` | `/resources` | — | Catalog: search, price/type/status filters, sort, pagination |
| `POST` | `/resources` | API key | Publish a file (multipart) or link resource |
| `GET` | `/resources/:id/meta` | — | Public preview |
| `GET` | `/resources/:id` | x402 | Pay and access the resource |
| `DELETE` | `/resources/:id` | API key | Delist own resource |
| `GET` | `/resources/:id/register/prepare` | API key | Unsigned on-chain register tx |
| `POST` | `/resources/:id/register` | API key | Submit signed register tx |
| `POST` | `/resources/:id/price[/prepare]` | API key | Update on-chain price |
| `POST` | `/resources/:id/ownership[/prepare]` | API key | Transfer on-chain ownership |
| `POST` | `/verify-content` | x402 | AI originality check |
| `GET` | `/agent/status` | — | Verification agent stats |
| `POST` | `/publishers` | — | Register; returns the API key once |
| `GET` | `/publishers/me[/resources\|/analytics]` | API key | Profile, resources, earnings |
| `GET` `PATCH` | `/publishers/me/rate-limit` | API key | View / override own rate limit |
| `GET` `PATCH` | `/publishers/me/webhooks` | API key | Webhook URL, secret, events |
| `POST` | `/publishers/me/webhooks/test` | API key | Send a signed test event |
| `GET` | `/publishers/leaderboard` | — | Creator leaderboard |
| `GET` | `/payments/:id/receipt` | — | Payment receipt |
| `GET` | `/buyers/:address/payments` | — | Buyer purchase history |
| `GET` | `/registry/status` | — | On-chain registry stats |
| `GET` | `/admin/stats`, `/admin/audit` | Admin key | Platform metrics, payment audit |
| `POST` | `/admin/delist/:id` | Admin key | Force delist |

### Errors

Every error response has the same shape:

```json
{ "error": "Resource not found", "code": "NOT_FOUND", "requestId": "…" }
```

`code` is one of `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INTERNAL_ERROR`,
`UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE` or `GATEWAY_TIMEOUT`. Validation errors
add field-level `details`. The `requestId` matches the `x-request-id` header.

### Webhooks

Publishers configure one endpoint with `PATCH /publishers/me/webhooks`
(`webhookUrl`, `webhookSecret`, `webhookEvents`, `webhookEnabled`). Events:
`resource.purchased`, `payment.received`, `resource.listed`, `resource.delisted`.
Deliveries are `POST { event, timestamp, data }`. When a secret is set,
`X-SynapsVault-Signature` holds the hex HMAC-SHA256 of `${timestamp}.${body}`,
where `timestamp` is the ISO-8601 value in `X-SynapsVault-Timestamp` and
`body` is the raw JSON body (#45). Each delivery also carries a unique
`X-SynapsVault-Id` header for deduplication.

Verification example (Node.js):

```js
const crypto = require("crypto");

function verifyWebhook(req, secret) {
  const timestamp = req.headers["x-synapsvault-timestamp"];
  const signature = req.headers["x-synapsvault-signature"];

  // Reject deliveries older than 5 minutes to prevent replays.
  const age = Date.now() - new Date(timestamp).getTime();
  if (age > 5 * 60 * 1000) throw new Error("Webhook too old");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${req.rawBody}`)   // rawBody = Buffer / string before JSON.parse
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
    throw new Error("Invalid webhook signature");
  }
}
npm install
npm run dev
```

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, migrations, and workflow details.

## Release Provenance

Every published backend image embeds reproducible release metadata and ships with a dependency SBOM so operators can identify exactly what is running in a container.

### Embedded metadata

The Docker image is built with the following build args, which are surfaced as OCI labels and environment variables:

| Build arg     | OCI label                     | Env var       | Description                          |
| ------------- | ----------------------------- | ------------- | ------------------------------------ |
| `GIT_COMMIT`  | `org.opencontainers.image.revision` | `GIT_COMMIT`  | Full git SHA the image was built from |
| `VERSION`     | `org.opencontainers.image.version`  | `APP_VERSION` | Release version / tag                |
| `BUILD_DATE`  | `org.opencontainers.image.created`  | —             | Build timestamp (ISO 8601)           |

These values are injected by CI from the workflow context only — no environment secrets are baked into the image.

### Mapping an image digest to its source commit and SBOM

1. **Read the labels** from the image digest:

   ```bash
   docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
     ghcr.io/<owner>/<repo>@sha256:<digest>
   ```

   The `org.opencontainers.image.revision` label is the source commit SHA. The `org.opencontainers.image.version` label is the release version.

2. **Locate the SBOM** for that release. Each release publishes a CycloneDX SBOM artifact named `sbom-<version>.cdx.json` (attached to the GitHub Release and uploaded as a CI artifact). Download it from the release page or the workflow run that produced the image.

3. **Cross-check** the SBOM against the commit by inspecting the `metadata.component` and `metadata.properties` fields, which record the same commit SHA and version embedded in the image labels.

If the labels are missing, the image was not built through the release workflow and should not be treated as a reproducible release.
