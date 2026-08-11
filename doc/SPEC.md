# Paperclip Control-Plane Specification

Status: current fresh-redesign architecture

Paperclip is a board-operated control plane for task-backed provider work. It
owns durable authority, execution admission, audit, costs, and the task-session
projection. Providers remain operator-chosen runtimes.

## Core invariants

1. No model-visible state or provider session crosses tasks implicitly.
2. With every context dial false, a fresh execution receives exactly the
   immutable task request or typed follow-up text.
3. Names, titles, creation order, and organization presentation grant no
   authority.
4. Provider executions receive no general Paperclip REST credential, caller
   profile, eager context payload, managed instructions, or operational
   Paperclip skill.
5. The canonical conversation is one task-scoped Paperclip Session log.
   Provider-native state stays opaque and may be correlated only within one
   exact task ownership epoch.
6. Every provider invocation starts from a persisted, still-valid
   task-execution reference and a compiled run interface.
7. Paperclip uses only externally provisioned PostgreSQL and evolves its schema
   through ordinary ordered Drizzle migrations.
8. Human identity has one lifecycle in every environment: Better Auth signup,
   sign-in, profile update, and sign-out.

## Humans, companies, and agents

Better Auth is the sole account/session owner. A human board actor always has a
persisted Better Auth user id and acts through a browser session or a board API
key derived from that user. Instance roles, company memberships, preferences,
secrets, task attribution, and board API keys are authorization/domain records;
none creates or substitutes for a user.

Every product entity is company-scoped. An agent stores:

- name and optional display-only title
- verbatim capabilities
- lifecycle status and budgets
- adapter binding and immutable adapter-configuration revisions
- independently stored context, action, mention, and company-skill selections

There is no persisted role or privileged default identity. Every new grant is
false or absent until a human explicitly configures it. Provider-native
authentication/configuration is opaque and target-scoped; Paperclip never
infers, seeds, reads, copies, reconciles, or deletes a provider home or
credential store.

## Tasks and authority

An ordinary task has:

- immutable `request`
- optional board-editable display `title`
- immutable creator authority
- one checked owner
- monotonically increasing ownership epoch
- lifecycle `open | blocked | done | cancelled`
- required terminal disposition
- optional parent task/Session link
- project, goal, priority, dependency, document, attachment, and work-product
  metadata

Creation requires exact request bytes, an explicit eligible owner, and an
idempotency key. Reassignment is a creator/board operation, advances the
ownership epoch, revokes the former engagement, and starts the new owner fresh.
A board reopen is a separate audited command: it preserves request, owner,
epoch, and Session while re-applying the native-continuity fence, clearing the
terminal disposition, and re-evaluating creator
receivability. The preserved
invokable-agent branch commits exactly one ref; the named-user or
collective-board-owned system-escalation branch is provider-free and commits no
ref or run. Other owner shapes are rejected without mutation.

The board may edit title metadata, reassign, reopen, and request a fresh
execution through distinct audited operations. No generic task
status/description/assignee patch, checkout/release protocol, comment-driven
reopen, or freeform text routing exists.

## Context dial

Every agent has nine false-by-default context keys:

| Tier | Task content | Comments | Structured runs |
| --- | --- | --- | --- |
| current task | `carry_context` | `read_task_comments` | `read_task_agent_run` |
| sub-tasks | `list_sub_tasks` | `read_sub_task_comments` | `read_sub_task_agent_run` |
| company | `list_company_tasks` | `read_company_task_comments` | `read_company_task_agent_run` |

The same keys govern retrieval and fresh-execution composition. During an active
owner execution, Paperclip automatically grants all current-task and sub-task
cells. The three company cells remain exactly the agent's configured grants.
Consults, non-owners, and restricted execution modes receive no owner baseline;
false surfaces are absent and undiscoverable.

`carry_context` controls same-task provider continuity; it never controls what
Paperclip records. A false-carry execution is always fresh and receives only
composition authorized by the two current-task read cells.

## Task-session log

Paperclip owns the Session schema, event store, projector, history, runner,
lowering, revert, and tool-state behavior as first-class
application architecture. Source-conformance provenance is a development-time
verification record, never a runtime dependency or connector boundary.

A task maps to `Session`; a sub-task maps to a child Session. Typed user,
synthetic, system, assistant, reasoning, and tool messages are
stored as validated, secret-redacted PostgreSQL events and projected into
materialized messages. The chronological comment thread is the human-facing
projection, not a second conversation store.

Provider-native continuity is represented only by a fixed, encrypted
`task-execution-native/v1` correlation envelope keyed to:

`(company, task, ownership epoch, agent, adapter configuration identity)`

It is retained only for effective-true-carry work. A mention always creates a
fresh Paperclip run, but the receiving agent may resume its own compatible ACP
backend session when `carry_context` and this exact scope match; it never
receives the caller's handle. Reassignment, adapter revision change, board/user
fresh execution, and false-carry work cannot reuse it. The opaque handle is
never shown in API, UI, CLI, logs, prompt text, run-directory metadata, or generic
adapter context.

The Session log remains complete for audit and inspection. Paperclip does not
summarize, prune, or replay it as provider context when a native session is
missing. The selected provider CLI may manage its own native history while its
session remains resumable.

## Compiled provider interface

The seven possible task actions are:

- `task_create`
- `task_assign`
- `task_update`
- `mention_agent`
- `mention_board`
- `agent_hire`
- `agent_configure`

