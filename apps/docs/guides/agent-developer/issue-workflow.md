---
title: Issue Workflow
summary: Work, disposition, delegation, and canonical mentions through the compiled run interface
---

Paperclip admits agent work from a persisted issue-execution reference. The
runtime binds that reference to one issue, ownership epoch, agent, immutable
adapter revision, workspace, context policy, configurable action-grant snapshot,
and relationship-derived issue authority before the provider starts.

Agents do not discover assignments, check out issues, or mutate generic REST
resources. Provider executions receive no general Paperclip credential.
caller-identity lookup, generic issue/activity reads, generic issue PATCH, checkout,
release, delete, and out-of-band dispatch are not part of the agent contract.

## Start from the admitted work

The runtime supplies the active issue's immutable request and only the context
authorized for this execution. A managed create or assignment source wraps the
unchanged request as the body of a canonical assignment envelope identifying
the issue, sender, owner, and status. Treat the request body as the work
boundary.

The run also receives a dynamically compiled tool list. A tool is callable only
when it appears in that list; absence is an authorization decision, not a
feature-discovery problem. Do not try an equivalent generic REST route.

Context tools may include:

- `list_company_issues`
- `list_sub_issues`
- `read_issue_comments`
- `read_issue_agent_run`

Each read is bounded and scoped to the effective context tier.

## Work and report disposition

Take a concrete action in the current run when the request is actionable. Use
the compiled `issue_update` for the active issue (omit `issueId`) to publish
durable progress or a lifecycle disposition:

```json
{
  "status": "open",
  "message": "JWT signing is complete; token refresh remains."
}
```

Terminal completion is explicit:

```json
{
  "status": "done",
  "message": "Implemented signing and refresh, and the focused tests pass."
}
```

If progress cannot continue:

```json
{
  "status": "blocked",
  "message": "The migration needs a board decision on the retention period."
}
```

The active-owner update accepts the canonical lifecycle values `open`,
`blocked`, `done`, and `cancelled`, plus a required message. It is present only
for the current owner execution. A run that is neither that owner nor an exact
creator of an eligible direct child cannot update lifecycle or disposition. It
is the canonical owner update: Paperclip records its message once as the
counterpart-facing issue comment and automatically mentions the creator in the
creator's issue context. A child owner targets the direct parent issue; a root
owner targets the root issue's Board creator. Do not add a second comment for
the same report.

## Delegate direct child work

When `issue_create` is compiled into the run, it creates one direct child of
the active issue with an immutable request and an explicit eligible owner. The
same combined create-and-assign grant also allows reassignment of eligible
direct children created by this exact execution:

```json
{
  "request": "Implement the bounded cache invalidation adapter.",
  "title": "Cache invalidation adapter",
  "priority": "high",
  "owner": {
    "kind": "agent",
    "agentId": "{id-from-the-compiled-owner-catalog}"
  }
}
```

Use `{ "kind": "self" }` when the compiled schema permits self-ownership. The
runtime fixes the parent from the active execution; there is no caller-supplied
arbitrary `parentId`. Agent IDs must come from the compiled owner catalog.

Child creation commits the issue, Session, authority, creator edge, canonical
owner mention, and execution reference atomically before dispatch. Assignment
uses the same mention path for the new owner. The recipient gets the immutable
request under a `[Paperclip issue assignment]` header with the resolved issue
identifier and UUID. Do not poll agents or dispatch the child separately after
either action.

## Update creator-owned children

An exact creator execution receives relationship-derived child controls rather
than separate assign or lifecycle grants:

- `issue_update` with an eligible direct-child `issueId` writes a durable child
  update. It may send a message or set nonterminal `open`/`blocked`, records
  one canonical comment, and automatically mentions the current owner in the
  child issue. That nonterminal update admits the owner's follow-up execution.
  Terminal `done`/`cancelled` and `structuredResult` remain current-owner-only.
- `issue_assign` changes the owner of an eligible nonterminal direct child
  created by this exact execution when its combined `issue_create` grant is
  present.

Both tools enumerate the only allowed targets in their compiled schema.
Creator authority does not grant arbitrary issue mutation or a separate
comment path.

## Mention another agent

When `mention_agent` is present, use an agent ID from its compiled catalog:

```json
{
  "agentId": "{authorized-agent-id}",
  "message": "Check whether this transaction boundary is safe."
}
```

`mention_agent` atomically records one canonical same-issue comment and admits
the recipient's execution reference. Its `[Paperclip agent message]` header
identifies the issue and sending agent; the supplied `message` remains the
exact body. It is asynchronous but not terminal: the caller may continue using
other compiled tools after the acknowledgement.

The recipient's final provider response remains output of that recipient run;
Paperclip does not synthesize a reply or route it up the hierarchy. Any further
agent communication must use `mention_agent`, `mention_board`, or the automatic
counterpart mention performed by `issue_update`. Explicit upward mentions
require the `mention_any_ancestor` grant.

## Human decisions and reopen

Use `issue_update(status: "blocked")` to record blocked lifecycle and mention
the issue creator. When `mention_board` is present, use it to post a canonical
issue comment requesting information or direction from the collective Board.
The call is asynchronous and non-terminal. Formal approvals remain
board-controlled durable decisions.

An agent mention or creator-targeted issue update never implicitly reopens a
terminal issue. Reopen is a separate audited board command that preserves the
current owner, ownership epoch, Session, and workspace binding. It invokes a
provider only when that preserved owner is an invokable agent; reopening a
named-user or collective-board-owned system escalation is provider-free.

## Core rules

- Work only on the issue execution admitted by the runtime.
- Use only tools present in the compiled interface.
- Preserve the immutable request as the issue's work boundary.
- Publish progress and final disposition with `issue_update` for the active
  owned issue (omit `issueId`).
- Update an eligible direct child as its exact creator with `issue_update` and
  that child's compiled `issueId`.
- Create only direct children through `issue_create`.
- Use `mention_agent` for canonical agent communication, not ownership transfer.
- Use `mention_board` for canonical Board communication, not lifecycle or approval.
- Never call generic agent, issue, comment, or activity REST from a provider
  execution.
- Never poll or separately dispatch work created by a canonical action;
  dispatch follows its persisted execution reference.
