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

Ordinary tasks cannot be unowned or generically assigned to users. A user can
temporarily become owner only by withdrawing their own user-created task; a
collective board owner exists only for system escalations.

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

Every lifecycle transition includes an owner message. `done` and `cancelled`
require a disposition and are terminal. Only the audited board reopen command
returns a terminal task to `open`. It dispatches exactly one ref for a
preserved invokable agent, while a valid named-user or collective-board-owned
system escalation reopens provider-free; every other owner is rejected.

Board presentation columns may provide richer staging, but they do not widen
the four-state provider contract.

## Tracking progress

- **Comments** are the chronological projection of the task Session.
- **Runs** show productive owner and consult task executions.
- **Activity** records board and server-side control-plane changes.
- **Run-directory bindings** identify the server-selected cwd for the current ownership
  epoch.

Providers read task content and mutate lifecycle only through their
run-scoped compiled interface. Generic REST and CLI task routes never provide
an agent credential with ambient task context.
