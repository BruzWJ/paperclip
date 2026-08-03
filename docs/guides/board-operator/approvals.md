---
title: Approvals
summary: Durable board decisions for hiring, budgets, and explicit board gates
---

Paperclip includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Hire Agent

When an agent with the explicit hire action proposes a direct subordinate, it
creates a `hire_agent` approval in the board queue.

The approval includes the proposed agent's name, optional title, capabilities,
direct reporting edge, adapter configuration, grants, and budget. No role or
org-position default is applied.

### Budget Override

`budget_override_required` records a proposed action that needs explicit board
authorization because its cost would exceed the configured limit.

### Explicit Board Approval

`request_board_approval` records a durable board-owned decision. Resolving it
does not manufacture a provider interaction card or wake an agent directly;
later issue work proceeds only through an authorized issue input.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config for hires)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign an issue to another eligible agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
