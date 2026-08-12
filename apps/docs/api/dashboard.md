---
title: Dashboard
summary: Dashboard metrics endpoint
---

Get a health summary for a company in a single call.

## Get Dashboard

```
GET /api/companies/{companyId}/dashboard
```

## Response

Returns a summary including:

- **Agent counts** by lifecycle status (idle, paused, error)
- **Task counts** by lifecycle status
- **Stale tasks** — active tasks with no recent progress
- **Cost summary** — current month spend vs budget
- **Recent activity** — latest mutations

## Use Cases

- Board operators: quick health check from the web UI
- Board members: identify blocked work, budget pressure, and execution failures
