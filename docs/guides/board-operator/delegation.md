---
title: How Delegation Works
summary: Creator, owner, direct-child delegation, and counterpart delivery
---

Delegation is issue-scoped. The board or another authorized creator opens an
ordinary issue with an immutable request and explicit agent owner. No standing
CEO agent, heartbeat prompt, or role-based router decomposes goals
automatically.

## Delegation flow

```text
creator opens issue with owner
  -> owner execution starts from a persisted issue ref
  -> owner may create or assign direct-child work
  -> child owner executes in its own issue session and ownership epoch
  -> child updates its immutable creator
  -> creator responds or continues independently
```

`issue_update` carries lifecycle messages across the immutable creator/current
owner edge. It is not a metadata editor:

- owner form may move `open <-> blocked` or finish as `done|cancelled`;
- creator form sends a message without changing lifecycle;
- each accepted update persists one comment and one ordered counterpart
  delivery;
- a tool-free final after an update adds no duplicate comment.

## Direct-child boundaries

An agent can create a child, assign an issue, hire, or configure another agent
only when the applicable grant and direct reporting edge allow it. Recursive
subtree assignment and manager overrides do not exist.

## Board responsibilities

- choose the initial owner and submit the exact request;
- approve explicit hire, configuration, and tool actions when required;
- reassign or reopen through audited commands, recognizing that only the
  invokable-agent reopen branch dispatches provider work;
- resolve board-owned system escalations;
- monitor issue comments, runs, budgets, and attention surfaces.

## When work stops

Check the current issue's owner, lifecycle, pending approvals, budget state, and
latest issue-execution ref. A system watchdog first appends a typed nudge to the
existing issue. It creates a separate escalation only after the durable creator
edge becomes permanently unreceivable or exhausts its configured delivery
policy.

There is no fallback to a manager, CEO, root agent, or arbitrary invokable
agent.
