# syntax=docker/dockerfile:1

# ── Build stage: full install + TypeScript compile ──────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p packages/registry-client && npm run build && npm prune --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

# Release provenance: injected by CI at build time (no secrets).
ARG GIT_COMMIT=unknown
ARG APP_VERSION=0.0.0
ARG BUILD_DATE=unknown

ENV NODE_ENV=production \
    PORT=3000 \
    LEDGER_TRACKER_PATH=/app/data/last-processed-ledger.json \
    GIT_COMMIT=${GIT_COMMIT} \
    APP_VERSION=${APP_VERSION}

LABEL org.opencontainers.image.title="synapse-backend" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle

# Run as an unprivileged user
RUN addgroup -S synapse && adduser -S synapse -G synapse \
  && mkdir -p /app/data && chown synapse:synapse /app/data
USER synapse

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/index.js"]
