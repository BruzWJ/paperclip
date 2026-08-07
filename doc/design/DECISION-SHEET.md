# Design decision ledger

`DESIGN.md` is the source of truth for the design-system contract. This ledger
keeps only the durable decisions still referenced by current source or tooling.

## A. Shared visual semantics

- **A1 — status badge maps:** use the shared badge color map; do not restore a
  duplicate agent-specific map.
- **A2 — contrast constants:** keep the shared readable-text constants where
  the values are genuinely identical.
- **A3 — project colors:** retain distinct semantic tokens for a new-project
  seed and an unassigned-project fallback.
- **A6 — live conversation marker:** keep its blue token separate from an
  execution-status token even when their current values coincide.

## B. Token policy

- **B1 — intentional one-off decoration:** first-party demo or showcase
  decoration may remain inline only when it is documented in the token-gate
  allowlist with its reason.
- **B2 — Tailwind palette utilities:** treat them as token-debt for a dedicated
  future migration; the current gate does not mechanically rewrite them.
- **B3 — type ladder:** use the named type scale established in the token layer
  rather than introducing one-off text sizes.
- **B5 — status charts:** chart status colors use the canonical status
  vocabulary where the chart represents execution state.

## C. Component policy

- **C8 — status badges:** the accessibility-tuned status badge remains a
  deliberate bespoke component.
- **C11 — agent navigation rows:** use the shared sidebar-row interaction
  behavior for agent entries.

Any new decision must identify the current source surface it affects and must
not revive a removed product route, component, or test fixture.
