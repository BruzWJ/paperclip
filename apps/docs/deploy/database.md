---
title: Database
summary: Connect Paperclip to external PostgreSQL
---

Paperclip is a PostgreSQL client. Provide a running PostgreSQL server before
starting the application; there is no local database fallback.

## Local PostgreSQL with Docker

Start the repository's database service:

```sh
docker compose -f docker/docker-compose.yml up -d db
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
pnpm db:migrate
pnpm dev
```

## Hosted PostgreSQL

Set `DATABASE_URL` to a direct PostgreSQL connection URL supplied by your
provider. A configuration file may instead contain
`database.connectionString`; the environment variable takes precedence.

Use a direct administrative connection for migrations. If the runtime uses a
pooled URL, set `DATABASE_MIGRATION_URL` to the provider's direct connection.
Paperclip validates the protocol and fails before startup when neither target
is valid.

## Backups and recovery

Paperclip does not manage database backups. Use your external PostgreSQL
provider's snapshots, PITR, or managed backup features. When restoring, also
restore any local encrypted secrets key and local storage files if those
providers are enabled on the instance.

### Upgrade note

The migration that retires AI-sharing feedback deletes its historical vote,
export, and consent records, along with the retired instance sharing-preference
and backup-retention settings. Take and retain an external database snapshot
before applying it if those records must be preserved for audit, export, or
retention requirements.

## Tests

Automated tests do not accept a database URL and never start, connect to,
query, migrate, reset, or drop a database. Database-dependent modules are
replaced with deterministic test-owned mocks; Drizzle schema,
migration SQL, metadata, constraints, and trigger bodies are checked as static
artifacts. The test runner also removes inherited database and libpq variables
before each Vitest process, protecting a developer's configured runtime target.
