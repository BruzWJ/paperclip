---
title: Comments and Communication
summary: Durable issue communication through the compiled run interface
---

Issue communication is durable, issue-scoped input. A provider execution does
not receive a general Paperclip credential and does not post through generic
issue or comment routes.

## Owner updates

When `issue_update` is present with the owner form, the current owner may
publish progress and lifecycle disposition:

```json
{
  "form": "owner",
  "status": "open",
  "message": "JWT signing is complete; refresh-token verification remains."
}
```

Use concise Markdown in `message`: state what changed, the evidence, and the
next action or blocker. The canonical owner states are `open`, `blocked`,
`done`, and `cancelled`.

The owner form is absent from non-owner handoff executions and any run that
does not hold the exact current issue/ownership-epoch authority.

## Creator messages

An exact creator execution may receive `issue_update` with
`form: "creator_message"`. Its compiled schema enumerates eligible direct
children created by that same execution:

```json
{
  "form": "creator_message",
  "issueId": "{eligible-direct-child-id}",
  "message": "The interface is approved; keep the transaction boundary."
}
```

This is a durable message, not an ownership transfer. A target omitted from the
schema is not authorized.

## Agent handoffs

When `mention_agent` is present, hand off same-issue work using an agent ID from
its compiled catalog:

```json
{
  "agentId": "{authorized-agent-id}",
  "message": "Review the transaction boundary and identify one concrete risk."
}
```

The call durably admits the handoff, returns an acknowledgement rather than the
recipient's response, and is terminal for the caller's turn. The caller ends
normally, and Paperclip starts the recipient only after that caller finalizes.

The recipient's final response is admitted as a fresh one-hop message and run
for its direct parent, repeating until the current issue owner/root receives
it. The route never skips an unavailable parent and never auto-notifies the
Board. A fresh Paperclip run may still resume a compatible ACP backend session
when `carry_context` and the exact scope match.

The direct parent is an implicit return route, not an implicit outgoing tool
target. Explicitly mentioning a parent or higher ancestor requires the
`mention_any_ancestor` grant.

## Human comments and typed mentions

Humans may add comments through the board UI. The committed comment becomes
issue Session input only through the canonical dispatch path. A typed human
mention can dispatch only the explicit current owner and ownership epoch;
provider-authored prose never infers a dispatch or changes ownership.

## Board requests

When `mention_board` is present, the current owner may explicitly request
information or direction from the collective Board:

```json
{
  "message": "Which retention policy should this implementation use?"
}
```

`message` is the complete Board request. The call
returns only its durable acknowledgement and is terminal for the caller's turn.
It does not block the issue, create an approval or review, or invoke another
agent. A Board user continues the issue in a fresh run through the existing
typed current-owner mention.

## Decisions and questions

Use `issue_update(status: "blocked")` only to record blocked issue lifecycle and
notify the issue creator. When Board direction is needed, use `mention_board`
if granted. Formal approvals remain board-controlled durable decisions. Link a
governed decision to the exact proposal or document revision; changed proposal
content requires a new decision.

## Rules

- Use only communication forms present in the compiled interface.
- Never call generic issue, comment, agent, or activity REST routes from a
  provider execution.
- Never infer ownership or authority from a name written in prose.
- Use `issue_create` plus an explicit owner for delegated work.
- Use `mention_agent` only as a terminal durable handoff.
- Use `mention_board` for an explicit Board request, not lifecycle or approval.
