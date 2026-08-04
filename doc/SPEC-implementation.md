# Paperclip Implementation Architecture

Status: current fresh-redesign implementation map

This document maps the canonical control-plane design in
[SPEC.md](./SPEC.md) to repository modules. It contains only current
architecture.

## Package boundaries

### Paperclip Issue Session

Paperclip owns Session contracts/codecs under
`packages/shared/src/issue-session`, physical tables under `packages/db`, and
event, admission, projection, history, runner, lowering, and revert services
under `server`. They form one first-class Paperclip Session engine.

### `packages/db`

The schema owns:

- Better Auth user/account/session/verification tables for Better Auth's
  adapter, plus Paperclip authorization records that reference real users
- issue request/owner/creator/lifecycle/epoch fields
- issue Sessions, durable events, materialized messages, inputs, and
  dispositions
- execution-history views and ordered membership
- issue-execution references, leases, authorities, native correlations, and
  reset generations
- creator edges and ordered deliveries
- execution-workspace bindings
- context/action/mention grants
- selected company tools and genuine company skills

Company, issue, run, Session, authority, reference, workspace, and grant
relations remain company-scoped with database uniqueness and foreign-key
enforcement.

### `packages/shared`

The shared package exports the closed canonical vocabulary:

- nine context keys
- seven issue-action keys
- two mention-reach keys
- canonical owner/creator/lifecycle/disposition types
- `IssueExecutionRef`
- `RemoteWorkspaceLaunch`
- `paperclip.run-tools/v1`
- strict board-ingress and compiled-tool schemas

It does not export generic issue mutation, checkout/release, general provider
credentials, role-based authority, conversational agent sessions, arbitrary
wake operations, managed instruction injection, or interaction-card contracts.

### Adapters and `packages/adapter-utils`

Adapters receive a split request:

- server-only control data for budgets, target, workspace, cancellation, and
  accounting
- provider invocation data containing lowered messages, resolved local `cwd`
  or closed remote launch, opaque operator-native configuration, optional
  validated native correlation, and compiled run-tools transport

Provider invocation scrubbers reject caller identity, general Paperclip
credentials, workspace metadata, Paperclip-managed prompt/instruction state,
and noncanonical continuity fields.

## Server runtime

### Session and admission

- `issue-session/event-store.ts` persists durable Session events.
- `issue-session/projector.ts` is the sole steady-state
  materialized-message/comment writer.
- `issue-session/admission.ts` admits typed user, synthetic, and system sources
  plus issue-execution references atomically.
- Session input/history/composition services promote inputs and compose scoped
  execution views directly from PostgreSQL.
- `agent-execution/session-runner/*` owns provider steps, continuations,
  lowering, and productive Session output.
- `issue-session-lifecycle.ts` coordinates company archive, reactivation, and
  cancellation-gated purge across the coherent Session graph.

Every input has one stable source identity and delivery. Idempotent replay
requires byte-equivalent source, Session, prompt, and event arguments.

### Issue execution

- `ordinary-issue-runtime.ts` owns board/user/plugin/routine/system issue
  creation, reassignment, comments, typed mentions, and the checked
  `agent_execution | board_only` reopen transaction.
- `issue-execution-dispatcher.ts` leases only persisted active references.
- `issue-execution-postgres.ts` assembles the PostgreSQL
  lease/resolution/finalization repositories.
- `issue-execution-dispatcher-postgres.ts` locks and validates dispatchable
  refs before it creates a run attempt and lease.
- `issue-execution-prompt-cycle-postgres.ts` resolves the exact current
  attempt, immutable ACP revision, workspace, tools, and native-session
  operation under that lease.
- `issue-execution-attempt-executor.ts` drives the Session runner and adapter.
  A missing correlated ACP target is invalidated and retried once as a fresh
  session using the exact current source; Paperclip never injects Session
  history into that replacement prompt.
- `agent-execution/session-runner/output.ts` publishes productive Session
  output.
- `productive-run-linkage.ts` verifies exact run/reference/source evidence.
- `outcome-translator-postgres.ts` commits lifecycle, counterpart delivery,
  and the comment of record.

The dispatcher is the only steady-state provider-invocation producer. Recovery
re-leases an existing valid reference instead of creating replacement work.
Terminal finalization writes run liveness with the terminal state; reads do not
mutate historical runs.

### Compiled interface

- `runtime-interface-compiler.ts` defines exact descriptor schemas and dynamic
  catalogs.
