# Tasks and Sub-Tasks

This document summarizes Paperclip's canonical work-object contract. Backend,
runtime, API, persistence, session-correlation, and product UI surfaces use
`task` and `sub-task` as the sole work-object terminology.

## Canonical Task

A task contains:

| Field | Contract |
| --- | --- |
| `id`, `companyId` | Stable company-scoped UUID identity |
| `taskNumber` | Positive per-company counter used by the canonical board address `/<company-id>/tasks/<task-number>` |
| `identifier` | Optional human-readable display metadata; never a route or API identity |
| `request` | Immutable, non-empty execution request |
| `title` | Optional presentation text; board-editable through a dedicated command |
| `status` | `open \| blocked \| done \| cancelled` |
| `disposition` | Required terminal message and optional structured result for `done`/`cancelled`; absent otherwise |
| `owner` | Exactly one canonical owner union: agent, named user, or board |
| `creator` | Immutable typed creator: agent execution, user/board, plugin, routine, or system |
| `ownershipEpoch` | Monotonic epoch advanced by each reassignment |
| `parentId` | Optional parent task; the only work hierarchy relation |
| `projectId`, `goalId` | Optional board organization links |
| `priority`, `labels`, `billingCode` | Board presentation/accounting metadata |
| `presentationStage` | Optional board-only presentation state |
| timestamps | Audit chronology |

Legacy mutable `description`, dual assignee columns, dual creator columns,
checkout ownership, and free-form lifecycle patches are not part of this
contract.

## Invariants

- Every ordinary task has one invokable agent owner when it is created or
  reassigned.
- A system escalation may be Board-owned until explicitly reassigned to an
  invokable agent.
- Request and creator never change.
- Reassignment locks the task, advances `ownershipEpoch`, revokes stale
  authority/native correlation, and records the new owner execution.
- A new owner or epoch cannot inherit a previous owner's provider session.
- Terminal tasks reject further agent relationship updates.
- Parent and child tasks never imply blocker or escalation relationships.
- A provider invocation cannot exist without a persisted `TaskExecutionRef`.

## Creation Sources

Every source uses the same ordinary task runtime and invokable-owner resolver:

- board/user task creation;
- an authorized parent execution's `task_create` action;
- plugin-created tasks with immutable installation/callback creator identity;
- routine dispatch;
- the single-level system-escalation constructor.

Creation records the canonical task, creator edge, task Session input, owner
authority, and dispatch ref before scheduling work.

## Mutations

### Board commands

The board has distinct audited operations for:

- editing title/presentation metadata;
- reassigning ownership;
- updating status with required `status`, `message`, and resolved recipient;
- posting comments, optionally mentioning the exact current agent owner.

Terminal-to-`open` uses the same status-update transaction, ref, and response.
These commands are not a generic task patch endpoint.

### Relationship-derived `task_update`

The current agent owner omits `taskId` to update its active task. An exact
agent creator execution supplies an eligible direct-child `taskId` to update
that child. Both paths submit one required message and may:

- move `open ↔ blocked`;

Only the current agent owner may additionally:

- move `open | blocked → done`;
- move `open | blocked → cancelled`;
- supply a terminal structured result.

The commit writes the typed source, canonical Session event, derived comment,
terminal disposition, and counterpart comment/ref admission atomically. Owner updates
reach the immutable creator; creator-targeted child updates reach the current
owner. No generic run-summary or separate agent comment is added.

### Creator update

An immutable creator may update a current nonterminal task it created. Agent
creators are authorized by the exact active parent execution and its persisted
direct-child creator edge, not by matching agent identity. A creator-targeted
child update may send a message or set nonterminal `open`/`blocked`. It writes
the same canonical comment and automatically mentions the current owner in the
child task; it is not a separate agent communication path. A nonterminal update
admits the current owner’s follow-up execution. Terminal `done`/`cancelled` and
structured results remain current-owner-only.

### Comments and mentions

Board comments persist in every lifecycle and dispatch only through a typed
mention. Exact terminal owner mentions and terminal-target notifications are
response-only per turn; free-form text never selects owners or changes state.

## Task Execution

Each task has one canonical Paperclip Session log. Every execution ref
owns an immutable authorized lowering view containing only its admitted source,
its optional dial-authorized composition snapshot, and output from its own
lineage.

Provider-native continuity is a separate protected envelope scoped to:

```
(company, task, ownership epoch, agent, adapter configuration revision)
```

It is read and written only when effective `carry_context` is true. Paperclip
never uses an agent-wide conversational-session key. Full and response-only
turns use the same native-session selection; access is not a correlation key.

## Run directory

The server resolves the local run directory for each task and ownership epoch.
It is internal execution plumbing, not a board-selectable resource.

## Dependencies and Recovery

Ordinary blocker dependencies remain independent board data. Recovery first
records a typed system notice on the affected task. Only a terminal,
unreceivable creator edge can create the one canonical root-level system
escalation; that escalation is neither a blocker nor a parent of the affected
task and cannot recursively escalate.

## Agent Visibility

Providers receive a compiled run interface, not generic task REST access. The
seven possible runtime Paperclip actions are:

```
task_create
task_assign
task_update
mention_agent
mention_board
agent_hire
agent_configure
```

Each descriptor contains only targets authorized for the exact active execution
and is rechecked under lock at commit time. Four configurable action grants
control `task_create`, `mention_board`, `agent_hire`, and
`agent_configure`. The combined `task_create` grant also controls eligible
direct-child `task_assign`; `task_update` is derived automatically from the
current owner or exact creator relationship and canonically mentions the
counterpart. `mention_agent` compiles dynamically from reachable targets and
does not require a persisted grant.

Response-only prompts expose reads only, deny non-interactive writes, and carry
a compact turn-scoped notice.

For the full contract, see [SPEC.md](./SPEC.md) and
[execution-semantics.md](./execution-semantics.md).
