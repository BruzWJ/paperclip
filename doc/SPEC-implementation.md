# Paperclip Implementation Architecture

Status: current fresh-redesign implementation map

This document maps the canonical control-plane design in
[SPEC.md](./SPEC.md) to repository modules. It contains only current
architecture.

## Package boundaries

### Paperclip Task Session

Paperclip owns Session contracts/codecs under
`packages/shared/src/task-session`, physical tables under `packages/db`, and
event, admission, projection, history, runner, lowering, and revert services
under `server`. They form one first-class Paperclip Session engine.

### `packages/db`

The schema owns:

- Better Auth user/account/session/verification tables for Better Auth's
  adapter, plus Paperclip authorization records that reference real users
- task request/owner/creator/lifecycle/epoch fields
- task Sessions, durable events, materialized messages, inputs, and
  dispositions
- execution-history views and ordered membership
- task-execution references, leases, authorities, native correlations, and
  reset generations
- creator edges and ordered deliveries
- context/action/mention grants
- installed plugin manifests and exact plugin tool-call bindings

Company, task, run, Session, authority, reference, and grant relations remain
company-scoped with database uniqueness and foreign-key enforcement.

### `packages/shared`

The shared package exports the closed canonical vocabulary:

- nine context keys
- five configurable action-grant keys and seven runtime task-action keys
- two mention-reach keys
- canonical owner/creator/lifecycle/disposition types
- `TaskExecutionRef`
- `paperclip.run-tools/v1`
- strict board-ingress and compiled-tool schemas

It does not export generic task mutation, checkout/release, general provider
credentials, role-based authority, conversational agent sessions, arbitrary
wake operations, generic managed-instruction injection, or interaction-card
contracts. `agents.instruction` is the narrow exception: a bootstrap execution
queued before a new task's unchanged work execution.

### Adapters and `packages/adapter-utils`

Adapters receive a split request:

- server-only control data for budgets, target, cancellation, and accounting
- provider invocation data containing lowered messages, resolved local `cwd`,
  exact ACPX session configuration selections, optional
  validated native correlation, and compiled run-tools transport

Provider invocation scrubbers reject caller identity, general Paperclip
credentials, run-directory metadata, generic Paperclip prompt/instruction state,
and noncanonical continuity fields.

## Server runtime

### Session and admission

- `task-session/event-store.ts` persists durable Session events.
- `task-session/projector.ts` is the sole steady-state
  materialized-message/comment writer.
- `task-session/admission.ts` admits typed user, synthetic, and system sources
  plus task-execution references atomically.
- Session input/history/composition services promote inputs and compose scoped
  execution views directly from PostgreSQL.
- `agent-execution/session-runner/*` owns provider steps, continuations,
  lowering, and productive Session output.
- `task-session-lifecycle.ts` coordinates company archive, reactivation, and
  cancellation-gated purge across the coherent Session graph.

Every input has one stable source identity and admission. Idempotent replay
requires byte-equivalent source, Session, prompt, and event arguments.

### Task execution

- `ordinary-task-runtime.ts` owns board/user/plugin/routine/system task
  creation, reassignment, comments, typed mentions, and the checked
  `agent_execution | board_only` reopen transaction.
- `task-execution-dispatcher.ts` leases only persisted active references.
- `task-execution-postgres.ts` assembles the PostgreSQL
  lease/resolution/finalization repositories.
- `task-execution-dispatcher-postgres.ts` locks and validates dispatchable
  refs before it creates a run attempt and lease.
- `task-execution-prompt-cycle-postgres.ts` resolves the exact current
  attempt, immutable ACP revision, run directory, capabilities, and native-session
  operation under that lease.
- `task-execution-attempt-executor.ts` drives the Session runner and adapter.
  A missing correlated ACP target invalidates that correlation and fails the
  run closed. Paperclip never automatically injects Session history into a
  replacement work prompt.
- `agent-execution/session-runner/output.ts` publishes productive Session
  output.
- `productive-run-linkage.ts` verifies exact run/reference/source evidence.
- `runtime-task-action-port.ts` commits lifecycle and routes create, assign,
  and update communication through the canonical agent/Board mention helpers.

The dispatcher is the only steady-state provider-invocation producer. Recovery
re-leases an existing valid reference instead of creating replacement work.
Terminal finalization writes run liveness with the terminal state; reads do not
mutate historical runs.

### Compiled interface

- `runtime-interface-compiler.ts` selects exact registry descriptor projections
  from dynamic catalogs and adds host-owned recovery/plugin descriptors.
- `runtime-interface-compiler-db.ts` resolves current grants and targets from
  PostgreSQL.
- `run-interface-session.ts` mints/revokes lease-bound compiled-interface
  bearers.
