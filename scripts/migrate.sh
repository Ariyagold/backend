#!/usr/bin/env bash
#
# Database migration runner.
#
# Supported upgrade paths
# -----------------------
# Upgrades are supported from the previous released schema to the current
# schema (i.e. one release step at a time). When a migration is incompatible
# with existing rows (drops/renames columns, tightens constraints, changes
# index definitions, etc.) a matching upgrade fixture MUST be added under
# `drizzle/fixtures/<from-version>/` so CI can populate representative
# prior-version data, run the upgrade, and verify data and indexes survive.
#
# Usage:
#   scripts/migrate.sh                 # apply pending migrations
#   scripts/migrate.sh --upgrade-test  # seed prior-version fixture, migrate, verify
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="${ROOT_DIR}/drizzle/fixtures"

run_migrations() {
  echo "Applying migrations..."
  npx drizzle-kit migrate
}

# Load the most recent prior-version fixture (if any) before upgrading.
seed_fixture() {
  if [ ! -d "${FIXTURES_DIR}" ]; then
    echo "No upgrade fixtures found; skipping prior-version seed."
    return 0
  fi

  local fixture
  fixture="$(find "${FIXTURES_DIR}" -mindepth 2 -maxdepth 2 -name 'seed.sql' | sort | tail -n 1)"
  if [ -z "${fixture}" ]; then
    echo "No upgrade fixtures found; skipping prior-version seed."
    return 0
  fi

  echo "Seeding prior-version data from ${fixture}..."
  psql "${DATABASE_URL:?DATABASE_URL must be set}" -v ON_ERROR_STOP=1 -f "${fixture}"
}

# Verify representative data and indexes survived the upgrade.
verify_upgrade() {
  local fixture_dir
  fixture_dir="$(dirname "$(find "${FIXTURES_DIR}" -mindepth 2 -maxdepth 2 -name 'seed.sql' | sort | tail -n 1)")"
  local verify_sql="${fixture_dir}/verify.sql"

  if [ ! -f "${verify_sql}" ]; then
    echo "No verify.sql for ${fixture_dir}; skipping post-upgrade verification."
    return 0
  fi

  echo "Verifying upgraded data and indexes from ${verify_sql}..."
  psql "${DATABASE_URL:?DATABASE_URL must be set}" -v ON_ERROR_STOP=1 -f "${verify_sql}"
}

case "${1:-}" in
  --upgrade-test)
    seed_fixture
    run_migrations
    verify_upgrade
    ;;
  "")
    run_migrations
    ;;
  *)
    echo "Unknown argument: $1" >&2
    exit 1
    ;;
esac
