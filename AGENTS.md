<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `apps/server/`: Express REST API, Socket.IO live invalidation, and orchestration services
- `apps/ui/`: client-rendered React + Vite board UI; neutral UI lives in `src/components`, while native TanStack Router routes and their colocated domain UI live in `src/routes`
- `apps/docs/`: published Mintlify documentation site and its assets
- `packages/cli/`: publishable Paperclip CLI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapter-utils/`: ACPX public-runtime discovery and execution bridge
- `packages/plugins/`: plugin SDK, tooling, first-party plugins, and examples
- `doc/`: repository-internal product, engineering, operations, and planning docs

`apps/docs/` and `doc/` are intentionally different. Content intended for the
published documentation site belongs in `apps/docs/`; engineering contracts and
repository plans remain in `doc/`.

## 4. Dev Setup

Provide an external PostgreSQL URL before starting the application.

```sh
docker compose -f docker/docker-compose.yml up -d db
pnpm install
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
pnpm db:migrate
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

For a clean local database, reset the Docker Compose PostgreSQL volume and
reapply migrations.

## 5. Core Engineering Rules

1. Keep changes company-scoped.
   Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
   If you change schema/API behavior, update all impacted layers:

- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `apps/server` routes/services
- `apps/ui` API clients and pages

3. Preserve control-plane invariants.

- Exactly one checked task owner record
- Task-execution refs as the only provider invocation source
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
   Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
   When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip task planning: if a Paperclip task asks for a plan, update the task `plan` document per the `paperclip` skill instead of creating a repo markdown file.

6. Keep provider output inside the execution boundary.
   Write generated files beneath the current execution workspace, verify them, and
   name workspace-relative paths in the final response. Providers do not receive a
   generic Paperclip API credential and must not upload attachments or create work
   products through REST. Board users decide which workspace files become durable
   artifacts. See `doc/AGENT-ARTIFACTS.md`.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/schema/*.ts`
2. Ensure new tables are exported from `packages/db/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm typecheck
```

Notes:

- `packages/db/drizzle.config.ts` reads the root TypeScript `schema.ts` directly.
- Generated SQL and Drizzle metadata live in `packages/db/migrations/`.

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal task work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent executions use request-scoped ACPX prompt capabilities, never generic
  REST credentials

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Make each route-owned screen its TanStack branch's actual `index.tsx` route
  module; do not add an intermediate page directory or recreate `src/pages/`
- Keep neutral reusable UI in `apps/ui/src/components/`. Colocate Paperclip
  domain UI beside its route consumer; when multiple routes share it, use the
  closest common route ancestor. Every non-route module under `src/routes/`
  must live in a Router-ignored `-` file or directory. Do not create a parallel
  `src/features/` or `src/pages/` ownership layer.
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across `packages/db`, `packages/shared`, `apps/server`, and `apps/ui`
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## 12. Adapter ownership

Paperclip has one AI execution path: the ACPX public-runtime bounded bridge.
For a new task owned by an agent with a non-null `instruction`, it admits the
instruction and task request as two ordered executions. The instruction run
creates the provider session; the immediately following work run resumes it.
ACPX is the sole supplier of exact agent names, launch resolution, models, and
stable session settings. Paperclip loads ACPX's public registry, including its
resolved `agents` overrides, and never treats that override map as an
installed-agent allowlist. Before an active ACPX probe, Paperclip applies one
provider-agnostic no-install fence to the ACPX-resolved launch: a direct
executable must already exist locally, while a package-exec launch requires an
exact local executable matching the ACPX registry name. A candidate is
selectable only after that fence and a disposable ACPX session both succeed.
An ACPX built-in name by itself is not evidence of local availability.

Paperclip must not add an agent/model/configuration catalog, aliases,
provider-specific executable mapping or parser, ACPX runtime/session state,
authentication, provider instruction packages, or tools. The generic no-install fence may inspect only the
launch returned by ACPX and must never execute or materialize a package. ACPX
owns resolution and lifecycle of the local provider CLI; Paperclip
owns durable authority fences, request-scoped MCP, safe event projection,
cancellation requests, and cleanup of its own request files. ACPX's temporary
state store is deleted after each bounded execution; only an opaque provider
backend session id may be retained in Paperclip's scoped correlation record
for the queued bootstrap handoff or an eligible ordinary resume.

Board MCP is a separate authenticated board-user ingress, not an agent/provider
communication contract. A human-operated local coding client may use the
existing board API-key lifecycle and the user's active company memberships via
`/api/mcp`. Board MCP must never be injected into a provider execution or used
as an ACPX fallback; provider runs continue to receive only their short-lived,
task-scoped request capability through `/api/run-tools`.

### Local Dev

- Set `PORT=3101` (or another explicit free port) for a fork when an upstream
  instance already owns 3100; startup fails if the configured port is occupied.
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30-60s — don't assume failure immediately
- Kill ALL paperclip processes before starting: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf apps/ui/dist apps/ui/node_modules/.vite`

### External adapter packages

External adapter packages cannot add a Paperclip agent. Install and
authenticate an ACPX-compatible CLI locally; ACPX discovery supplies its name,
models, and settings dynamically. Declare an ACPX `agents` entry only for a
custom name or launch override. A generic advertised option,
including a reasoning setting when the agent exposes one, is persisted as an
immutable ACPX session configuration selection and applied through ACPX before
the prompt. ACPX is the sole provider communication and execution contract.
Paperclip does not maintain a parallel instruction-package channel or provider
home, and request-scoped MCP is its only tool-injection boundary.

Pre-save agent testing uses the same dynamic contract: Paperclip applies the
exact unsaved ACPX selections in a disposable no-prompt ACPX session, persists
nothing, and does not treat that observation as execution-workspace readiness.

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `apps/ui/` changes: every color, spacing, radius, type, shadow, and motion value in `apps/ui/src/components/**` and `apps/ui/src/routes/**` comes from the token layer in `apps/ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in those trees, outside the documented allowlist in `apps/ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.
