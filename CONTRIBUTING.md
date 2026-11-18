# Contributing to SynapsVault Backend

Welcome! We're building a Stellar-powered marketplace for digital resources. This guide covers local development, testing, and code standards.

## Local Development

### Prerequisites
- Node.js 24+ (npm 11)
- Docker & Docker Compose (for PostgreSQL)

### Setup

```bash
# Install dependencies
npm ci

# Copy environment variables
cp .env.example .env

# Start PostgreSQL (detached)
docker compose up postgres -d

# Run migrations
npm run db:migrate

# Start dev server (hot reload)
npm run dev
```

Dev server runs at `http://localhost:3000` with TypeScript hot-reload.

### Docker Workflow

```bash
# Build + run full stack (API + DB)
docker compose up

# Rebuild image
npm run docker:build

# Stop containers
docker compose down

# View logs
npm run docker:logs
```

## Branch Strategy

| Branch | Purpose | Target |
|--------|---------|--------|
| `main` | Production-ready code | Deployed to production |
| `dev` | Staging/integration | Pre-release testing |
| `feat/*` | New features | PR to `dev` |
| `fix/*` | Bug fixes | PR to `dev` |
| `chore/*` | Maintenance | PR to `dev` |

## Development Workflow

1. Create feature branch: `git checkout -b feat/my-feature`
2. Make changes and test locally
3. Run type checking: `npm run typecheck`
4. Run tests: `npm run test`
5. Commit with conventional format (see below)
6. Push and open PR to `dev`

## Testing

```bash
npm run test              # Run all tests once
npm run test:watch       # Watch mode (rerun on changes)
npm run test src/routes  # Test specific folder
```

All critical paths must have tests. Aim for >80% coverage on routes.

## Adding a New Route

1. **Create route file**: `src/routes/my-endpoint.ts`
   ```typescript
   import { Router } from 'express';
   const router = Router();
   
   router.post('/my-endpoint', async (req, res) => {
     // Implementation
   });
   
   export default router;
   ```

2. **Register in app**: Edit `src/app.ts`
   ```typescript
   import myRouter from './routes/my-endpoint';
   app.use('/api', myRouter);
   ```

3. **Add tests**: Create `src/routes/my-endpoint.test.ts`

4. **Document**: Add OpenAPI annotation if public endpoint

## Code Standards

- **TypeScript**: Strict mode enabled, no `any` without comment
- **Async/await**: Prefer over callbacks
- **Error handling**: Use try/catch in handlers, proper HTTP status codes
- **Database**: Use Drizzle ORM, migrations for schema changes
- **Environment**: Load via `.env` (never hardcode secrets)

## Commit Format (Conventional Commits)

```
feat(routes): add payment webhook endpoint
fix(db): handle concurrent subscription renewals
test(auth): add signature verification tests
docs: improve deployment guide
chore: upgrade express to 5.0
```

**Types**: feat, fix, test, docs, chore, refactor, perf

## Database Changes

```bash
# Make schema changes in src/db/schema.ts
npm run db:generate   # Create migration
npm run db:migrate    # Apply migration
```

### Upgrade Testing (Previous Released Schema)

Fresh-database migration smoke tests cannot catch incompatibilities with existing
production rows. Every migration must therefore be validated as an *upgrade* from
the previously released schema, not only as a fresh install.

**Supported upgrade paths**

- Upgrades are supported from the **immediately previous released schema** to the
  current `main`. Each release tag (`vX.Y.Z`) is a supported upgrade source for the
  next release.
- Skipping releases (e.g. `v1.0.0` → `v1.3.0`) is only supported when every
  intermediate migration is additive. If any intermediate migration is
  incompatible (drops/renames columns, tightens constraints, backfills), the
  upgrade must be performed step-by-step through each release.
- Downgrades are **not** supported.

**Upgrade fixtures**

- Upgrade fixtures live under `drizzle/upgrade-fixtures/<from-version>/` and
  contain representative prior-version data (SQL seed files) for the released
  schema they target.
- The upgrade test seeds a database with the fixture, runs `npm run db:migrate`,
  and asserts that existing rows are preserved and that indexes/constraints are
  present and valid.
- **Incompatible migrations require a fixture.** If a migration drops or renames
  columns, tightens constraints, or backfills data, the PR must add or update the
  corresponding upgrade fixture and the assertions that verify the transformation.
  PRs with incompatible migrations and no fixture will not be merged.

```bash
# Run upgrade tests locally (seeds prior-version data, then migrates)
npm run test:upgrade
```

## Code Review Checklist

- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Tests pass (`npm run test`)
- [ ] No console.log in production code
- [ ] Database migrations included
- [ ] Upgrade fixture added/updated for incompatible migrations
- [ ] Error handling for edge cases
- [ ] Follows conventional commit format

## Questions?

- Open a GitHub issue
- Check existing PRs for similar work
- Ask in Stellar Dev Discord #synapsvault
