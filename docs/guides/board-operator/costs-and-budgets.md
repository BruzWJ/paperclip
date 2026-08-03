---
title: Costs and Budgets
summary: Budget caps, cost tracking, and auto-pause enforcement
---

Paperclip tracks every known, matching-currency ACP prompt cost and enforces
budget limits without inventing prices for unavailable observations.

## How Cost Tracking Works

Each protocol-settled ACP prompt records:

- exact terminal context occupancy;
- a canonical decimal-string cost delta when the reported cumulative cost uses
  the company's immutable budget currency;
- otherwise a typed unavailable-cost reason with no charge.

Known deltas are aggregated per agent per month (UTC calendar month). Finance
events remain an independent business ledger and never contribute to AI spend.

## Setting Budgets

### Company Budget

Set an overall monthly budget for the company:

```
PATCH /api/companies/{companyId}/budgets
{ "budgetMonthlyAmount": "1000" }
```

### Per-Agent Budget

Set individual agent budgets from the agent configuration page or API:

```
PATCH /api/agents/{agentId}/operational-configuration
{ "budgetMonthlyAmount": "50" }
```

## Budget Enforcement

Paperclip enforces budgets automatically:

| Threshold | Action |
|-----------|--------|
| 80% | Soft alert — the board can review the remaining budget |
| 100% | Hard stop — the agent is budget-paused and no new provider attempt starts |

A budget-paused agent resumes only through canonical budget-incident resolution,
for example by increasing the limit above current known spend. Manual agent
resume cannot bypass the hard stop.

## Viewing Costs

### Dashboard

The dashboard shows current month spend vs budget for the company and each agent.

### Cost Breakdown API

```
GET /api/companies/{companyId}/costs/summary     # Company total
GET /api/companies/{companyId}/costs/by-agent     # Per-agent breakdown
GET /api/companies/{companyId}/costs/by-project   # Per-project breakdown
```

## Best Practices

- Set conservative budgets initially and increase as you see results
- Monitor the dashboard regularly for unexpected cost spikes
- Use per-agent budgets to limit exposure from any single agent
- Size budgets from expected workload and provider cost, not an agent's title or org position
