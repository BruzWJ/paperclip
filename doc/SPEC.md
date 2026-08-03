# Paperclip Control-Plane Specification

Status: current fresh-redesign architecture

Paperclip is a board-operated control plane for issue-backed provider work. It
owns durable authority, execution admission, audit, costs, workspaces, and the
issue-session projection. Providers remain operator-chosen runtimes.

## Core invariants

1. No model-visible state or provider session crosses issues implicitly.
2. With every context dial false, a fresh execution receives exactly the
   immutable issue request or typed follow-up text.
3. Names, titles, creation order, and organization presentation grant no
   authority.
4. Provider executions receive no general Paperclip REST credential, caller
   profile, eager context payload, managed instructions, or operational
   Paperclip skill.
5. The canonical conversation is one issue-scoped Paperclip Session log.
   Provider-native state stays opaque and may be correlated only within one
   exact issue ownership epoch.
6. Every provider invocation starts from a persisted, still-valid
   issue-execution reference and a compiled run interface.
7. Paperclip uses only externally provisioned PostgreSQL and evolves its schema
   through ordinary ordered Drizzle migrations.
8. Human identity has one lifecycle in every environment: Better Auth signup,
   sign-in, profile update, and sign-out.

## Humans, companies, and agents

Better Auth is the sole account/session owner. A human board actor always has a
persisted Better Auth user id and acts through a browser session or a board API
key derived from that user. Instance roles, company memberships, preferences,
secrets, issue attribution, and board API keys are authorization/domain records;
none creates or substitutes for a user.

Every product entity is company-scoped. An agent stores:

- name and optional display-only title
- verbatim capabilities
- lifecycle status and budgets
- adapter binding and immutable adapter-configuration revisions
- independently stored context, action, mention, company-tool, and company-skill
  selections

There is no persisted role or privileged default identity. Every new grant is
false or absent until a human explicitly configures it. Provider-native
authentication/configuration is opaque and target-scoped; Paperclip never
infers, seeds, reads, copies, reconciles, or deletes a provider home or
credential store.

## Issues and authority

An ordinary issue has:

- immutable `request`
- optional board-editable display `title`
- immutable creator authority
- one checked owner
- monotonically increasing ownership epoch
- lifecycle `open | blocked | done | cancelled`
- required terminal disposition
- optional parent issue/Session link
- project, goal, priority, dependency, document, attachment, and work-product
  metadata

Creation requires exact request bytes, an explicit eligible owner, and an
idempotency key. Reassignment is a creator/board operation, advances the
ownership epoch, revokes the former engagement, and starts the new owner fresh.
A board reopen is a separate audited command: it preserves request, owner,
epoch, Session, and workspace binding while re-applying the native-continuity
fence, clearing the terminal disposition, and re-evaluating creator
receivability. The preserved
invokable-agent branch commits exactly one ref; the named-user or
collective-board-owned system-escalation branch is provider-free and commits no
ref or run. Other owner shapes are rejected without mutation.

The board may edit title metadata, reassign, reopen, and request a fresh
execution through distinct audited operations. No generic issue
status/description/assignee patch, checkout/release protocol, comment-driven
reopen, or freeform text routing exists.

## Context dial

Every agent has nine false-by-default context keys:

| Tier | Issue content | Comments | Structured runs |
| --- | --- | --- | --- |
| current issue | `carry_context` | `read_issue_comments` | `read_issue_agent_run` |
| sub-issues | `list_sub_issues` | `read_sub_issue_comments` | `read_sub_issue_agent_run` |
| company | `list_company_issues` | `read_company_issue_comments` | `read_company_issue_agent_run` |

The same keys govern retrieval and fresh-execution composition. A per-issue
attention mask may only narrow true grants to false. False surfaces are absent
and undiscoverable.

`carry_context` controls same-issue provider continuity; it never controls what
Paperclip records. A false-carry execution is always fresh and receives only
composition authorized by the two current-issue read cells.

## Issue-session log and compaction

Paperclip owns the Session schema, event store, projector, history, runner,
lowering, revert, tool-state, and production compaction behavior as first-class
application architecture. Source-conformance provenance is a development-time
verification record, never a runtime dependency or connector boundary.

An issue maps to `Session`; a sub-issue maps to a child Session. Typed user,
synthetic, system, assistant, reasoning, tool, and compaction messages are
stored as validated, secret-redacted PostgreSQL events and projected into
materialized messages. The chronological comment thread is the human-facing
projection, not a second conversation store.

Provider-native continuity is represented only by a codec-validated
`issue-execution-native/v1` envelope keyed to:

`(company, issue, ownership epoch, agent, adapter configuration identity)`

It is retained only for effective-true-carry owner work. Reassignment, adapter
revision change, board/user fresh execution, false-carry work, and consult work
cannot reuse it. The opaque handle is never shown in API, UI, CLI, logs, prompt
text, workspace metadata, or generic adapter context.

Compaction is issue-session infrastructure and a separately kinded run. It uses
the canonical overflow threshold, prune-first behavior, protected recent tool
output, summary chaining, verbatim tail selection, overflow recovery, and
auto-continue behavior. It writes the canonical compaction request/assistant
message pair and no human comment.

## Compiled provider interface

The six possible issue actions are:

- `issue_create`
- `issue_assign`
- `issue_update`
- `mention_agent`
- `agent_hire`
- `agent_configure`

