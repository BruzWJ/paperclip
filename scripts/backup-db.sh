#!/usr/bin/env bash
set -euo pipefail

# Backup the configured Paperclip database to the configured backup directory
# (default: ~/.paperclip/instances/<instance-id>/data/backups)
#
# Usage:
#   ./scripts/backup-db.sh
#   pnpm db:backup
#
# DATABASE_URL or database.connectionString must point at an already-running
# external PostgreSQL server. BETTER_AUTH_SECRET must be the deployment's
# durable secret, and compatible pg_dump/pg_restore client tools must be
# installed. The command writes a complete payload plus its required manifest.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
exec pnpm paperclipai db:backup "$@"
