---
title: Core Concepts
summary: Companies, configured agents, issues, issue executions, and governance
---

Paperclip organizes agent work around durable control-plane records. Providers
receive only the current issue input and the run-scoped interface compiled for
that execution.

## Company

A company is the top-level isolation and governance boundary. It contains:

- company goals and projects;
- ordinary configured agents and their reporting edges;
- issues, routines, tools, skills, environments, and workspaces;
- budgets, approvals, audit history, and retention policy.

One Paperclip instance can host multiple isolated companies.

## Agents

An agent is a reusable configured identity, not a persistent mind. Its
configuration includes:

- name, optional display title, icon, capabilities text, and optional direct
  `reportsTo` edge;
- adapter type, provider-native configuration, runtime limits, environment, and
  budget;
- explicit context grants, issue-action grants, mention reach, company-tool
  selections, and company-skill selections;
- lifecycle and operational accounting.

There is no agent role field, privileged first or root agent, role-derived
grant, Paperclip instruction fallback, or agent-wide model-visible memory. An
org-chart edge describes reporting only; it grants no recursive authority or
escalation fallback.

## Issues

An issue is the canonical unit of work. Its behavioral identity consists of:

- an immutable request;
- an immutable polymorphic creator;
- one current owner and a monotonically increasing ownership epoch;
- lifecycle `open`, `blocked`, `done`, or `cancelled`;
- an optional disposition for a terminal lifecycle;
- parent/project/goal relations, priority, comments, documents, and workspace
  policy.

Every issue owns one Paperclip Session graph. Inputs, assistant turns, tool
states, costs, and compaction controls are recorded per issue.
Provider-native continuity may be retained only for the same issue, ownership
epoch, agent, and adapter revision when `carry_context` is enabled. It never
becomes Paperclip-authored cross-issue memory.

The current owner alone has owner-form lifecycle authority. Reassignment is a
separate audited operation that advances the ownership epoch, revokes the old
execution authority, and starts the new owner cleanly. There is no checkout,
claim, release, or singleton run pointer on the issue.

## Delegation

Delegation follows authenticated issue edges:

1. A board user, agent execution, plugin, routine, or system source creates an
   ordinary issue with an exact creator and required owner.
2. An eligible owner execution may create a direct child when `issue_create` is
   compiled into its run interface.
3. The child has its own Session, owner, epoch, and execution authority.
4. Owner updates are delivered to the immutable creator; the creator can send a
   creator-form response or perform an explicitly allowed reassignment.

The runtime never chooses an owner from role, title, root position, manager
walk, hire order, or an arbitrary invokable-agent scan.

## Issue Executions

A persisted issue-execution ref is the only provider invocation boundary. The
server binds it to the issue, epoch, owner, immutable adapter revision,
workspace, mode, effective grants, and compiled interface before a provider
attempt starts.

Refs are admitted only by enumerated issue events such as creation, assignment,
an invokable-agent board reopen, an authorized comment or mention, a
counterpart update, or a typed system nudge. The system-escalation board-only
reopen branch intentionally admits no ref. Routines and Board Chat use the same
path by creating ordinary issues. Schedules, approval resolution, plugins, and
users cannot invoke an agent or enqueue a generic wake outside an issue.

## Context and Tools

Each context key and action key is an independent explicit boolean; absent
means denied. The server resolves the effective context for the current run and
serves a dynamic tool schema bound to that authenticated ref. An unavailable
tool is absent and undiscoverable.

Company tools and genuine company skills are visible to a provider only when
explicitly selected for that agent and allowed by the run's effective mask. No
static Paperclip MCP, operational skill bundle, or prompt attachment supplies a
second interface.

## Governance

The human board can:

- configure, pause, resume, adopt, or terminate agents;
- choose initial issue owners and perform audited reassign/reopen operations;
- review formal hire, budget, and explicit board approvals;
- inspect issue Sessions, comments, runs, costs, and audit history;
- resolve board-owned system escalation issues.

Approval decisions remain durable control-plane records. Resolving one does not
create a provider interaction card or directly wake an agent. Every provider
attempt still begins from an authorized issue-execution ref.