The runtime compiler derives the exact interface from the leased task
reference, live owner/creator authority, and context/action/mention grants.
The four configurable action grants govern
`task_create`, `mention_board`, `agent_hire`, and
`agent_configure`; `task_create` also enables reassignment of eligible direct
children created by that exact execution. `task_update` is relationship-derived
instead: the current owner omits `taskId` to update its active task, and the
exact creator execution supplies an eligible direct-child `taskId`. Both paths
record one canonical comment and automatically mention the owner/creator
counterpart in that counterpart's task context. `mention_agent` is dynamically
compiled from reachable mention targets (direct children and granted ancestor/
descendant reach) and does not require a persisted grant. A creator
path may send a message or set nonterminal `open`/`blocked`; terminal
`done`/`cancelled` and `structuredResult` are current-owner-only. Dynamic
catalogs contain only eligible direct children, valid mention targets, and permitted
configuration targets. There is no implicit response route; explicit upward
mentions require the ancestor grant. A missing configurable grant means false.

The provider receives a `paperclip.run-tools/v1` endpoint/bearer bound to the
run, task, epoch, agent, adapter revision, reference, and lease. It is accepted
only by the compiled endpoint and becomes invalid on lease loss or authority
change. General task, comment, activity, agent-profile, company, skill, and
tool-selector REST routes reject provider credentials.

## Communication, admission, and recovery

Delegation creates a direct child task with an explicit owner and immutable
creator edge. Canonical `task_update` writes ordered progress or terminal
disposition as the counterpart-facing chronological comment. A child-owner
update targets the direct parent, a root-owner update targets the root task's
Board creator, and a creator-targeted child update targets the child. Both paths
may carry a message and nonterminal `open`/`blocked` status but cannot mutate
request, title, owner, dependencies, or metadata. Terminal `done`/`cancelled`
and `structuredResult` are current-owner-only. The counterpart mention is
automatic, so providers do not add a separate comment for the same update. A
nonterminal creator-targeted update admits the current owner’s follow-up
execution.

An ordinary human comment is durable and non-dispatching by default. A typed
mention may invoke only the exact current agent owner and ownership epoch. Prose
is never parsed as a mention, assignment, approval, or lifecycle operation.
`mention_agent` atomically records one canonical same-task comment and admits
the recipient's execution reference. It is asynchronous and non-terminal, and
dispatch begins after the action transaction commits. The recipient's final
provider response is not automatically relayed; any further communication must
use `mention_agent`, `mention_board`, or `task_update`.

An agent with the explicit `mention_board` action grant may publish a canonical
comment to collective Board Attention. It atomically commits its non-terminal
acknowledgement with that request. It does not change task lifecycle or create
an approval, review, or execution reference. A later typed Board comment mention to that exact owner
and ownership epoch supplies the response in a fresh run and removes the request
from Board Attention. A terminal task hides the request, and a later reopen
does not revive it.

Provider-producing sources—creation, reassignment, the invokable-agent branch
of audited reopen, typed mention/update, routine/plugin creation, and typed
system nudge—atomically persist their source, Session input, and
`TaskExecutionRef` before dispatch. The provider-free reopen branch is valid
only for a named-user or collective-board-owned system escalation and persists
no ref or run. The internal dispatcher leases only a still-valid persisted
reference. Worker loss or transient retry re-leases that reference; it never
fabricates a wake, prompt, Session, or idempotency identity.

There is no generic manual invoke, timer ping, arbitrary wake queue,
provider-facing wake endpoint, or direct plugin agent session. Scheduled work is
a routine that creates an ordinary execution task with explicit request and
owner.

Recovery first records a typed system notice on the affected task. Escalation
is a distinct root-level task only after the canonical creator edge is
structurally or exhaustively unreceivable. Titles, creation order, and budget
reranking never select escalation authority.

## Provider boundary

Every run receives a resolved local working directory before launch. The ACPX
public-runtime bridge uses that directory for the compatible CLI that ACPX
launches. The current ACPX public runtime has no Paperclip-managed SSH, sandbox,
or plugin transport; a declarative adapter definition receives no process
callback or alternate remote transport.

Paperclip does not inject an ambient caller profile, working-directory metadata,
a general REST credential, provider instructions, or another task's cwd/home
into a provider child. A canonical source created by an agent-reaching managed
tool may identify that tool's locked source agent, target task, and lifecycle
state in its own persisted message envelope. The only Paperclip capability is
still the compiled run interface. Explicitly selected genuine company skills may
be materialized for a run but grant no authority.

## Plugins and routines

Plugins may create callback-bound ordinary tasks and receive canonical
lifecycle/comment callbacks. They cannot invoke agents, open provider sessions,
wake work directly, patch arbitrary task lifecycle, or impersonate another
creator. Managed agents remain ordinary identities and cannot be reclaimed
after board adoption or termination.

Routine slots create ordinary tasks with configured owners and minimal
immutable requests. Their canonical comment and run history remains the source
of record; no built-in summarizer agent or draft token stream exists.

## Company lifecycle

Company archive and reactivation are ordinary product operations over the
current schema. Archiving fences new execution and hides the company from normal
active views while retaining its coherent task, Session, run, comment,
prompt-capability, and audit graph. Reactivation restores availability but starts
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

Paperclip does not ship application-managed database backup/restore. Operators
recover from their external PostgreSQL provider backups (or other host-level
backups) and must separately preserve secrets key material and local storage
files when those providers are enabled.

## Validation

Repository validation must prove:

- ordinary generated forward migrations and external-PostgreSQL-only operation
- only the Session projector mutates the human comment projection
- provider invocations contain no forbidden identity/context/environment/session
  bridge
- general REST and selector-session interfaces deny or omit provider access
- ownership, epoch, revision, reference, lease, and idempotency races fail closed
- reassignment/reset/false-carry work and mentions outside an exact
  effective-true-carry scope cannot inherit another provider conversation
- focused PostgreSQL suites, typecheck, tests, and build pass