- `runtime-interface-compiler-db.ts` resolves current grants and targets from
  PostgreSQL.
- `run-interface-session.ts` mints/revokes lease-bound compiled-interface
  bearers.
- `run-interface-session-db.ts` persists those bearer sessions.
- `run-tools.ts` is the sole provider-facing Paperclip route.
- `runtime-tool-executor.ts` dispatches validated compiled calls.
- `runtime-issue-action-port.ts` implements issue actions.
- `runtime-agent-configuration.ts` implements granted agent
  hire/configuration operations.

General REST authentication never accepts a compiled bearer. The compiler never
exposes false-grant surfaces.

### Workspaces

Execution workspace services and the issue-execution resolver use
`issue_execution_workspace_bindings` as the ownership/selection source for one
issue epoch. Projectless workspaces are valid. The ACPX public-runtime bridge
supplies the resolved workspace to the same bounded single-prompt ACPX path. ACPX launches
the local compatible CLI itself; adapter definitions do not execute or
transport provider work. The current public ACPX runtime is local-only, so
remote driver selection is not admitted.

### Creator routing and recovery

Creator edges bind immutable creator authority to each ownership epoch. Owner
updates produce ordered creator deliveries. Creator updates are message-only
and target the current owner. Endpoint loss, epoch replacement, fresh-execution
reset, cancellation, and termination revoke the relevant
reference/edge/delivery generation atomically.

Recovery services record typed existing-issue notices first. The canonical
resolver creates at most one root system escalation per affected issue/epoch
only when creator delivery is structurally or exhaustively unreceivable.

## Board/operator routes

Board/user REST routes provide:

- canonical issue and child creation
- title metadata update
- creator/board reassignment
- audited board reopen with one invokable-agent ref branch and one
  provider-free system-escalation board branch
- typed human comment/owner mention
- issue-execution fresh-session control
- agent lifecycle/configuration/grant/selection administration
- run inspection/cancellation
- company, project, goal, routine, plugin, tool, approval, workspace, and audit
  control

Every issue route rejects a provider actor. There is no generic
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

## UI and CLI

The UI and CLI are board/operator clients. They:

- use Better Auth signup/sign-in/profile/sign-out for every human
- create issues with immutable request, explicit eligible owner, and
  idempotency key
- show owner/creator/lifecycle terminology
- expose distinct title/reassign/reopen/comment/fresh-session controls
- configure the context matrix and independent action/mention/tool/skill
  selections
- inspect structured transcripts without provider-native handles
- configure bind/exposure without selecting a different identity path

They do not emulate provider behavior or retain alternate commands for generic
issue mutation, provider credentials, arbitrary wake/invoke, managed
instructions/skills, or agent-wide conversations.

## Plugins, routines, and company lifecycle

Plugin issue APIs use immutable installation/callback creator authority.
Plugins may list/get/create/update their own message/lifecycle projection and
withdraw only their own nonterminal issue through the dedicated audited
operation. They cannot invoke agents, request arbitrary work, own provider
sessions, or patch unrelated issue state.

Routine executions create ordinary issues with immutable request and configured
owner. Derived summary cards/projectors link to the canonical source
comment/run. No built-in summarizer identity or provider draft stream exists.

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

`backup-lib.ts` creates one complete custom-format PostgreSQL payload and one
external manifest. The manifest carries format/version, source physical
identity, exact table set, payload checksum/size, and a salted one-way
fingerprint of the durable Better Auth secret.

Restore accepts explicit payload, manifest, target URL, and secret-file inputs.
Before mutation it verifies:

- supported manifest shape
- checksum, payload size, and table set
- matching Better Auth secret fingerprint
- a physically distinct empty target
- unchanged source and target physical identities

Only a complete, checksummed restore may populate that target. Ordinary
forward migrations may advance it. Raw SQL, selective table/column transforms,
a nonempty target, source reuse, or an edited payload fails before the first
target mutation.

## Static gates

`pnpm check:production-boundaries` runs the complete internal boundary manifest,
including:

- the external-PostgreSQL boundary
- the zero-database test boundary
- canonical issue, Session, runtime, provider, and authentication boundaries

Other focused gates prove:

- the Session projector is the only materialized-comment writer
- the Session donor/provenance and Paperclip-owned structure remain exact
- provider child inputs contain no caller identity, general REST bridge,
  cross-issue memory, or noncanonical continuity state
- only canonical issue/session/runtime writers remain
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
