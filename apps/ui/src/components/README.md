# Reusable UI

This directory contains only neutral UI that can be reused across unrelated
Paperclip features and routes.

- `ui/`, `ai-elements/`, and `kibo-ui/` are protected registry sources. Update
  them through their upstream registry workflows; do not add Paperclip-specific
  branches to those files.
- Paperclip-owned modules in `patterns/` may compose registry components, but
  they stay independent of feature state, API mutations, and route details.
- Paperclip domain UI belongs beside its route consumer. If multiple route
  branches share it, place it at their closest common ancestor under `../routes/`.
  Non-route files and directories there must have a basename starting with `-`.

Routes may import components. Components must not import routes.