- `run-interface-session-db.ts` persists those bearer sessions.
- `run-tools.ts` is the sole provider-facing Paperclip route.
- `runtime-tool-gateway.ts` is the ACPX ingress for validated compiled calls.
- `runtime-task-action-port.ts` implements task actions.
- `paperclip-agent-message.ts` defines the closed managed-tool prompt contract
  and the per-tool renderers used at agent-mention admission. Tool producers
  supply immutable arguments plus locked source/task context; the rendered
  bytes become the one Session comment, execution-ref message, and ACPX source.
- `runtime-agent-configuration.ts` implements granted agent
  hire/configuration operations.

General REST authentication never accepts a compiled bearer. The compiler never
exposes false-grant surfaces.

### Canonical managed-tool surface

Paperclip-managed tools are one first-class control-plane surface with two
explicit authorities: the bounded ACPX execution authority and the
authenticated Board MCP user authority:

- `paperclip-managed-tool-registry.ts` is the sole schema/compiler contract.
  It owns the closed vocabulary, metadata, exact Board input schemas, dynamic
  ACPX projections, normalization into one canonical command, and ledger
  metadata.
- `paperclip-managed-tool-router.ts` is the sole authority-aware executor and
  `routeExecution` entrypoint. ACPX supplies a descriptor-normalized command
  and run authority; Board MCP supplies exact public input and a board-user
  authority derived from an existing board API key. Both use the same lower
  domain transactions rather than alternate implementations.

The runtime compiler only selects the registry's provider projections for a
leased execution, then adds host-owned recovery and plugin descriptors. The
ACPX gateway only validates the selected descriptor, maintains the call ledger,
and passes the canonical command to the shared router. Board MCP exposes the
Board projection of that registry through stateless Streamable HTTP. Its
authority is full-control only within the authenticated user's active company
memberships and it never enters a provider execution. The request-scoped ACPX
interface remains the only provider invocation and tool-injection surface.

### Run directories

The task-execution resolver supplies the resolved local directory to the
bounded ACPX path. ACPX launches the local compatible CLI itself; adapter
definitions do not execute or transport provider work. A new instructed task
queues a bootstrap run before its work run; each has its own prompt capability,
and the work run resumes the bootstrap run's exact provider session. The current
public ACPX runtime is local-only, so remote driver selection is not admitted.

### Creator routing and recovery

Creator edges bind immutable creator authority to each ownership epoch. Every
canonical `task_update` atomically admits its counterpart comment/ref in the
recipient Session: owner updates target the immediate parent or current root,
while creator child updates target the child. Creator updates may carry only
nonterminal `open`/`blocked` lifecycle transitions. Endpoint loss, epoch
replacement, fresh-execution reset, cancellation, and termination revoke the
relevant reference/edge generation atomically.

Recovery services record typed existing-task notices first. The canonical
resolver creates at most one root system escalation per affected task/epoch
only when its immutable creator edge becomes terminal.

## Board/operator routes

Board/user REST routes provide:

- canonical task and child creation
- title metadata update
- creator/board reassignment
- audited board reopen with one invokable-agent ref branch and one
  provider-free system-escalation board branch
- typed human comment/owner mention
- agent lifecycle/configuration/grant/selection administration
- run inspection/cancellation
- company, project, goal, routine, plugin, approval, and audit control

Every task route requires a board actor; generic HTTP authentication never
constructs a provider actor. There is no generic
description/status/assignee patch, checkout/release protocol, comment reopen,
arbitrary wake/invoke, general agent credential, agent-self/context route,
agent-wide conversation reset, interaction operation, or selector-session tool
gateway.

Better Auth's mounted handler owns account and browser-session creation in every
bind/exposure. Paperclip access routes resolve the resulting user before
granting instance roles, company memberships, or board keys. A first-admin CLI
invitation contains nullable inviter identity and
`source = bootstrap_admin_cli`; redemption requires a signed-in Better Auth
user.

### Board navigation and live data

The board is a client-rendered Vite application. Native TanStack Router file
routes under `apps/ui/src/routes/` compile into the checked-in
`routeTree.gen.ts`; route parameters, validated search state, guards, lazy page
loading, and navigation all use TanStack Router directly. Express serves the
built SPA through one canonical document handler. There is no server-rendering
runtime. The board tenant root is the canonical company UUID. Agent, project,
routine, and approval route parameters use UUIDs; task detail uses only
`/<company-uuid>/tasks/<task-number>`, with the exact positive per-company task
counter. There is no name, URL-key, task-identifier, task-UUID board URL,
alias, or resolver path. Markdown task references use only
`task://<task-uuid>`.

Each screen implementation is its owning route branch's actual `index.tsx`
module and exports the corresponding `createFileRoute(...)` definition. There
is no intermediate page/component directory and no parallel global pages tree
or Next.js-style `app/` router. Route-specific tests are colocated and ignored
by the Router plugin's test-file pattern. Neutral reusable UI remains in
`apps/ui/src/components/`. Paperclip domain UI stays beside its route consumer,
or at the closest common route ancestor when several route branches share it,
in a file or directory whose basename starts with `-` so the Router plugin
ignores it. There is no parallel `src/features/` ownership layer.

