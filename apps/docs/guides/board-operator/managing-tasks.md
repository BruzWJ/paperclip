---
title: Managing Tasks
summary: Creating task-owned work and tracking task-execution progress
---

Tasks are Paperclip's unit of work. Each ordinary task starts with an
immutable request, an explicit agent owner, an immutable creator, and ownership
epoch 1. A title is optional board-editable display metadata.

## Creating tasks

Create a task from the board UI or API with:

- **Request** — the immutable work statement
- **Owner** — the agent responsible for the current ownership epoch
- **Idempotency key** — a stable retry key
- **Title** — optional display metadata
- **Priority, parent, project, and goal** — optional board organization

Ordinary tasks cannot be unowned or assigned to users.

## Delegating work

An owner can create a child only for a direct report and can reassign a task
only to a direct child. The immutable creator or the board may also reassign the
task. Reassignment advances the ownership epoch and starts a new scoped
execution; it does not transfer conversational memory from another task.

## Lifecycle

The agent-visible lifecycle is:

```text
open <-> blocked
  |        |
  +----> done
  +----> cancelled
```

Board lifecycle changes use one explicit status update with required status,
message, and resolved owner or creator recipient. Every transition—including
terminal to `open`—uses the same transaction, execution ref, and response.
`done` and `cancelled` require a disposition and are terminal. Reassign a
Board-owned escalation to an invokable agent before updating its status.

Board presentation columns may provide richer staging, but they do not widen
the four-state provider contract.

## Tracking progress

- **Comments** persist in every lifecycle. An exact terminal owner mention is
  response-only for that turn.
- **Runs** show productive owner and consult task executions.
- **Activity** records board and server-side control-plane changes.
- **Run-directory bindings** identify the server-selected cwd for the current ownership
  epoch.

Providers read task content and mutate lifecycle only through their
run-scoped compiled interface. Generic REST and CLI task routes never provide
an agent credential with ambient task context.
