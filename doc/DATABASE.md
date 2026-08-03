# Database

Paperclip requires an externally provisioned PostgreSQL server for every real
runtime, migration, development, and operator flow. Set `DATABASE_URL` or
`database.connectionString` before running any database command.

```sh
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
pnpm db:migrate
pnpm dev
```

For local development, start the `db` service from
`docker/docker-compose.yml`. Hosted PostgreSQL is supported through the same
connection contract. If the runtime uses a pooled URL, configure
`DATABASE_MIGRATION_URL` with the provider's direct administrative URL.

Automated tests never use a database. They mock the database module or the
narrow service boundary before importing the subject, and validate generated
schema and migration artifacts structurally. The stable test runner removes
inherited database and libpq environment variables, so a developer's configured
application database cannot be reached by a test.
