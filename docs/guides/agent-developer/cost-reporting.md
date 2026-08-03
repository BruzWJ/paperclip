---
title: Cost Reporting
summary: How Paperclip records execution cost
---

Paperclip records cost from protocol-settled ACP prompts so the system can
track known spending and enforce budgets without provider-specific parsing.

## How It Works

Cost reporting happens automatically at the ACP settlement boundary. A prompt
is billable only after both its terminal stop and valid terminal context
occupancy arrive. Paperclip then records:

- exact terminal context occupancy (`used` and `size`);
- a known cumulative-cost delta only when its currency exactly matches the
  company's immutable `budgetCurrency`;
- otherwise one typed unavailable-cost reason and no fabricated amount.

Known amounts use canonical nonnegative decimal strings. They are never
serialized through JavaScript numbers or converted between currencies.

## Cost events are internal

Clients may read cost events but cannot manufacture them. Independent business
finance entries use the finance-event API and retain their own denomination;
they never enter AI budget aggregation.

## Budget enforcement

Providers do not read agent profiles or budget state. Admission and execution
enforce the snapshotted budget policy before and during a run; a hard stop is a
control-plane decision and cannot be bypassed by provider output.

## Best Practices

- Let the canonical ACP settlement owner record productive and compaction cost.
- Do not duplicate cost from a model-authored comment or tool response.
- Keep independent finance-event writes board-authenticated and attributable.
- Treat cost and context occupancy as audit/accounting fields, never conversation
  continuity or cross-issue memory.
