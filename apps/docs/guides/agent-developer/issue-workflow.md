---
title: Issue Workflow
summary: Work, disposition, delegation, and agent handoff through the compiled run interface
---

Paperclip admits agent work from a persisted issue-execution reference. The
runtime binds that reference to one issue, ownership epoch, agent, immutable
adapter revision, workspace, context policy, and action-grant snapshot before
the provider starts.

Agents do not discover assignments, check out issues, or mutate generic REST
resources. Provider executions receive no general Paperclip credential.
caller-identity lookup, generic issue/activity reads, generic issue PATCH, checkout,
release, delete, and out-of-band dispatch are not part of the agent contract.

## Start from the admitted work

The runtime supplies the active issue's immutable request and only the context
authorized for this execution. Treat that request as the work boundary.

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
the compiled `issue_update` owner form to publish durable progress or a
lifecycle disposition:

```json
{
  "form": "owner",
  "status": "open",
  "message": "JWT signing is complete; token refresh remains."
}
```

Terminal completion is explicit:

```json
{
  "form": "owner",
  "status": "done",
  "message": "Implemented signing and refresh, and the focused tests pass."
}
```

If progress cannot continue:

```json
{
  "form": "owner",
  "status": "blocked",
  "message": "The migration needs a board decision on the retention period."
}
```

The owner form accepts the canonical lifecycle values `open`, `blocked`,
`done`, and `cancelled`, plus a required message. It is present only for the
current owner execution. Non-owner handoff runs cannot change owner lifecycle
or disposition.

## Delegate direct child work

When `issue_create` is compiled into the run, it creates one direct child of
the active issue with an immutable request and an explicit eligible owner:

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

Child creation commits the issue, Session, authority, creator edge, and
execution reference atomically before dispatch. Do not poll agents or dispatch
the child separately after creation.

## Update creator-owned children

An exact creator execution may receive two separate capabilities:

- `issue_update` with `form: "creator_message"` sends a durable creator message
  to an eligible direct child.
- `issue_assign` changes the owner of an eligible nonterminal direct child
  created by this exact execution.

Both tools enumerate the only allowed targets in their compiled schema.
Creator authority does not grant arbitrary issue mutation.

## Hand off to another agent

When `mention_agent` is present, use an agent ID from its compiled catalog:

```json
{
  "agentId": "{authorized-agent-id}",
  "message": "Check whether this transaction boundary is safe."
}
```

`mention_agent` is a durable, same-issue handoff that is terminal for the
caller's turn. A successful call returns only an admission acknowledgement;
the caller then ends normally instead of waiting for the recipient's output.
Paperclip starts the recipient only after the caller finalizes.

The recipient's final response becomes a fresh one-hop message and run for its
direct parent. This repeats until the current issue owner/root receives it. An
unavailable direct parent stops the route; Paperclip never skips to a higher
ancestor and never auto-notifies the Board. Each hop is a fresh Paperclip run,
although a compatible ACP backend session may resume when `carry_context` and
the exact issue, epoch, agent, and adapter-revision scope match.

The implicit return route does not add the direct parent to the outgoing target
catalog. Explicit upward mentions require the `mention_any_ancestor` grant.

## Human decisions and reopen

Use `issue_update(status: "blocked")` to record blocked lifecycle and notify the
issue creator. When `mention_board` is present, use it to request information or
direction from the collective Board, then end the turn after its durable
acknowledgement. Formal approvals remain board-controlled durable decisions.

An agent comment, creator message, or handoff never implicitly reopens a
terminal issue. Reopen is a separate audited board command that preserves the
current owner, ownership epoch, Session, and workspace binding. It invokes a
provider only when that preserved owner is an invokable agent; reopening a
named-user or collective-board-owned system escalation is provider-free.

## Core rules

- Work only on the issue execution admitted by the runtime.
- Use only tools present in the compiled interface.
- Preserve the immutable request as the issue's work boundary.
- Publish progress and final disposition with the owner form of `issue_update`.
- Create only direct children through `issue_create`.
- Use `mention_agent` as a terminal durable handoff, not ownership transfer.
- Use `mention_board` for explicit Board direction, not lifecycle or approval.
- Never call generic agent, issue, comment, or activity REST from a provider
  execution.
- Never poll or separately dispatch work created by a canonical action;
  dispatch follows its persisted execution reference.
