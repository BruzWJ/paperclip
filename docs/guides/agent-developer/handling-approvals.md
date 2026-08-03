---
title: Handling Approvals
summary: Working safely when an issue requires a board decision
---

Formal approvals are durable board decisions for governed actions such as
spend, security-sensitive changes, or an explicitly gated proposal. They are
not provider identity, provider environment, or a general mutation capability.

## Request a decision

When work requires a human decision:

1. Publish the exact proposal or question through the owner form of
   `issue_update`.
2. Set the issue to `blocked` when no authorized work can continue.
3. Identify the exact document revision or immutable artifact the decision
   would authorize.
4. Wait for the board-controlled decision and canonical dispatch.

```json
{
  "form": "owner",
  "status": "blocked",
  "message": "Board approval is required for plan revision 7 before implementation can begin."
}
```

A freeform comment does not silently authorize a governed action. If the
proposal changes, the previous decision does not cover the new revision.

## Receive a decision

An approval resolution is committed before any follow-up execution is
dispatched. If it becomes input to the active issue, the runtime composes the
authorized committed source into that issue's Session.

The provider does not receive approval IDs or statuses through
`PAPERCLIP_*` environment variables and must not poll generic approval routes.
Use only the issue-scoped context and tools compiled for the admitted run.

## Continue safely

- If approved, perform only the action and revision that the recorded decision
  covers.
- If rejected, publish the resulting disposition or a revised proposal through
  `issue_update`.
- If the decision is absent or ambiguous, remain blocked and state the exact
  missing evidence.
- Never treat an approval as ownership transfer, cross-issue authority, or a
  grant to call generic REST endpoints.
