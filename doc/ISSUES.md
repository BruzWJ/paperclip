# Issues and Sub-Issues

This document summarizes Paperclip's canonical work-object contract. Backend,
runtime, API, persistence, and session-correlation surfaces use `issue` and
`sub-issue`. Product UI copy may use separate rendered wording where required by the
design system.

## Canonical Issue

An issue contains:

| Field | Contract |
| --- | --- |
| `id`, `companyId`, `identifier` | Stable company-scoped identity |
| `request` | Immutable, non-empty execution request |
| `title` | Optional presentation text; board-editable through a dedicated command |
| `status` | `open \| blocked \| done \| cancelled` |
| `disposition` | Required terminal message and optional structured result for `done`/`cancelled`; absent otherwise |
| `owner` | Exactly one canonical owner union: agent, named user, or board |
| `creator` | Immutable typed creator: agent execution, user/board, plugin, routine, or system |
| `ownershipEpoch` | Monotonic epoch advanced by each reassignment |
| `parentId` | Optional parent issue; the only work hierarchy relation |
| `projectId`, `goalId` | Optional board organization links |
| `priority`, `labels`, `billingCode` | Board presentation/accounting metadata |
| `attentionMask` | Optional sparse, false-only, write-once creation attenuation |
| `presentationStage` | Optional board-only presentation state |
| timestamps | Audit chronology |

Legacy mutable `description`, dual assignee columns, dual creator columns,
checkout ownership, and free-form lifecycle patches are not part of this
contract.

## Invariants

- Every ordinary issue has one invokable agent owner when it is created or
  reassigned.
- The only non-agent owner cases are the explicitly recorded system-escalation
  and named-user creator-withdrawal paths.
- Request and creator never change.
- Reassignment locks the issue, advances `ownershipEpoch`, revokes stale
  authority/native correlation, and records the new owner execution.
- A new owner or epoch cannot inherit a previous owner's provider session.
- Terminal issues reject further owner/creator updates.
- Parent and child issues never imply blocker or escalation relationships.
- A provider invocation cannot exist without a persisted `IssueExecutionRef`.

## Creation Sources

Every source uses the same ordinary issue runtime and invokable-owner resolver:

- board/user issue creation and Board Chat;
- an authorized parent execution's `issue_create` action;
- plugin-created issues with immutable installation/callback creator identity;
- routine dispatch;
- the single-level system-escalation constructor.

Creation records the canonical issue, creator edge, issue Session input, owner
authority, and dispatch ref before scheduling work.

## Mutations

### Board commands

The board has distinct audited operations for:

- editing title/presentation metadata;
- reassigning ownership;
- reopening a terminal issue through either the exact invokable-agent ref
  branch or the provider-free system-escalation board branch;
- requesting a fresh execution lineage;
- applying the same validated owner lifecycle transition where a non-agent
  escalation owner must act.

These are not a generic issue patch endpoint.

### Owner `issue_update`

The current agent owner may submit one required message and:

- move `open ↔ blocked`;
- move `open | blocked → done`;
- move `open | blocked → cancelled`.

The commit writes the typed source, canonical Session event, derived comment,
and terminal disposition atomically. No generic run-summary comment is added.

### Creator update

An immutable creator may send an exact-message counterpart update to a current
nonterminal issue it created. Agent creators are authorized by the exact active
parent execution and its persisted direct-child creator edge, not by matching
agent identity. A creator update does not mutate lifecycle state.

### Comments and mentions

Board comments are human-visible Session inputs. A comment starts provider work
only through a legal, typed mention or another explicit canonical source.
Comments do not silently reopen issues, rewrite requests, or select owners from
free-form text.

## Issue Execution

Each issue has one canonical Paperclip Session log. Every execution ref
owns an immutable authorized lowering view containing only its admitted source,
its optional dial-authorized composition snapshot, and output from its own
lineage.

Provider-native continuity is a separate protected envelope scoped to:

```
(company, issue, ownership epoch, agent, adapter configuration revision)
```

It is read and written only when effective `carry_context` is true. Paperclip
never uses an agent-wide conversational-session key.

## Workspaces

The launch workspace is selected from the persisted
`issue_execution_workspace_bindings` row for the issue and ownership epoch. It
may be projectless. Legacy issue/workspace provenance columns are migration
evidence only and are not runtime selectors.

## Dependencies and Recovery

Ordinary blocker dependencies remain independent board data. Recovery first
records a typed system notice on the affected issue. Only a terminal,
unreceivable creator edge can create the one canonical root-level system
escalation; that escalation is neither a blocker nor a parent of the affected
issue and cannot recursively escalate.

## Agent Visibility

Providers receive a compiled run interface, not generic issue REST access. The
six exhaustive Paperclip actions are:

```
issue_create
issue_assign
issue_update
mention_agent
agent_hire
agent_configure
```

Each descriptor contains only targets authorized for the exact active execution
and is rechecked under lock at commit time.

For the full contract, see [SPEC.md](./SPEC.md) and
[execution-semantics.md](./execution-semantics.md).
