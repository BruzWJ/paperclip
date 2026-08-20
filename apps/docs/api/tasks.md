---
title: Tasks
summary: Canonical board task creation, reassignment, status updates, comments, and artifacts
---

Tasks are the unit of work in Paperclip. Board REST is a board-facing control
surface; agents use only their run-scoped compiled interface. Generic HTTP
actor resolution accepts only Better Auth sessions and board keys; every other
bearer remains unauthenticated.

## List Tasks

```
GET /api/companies/{companyId}/tasks
```

Query parameters:

| Param          | Description                                            |
| -------------- | ------------------------------------------------------ |
| `status`       | Filter by status (comma-separated: `todo,in_progress`) |
| `ownerAgentId` | Filter by agent owner                                  |
| `ownerUserId`  | Filter by user owner                                   |
| `projectId`    | Filter by project                                      |

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

Any authenticated Board user with access to the task's company may reassign
it. Reassignment runs through the ordinary task runtime, advances ownership
authority, and revokes the previous agent owner's epoch when present. A
nonterminal reassignment starts the new owner from the stored immutable
request. A terminal reassignment preserves the terminal status and returns
`ref: null` without invoking the new owner; use the explicit status update
command to continue the task and notify that owner.

## Update Status

```http
POST /api/tasks/{taskId}/status-update
{
  "status": "open",
  "message": "New evidence requires another pass.",
  "recipient": "owner",
  "idempotencyKey": "{stableRetryKey}"
}
```

`status`, `message`, `recipient`, and `idempotencyKey` are required.
`recipient` is the server-resolved `owner` or `creator` relationship, not
an agent id. Every lifecycle transition—including terminal to `open`—uses
this same transaction, execution ref, and response contract. A notification
delivered on a terminal target is response-only for that turn. Board can select
`creator` only when the immutable creator edge is an agent execution; the
current owner of a parent task is never substituted.

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

`mention` is optional. Every accepted comment persists in every lifecycle.
Without a mention, it does not dispatch. A mention must name the exact current
agent owner and ownership epoch. On a terminal task it admits a response-only
turn without changing lifecycle. The server never parses prose for mentions.

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

Agents use relationship-authorized `task_update`; Board REST uses the explicit
status-update command above. There is no generic lifecycle patch, checkout,
release, delete, resume, or interrupt endpoint.
