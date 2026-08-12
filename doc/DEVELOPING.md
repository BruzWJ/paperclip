# Developing

This project requires an externally provisioned PostgreSQL database in local
development.

## Reachability and authentication

Every developer signs up and signs in through Better Auth. Loopback, private
network, and public exposure use the same account/session lifecycle. See
`doc/DEPLOYMENT.md`.

## Prerequisites

- Node.js >=22.13.0
- pnpm 9+

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- Pull request CI validates dependency resolution when manifests change.
- Pushes to `master` regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only --no-frozen-lockfile`, commit it back if needed, and then run verification with `--frozen-lockfile`.

## Monorepo Workspace Orchestration

Paperclip is a pnpm workspace orchestrated by Turborepo. The root
`turbo.json` defines dependency-aware, cached workspace builds and typechecks:

```sh
pnpm build
pnpm typecheck
```

The application workspaces live under `apps/`: the product backend and frontend
are `apps/server/` and `apps/ui/`, while `apps/docs/` is the
published documentation site. Reusable and publishable workspaces live under
`packages/`, including `packages/cli/`, `packages/db/`, `packages/shared/`,
`packages/adapter-utils/`, and the plugin packages. Turbo discovers these
workspace roots through `pnpm-workspace.yaml`.

The orchestration smoke fixture below `packages/plugins/examples/` remains a
standalone package, as recorded by the exclusion in `pnpm-workspace.yaml`; it
keeps an independent install and test workflow.

The root `doc/` directory is not a duplicate documentation app. It holds
repository-internal product contracts, engineering notes, operational runbooks,
and dated implementation plans. Public documentation and Mintlify navigation
belong in `apps/docs/`; internal repository documentation remains in `doc/`.

`pnpm dev` remains Paperclip's managed same-origin development supervisor, and
`pnpm test` remains the stable repository-wide Vitest runner so its isolation,
serialization, and CI sharding contracts stay intact.

## Board UI Runtime

The board is a client-rendered React + Vite application. Its native TanStack
Router file routes live under `apps/ui/src/routes/`; the Router Vite plugin
generates `apps/ui/src/routeTree.gen.ts`, which is checked in and must not be
edited by hand. Keep the Router plugin before the React plugin in both the
normal and browser-test Vite configurations so route generation and automatic
route code splitting use the same contract.

Each route-owned screen is the route branch's actual `index.tsx` module. That
file exports `Route = createFileRoute(...)` and the component it renders; do not
insert another page or component directory between the route and its screen.
Route-specific tests may sit beside the route module and are excluded by the
Router plugin's test-file ignore pattern. Prefix non-route helper files with
`-`, and keep reusable UI in `apps/ui/src/components/`. There is no parallel
`src/pages/` tree and this Vite application does not use Next.js App Router
conventions.

The tenant route root uses the canonical lowercase company UUID. Agent,
project, routine, and approval parameters use canonical UUIDs directly. Task
detail has one board URL, `/<company-uuid>/tasks/<task-number>`, where the task
number is the exact positive per-company counter. Do not add name,
URL-key, task-identifier, task-UUID board URLs, aliases, or resolver routes.
Markdown task references have one format: `task://<task-uuid>`.

TanStack Query owns the browser's REST snapshots. The Express API remains the
source of record for reads and mutations. The same Node HTTP server also hosts
the authenticated, company-scoped Socket.IO endpoint at
`/api/live/socket.io`. Its typed `live:event:v1` messages are cache-invalidation
hints; consumers refresh the affected REST-backed queries instead of treating
the message payload as canonical data. There is no parallel domain polling,
cross-tab leader election, or BroadcastChannel cache transport. The UI has no
server-rendering runtime.

## Start Dev

From repo root:

```sh
pnpm install
pnpm dev
```

This starts:

- API server: `http://localhost:3100`
- UI: served by the API server in dev middleware mode (same origin as API)

`pnpm dev` runs the server in watch mode and restarts on changes from workspace packages. Use `pnpm dev:once` to run without file watching.

`pnpm dev:once` auto-applies pending local migrations by default before starting the dev server.

