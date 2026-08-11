---
title: Quickstart
summary: Get Paperclip running in minutes
---

Get Paperclip running locally in under 5 minutes.

## Quick Start (Recommended)

```sh
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
npx paperclipai onboard --yes
```

This walks you through setup, configures your environment, and gets Paperclip running against the supplied PostgreSQL server.

If you already have a Paperclip install, rerunning `onboard` keeps your current config and data paths intact. Use `paperclipai configure` if you want to edit settings.

To start Paperclip again later:

```sh
npx paperclipai run
```

> **Note:** If you used `npx` for setup, always use `npx paperclipai` to run commands. The `pnpm paperclipai` form only works inside a cloned copy of the Paperclip repository (see Local Development below).

## Local Development

For contributors working on Paperclip itself. Prerequisites: Node.js >=22.13.0 and pnpm 9+.

Clone the repository, then:

```sh
docker compose -f docker/docker-compose.yml up -d db
pnpm install
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
pnpm db:migrate
pnpm dev
```

This starts the API server and UI at [http://localhost:3100](http://localhost:3100).

`DATABASE_URL` must name a running PostgreSQL server before Paperclip starts.

When working from the cloned repo, you can also use:

```sh
pnpm paperclipai run
```

This auto-onboards if config is missing, runs health checks with auto-repair, and starts the server.

## What's Next

Once Paperclip is running:

1. Create your first company in the web UI
2. Define a company goal
3. Create an ordinary agent and configure its adapter, grants, and skills
4. Build out the org chart with more agents
5. Set budgets and create an initial task with an explicit agent owner
6. Follow its task execution, comments, costs, and disposition from the board

<Card title="Core Concepts" href="/start/core-concepts">
  Learn the key concepts behind Paperclip
</Card>
