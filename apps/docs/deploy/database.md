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

## Complete disaster-recovery backups

`paperclipai db:backup` creates two inseparable files: a complete custom-format
PostgreSQL payload and an external Paperclip manifest. The payload includes the
canonical schema, migration journal, tables, sequences, constraints, and all
rows. The manifest records the source physical database identity, complete
table set, payload checksum, and a salted one-way fingerprint of
`BETTER_AUTH_SECRET`.

The host running the command must have compatible `pg_dump` and `pg_restore`
client tools installed. `DATABASE_URL` (or the configured external connection)
and the deployment's durable `BETTER_AUTH_SECRET` must be present:

```sh
paperclipai db:backup
```

Restore is a disaster-recovery operation, not initialization, repair, reset,
reseed, worktree cloning, or selective import. Provision a physically distinct
empty PostgreSQL database and put the same deployment Better Auth secret in a
mode-`0600` file, then supply every input explicitly:

```sh
paperclipai db:restore \
  --database-url 'postgresql://operator@new-db.example/paperclip' \
  --backup-file /secure/backups/paperclip-20260729T120000Z.dump \
  --manifest-file /secure/backups/paperclip-20260729T120000Z.dump.manifest.json \
  --better-auth-secret-file /secure/backups/better-auth-secret
```

Paperclip validates the manifest, payload checksum, archive table set, secret
fingerprint, target emptiness, and physical source/target inequality before
mutation. It restores the archive exactly once in a transaction, applies only
ordinary remaining forward migrations, and returns verified non-secret facts.
Raw SQL, an inferred sidecar manifest, an initialized target, a different
deployment secret, and a partial backup are rejected without clearing the
target.

## Tests

Automated tests do not accept a database URL and never start, connect to,
query, migrate, reset, or drop a database. Database-dependent modules are
replaced with deterministic test-owned mocks; Drizzle schema,
migration SQL, metadata, constraints, and trigger bodies are checked as static
artifacts. The test runner also removes inherited database and libpq variables
before each Vitest process, protecting a developer's configured runtime target.
