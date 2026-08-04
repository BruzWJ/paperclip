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

Issue execution may also use project execution workspace policies and workspace runtime services for per-project worktrees, preview servers, and managed dev commands. Configure those through the project workspace/runtime surfaces rather than starting long-running unmanaged processes when an issue needs a reusable service.

## Storybook

The board UI Storybook keeps stories and Storybook config under `ui/storybook/` so component review files stay out of the app source routes.

```sh
pnpm storybook
pnpm build-storybook
```

These run the `@paperclipai/ui` Storybook on port `6006` and build the static output to `ui/storybook-static/`.

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

The board UI ships its own sans-serif webfont assets in `ui/public/fonts/`.
`ui/src/index.css` declares Inter v4.1 variable regular and italic faces and wires
the Tailwind `font-sans` token to those bundled files before system fallbacks.
Linux screenshot or Storybook capture jobs should not install host Inter packages
or inject external font CSS to make Paperclip text render correctly.

Font assets live in Vite's public directory so `pnpm --filter @paperclipai/ui build`
emits them under `ui/dist/fonts/`. The server package copies the same output into
`server/ui-dist/fonts/` through `scripts/prepare-server-ui-dist.sh`.

Inspect or stop the current repo's managed dev runner:

```sh
pnpm dev:list
pnpm dev:stop
```

`pnpm dev:once` tracks backend-relevant file changes. When the current boot is stale, the board UI shows a `Restart required` banner. You can also enable guarded auto-restart in `Instance Settings > Experimental`, which waits for queued/running local agent runs to finish before restarting the dev server. Database migrations remain an explicit `pnpm db:migrate` operation.

## Hot-Restart Deploys

Primary-instance rebuilds that restart `paperclip.service` can request one-shot live-run adoption instead of using the normal graceful shutdown drain. Before restarting the service, write the marker from the newly staged app with the current service PID:

```sh
old_main_pid="$(systemctl show paperclip.service -p MainPID --value)"
pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts --server-pid "$old_main_pid"
systemctl restart paperclip.service
```

Use `--drain-required` only when the deploy intentionally requires termination
of active work before restart. Without that flag, the old server verifies that
the marker targets its own PID, snapshots current issue-execution run IDs and
their durable run facts, and skips the shutdown drain so eligible detached
prompts can settle without replay. Paperclip does not own ACPX child-process
PIDs. On startup the new server writes
`$PAPERCLIP_HOME/hot-restart-report.json` with `previousServerPid`,
`newServerPid`, `previousServerVersion`, `newServerVersion`, `adoptedRunIds`,
`finalizedWhileDownRunIds`, `lostRunIds`, and per-run classifications before
the normal orphan reaper runs.

A healthy guarded deploy must compare the report against `/api/health` (`version` or `serverVersion`) and treat any `lostRunIds` entry as a continuity failure that needs recovery before marking deployment complete.

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

For normal issue work, start with the smallest targeted check that proves the change. Reserve repo-wide typecheck/build/test runs for PR-ready delivery or changes broad enough that narrow checks do not cover the risk.

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
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Or use Compose:

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for the target-scoped provider-native configuration
boundary used by containerized adapters.

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
    backups/                                     # automatic DB backups
  logs/
  secrets/master.key                             # local_encrypted master key
  projects/                                      # managed project and issue-execution workspaces
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

## Issue Artifact Uploads

When a provider run generates a file that a board user or reviewer should
inspect, record the workspace-relative work product from the compiled interface
when that action is granted, or attach it through a board/operator client. Do
not rely on an unbound local path as the only access path.

Board CLI example:

```sh
pnpm paperclipai issue attachment:upload <issue-id> dist/demo.mp4
pnpm paperclipai issue work-product:create <issue-id> \
  --payload-json '{"type":"artifact","title":"Demo video render"}'
```

If a file intentionally remains workspace-only, create a work product with
`metadata.resourceRef.kind: "workspace_file"` and include the workspace-relative
path in the issue's normal owner update. Paperclip does not inject an
operational upload skill or general REST credential into provider runtimes.

## Issue Execution Workspaces

Every productive ACP request resolves an execution workspace bound to the issue
and its current ownership epoch before launch. A workspace may be projectless,
but there is no agent-home, adapter-configured, server-process-cwd, or prior-
issue fallback.

Provider-native authentication and configuration remain operator-owned and
opaque. Paperclip does not create, inspect, seed, copy, reconcile, quota-probe,
or delete a provider home. The selected CLI must already be authenticated on
the local host. Paperclip applies only the immutable adapter revision's
non-secret choices through ACPX's generic configuration setter; it neither
passes an arbitrary provider payload to an adapter nor launches an auth probe.

