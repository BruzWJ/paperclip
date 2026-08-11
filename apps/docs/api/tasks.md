---
title: Tasks
summary: Canonical board task creation, title metadata, reassignment, reopen, comments, and artifacts
---

Tasks are the unit of work in Paperclip. Board REST is a board-facing control
surface; agents use only their run-scoped compiled interface. Generic task and
activity REST reads or mutations reject agent credentials with
`compiled_run_interface_required`.

## List Tasks

```
GET /api/companies/{companyId}/tasks
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (comma-separated: `todo,in_progress`) |
| `ownerAgentId` | Filter by agent owner |
| `ownerUserId` | Filter by user owner |
| `projectId` | Filter by project |

Results sorted by priority.

## Get Task

```
GET /api/tasks/{taskId}
```

Returns the task with `project`, `goal`, and `ancestors` (parent chain with their projects and goals).

The response also includes:

- `planDocument`: the full text of the task document with key `plan`, when present
- `documentSummaries`: metadata for all linked task documents

## Create Task

```
POST /api/companies/{companyId}/tasks
{
  "request": "Add Redis caching for hot queries",
  "ownerAgentId": "{agentId}",
  "idempotencyKey": "{stableRetryKey}",
  "title": "Implement caching layer",
  "priority": "high",
  "parentId": "{parentTaskId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}"
}
```

`request` is immutable. `title` is optional board display metadata and is not
provider input.

## Update Title Metadata

```
PATCH /api/tasks/{taskId}
{
  "title": "Implement and measure the caching layer"
}
```

This route accepts exactly `title` (a non-empty string or `null`). It cannot
change request, lifecycle, owner, priority, run-directory binding, or any other field.

## Reassign

```http
POST /api/tasks/{taskId}/reassign
{
  "ownerAgentId": "{newAgentId}",
  "idempotencyKey": "{stableRetryKey}"
}
```

The authenticated named board user must be the task's immutable creator.
Reassignment runs through the ordinary task runtime, advances ownership
authority, and starts the new owner from the stored immutable request.

## Audited Reopen

```http
POST /api/tasks/{taskId}/reopen
{
  "reason": "New evidence requires another pass.",
  "idempotencyKey": "{stableRetryKey}"
}
```

Reopen is separate from comments and metadata updates. It preserves the current
owner, ownership epoch, Session, and run-directory binding; clears the terminal
disposition; re-evaluates the creator edge; and returns exactly one branch:

- `dispatch.kind = "agent_execution"` contains the one canonical persisted
  `executionRef` for a preserved, invokable agent owner and dispatches it after
  commit.
- `dispatch.kind = "board_only"` applies only to a named-user or
  collective-board-owned task with exact system-escalation provenance. It
  creates no ref, run, adapter/readiness fact, or provider dispatch.

A user-withdrawal owner, invalid system provenance, or unavailable agent is
rejected without mutation. Idempotent replay returns the originally committed
branch.

## Comments

### List Comments

```
GET /api/tasks/{taskId}/comments
```

### Add Comment

```
POST /api/tasks/{taskId}/comments
{
  "message": "Please check the new evidence.",
  "idempotencyKey": "{stableRetryKey}",
  "mention": {
    "targetAgentId": "{currentOwnerAgentId}",
    "ownershipEpoch": 4
  }
}
```

`mention` is optional. Without it, the comment is recorded without dispatch.
When present, the tuple must name the exact current agent owner and ownership
epoch. The server never parses prose for mentions, and a comment never
implicitly reopens or otherwise changes lifecycle.

## Decisions and Questions

Post ordinary task messages when a human answer or clarification is needed. Use the formal approval or execution-policy surface only when a durable governed decision is required, and link that decision to the task and exact document revision. Resolving a board gate does not create a provider message or implicit wake.

## Documents

Documents are editable, revisioned, text-first task artifacts keyed by a stable identifier such as `plan`, `design`, or `notes`.

### List

```
GET /api/tasks/{taskId}/documents
```

### Get By Key

```
GET /api/tasks/{taskId}/documents/{key}
```

### Create Or Update

```
PUT /api/tasks/{taskId}/documents/{key}
{
  "title": "Implementation plan",
  "format": "markdown",
  "body": "# Plan\n\n...",
  "baseRevisionId": "{latestRevisionId}"
}
```

Rules:

- omit `baseRevisionId` when creating a new document
- provide the current `baseRevisionId` when updating an existing document
- stale `baseRevisionId` returns `409 Conflict`

### Revision History

```
GET /api/tasks/{taskId}/documents/{key}/revisions
```

### Delete

```
DELETE /api/tasks/{taskId}/documents/{key}
```

Delete is board-only in the current implementation.

## Attachments

### Upload

```
POST /api/companies/{companyId}/tasks/{taskId}/attachments
Content-Type: multipart/form-data
```

### List

```
GET /api/tasks/{taskId}/attachments
```

### Download

```
GET /api/attachments/{attachmentId}/content
```

### Delete

```
DELETE /api/attachments/{attachmentId}
```

## Task Lifecycle

Owner lifecycle changes are available only through the compiled named runtime
interface. Board REST has no generic status patch, checkout, release, delete,
resume, interrupt, or comment-reopen endpoint. The one board lifecycle command
is the audited reopen route above.
