# Component inventory

The source tree is the authoritative component inventory. This document records
the review rule rather than a point-in-time list, because a static catalogue
quickly becomes misleading when screens and components are removed.

## Review rule

Before adding or consolidating a UI component:

1. Inspect the current `apps/ui/src/components/` and `apps/ui/src/pages/`
   trees for an existing primitive or equivalent behavior.
2. Reuse the established component when its behavior and accessibility contract
   fit; otherwise keep the new component focused on one clearly distinct
   responsibility.
3. Keep visual values token-backed as required by `DESIGN.md`, and add or
   update a Storybook story for a new visual surface.
4. Record a proposed consolidation only after comparing current props,
   interaction behavior, and rendered output. Do not merge distinct domains on
   name similarity alone.

## Current scope

The board exposes the retained issue, agent, project, goal, routine, approval,
plugin, and run surfaces. Removed experimental products are intentionally absent
from the inventory and must not be reintroduced through a component, route, or
storybook story.
