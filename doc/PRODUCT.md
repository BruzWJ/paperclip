# Paperclip — Product Definition

## What It Is

Paperclip is the control plane for autonomous AI companies. One Paperclip
instance can run multiple companies; every record, execution, policy decision,
and cost is company-scoped.

## Core Concepts

### Company

A company has:

- a goal and a hierarchy of projects and tasks that explain why work exists;
- configured agent identities connected by reporting lines;
- board users, budgets, and approvals;
- an auditable task-session log and human-facing comment thread.

### Agents Are Configured Identities

An agent is a reusable identity, not a stored mind. Its model-facing identity is
limited to:

- a display name and optional display title;
- its `reportsTo` relationship;
- a free-text capabilities description used in the owner catalog.

An agent may additionally have an optional board-owned `instruction`. On that
agent's first execution in an exact `(task, ownership epoch, agent)` lane,
Paperclip queues it as its own bootstrap execution immediately before the
unchanged work message. This also covers an agent first contacted on an
existing task. The work execution resumes that exact provider session. Later
executions in the same lane never replay the instruction or substitute a new
provider session when exact carry is unavailable. The instruction grants no
authority and is not a provider system prompt or work-message prefix.

Other control-plane configuration—adapter binding, provider-native target
declaration, context/action/mention dials, lifecycle state, budget, and
telemetry—is never injected into provider context.

Provider-native configuration and storage are operator-owned and opaque.
Paperclip does not inspect, seed, copy, merge, or delete provider homes,
authentication, or hidden state.

### Tasks Are the Only Invocation Boundary

Every provider invocation is a task execution backed by a durable source:
assignment, status update, typed comment or mention, routine, plugin, or system
dispatch. There is no arbitrary invoke, taskless wake, agent-wide session, or
plugin-owned agent session.

An ordinary task has:

- an immutable, non-empty request and optional board-editable title;
- exactly one canonical owner and an immutable typed creator;
- a monotonic ownership epoch that advances on every reassignment;
- the lifecycle `open | blocked | done | cancelled`, with a required terminal
  disposition;
- parent/sub-task links, comments, documents, attachments, and work products.

Board comments persist in every lifecycle. Status changes require one explicit
status, message, and resolved owner or creator recipient; terminal-to-`open`
uses the same transaction, ref, and response. Exact terminal owner mentions are
response-only per turn.
Provider actors receive only the seven
dynamically compiled Paperclip actions allowed by their exact active execution;
generic REST task mutation is not an agent tool.

### Task Sessions and Continuity

Paperclip persists one canonical, PostgreSQL-backed task Session. Its typed
source inputs, assistant turns, tool state, cost/tokens, and derived
comments are Paperclip-owned, auditable, and secret-redacted before
persistence.

The canonical log is not ambient provider history. Each task-execution ref has
an immutable authorized lowering view. Context from another task appears only
through an explicitly enabled, permission-checked composition dial.
Paperclip never automatically replays, summarizes, or injects this log into a
replacement work prompt. If ACPX reports a missing frozen target, Paperclip
invalidates that correlation and fails the run closed.

Provider-native continuity is separately correlated to the exact
`(task, ownership epoch, agent, adapter revision)` scope. With effective
`carry_context` disabled, Paperclip neither reads nor writes a native
correlation. A new task or ownership epoch cannot inherit another task's
Paperclip-authored context.

Access is compiled per turn and never affects native-session selection.

### Provider Targets

Before launch, every task execution receives a resolved local working
directory. There is no agent-home, adapter-configured working-directory,
process-directory, or prior-session fallback.

The ACPX public-runtime bridge carries the immutable run interface to one
locally installed compatible CLI discovered from ACPX's public registry.
ACPX's resolved `agents` configuration contributes launch overrides; it is not
an installed-agent allowlist. Paperclip prevents package-exec discovery from
materializing an absent CLI, then requires the candidate to pass an ACPX
session probe. ACPX owns provider launch and session lifecycle; Paperclip never
exports a generic API credential or identity bridge into the provider process.
The current public ACPX runtime is local-only, so remote target drivers are not
advertised for ACPX agents.

### Actions and Tool Injection

- Paperclip actions are the exhaustive seven-action catalog dynamically compiled
  from the current execution's authority.
- Plugin tools are a separate, administrator-installed runtime source. Every
  declared tool remains inside the canonical prompt-capability and audit
  boundary.
- Response-only prompts expose reads only and carry a compact turn-scoped notice.

ACPX is the sole provider communication and execution contract. Paperclip does
not maintain a parallel provider-instruction channel. Request-scoped MCP is the
only tool-injection boundary; no virtual search/run wrapper, ambient MCP
surface, or generic REST instruction bundle is injected into a run.

## Product Principles

1. **Company is the unit of organization.** Everything is company-scoped.
2. **Agent identity is configuration.** Paperclip core does not synthesize an
   agent-wide provider context between tasks.
3. **All execution is task-backed.** Durable authority and source records
   precede every provider invocation.
4. **All work explains why it exists.** Parent/sub-task and project/goal links
   keep work inspectable and aligned.
5. **Control plane, not provider internals.** Paperclip coordinates, authorizes,
   records, and bills; providers own their native configuration and hidden
   state.
6. **Board-level clarity first.** Human-readable status, comments, outputs,
   cost, and approvals lead; raw run details remain available for audit.
7. **Thin core, rich edges.** Optional product surfaces belong in plugins, but
   plugins cannot bypass the canonical task-execution boundary.

## First-Run Flow

1. Create a company and state its goal.
2. Configure one ordinary agent identity and an explicit provider target.
3. Optionally add reporting relationships, budgets, and further agents.
4. Create a board task with an immutable request and an invokable agent owner.
5. Observe its typed task execution, comments, work products, cost, and
   terminal disposition.
6. Add routines when recurring work is needed; each routine creates an ordinary
   execution task.

There is no built-in CEO, automatic privileged agent, default instruction
bundle, or automatic provider invocation during onboarding.

## Deployment

Every human uses Better Auth signup/sign-in, whether Paperclip listens only on
loopback, on a private network, or through a public endpoint. Bind controls
reachability and exposure controls transport hardening; neither changes the
account or session model.

Canonical deployment behavior lives in
[DEPLOYMENT.md](./DEPLOYMENT.md). The detailed runtime and data
contracts live in [SPEC.md](./SPEC.md),
[execution-semantics.md](./execution-semantics.md), and
[spec/agents-runtime.md](./spec/agents-runtime.md).
