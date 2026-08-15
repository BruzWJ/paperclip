# Domain UI features

This directory contains Paperclip-specific UI reused across route branches.
Group components, hooks, tests, and supporting models by product domain, and
keep their API and state orchestration with that domain.

Features may compose neutral UI from `../components/`; route modules may compose
features into screens. The actual route-owned screen remains its branch's
`index.tsx` route module. If a helper has only one route consumer, colocate it
with that route in a file or directory whose basename starts with `-` so the
Router plugin ignores it.