REST remains the canonical board data and mutation boundary. TanStack Query
owns client snapshots and cache reconciliation. Socket.IO attaches to the same
Node HTTP server at `/api/live/socket.io`, authenticates the same-origin Better
Auth browser session, requires instance-admin access or an active membership
for the selected company, and emits typed `live:event:v1` notifications only
to that company's room. The UI treats those notifications as invalidation
hints and refreshes the relevant REST-backed queries; a socket payload is never
an independent source of record. Domain freshness has no polling or cross-tab
cache-broadcast path alongside Socket.IO.

## UI and CLI

The UI and CLI are board/operator clients. They:

- use Better Auth signup/sign-in/profile/sign-out for every human
- use native client-side TanStack Router navigation and validated file-route
  search state in the board UI
- reconcile company-scoped Socket.IO notifications through TanStack Query
  against canonical REST resources
- create tasks with immutable request, explicit eligible owner, and
  idempotency key
- show owner/creator/lifecycle terminology
- expose distinct title/reassign/reopen/comment controls
- configure the context matrix and independent action/mention selections,
  with create-and-assign as one action grant and relationship-derived lifecycle
  updates
- inspect structured transcripts without provider-native handles
- configure bind/exposure without selecting a different identity path

They do not emulate provider behavior or retain alternate commands for generic
task mutation, provider credentials, arbitrary wake/invoke, generic managed
provider instructions, or agent-wide conversations. Board users may edit the
optional canonical agent instruction through operational configuration.

## Plugins, routines, and company lifecycle

Plugin task APIs use immutable installation/callback creator authority.
Plugins may list/get/create/update their own message/lifecycle projection and
withdraw only their own nonterminal task through the dedicated audited
operation. They cannot invoke agents, request arbitrary work, own provider
sessions, or patch unrelated task state.

Administrator-approved infrastructure plugins may declare generic elevated
worker capabilities for direct all-agent tools, exact live run-context
resolution, canonical redacted Session/runtime-record reads, blocking
before-prompt observation, and managed private-network HTTP. Those
capabilities are install-time visible, company-fenced, and revalidated at
invocation time. They do not add a plugin-specific REST route, provider
credential, or provider-session authority. Contributed tools remain inside the
canonical prompt-capability and audit boundary. Before-prompt hooks receive only
Paperclip-owned
identities and an immutable source-message snapshot; they return no provider
content, run in deterministic installation order, and fail closed before
provider transmission. Core sends the canonical source message byte-for-byte.

Routine executions create ordinary tasks with immutable request and configured
owner. Their canonical comment and run history remains the source of record. No
built-in summarizer identity or provider draft stream exists.

Company archive marks the current company graph inactive and fences new
execution. Reactivation makes that same graph available and starts no prior
work. Cancellation-gated hard deletion removes the complete graph. None of
these product operations provisions or transforms a database.

## External PostgreSQL and forward migrations

`packages/db/runtime-config.ts` accepts only an explicit external
PostgreSQL connection. `database-identity.ts` proves physical identity through
the connected cluster system identifier and database OID/name.

`packages/db/drizzle.config.ts` points directly at the TypeScript schema and the
package-root `migrations/` history. The DB package exposes direct Drizzle
generate, migrate, and studio commands. Each schema change creates the next
ordinary forward migration.

Worktree creation requires a newly provisioned external target, proves it is
physically distinct before mutation, and pins the target identity, URL
fingerprint, and newly generated Better Auth secret. Restart verifies those
immutable facts and never rewrites them.

## Complete disaster recovery

Paperclip does not ship application-managed database backup/restore. Operators
recover from their external PostgreSQL provider backups (or other host-level
backups) and must separately preserve secrets key material and local storage
files when those providers are enabled.

## Static gates

`pnpm check:production-boundaries` runs the complete internal boundary manifest,
including:

- the external-PostgreSQL boundary
- the zero-database test boundary
- canonical task, Session, runtime, provider, and authentication boundaries

Other focused gates prove:

- the Session projector is the only materialized-comment writer
- the Session donor/provenance and Paperclip-owned structure remain exact
- provider child control inputs contain no ambient caller identity, general
  REST bridge, cross-task memory, or noncanonical continuity state; managed
  tool source identity exists only inside its canonical persisted message
- only canonical task/session/runtime writers remain
- Better Auth is the sole human account/session writer

## Required validation

Run focused static and unit checks before the broader suites:

```sh
pnpm check:production-boundaries
pnpm typecheck
pnpm test:run
pnpm build
```

The internal boundary entries are deliberately not exposed as dozens of root
package scripts. Test suites use explicit fakes and fixtures and do not require
any database instance; external PostgreSQL is a production/development runtime
requirement only.
