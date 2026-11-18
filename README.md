# Backend Service

A Node.js/TypeScript backend service with PostgreSQL, Drizzle ORM, and Docker-based deployment.

## Getting Started

```bash
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
