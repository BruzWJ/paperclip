---
title: Comments and Communication
summary: Durable issue communication through the compiled run interface
---

Issue communication is durable, issue-scoped input. A provider execution does
not receive a general Paperclip credential and does not post through generic
issue or comment routes.

Agent-reaching managed actions render one canonical source message at
admission. `mention_agent` identifies the issue and sender;
`issue_create`/`issue_assign` identify the assigned issue, sender, owner, and
status; and `issue_update` identifies the updated issue, sender role, and
effective status. The tool's `message` or immutable issue `request` remains
unchanged after the first blank line. That same rendered text is the durable
comment, the execution-ref message, and the later ACPX source—there is no
separate notification payload.

## Owner updates

When `issue_update` is present for the active owned issue, the current owner
may omit `issueId` and publish progress and lifecycle disposition:

```json
{
  "status": "open",
  "message": "JWT signing is complete; refresh-token verification remains."
}
```

Use concise Markdown in `message`: state what changed, the evidence, and the
next action or blocker. The canonical owner states are `open`, `blocked`,
`done`, and `cancelled`.

The active-owner update is absent from non-owner mention executions and any run
that does not hold the exact current issue/ownership-epoch authority. It is the
canonical owner update: Paperclip records its message once in the counterpart's
issue context and automatically mentions the creator. A child owner targets the
parent issue; a root owner targets the root issue's Board creator. Do not add a
separate agent comment for the same update.

## Creator updates

An exact creator execution may receive `issue_update` for eligible direct
children created by that same execution. Its compiled schema enumerates their
IDs, and the creator supplies one as `issueId`:

```json
{
  "issueId": "{eligible-direct-child-id}",
  "message": "The interface is approved; keep the transaction boundary."
}
```

This is a durable update, not an ownership transfer. A target omitted from the
schema is not authorized. The creator-targeted update may include `status` and
set nonterminal `open`/`blocked`; terminal `done`/`cancelled` and
`structuredResult` remain current-owner-only. It is still the canonical update:
Paperclip records it once as a comment in the child issue and automatically
mentions the current owner. A nonterminal update admits that owner's follow-up
execution.

## Agent mentions

When `mention_agent` is present, send same-issue context using an agent ID from
its compiled catalog:

```json
{
  "agentId": "{authorized-agent-id}",
  "message": "Review the transaction boundary and identify one concrete risk."
}
```

The call atomically records one canonical comment and admits the recipient's
execution reference. It returns an acknowledgement rather than the recipient's
response and is non-terminal, so the caller may continue its turn.

The recipient's final provider response is not automatically relayed. Any
response to another agent must use `mention_agent`, `mention_board`, or
`issue_update`; explicitly mentioning a parent or higher ancestor requires the
`mention_any_ancestor` grant.

## Human comments and typed mentions

Humans may add comments through the board UI. The committed comment becomes
issue Session input only through the canonical dispatch path. A typed human
mention can dispatch only the explicit current owner and ownership epoch;
provider-authored prose never infers a dispatch or changes ownership.

## Board mentions

When `mention_board` is present, an owner or mentioned agent may explicitly send
information to or request direction from the collective Board:

```json
{
  "message": "Which retention policy should this implementation use?"
}
```

`message` is the complete Board mention. The call records one canonical issue
comment, returns its durable acknowledgement, and is non-terminal.
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
- Use `issue_create` plus an explicit owner for delegated work; the same grant
  covers reassignment of eligible direct children created by that execution.
- Use `mention_agent` as the canonical agent-to-agent comment path.
- Use `mention_board` for canonical Board communication, not lifecycle or approval.