The runtime compiler derives the exact interface from the leased issue
reference, live owner/creator authority, context/action/mention grants, and
selected company tools. Dynamic catalogs contain only eligible direct children,
valid mention targets, and permitted configuration targets. A missing grant
means false.

The provider receives a `paperclip.run-tools/v1` endpoint/bearer bound to the
run, issue, epoch, agent, adapter revision, reference, and lease. It is accepted
only by the compiled endpoint and becomes invalid on lease loss or authority
change. General issue, comment, activity, agent-profile, company, skill, and
tool-selector REST routes reject provider credentials.

## Communication, admission, and recovery

Delegation creates a direct child issue with an explicit owner and immutable
creator edge. Owner-form `issue_update` writes ordered progress or terminal
disposition to the chronological thread and routes it to the immutable creator.
Creator-form updates are message-only and cannot mutate lifecycle or metadata.

An ordinary human comment is durable and non-dispatching by default. A typed
mention may invoke only the exact current agent owner and ownership epoch. Prose
is never parsed as a mention, assignment, approval, or lifecycle operation.
Same-issue assistance through `mention_agent` executes as an isolated nested
provider view in the same issue Session.

Provider-producing sources—creation, reassignment, the invokable-agent branch
of audited reopen, typed mention/update, routine/plugin creation, and typed
system nudge—atomically persist their source, Session input, and
`IssueExecutionRef` before dispatch. The provider-free reopen branch is valid
only for a named-user or collective-board-owned system escalation and persists
no ref or run. The internal dispatcher leases only a still-valid persisted
reference. Process loss or transient retry re-leases that reference; it never
fabricates a wake, prompt, Session, or idempotency identity.

There is no generic manual invoke, timer ping, arbitrary wake queue,
provider-facing wake endpoint, or direct plugin agent session. Scheduled work is
a routine that creates an ordinary execution issue with explicit request and
owner.

Recovery first records a typed system notice on the affected issue. Escalation
is a distinct root-level issue only after the canonical creator edge is
structurally or exhaustively unreceivable. Titles, creation order, and budget
reranking never select escalation authority.

## Workspaces and provider boundary

Every run resolves a persisted `(company, issue, ownership epoch)` workspace
binding before launch, including projectless work. The common execution-target
bridge realizes the resolved workspace for local, SSH, sandbox, or plugin
drivers and culminates in the one worker-supervised ACP subprocess. A
declarative adapter definition receives no process callback or alternate remote
transport.

Paperclip does not inject caller identity, issue/workspace metadata, a general
REST credential, provider instructions, or another issue's cwd/home into a
provider child. The only Paperclip capability is the compiled run interface.
Explicitly selected genuine company skills may be materialized as workspace
content but grant no authority.

## Board Chat, plugins, and routines

Board Chat creates an ordinary board/user-authored issue for the explicitly
selected eligible agent. The first message is the immutable request; follow-ups
use creator-form updates. No concierge identity, standing chat issue, prompt
relay, or hidden transcript exists.

Plugins may create callback-bound ordinary issues and receive canonical
lifecycle/comment callbacks. They cannot invoke agents, open provider sessions,
wake work directly, patch arbitrary issue lifecycle, or impersonate another
creator. Managed agents remain ordinary identities and cannot be reclaimed
after board adoption or termination.

Routine slots create ordinary issues with configured owners and minimal
immutable requests. Summary projections derive from canonical comment/run
output; no built-in summarizer agent or draft token stream exists.

## Company lifecycle

Company archive and reactivation are ordinary product operations over the
current schema. Archiving fences new execution and hides the company from normal
active views while retaining its coherent issue, Session, run, comment,
workspace, tool, and audit graph. Reactivation restores availability but starts
no prior execution. Cancellation-gated hard deletion removes the complete
company graph atomically.

These product operations never initialize a database or transform data from
another Paperclip database.

## PostgreSQL lifecycle

Paperclip accepts one explicit external PostgreSQL connection. It never bundles
or starts a database process.

Drizzle owns one ordinary ordered migration history in
`packages/db/migrations`. `pnpm db:generate` appends a migration from the
current TypeScript schema and `pnpm db:migrate` applies pending migrations.
Committed migrations are immutable history; each subsequent schema change adds
the next migration.

Database identity is the connected PostgreSQL cluster system identifier plus
database OID/name, not URL text. Sensitive cross-target operations re-probe that
identity before mutation.

## Disaster recovery

A backup is one complete custom-format PostgreSQL payload plus an external
manifest containing:

- source physical database identity
- exact table set
- payload size and checksum
- salted one-way fingerprint of the durable Better Auth secret

A restore accepts only that complete, checksummed pair. It requires
the matching durable Better Auth secret and a physically distinct empty target.
Every check completes before the first target mutation. Ordinary forward
migrations may advance the restored database to the current build.

Raw SQL input, selective tables/columns, source-database reuse, a nonempty
target, an edited payload, or a different authentication secret is rejected.
Disaster recovery is not schema migration.

## Validation

Repository validation must prove:

- ordinary generated forward migrations and external-PostgreSQL-only operation
- only the Session projector mutates the human comment projection
- provider invocations contain no forbidden identity/context/environment/session
  bridge
- general REST and selector-session interfaces deny or omit provider access
- ownership, epoch, revision, reference, lease, and idempotency races fail closed
- reassignment/reset/false-carry/consult work cannot inherit another provider
  conversation
- complete manifested disaster recovery rejects every invalid source or target
  before mutation
- focused PostgreSQL suites, typecheck, tests, and build pass