`pnpm dev` and `pnpm dev:once` are now idempotent for the current repo and instance: if the matching Paperclip dev runner is already alive, Paperclip reports the existing process instead of starting a duplicate.

## Storybook

The board UI Storybook keeps stories and Storybook config under `apps/ui/storybook/` so component review files stay out of the app source routes.

```sh
pnpm storybook
pnpm build-storybook
```

These run the `@paperclipai/ui` Storybook on port `6006` and build the static output to `apps/ui/storybook-static/`.

The Storybook visual regression suite uses external PNG baselines instead of
committed screenshots:

```sh
pnpm test:storybook-visual
pnpm test:storybook-visual:update
```

`pnpm test:storybook-visual` downloads and verifies the baseline archive from
`tests/storybook-visual/baseline-manifest.json` before running Playwright.
Accepted visual changes should update the manifest metadata and publish a new
immutable archive with `pnpm storybook-visual:baseline pack` and
`pnpm storybook-visual:baseline upload`; do not commit generated PNG snapshots.

Known limitation: Storybook visual baselines are Linux/Ubuntu-only. The manifest
pins the capture environment to `ubuntu-24.04` and the Playwright suite uses
pixel-exact comparison, so local runs on macOS, Windows, or other non-matching
platforms can report false-positive diffs from font rasterization and subpixel
rendering. Use the `Storybook Visual` GitHub Actions workflow on `ubuntu-latest`
as the source of truth, or run locally in a matching Linux environment before
accepting or updating baselines.

PR visual checks are opt-in while the suite stabilizes. Add the
`storybook-visual` label to a PR, or run the `Storybook Visual` GitHub Actions
workflow manually, to produce downloadable Playwright report/test-result
artifacts. Normal PR visual runs use read-only repository permissions and do not
upload or mutate baseline objects.

## UI Fonts And Screenshots

The board UI ships its own sans-serif webfont assets in `apps/ui/public/fonts/`.
`apps/ui/src/index.css` declares Inter v4.1 variable regular and italic faces and wires
the Tailwind `font-sans` token to those bundled files before system fallbacks.
Linux screenshot or Storybook capture jobs should not install host Inter packages
or inject external font CSS to make Paperclip text render correctly.

Font assets live in Vite's public directory so `pnpm --filter @paperclipai/ui build`
emits them under `apps/ui/dist/fonts/`. The server package copies the same output into
`apps/server/ui-dist/fonts/` through `scripts/prepare-server-ui-dist.sh`.

Inspect or stop the current repo's managed dev runner:

```sh
pnpm dev:list
pnpm dev:stop
```

`pnpm dev:once` tracks backend-relevant file changes. When the current boot is
stale, the board UI shows a `Restart required` banner. Automatic idle restart
is off by default; enable `autoRestartDevServerWhenIdle` in **Instance settings
→ General** to let the managed runner request a restart after backend changes
and after queued or running task executions finish. Database migrations remain
an explicit `pnpm db:migrate` operation.

Private-network development:

```sh
pnpm dev --bind lan
```

This uses private exposure with a private-network bind preset. On a fresh
instance, open the app, sign in or create an
account, and use the setup screen to claim the first instance admin from the
browser. The CLI fallback remains:

```sh
pnpm paperclipai auth bootstrap-admin
```

For Tailscale-only reachability on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## Test Commands

Use the cheap local default unless you are specifically working on browser flows:

```sh
pnpm test
```

`pnpm test` runs the Vitest suite only. For interactive Vitest watch mode use:

```sh
pnpm test:watch
```

Browser suites stay separate:

```sh
pnpm test:e2e
```

The browser suite starts only the Vite UI and uses test-owned API fixtures; it
does not start Paperclip or connect to a database. Published-release verification
is artifact-only in `.github/workflows/release-smoke.yml` and does not launch a
deployed service. These checks are intended for targeted local verification and
CI, not the default agent/human test command.

