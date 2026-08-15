# Reusable UI

This directory contains only neutral UI that can be reused across unrelated
Paperclip features and routes.

- `ui/`, `ai-elements/`, and `kibo-ui/` are protected registry sources. Update
  them through their upstream registry workflows; do not add Paperclip-specific
  branches to those files.
- Paperclip-owned modules in `patterns/` may compose registry components, but
  they stay independent of feature state, API mutations, and route details.
- Paperclip domain UI shared across route branches belongs in `../features/`.
  Helpers used by only one route belong beside that route in a file or directory
  whose basename starts with `-`.

Features and routes may import components. Components must not import features
or routes.
