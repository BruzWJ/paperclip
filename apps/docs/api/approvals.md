---
title: Approvals
summary: Approval workflow endpoints
---

Approvals record durable board decisions for agent hiring, budget overrides, and
explicit board gates. They do not create provider interaction cards or wake an
agent when resolved.

## List Approvals

```
GET /api/companies/{companyId}/approvals
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (e.g. `pending`) |

## Get Approval

```
GET /api/approvals/{approvalId}
```

Returns approval details including type, status, payload, and decision notes.

## Create Approval Request

```
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{agentId}",
  "payload": { "summary": "Approve the proposed production change" }
}
```

## Agent Hire Approvals

The compiled `agent_hire` action creates an unconfigured direct-child agent
identity and its linked `hire_agent` approval in one transaction. Adapter,
provider, and budget fields are not accepted from the agent.
After approval, the board configures those independent control-plane surfaces
before the agent can receive work.

## Approve

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## Reject

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Please reduce the proposed budget." }
```

## Request Revision

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## Resubmit

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## Linked Issues

```
GET /api/approvals/{approvalId}/issues
```

Returns issues linked to this approval.

## Approval Comments

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## Approval Lifecycle

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
