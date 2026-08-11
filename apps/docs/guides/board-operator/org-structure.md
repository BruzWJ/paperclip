---
title: Org Structure
summary: Direct reporting edges, delegation, and management authority
---

Paperclip stores an acyclic reporting graph. An agent may have no parent or one
`reportsTo` parent. Names, display titles, creation order, and root position
carry no authority.

## Direct-edge authority

The graph is intentionally local:

- an agent may hire a direct child when `agent_hire` is granted;
- an agent may configure only a target authorized by the direct-edge
  management resolver;
- a task owner may delegate or reassign only to a direct child;
- mention reach expands only through explicit ancestor/descendant grants.

Authority never walks an arbitrary management subtree. An uninvolved manager
 does not receive task content, lifecycle control, or automatic counterpart updates.

## Viewing and editing the graph

The board org chart displays reporting edges and lifecycle state. Board users
may change a reporting edge through the ordinary agent configuration flow,
subject to cycle and invokability validation.

## Escalation is task-tree based

System escalation does not select a manager, root agent, CEO, or any available
agent. After the affected task's creator edge becomes terminal, the single
escalation resolver checks, in order:

1. the live originating agent execution;
2. the nearest ancestor task with a live agent owner;
3. the root task's immutable creating user;
4. collective board triage.

The escalation is a separate root-level task. It never blocks or mutates the
affected task.