For normal task work, start with the smallest targeted check that proves the change. Reserve repo-wide typecheck/build/test runs for PR-ready delivery or changes broad enough that narrow checks do not cover the risk.

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm paperclipai run
```

> **Note: private npm registry `.npmrc` + first-run onboarding**
>
> The first-run experience often starts with `npx paperclipai onboard --yes` (before you have a repo checkout). If your global `~/.npmrc` sets `registry` to a private registry (for example GitHub Packages), `npx` may try to resolve `paperclipai` from that private registry and fail with `E404`.
>
> Diagnostic:
>
> ```sh
> npm config get registry
> ```
>
> Workaround (cross-platform; force the public npm registry for this command):
>
> ```sh
> npx --registry https://registry.npmjs.org paperclipai onboard --yes
> ```

`paperclipai run` does:

1. auto-onboard if config is missing
2. runs `paperclipai doctor` checks
3. starts the server when checks pass

## Docker Quickstart (No local Node install)

Build and run Paperclip in Docker:

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e PAPERCLIP_BIND=lan \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Or use Compose:

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for the target-scoped provider-native configuration
boundary used by ACPX agents in containers.

## Docker For Untrusted PR Review

For a separate review-oriented container that preserves the selected CLI's
operator-owned native login state in a Docker volume and checks out PRs into an
isolated scratch workspace, see `doc/UNTRUSTED-PR-REVIEW.md`.

## Local Instance Layout

Every local install keeps runtime state directly under the selected instance root:

```text
~/.paperclip/instances/default/                  # instance root
  config.json                                    # runtime config
  .env                                           # instance env file
  data/
    storage/                                     # local_disk uploads
  logs/
  secrets/master.key                             # local_encrypted master key
```

`PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` override the home root and instance id respectively. `paperclipai onboard` echoes the resolved values in its banner (`Local home: <home> | instance: <id> | config: <path>`) so you can confirm where state will land before continuing.

## Database in Dev

For local development, start a PostgreSQL service and set `DATABASE_URL`.

```sh
docker compose -f docker/docker-compose.yml up -d db
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
pnpm db:migrate
```

Override home or instance:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

The server fails before startup when no valid external target is configured.

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.paperclip/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm paperclipai configure --section storage
```

## Task Artifact Uploads

When a provider run generates a file that a board user or reviewer should
inspect, attach it through a board/operator client. Do not rely on an unbound
local path as the only access path.

Board CLI example:

```sh
pnpm paperclipai task attachment:upload <task-id> dist/demo.mp4
pnpm paperclipai task work-product:create <task-id> \
  --payload-json '{"type":"artifact","title":"Demo video render"}'
```

Paperclip does not inject an upload instruction package or general REST
credential into provider runtimes.

## Agent Runtime

Provider-native authentication and configuration remain operator-owned and
opaque. Paperclip does not create, inspect, seed, copy, reconcile, quota-probe,
or delete a provider home. The selected CLI must already be authenticated on
the local host. Paperclip applies only the immutable adapter revision's
non-secret choices through ACPX's generic configuration setter; it neither
passes an arbitrary provider payload to an adapter nor launches an auth probe.

Every ACPX-discovered agent is represented by a data-only
`acpx-runtime/v1` definition. Paperclip enumerates ACPX's public registry with
its resolved `agents` overrides; that map is launch configuration, not an
installed-agent allowlist. Paperclip maintains no built-in agent or model
catalog. Before it asks ACPX to open a disposable session, a generic
non-launching fence requires ACPX's direct executable—or, for a package-exec
entry, the exact registry-name executable—to exist locally. This prevents
discovery from downloading an absent CLI without adding provider-specific
names or launch mappings. A registry name or config entry alone is not
selectable. ACPX owns the underlying launch and runtime state; Paperclip
creates no provider process/HTTP callback, SDK, parser, or registry fallback.

The pre-save **Test Agent** action reuses the exact same dynamic resolution and
opens a disposable, no-prompt ACPX session with the draft's generic session
selections. It persists no agent, revision, run, provider prompt, or ACPX state
and deliberately makes no claim that a future execution can start.

## Worktree-local Instances

Every Paperclip worktree uses a newly provisioned, externally hosted PostgreSQL
database. The database must be empty and physically distinct from the parent
checkout's database. Supply it explicitly; Paperclip never copies the parent
database or account state.

Initialize an existing linked git worktree:

