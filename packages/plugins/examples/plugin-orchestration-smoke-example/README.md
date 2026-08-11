# Plugin Task Runtime Smoke Example

This first-party example validates the canonical plugin task control plane.
It is intentionally small and exists as an acceptance fixture rather than a
product plugin.

## What it exercises

- `apiRoutes` under `/api/plugins/:pluginId/api/*`
- restricted database migrations and runtime `ctx.db`
- plugin-owned rows joined to `public.tasks`
- plugin-created ordinary child tasks with a required invokable owner and
  durable callback identity
- canonical task reads, creator messages, reassignment, and withdrawal
- task detail and settings UI slots that surface route, capability, namespace,
  and smoke status

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Install Into Paperclip

Use an absolute local path during development:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Authorization: Bearer <instance-admin-board-key>" \
  -H "Content-Type: application/json" \
  -d '{"source":"local","path":"/absolute/path/to/paperclip/packages/plugins/examples/plugin-orchestration-smoke-example"}'
```

Alternatively, on a Paperclip source checkout, an instance admin can install
this example from **Instance settings → Plugins → Available Plugins**. The
board builds the workspace package before installing its canonical local path.

## Scoped Route Smoke

After the plugin is ready, run the scoped route against an existing task:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/<plugin-installation-id>/api/tasks/<task-id>/smoke \
  -H "Authorization: Bearer <board-key>" \
  -H "Content-Type: application/json" \
  -d '{"ownerAgentId":"<agent-id>"}'
```

The route returns the generated ordinary child task, its owner, current
status, and creator request.
