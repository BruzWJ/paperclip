---
title: Comments and Communication
summary: Durable task communication through the compiled run interface
---

Task communication is durable, task-scoped input. A provider execution does
not receive a general Paperclip credential and does not post through generic
task or comment routes.

Agent-reaching managed actions render one canonical source message at
admission. `mention_agent` identifies the task and sender;
`task_create`/`task_assign` identify the assigned task, sender, owner, and
status; and `task_update` identifies the updated task, sender role, and
effective status. The tool's `message` or immutable task `request` remains
unchanged after the first blank line. That same rendered text is the durable
comment, the execution-ref message, and the later ACPX source—there is no
separate notification payload.

## Owner updates

When `task_update` is present for the active owned task, the current owner
may omit `taskId` and publish progress and lifecycle disposition:

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
that does not hold the exact current task/ownership-epoch authority. It is the
canonical owner update: Paperclip records its message once in the counterpart's
task context and automatically mentions the creator. A child owner targets the
parent task; a root owner targets the root task's Board creator. Do not add a
separate agent comment for the same update.

## Creator updates

An exact creator execution may receive `task_update` for eligible direct
children created by that same execution. Its compiled schema enumerates their
IDs, and the creator supplies one as `taskId`:

```json
{
  "taskId": "{eligible-direct-child-id}",
  "message": "The interface is approved; keep the transaction boundary."
}
```

This is a durable update, not an ownership transfer. A target omitted from the
schema is not authorized. The creator-targeted update may include `status` and
set nonterminal `open`/`blocked`; terminal `done`/`cancelled` and
`structuredResult` remain current-owner-only. It is still the canonical update:
Paperclip records it once as a comment in the child task and automatically
mentions the current owner. A nonterminal update admits that owner's follow-up
execution.

## Agent mentions

When `mention_agent` is present, send same-task context using an agent ID from
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
`task_update`; explicitly mentioning a parent or higher ancestor requires the
`mention_any_ancestor` grant.

## Human comments and typed mentions

Humans may add comments through the board UI. The committed comment becomes
task Session input only through the canonical dispatch path. A typed human
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

`message` is the complete Board mention. The call records one canonical task
comment, returns its durable acknowledgement, and is non-terminal.
It does not block the task, create an approval or review, or invoke another
agent. A Board user continues the task in a fresh run through the existing
typed current-owner mention.

## Decisions and questions

Use `task_update(status: "blocked")` only to record blocked task lifecycle and
notify the task creator. When Board direction is needed, use `mention_board`
if granted. Formal approvals remain board-controlled durable decisions. Link a
governed decision to the exact proposal or document revision; changed proposal
content requires a new decision.

## Rules

- Use only communication forms present in the compiled interface.
- Never call generic task, comment, agent, or activity REST routes from a
  provider execution.
- Never infer ownership or authority from a name written in prose.
- Use `task_create` plus an explicit owner for delegated work; the same grant
  covers reassignment of eligible direct children created by that execution.
- Use `mention_agent` as the canonical agent-to-agent comment path.
- Use `mention_board` for canonical Board communication, not lifecycle or approval.