```sh
paperclipai worktree init \
  --database-url postgres://paperclip:secret@db.example.test:5432/paperclip_feature
```

Or create and initialize a linked worktree in one command:

```sh
pnpm paperclipai worktree:make paperclip-pr-432 \
  --database-url postgres://paperclip:secret@db.example.test:5432/paperclip_pr_432
```

Creation verifies the connected parent and target PostgreSQL identities, rejects
the same physical database, generates a distinct Better Auth secret, and writes
immutable creation metadata plus a mode-`0600` `.paperclip/.env`. Apply the
ordinary pending migrations to the target before starting the worktree. No
user, company, task, session, or other product row is copied.

The worktree bootstrap always loads its pinned `DATABASE_URL` and
`BETTER_AUTH_SECRET` before database or authentication initialization. Missing,
changed, unavailable, same-target, or wrong-permission metadata fails closed.
Discard the failed target and provision a new empty database;
Paperclip does not modify existing worktree metadata or database state.

After creation, normal commands such as `pnpm dev` and `paperclipai doctor`
remain scoped to that worktree. The first human signs up through the ordinary
Better Auth flow and explicitly claims instance-admin authorization.

### Worktree CLI Reference

**`pnpm paperclipai worktree init --database-url <url> [options]`** — Create a
new repo-local Paperclip instance for the current linked worktree.

| Option                 | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `--database-url <url>` | Required newly provisioned empty external PostgreSQL target          |
| `--name <name>`        | Display name used to derive the instance id                          |
| `--instance <id>`      | Explicit isolated instance id                                        |
| `--home <path>`        | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--server-port <port>` | Preferred server port                                                |

**`pnpm paperclipai worktree:make <name> --database-url <url> [options]`** —
Create `~/NAME` as a git worktree, then initialize a new Paperclip instance.

| Option                 | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `--database-url <url>` | Required newly provisioned empty external PostgreSQL target          |
| `--start-point <ref>`  | Remote ref to base the new branch on (e.g. `origin/main`)            |
| `--instance <id>`      | Explicit isolated instance id                                        |
| `--home <path>`        | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--server-port <port>` | Preferred server port                                                |

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/companies` returns a JSON array

## Fresh Local Dev Database

When development needs a clean database, provision a new empty external
PostgreSQL database, point Paperclip at that target, and run `pnpm db:migrate`.
Further schema work uses `pnpm db:generate` to append ordinary forward
migrations.

## Database backups

Paperclip does not manage database backups. Use your external PostgreSQL
provider's backup tooling (snapshots, PITR, managed backups) and separately
preserve local secrets key material and storage files when those providers are
enabled.

## Secrets in Dev

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

- Default local key path: `~/.paperclip/instances/default/secrets/master.key`
- Override key material directly: `PAPERCLIP_SECRETS_MASTER_KEY`
- Override key file path: `PAPERCLIP_SECRETS_MASTER_KEY_FILE`
- Back up the key file and database together; either one alone is not enough to restore local encrypted secrets.

Strict mode (recommended outside a single-operator trusted host):

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.
Public deployments default strict mode on unless explicitly overridden.

CLI configuration support:

- `pnpm paperclipai onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm paperclipai configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm paperclipai doctor` validates secrets adapter configuration, can create a missing local key file with `--repair`, and reports missing AWS Secrets Manager bootstrap env when that provider is selected.
- Provider health is available at `GET /api/companies/:companyId/secret-providers/health` and reports local key permission warnings plus backup guidance.

Per-company provider vaults are configured in the board UI under
`Company Settings → Secrets → Provider vaults`, backed by
`/api/companies/{companyId}/secret-provider-configs`. The CLI does not own
vault lifecycle today. See `apps/docs/deploy/secrets.md` (`Provider Vaults` section)
for the operator model.

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

Configure this explicitly for the environment. Network reachability does not
select a different human identity or authorization path.

## CLI Client Operations

Paperclip CLI now includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
pnpm paperclipai task list --company-id <company-id>
pnpm paperclipai task create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai task comment <task-id> --message "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm paperclipai task list
pnpm paperclipai dashboard get
```

See full command reference in `doc/CLI.md`.
