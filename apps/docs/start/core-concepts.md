---
title: Core Concepts
summary: Companies, configured agents, tasks, task executions, and governance
---

Paperclip organizes agent work around durable control-plane records. Providers
receive only the current task input and the run-scoped interface compiled for
that execution.

## Company

A company is the top-level isolation and governance boundary. It contains:

- company goals and projects;
- ordinary configured agents and their reporting edges;
- routines;
- budgets, approvals, audit history, and retention policy.

One Paperclip instance can host multiple isolated companies.

## Agents

An agent is a reusable configured identity, not a persistent mind. Its
configuration includes:

- name, optional display title, icon, capabilities text, and optional direct
  `reportsTo` edge;
- adapter type, provider-native configuration, runtime limits, and budget;
- explicit context grants, five configurable action grants, and mention reach;
- lifecycle and operational accounting.

There is no agent role field, privileged first or root agent, role-derived
grant, Paperclip instruction fallback, or built-in agent-wide model-visible
memory. An administrator-approved infrastructure plugin may observe the generic
before-prompt lifecycle and contribute agent tools, but cannot alter provider
prompt content or the agent's Paperclip authority. An org-chart edge describes
reporting only; it grants no recursive authority or escalation fallback.

## Tasks

A task is the canonical unit of work. Its behavioral identity consists of:

- an immutable request;
- an immutable polymorphic creator;
- one current owner and a monotonically increasing ownership epoch;
- lifecycle `open`, `blocked`, `done`, or `cancelled`;
- an optional disposition for a terminal lifecycle;
- parent/project/goal relations, priority, comments, and documents.

Every task owns one Paperclip Session graph. Inputs, assistant turns, tool
states and costs are recorded per task.
Provider-native continuity may be retained only for the same task, ownership
epoch, agent, and adapter revision when `carry_context` is enabled. It never
becomes Paperclip-authored cross-task memory.

The current owner may update its active task, while an exact creator execution
may update eligible direct children. Reassignment is a separate audited
operation that advances the ownership epoch, revokes the old execution
authority, and starts the new owner cleanly. There is no checkout, claim,
release, or singleton run pointer on the task.

Board comments persist in every lifecycle. Board status changes require one
status, message, and resolved owner or creator recipient; terminal to `open`
uses the same transaction and response as every other transition.

## Delegation

Delegation follows authenticated task edges:

1. A board user, agent execution, plugin, routine, or system source creates an
   ordinary task with an exact creator and required owner.
2. An eligible owner execution with `task_create` may create a direct child
   and reassign eligible direct children it created.
3. The child has its own Session, owner, epoch, and execution authority.
4. Owner and eligible creator updates are relationship-derived, while the
   combined `task_create` grant governs direct-child creation and
   reassignment. Both use canonical `task_update`, which automatically
   canonically mentions the owner/creator counterpart with their message rather than using a
   separate comment path. A creator update can send a message or set
   nonterminal `open`/`blocked`; terminal `done`/`cancelled` remains
   current-owner-only.

The runtime never chooses an owner from role, title, root position, manager
walk, hire order, or an arbitrary invokable-agent scan.

## Task Executions

A persisted task-execution ref is the only provider invocation boundary. The
server binds it to the task, epoch, owner, immutable adapter revision, mode,
effective grants, and compiled interface before a provider attempt starts.

Refs are admitted only by enumerated task events such as creation, assignment,
status update, authorized mention, counterpart update, or typed system nudge.
Routines use the same path by creating ordinary tasks. Nothing can invoke an
agent or enqueue a generic wake outside a task.

## Context and Prompt Capabilities

Each context key and configurable action-grant key is an independent explicit
boolean; absent means denied. `task_create` also governs eligible direct-child
reassignment. Owner lifecycle updates and creator nonterminal updates are
derived from the task relationship rather than configured booleans. The server
resolves the effective context for the current run and compiles the
`paperclip.run-tools/v1` prompt-capability interface bound to that authenticated
ref. An unavailable action is absent and undiscoverable.

Terminal owner mentions and notifications are response-only per turn. They
receive read tools plus a compact notice without changing session selection.

ACPX is the sole provider communication and execution contract. Paperclip does
not maintain a parallel provider-instruction channel. A fresh request-scoped
MCP server set supplied through ACPX is its only tool-injection boundary.

## Governance

The human board can:

- configure, pause, resume, adopt, or terminate agents;
- choose task owners and perform audited reassign/status-update operations;
- review formal hire, budget, and explicit board approvals;
- inspect task Sessions, comments, runs, costs, and audit history;
- reassign Board-owned system escalations to agents before status updates.

Approval decisions remain durable control-plane records. Resolving one does not
create a provider interaction card or directly wake an agent. Every provider
attempt still begins from an authorized task-execution ref.
