# Reusable application patterns

This directory contains Paperclip-owned, product-neutral compositions built on
the protected shadcn, Kibo, and AI Elements registry sources. Keep a pattern
here only when unrelated features or routes can reuse the same prop-level
behavior without importing Paperclip domain state, API mutations, or route
assumptions.

The retained patterns cover reusable selectors, tables and trees, file and code
views, form/dialog layouts, status presentation, media display, and accessible
interaction helpers. Paperclip-specific orchestration belongs beside its route
consumer, or at the closest common route ancestor when shared, in a
Router-ignored `-` file or directory under `apps/ui/src/routes/`.

The form layouts are adapted from the official Kibo Patterns examples
`field/layouts/field-layouts-6`, `dialog/standard/dialog-standard-6`, and
`dialog/standard/dialog-standard-7` at upstream commit
`3d63cdb15b79d972e3dc38a10997987672f9b263`. Kibo Patterns are source examples,
not a separately installable runtime component; keep this one shared
composition rather than copying an example into each feature.

Registry refreshes should update `components/kibo-ui` first, then verify these
adapters with their focused tests, UI typecheck, and `pnpm check:token-gates`.
