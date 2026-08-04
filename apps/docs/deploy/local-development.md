---
title: Local Development
summary: Set up Paperclip for local development
---

Run Paperclip locally against a provisioned PostgreSQL server.

## Prerequisites

- Node.js >=22.13.0
- pnpm 9+

## Start Dev Server

```sh
docker compose -f docker/docker-compose.yml up -d db
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
pnpm install
pnpm db:migrate
pnpm dev
```

This starts:

- **API server** at `http://localhost:3100`
- **UI** served by the API server in dev middleware mode (same origin)

The database target is required. Paperclip validates it before startup and
never creates a local database process.

## One-Command Bootstrap

For a first-time install:

```sh
pnpm paperclipai run
```

This does:

1. Auto-onboards if config is missing
2. Runs `paperclipai doctor` checks
3. Starts the server when checks pass

## Bind Presets In Dev

Default `pnpm dev` uses loopback-only binding. Open the UI and create or sign
in to a Better Auth account before using the board.

To open Paperclip to a private network:

```sh
pnpm dev --bind lan
```

For Tailscale-only binding on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Allow additional private hostnames:

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

For full setup and troubleshooting, see [Tailscale Private Access](/deploy/tailscale-private-access).

## Health Checks

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## Safe Worktree Bootstrap for Local Agent Runs

For safer parallel local experiments, initialize a dedicated worktree instance instead of reusing your main checkout:

```sh
pnpm paperclipai worktree:make local-lab \
  --database-url postgres://paperclip:secret@db.example.test:5432/paperclip_local_lab
cd ~/paperclip-local-lab
pnpm paperclipai run
pnpm paperclipai doctor
```

The target must be a newly provisioned empty PostgreSQL database. Worktree
creation writes a pinned database URL and a distinct Better Auth secret. If
creation or later identity validation fails, discard the target and create a
new worktree with another empty database.

When done, shut it down and remove the isolated state explicitly:

```sh
pnpm paperclipai worktree:cleanup local-lab --force
```

## Start With A New Database

Paperclip does not clear or rebuild an existing database. Provision a new empty
external PostgreSQL database, update `DATABASE_URL` (or
`database.connectionString`), and start Paperclip once against that target.

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | Externally provisioned PostgreSQL target selected by `DATABASE_URL` or configuration |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |
| Logs | `~/.paperclip/instances/default/logs` |

Override with environment variables:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```