Every ACPX-discovered agent is represented by a data-only
`acpx-runtime/v1` definition. Paperclip asks ACPX to probe the locally
available compatible CLIs and uses the exact registry name ACPX returns;
Paperclip does not maintain a built-in agent or model catalog. A CLI that fails
the disposable local ACPX probe is not selectable. ACPX owns the underlying
launch and runtime state; Paperclip creates no raw command, process/HTTP
callback, provider SDK, parser, or registry fallback.

## Config Freshness

Agent, project, environment, secret, skill, and workspace config edits are sampled
at the next issue-execution boundary. An execution that is already running
finishes with the immutable configuration revision it started with.

When effective run config changes, Paperclip may invalidate the exact
issue/epoch/agent/revision native-correlation scope, refresh persisted workspace
runtime config, replace a reused execution workspace, or avoid reusing a
sandbox/environment lease. Fresh execution can lose provider-native continuity,
workspace state, or sandbox state; correctness of the next run's configuration
takes priority over continuity. Plain environment values affect freshness
through value hashes; run result JSON and workspace operation logs expose only
the non-sensitive freshness decision categories, without storing secret values,
full env maps, provider credentials, or private path details.

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
user, company, issue, session, or other product row is copied.

The worktree bootstrap always loads its pinned `DATABASE_URL` and
`BETTER_AUTH_SECRET` before database or authentication initialization. Missing,
changed, unavailable, same-target, or wrong-permission metadata fails closed.
Discard the failed target and provision a new empty database;
Paperclip does not modify existing worktree metadata or database state.

After creation, normal commands such as `pnpm dev`, `paperclipai doctor`, and
`paperclipai db:backup` remain scoped to that worktree. The first human signs up
through the ordinary Better Auth flow and explicitly claims instance-admin
authorization.

### Worktree CLI Reference

**`pnpm paperclipai worktree init --database-url <url> [options]`** — Create a
new repo-local Paperclip instance for the current linked worktree.

| Option | Description |
|---|---|
| `--database-url <url>` | Required newly provisioned empty external PostgreSQL target |
| `--name <name>` | Display name used to derive the instance id |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--server-port <port>` | Preferred server port |

**`pnpm paperclipai worktree:make <name> --database-url <url> [options]`** —
Create `~/NAME` as a git worktree, then initialize a new Paperclip instance.

| Option | Description |
|---|---|
| `--database-url <url>` | Required newly provisioned empty external PostgreSQL target |
| `--start-point <ref>` | Remote ref to base the new branch on (e.g. `origin/main`) |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--server-port <port>` | Preferred server port |

For project execution worktrees, Paperclip can also run a project-defined provision command after it creates or reuses an isolated git worktree. Configure this on the project's execution workspace policy (`workspaceStrategy.provisionCommand`). The command runs inside the derived worktree as a launcher-side provisioning step. The ACPX public runtime receives the resolved directory as its session `cwd`; Paperclip does not serialize caller, issue, or workspace metadata into its environment.

## App-Shipped Skills Catalog

The Paperclip app ships a curated catalog of company skills out of the box. The
catalog is a workspace package at `packages/skills-catalog`:

```text
packages/skills-catalog/
  catalog/
    bundled/<category>/<slug>/SKILL.md   # recommended defaults
    optional/<category>/<slug>/SKILL.md  # role/domain-specific
  generated/catalog.json                  # checked-in manifest
  scripts/
    build-catalog-manifest.ts             # regenerate generated/catalog.json
    validate-catalog.ts                   # validation only
  src/                                    # builder + types consumed by server/CLI
```

Server and CLI import the generated manifest; they do not crawl repository
paths at request time. Root `skills/` remains reserved for Paperclip runtime
skills and is not part of the catalog.

Validate the catalog without writing the manifest:

```sh
pnpm --filter @paperclipai/skills-catalog validate
```

Regenerate `generated/catalog.json` after editing any catalog `SKILL.md`,
frontmatter, file inventory, category, or slug:

```sh
pnpm --filter @paperclipai/skills-catalog build:manifest
```

The package's `build` script runs `build:manifest` and then `tsc`; tests live
under `pnpm --filter @paperclipai/skills-catalog test`. Validation fails when:

- a catalog entry is not under `catalog/bundled/<category>/<slug>` or
  `catalog/optional/<category>/<slug>`
- `SKILL.md` is missing or the frontmatter `name`/`description` is empty
- the frontmatter `key` disagrees with the generated canonical key
- two catalog entries share an `id`, `key`, or `slug`
- file inventory contains absolute paths, `..`, broken symlinks, or files
  outside the skill directory
