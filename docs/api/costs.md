---
title: Costs
summary: Cost events, summaries, and budget management
---

Track protocol-settled ACP cost and budget state across agents, projects, and
the company.

## Cost Event Ownership

Paperclip writes one cost event internally for every protocol-settled ACP
prompt. A known event exposes `knownDeltaAmount` as a canonical decimal string
in the owning company's `budgetCurrency`; unavailable observations expose a
typed reason and no invented amount. There is no public cost-event write API.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown for the current month.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown for the current month.

## Budget Management

### Set Company Budget

```
PATCH /api/companies/{companyId}/budgets
{ "budgetMonthlyAmount": "1000" }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}/operational-configuration
{ "budgetMonthlyAmount": "50" }
```

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — the board can review remaining budget |
| 100% | Hard stop — the scope is budget-paused and new provider attempts are denied |

Budget windows reset on the first of each month (UTC).
