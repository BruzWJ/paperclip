# Component inventory

The source tree is the authoritative component inventory. This document records
the review rule rather than a point-in-time list, because a static catalogue
quickly becomes misleading when screens and components are removed.

## Review rule

Before adding or consolidating a UI component:

1. Inspect the current `apps/ui/src/components/`, `apps/ui/src/features/`, and
   route-owned `apps/ui/src/routes/**/` trees (`index.tsx` is the screen entry)
   for an existing primitive or equivalent behavior.
2. Reuse the established component when its behavior and accessibility contract
   fit; otherwise keep the new component focused on one clearly distinct
   responsibility.
3. Keep visual values token-backed as required by `DESIGN.md`, and add or
   update a Storybook story for a new visual surface.
4. Record a proposed consolidation only after comparing current props,
   interaction behavior, and rendered output. Do not merge distinct domains on
   name similarity alone.

## Current scope

The board exposes the retained task, agent, project, goal, routine, approval,
plugin, and run surfaces. Removed experimental products are intentionally absent
from the inventory and must not be reintroduced through a component, route, or
storybook story.

## Ownership tiers

- `components/ui`: official shadcn primitives, updated through the shadcn CLI.
- `components/kibo-ui`: official Kibo composed components, updated through the Kibo CLI.
- `components/ai-elements`: official AI Elements components, updated through its registry workflow.
- Other `components` modules: Paperclip-owned, neutral patterns reusable across unrelated features and routes.
- `features`: Paperclip domain UI reused by more than one route branch.
- `routes`: route entry modules and route-only helpers; a non-route helper lives in a file or directory whose basename starts with `-` so the Router plugin ignores it.

Neutral patterns may compose registry components through their public APIs but
must not copy or rename registry implementations. Paperclip-specific adapters
belong in `features`, route-only behavior belongs beside its route consumer,
and a registry source file must not acquire Paperclip-specific branches.