- the regenerated manifest differs from the checked-in
  `generated/catalog.json`

Trust level is derived from inventory: `markdown_only` (markdown + references
only), `assets` (other non-script files), or `scripts_executables` (any
executable script). The build contract is documented in
`doc/plans/2026-05-26-skills-cli-catalog-contract.md`.

CI runs `pnpm --filter @paperclipai/skills-catalog validate` and the package's
vitest suite, so always regenerate the manifest in the same commit as the
catalog change.

## App-Shipped Teams Catalog

The team catalog package mirrors the skills catalog workflow for
agentcompanies/v1 team packages:

```text
packages/teams-catalog/
  catalog/
    bundled/<category>/<slug>/TEAM.md
    optional/<category>/<slug>/TEAM.md
  generated/catalog.json
  scripts/
    build-catalog-manifest.ts
    validate-catalog.ts
```

Validate without writing the manifest:

```sh
pnpm --filter @paperclipai/teams-catalog validate
```

Regenerate `generated/catalog.json` after editing catalog team files:

```sh
pnpm --filter @paperclipai/teams-catalog build:manifest
```

Team install/preview APIs enforce source policy. External skill sources require
explicit approval flags, and local-path skill sources are development-only
unless `allowLocalPathSources` is set by the caller.

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

## Automatic DB Backups

Paperclip can run complete manifested database backups on a timer. Each backup
is a custom-format PostgreSQL payload plus a required external JSON manifest.
Together they cover the canonical schema, migration journal, tables, sequences,
constraints, rows, physical source identity, checksum, table set, and a salted
one-way `BETTER_AUTH_SECRET` fingerprint. The server
host must provide compatible `pg_dump` and `pg_restore` client tools. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.paperclip/instances/default/data/backups`

Configure these in:

```sh
pnpm paperclipai configure --section database
```

Run a one-off backup manually:

```sh
pnpm paperclipai db:backup
# or:
pnpm db:backup
```

To restore later canonical state, provision a physically distinct empty
database and use the one supported operator command:

```sh
pnpm paperclipai db:restore \
  --database-url 'postgresql://operator@new-db.example/paperclip' \
  --backup-file /secure/backups/paperclip-20260729T120000Z.dump \
  --manifest-file /secure/backups/paperclip-20260729T120000Z.dump.manifest.json \
  --better-auth-secret-file /secure/backups/better-auth-secret
```

The secret file must contain the same durable deployment secret and should be
mode `0600`. Restore has no config/env target fallback, raw-SQL input, selective
transform, target clearing, worktree caller, or former-lineage compatibility
path. It validates every input before mutation, restores once transactionally,
and then applies only remaining forward migrations.

Environment overrides:

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`
- `PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS=<hours>` controls the `/api/health`
  stale-backup warning threshold
- `PAPERCLIP_DB_BACKUP_ALERT_FILE=/path/to/failure-marker` lets external cron
  wrappers surface the last failed backup in `/api/health`

Without `PAPERCLIP_DB_BACKUP_ALERT_FILE`, health checks look for
`db-backup-to-s3.failure` in the backup directory, beside the backup directory,
and in the default sibling `health/` directory.

DB backups are not full instance filesystem backups. For full local disaster
recovery, also back up local storage files and the local encrypted secrets key if
those providers are enabled.

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
vault lifecycle today. See `docs/deploy/secrets.md` (`Provider Vaults` section)
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
pnpm paperclipai issue list --company-id <company-id>
pnpm paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

See full command reference in `doc/CLI.md`.

## External Agent Invite Onboarding

External-agent invites expose machine-readable and plain-text onboarding instructions:

The board UI creates the invite from the agent-management surface.

- `GET /api/invites/:token` returns the invite summary.
- `GET /api/invites/:token/onboarding` returns the external registration contract.
- `GET /api/invites/:token/onboarding.txt` returns the same contract as plain text.

The external runtime submits an agent join request and waits for board approval. Approval creates/configures the ordinary agent; it does not mint or return a Paperclip agent key, claim secret, generic REST bridge, or operational skill.

The submitted adapter type must exactly match a currently discovered local ACPX
agent. Adapter configuration contains only the non-secret stable ACPX options
that ACPX advertises, plus the separately selected execution target and skill
channel. Paperclip rejects command/endpoint/provider-payload fields, generic
bridge credentials, provider secrets, and native-session selectors. When a
canonical issue-execution ref is dispatched, the worker supplies a fresh
request-scoped compiled tool interface through that prompt's ACPX `mcpServers`
input. Paperclip never retains a prior request's tool authority.
