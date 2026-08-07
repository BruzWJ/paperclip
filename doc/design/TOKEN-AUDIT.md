# Token audit

`DESIGN.md` is the design-system contract. This document records the current
audit procedure rather than a historical list of component paths, since a list
goes stale whenever a UI surface is removed.

## Current checks

Before handing off a UI change, run:

```sh
pnpm check:token-gates
pnpm --filter @paperclipai/ui typecheck
```

The token gate covers component and page render code. Visual values must come
from the token layer, except for entries explicitly allowlisted in
`apps/ui/src/index.css` with their reason.

## Review procedure

1. Inspect the current component and page source rather than relying on a
   static inventory.
2. Add a semantic token when an existing token does not express the required
   value; do not introduce a raw literal or arbitrary utility.
3. For a mechanical, multi-file change, use an idempotent script and verify its
   resulting diff.
4. Record a durable policy decision in `DECISION-SHEET.md` and update
   `DESIGN.md` when it changes the design-system contract.

Removed product surfaces are not audit targets and must not be reintroduced by
an allowlist, token comment, or Storybook fixture.
