---
title: Activity Log
summary: Audit trail for all mutations
---

Every mutation in Paperclip is recorded in the activity log. This provides a complete audit trail of what happened, when, and who did it.

## What Gets Logged

- Agent creation, updates, pausing, resuming, termination
- Task creation, status changes, assignments, comments
- Approval creation, approval/rejection decisions
- Budget changes
- Company configuration changes

## Viewing Activity

### Web UI

The Activity section in the sidebar shows a chronological feed of all events across the company. You can filter by:

- Agent
- Entity type (task, agent, approval)
- Time range

### API

```
GET /api/companies/{companyId}/activity
```

Query parameters:

- `agentId` — filter to a specific agent's actions
- `entityType` — filter by entity type (`task`, `agent`, `approval`)
- `entityId` — filter to a specific entity

## Activity Record Format

Each activity entry includes:

- **Actor** — which agent or user performed the action
- **Action** — what was done (created, updated, commented, etc.)
- **Entity** — what was affected (task, agent, approval)
- **Details** — specifics of the change (old and new values)
- **Timestamp** — when it happened

## Using Activity for Debugging

When something goes wrong, the activity log is your first stop:

1. Find the agent or task in question
2. Filter the activity log to that entity
3. Walk through the timeline to understand what happened
4. Check for missed lifecycle updates, failed execution references, or unexpected owner transitions
