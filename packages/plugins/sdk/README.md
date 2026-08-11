# `@paperclipai/plugin-sdk`

Official TypeScript SDK for Paperclip plugin authors.

- **Worker SDK:** `@paperclipai/plugin-sdk` — `definePlugin`, context, lifecycle
- **UI SDK:** `@paperclipai/plugin-sdk/ui` — React hooks and slot props
- **Testing:** `@paperclipai/plugin-sdk/testing` — in-memory host harness
- **Bundlers:** `@paperclipai/plugin-sdk/bundlers` — esbuild presets

Reference: `doc/plugins/PLUGIN_SPEC.md`

## Package surface

| Import | Purpose |
|--------|--------|
| `@paperclipai/plugin-sdk` | Worker entry: `definePlugin`, `runWorker`, `pluginManifestV1Schema`, context and manifest contracts |
| `@paperclipai/plugin-sdk/ui` | UI entry: `usePluginData`, `usePluginAction`, `useHostContext`, `useHostNavigation`, slot prop types |
| `@paperclipai/plugin-sdk/testing` | `createTestHarness` for unit/integration tests |
| `@paperclipai/plugin-sdk/bundlers` | `createPluginBundlerPresets` for worker/manifest/ui builds |

## Manifest entrypoints

In your plugin manifest you declare:

- **`entrypoints.worker`** (required) — Relative package path to the worker bundle (e.g. `dist/worker.js`). The host loads this and calls `setup(ctx)`.
- **`entrypoints.ui`** (required if you use UI) — Path to the UI bundle directory. Its entry module is always `index.js`; `createPluginBundlerPresets` emits that filename for any `uiEntry` source path.

Every slot `exportName` and every overlay launcher target must be a named React
component function exported by that `index.js`. Paperclip validates the whole
declared component set before registering it. One missing or non-component
export rejects that contribution revision; components from an older plugin
revision are never used as a fallback.

## Install

```bash
pnpm add @paperclipai/plugin-sdk
```

## Current deployment caveats

The SDK is stable enough for local development and first-party examples, but the runtime deployment model is still early.

- Plugin workers and plugin UI should both be treated as trusted code today.
- Plugin UI bundles run as same-origin JavaScript inside the main Paperclip app. They can call ordinary Paperclip HTTP APIs with the board session, so manifest capabilities are not a frontend sandbox.
- Local-path installs and the repo example plugins are development workflows. They assume the plugin source checkout exists on disk.
- For deployed plugins, publish an npm package and install that package into the Paperclip instance at runtime.
- The current host runtime expects a writable filesystem, `npm` available at runtime, and network access to the package registry used for plugin installation.
- Dynamic plugin install is currently best suited to single-node persistent deployments. Multi-instance cloud deployments still need a shared artifact/distribution model before runtime installs are reliable across nodes.
- The host ships a small shared React component kit through `@paperclipai/plugin-sdk/ui`. Use it for native Paperclip controls; custom React and CSS are still supported.

If you are authoring a plugin for others to deploy, treat npm-packaged installation as the supported path and treat repo-local example installs as a development convenience.

## Worker quick start

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("health", async () => ({ status: "ok" }));
    ctx.actions.register("ping", async () => ({ pong: true }));

    ctx.tools.register("calculator", async (params) => {
      const { a, b } = params as { a: number; b: number };
      return { content: `Result: ${a + b}`, data: { result: a + b } };
    });
  },
  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

**Note:** `runWorker(plugin, import.meta.url)` must be called so that when the host runs your worker (e.g. `node dist/worker.js`), the RPC host starts and the process stays alive. When the file is imported (e.g. for tests), the main-module check prevents the host from starting.

### Worker lifecycle and context

**Lifecycle (definePlugin):**

| Hook | Purpose |
|------|--------|
| `setup(ctx)` | **Required.** Called once at startup. Register event handlers, jobs, data/actions/tools, etc. |
| `onHealth()` | **Required.** Return `{ status, message?, details? }` for the health dashboard. |
| `onBeforePrompt?(input)` | Optional privileged blocking hook. Complete synchronization for one exact canonical source message and return `null` or `{ prependText }`. Requires `runtime.prompt.observe`. |
| `onShutdown?()` | Optional. Clean up before process exit (limited time window). |
| `onValidateConfig?(config)` | Optional. Return `{ ok, warnings?, errors? }` for explicit draft validation. |
| `onWebhook?(input)` | Present exactly when `manifest.webhooks` declares endpoints. Handle `POST /api/plugins/:pluginId/webhooks/:endpointKey`. |
| `onApiRequest?(input)` | Present exactly when `manifest.apiRoutes` declares routes. Handle scoped plugin JSON API requests. |

**Context (`ctx`) in setup:** `config`, `localFolders`, `events`, `jobs`, `db`, `http`, `runtime`, `activity`, `state`, `entities`, `projects`, `skills`, `routines`, `companies`, `tasks`, `agents`, `goals`, `access`, `authorization`, `data`, `actions`, `tools`, `metrics`, `telemetry`, `logger`, `manifest`. Worker-side host APIs are capability-gated; declare capabilities in the manifest.

`instanceConfigSchema` produces one instance-admin configuration for the
installed plugin. Read it with `await ctx.config.get()`; configuration is not
selected by company. Paperclip stores the administrator-provided configuration
object directly and does not interpret plugin-specific fields.

**Agent work:** create an ordinary task through `ctx.tasks.create` with an
explicit eligible owner and a registered creator callback. Plugins cannot
invoke an agent or open a conversational agent session directly.

**UI actions:** the host passes plugin-defined parameters unchanged. Treat
them as untrusted input and read company authority only from the immutable
`context.actor.companyId` argument supplied to the action handler.

**Jobs:** Declare in `manifest.jobs` with `jobKey`, `displayName`, `schedule` (cron), and register exactly one matching handler with `ctx.jobs.register(jobKey, fn)`. **Webhooks:** `manifest.webhooks` and `onWebhook(input)` must either both be present or both be absent. **State:** `ctx.state.get/set/delete(scopeKey)`; scope kinds: `instance`, `company`, `project`, `agent`, `task`, `goal`, `run`.

**Trusted local folders:** Declare `manifest.localFolders[]` and the `local.folders` capability when a plugin needs an operator-configured company-scoped folder. Use `ctx.localFolders.configure()`, `status()`, `readText()`, and `writeTextAtomic()` instead of resolving arbitrary filesystem paths yourself. The host validates absolute roots, read/write access, required relative folders/files, traversal attempts, symlink escapes, and writes through temp-file-plus-rename atomic replacement.

### Privileged infrastructure plugins

The following contracts are intentionally generic and high-trust. Their
capabilities are visible at install/upgrade time and should be approved only
for administrator-controlled plugins:

- Declare `agent.tools.register` to expose every manifest-declared tool directly
  to all agents while the plugin installation is ready. Installation is
  the administrator grant; no additional catalog projection or per-agent
  selection is involved. The database-backed per-prompt compiler is the sole
  discovery/schema authority; calls still use the prompt-capability gateway,
  immutable installation binding, direct bare-name worker dispatch, and audit
  trail. Register only the handler with `ctx.tools.register(name, handler)`;
  initialization fails unless handler names exactly match `manifest.tools`.
  Providers see `pluginId__toolName`; `__` is reserved and the combined MCP
  name is limited to 128 characters.
- Declare `runtime.context.read` to call `runContext.resolve()` and
  `runContext.taskReach(taskId)` inside a tool handler. The run-context
  handle is opaque, host-minted, short-lived, and accepted only for that exact
  invocation.
- Declare `runtime.records.read` to read canonical provider-safe records with
  `ctx.runtime.records.readRun(...)` and
  `ctx.runtime.records.readTaskComments(...)`, or snapshot-bounded canonical
  Session data with `ctx.runtime.records.readSession(...)`. The Session result
  contains immutable identity plus paginated messages/events; mutable Session
  head metadata is intentionally absent because it cannot truthfully represent
  an older snapshot. Message reads use either creation `afterSeq` or
  model-update `changedAfterSeq`, while every page is capped by the inclusive
  host-minted `snapshotHighWaterSeq`. Requests are fenced to the active
  invocation's company and exact prompt snapshot by the host.
  Paperclip does not fabricate historical versions of a mutable message: if
  its current `modelStateSeq` has advanced beyond an older requested cutoff,
  that row is omitted. Read at each host-minted boundary before advancing a
  `changedAfterSeq` checkpoint.
- Declare `runtime.prompt.observe` and implement `onBeforePrompt(input)` to run
  a blocking synchronization step before every provider message. Return `null`
  or one non-empty `{ prependText }` contribution. After every hook and its
  authority fence succeeds, Paperclip prepends contributions in installation
  order to the outbound request while leaving the canonical Session message
  unchanged. Invalid results or hook failures fail closed before transmission.
- Declare `http.private-network` together with `http.outbound` when the worker
  must call an operator-hosted loopback or private-network service. The host
  retains protocol validation, DNS resolution pinning, timeouts, and response
  limits; the capability changes only the private-address rejection.

These are worker capabilities, not new plugin-owned REST endpoints. A plugin
cannot convert an opaque run-context handle into broader authority or use a
company identifier from one invocation in another.

## Events

Subscribe in `setup` with `ctx.events.on(name, handler)` or `ctx.events.on(name, filter, handler)`. Emit plugin-scoped events with `ctx.events.emit(name, companyId, payload)` (requires `events.emit`).

**Core domain events currently produced (subscribe with `events.subscribe`):**

| Event | Typical entity |
|-------|-----------------|
| `task.board.comment.created` | task_comment |
| `agent.run.finished`, `agent.run.failed`, `agent.run.cancelled` | agent_run |

`task.board.comment.created` is emitted only for a committed named-board-user
comment. Session-projected agent comments do not emit it; terminal run events
are the corresponding post-run warming signal.

**Plugin-to-plugin:** Subscribe to `plugin.<pluginId>.<eventName>` (e.g. `plugin.acme.linear.sync-done`). Emit with `ctx.events.emit("sync-done", companyId, payload)`; the host namespaces it automatically.

**Filter (optional):** Pass a second argument to `on()`: `{ companyId?, agentId? }` so the host only delivers matching events. `agentId` applies to terminal run events.
Pairing `agentId` with `task.board.comment.created` is rejected at
registration; plugin-scoped event patterns may use `agentId` when their payload
defines that field.

Core and plugin-scoped events are in-process, post-commit warming signals. The
producer awaits delivery, isolates and logs handler failures, and does not
persist, replay, or retry an event. Plugins must use canonical host reads (and,
for pre-message synchronization, the blocking `onBeforePrompt` hook) as their
correctness boundary.

**Company context:** Events still carry `companyId` for company-scoped data, but plugin installation and activation are instance-wide in the current runtime. Access and authorization host services require an active company-scoped invocation such as an event, API route, tool run, or UI bridge call; the requested `companyId` must match that active scope.

## Scheduled (recurring) jobs

Plugins can declare **scheduled jobs** that the host runs on a cron schedule. Use this for recurring jobs like syncs, digest reports, or cleanup.

1. **Capability:** Add `jobs.schedule` to `manifest.capabilities`.
2. **Declare jobs** in `manifest.jobs`: each entry has `jobKey`, `displayName`, optional `description`, and `schedule` (a 5-field cron expression).
3. **Register a handler** in `setup()` with `ctx.jobs.register(jobKey, async (job) => { ... })`.

Worker activation requires an exact one-to-one match between declared job keys
and registered handlers. Undeclared, missing, and duplicate handlers are errors.

**Cron format** (5 fields: minute, hour, day-of-month, month, day-of-week):

| Field        | Values   | Example |
|-------------|----------|---------|
| minute      | 0–59     | `0`, `*/15` |
| hour        | 0–23     | `2`, `*` |
| day of month | 1–31   | `1`, `*` |
| month       | 1–12     | `*` |
| day of week | 0–6 (Sun=0) | `*`, `1-5` |

Examples: `"0 * * * *"` = every hour at minute 0; `"*/5 * * * *"` = every 5 minutes; `"0 2 * * *"` = daily at 2:00.

**Job handler context** (`PluginJobContext`):

| Field        | Type     | Description |
|-------------|----------|-------------|
| `jobKey`    | string   | Matches the manifest declaration. |
| `runId`     | string   | UUID for this run. |
| `trigger`   | `"schedule" \| "manual"` | What caused this run. |
| `scheduledAt` | string | ISO 8601 time when the run was scheduled. |

Runs can be triggered by the **schedule** or **manually** through the instance-admin API. Re-throw from the handler to mark the run as failed; the host records the failure. The host does not automatically retry—an instance administrator can trigger a new manual run through that API.

Example:

**Manifest** — include `jobs.schedule` and declare the job:

```ts
// In your manifest (e.g. manifest.ts):
const manifest = {
  // ...
  capabilities: ["jobs.schedule", "plugin.state.write"],
  jobs: [
    {
      jobKey: "heartbeat",
      displayName: "Heartbeat",
      description: "Runs every 5 minutes",
      schedule: "*/5 * * * *",
    },
  ],
  // ...
};
```

**Worker** — register the handler in `setup()`:

```ts
ctx.jobs.register("heartbeat", async (job) => {
  await ctx.logger.info("Heartbeat run", { runId: job.runId, trigger: job.trigger });
  await ctx.state.set({ scopeKind: "instance", stateKey: "last-heartbeat" }, new Date().toISOString());
});
```

## UI slots and launchers

Slots are mount points for plugin React components. Launchers are host-rendered buttons that navigate, invoke an action, or open plugin UI. Declare slots in `manifest.ui.slots` with `type`, `id`, `displayName`, and `exportName`; routed slots also require `routePath`, while entity-scoped slots require `entityTypes`. Declare launchers in `manifest.ui.launchers`.

### Slot types

| Slot type | Scope | Entity types (when context-sensitive) |
|-----------|-------|---------------------------------------|
| `page` | Global | — |
| `sidebar` | Global | — |
| `routeSidebar` | Global | — |
| `sidebarPanel` | Global | — |
| `settingsPage` | Global | — |
| `companySettingsPage` | Global | — |
| `dashboardWidget` | Global | — |
| `globalToolbarButton` | Global | — |
| `detailTab` | Entity | `project`, `task` |
| `taskDetailView` | Entity | `task` |
| `projectSidebarItem` | Entity | `project` |
| `toolbarButton` | Entity | `project`, `task` |

Launcher placement zones are a separate closed set:

| Placement zone | Scope | Entity types |
|----------------|-------|--------------|
| `sidebar` | Global | — |
| `globalToolbarButton` | Global | — |
| `toolbarButton` | Entity | `project`, `task` |

**Scope** describes whether the slot requires an entity to render. **Global** slots render without a specific entity but still receive the active `companyId` through `PluginHostContext` — use it to scope data fetches to the current company. **Entity** slots additionally require `entityId` and `entityType` (e.g. a detail tab on a specific task).

The host rejects `entityTypes` that do not have a production mount for the selected slot or launcher. Import `PLUGIN_UI_SLOT_TYPES`, `PLUGIN_UI_SLOT_ENTITY_TYPES`, and `PLUGIN_LAUNCHER_PLACEMENT_ZONES` from `@paperclipai/plugin-sdk` for the closed vocabularies.

### Slot component descriptions

#### `page`

A full-page extension mounted at `/:companyPrefix/:routePath/*`. The required manifest `routePath` is the page's only route identity; plugin keys and installation UUIDs are not route aliases. Use this for rich, standalone plugin experiences such as dashboards or multi-step workflows. Receives `PluginHostContextProps` with `context.companyId` set to the active company. Requires the `ui.page.register` capability.

#### `sidebar`

Adds a navigation-style entry to the main company sidebar navigation area, rendered alongside the core nav items (Dashboard, Tasks, Goals, etc.). Use this for lightweight, always-visible links or status indicators that feel native to the sidebar. Receives `PluginHostContextProps` with `context.companyId` set to the active company. Requires the `ui.sidebar.register` capability.

#### `routeSidebar`

A contextual sidebar shown while the current route is a plugin page route with the same `routePath`. Use this for full-page plugin workspaces that need their own local navigation. It does **not** replace the app sidebar: the host collapses the main `<Sidebar/>` to its 64px icon rail (still hover/peek-able) and renders your `routeSidebar` in a secondary pane beside it, producing `[ app rail ][ your sidebar ][ content ]`. Receives `PluginHostContextProps` with `context.companyId` and `context.companyPrefix` set to the active company. Requires the `ui.sidebar.register` capability.

Do **not** mount `RequestCollapsedSidebar` (or otherwise try to collapse the app sidebar) from a `routeSidebar` plugin — the host drives the collapse automatically while your route is active and restores the user's preference when they navigate away. The collapse is a hard invariant: a secondary sidebar always forces the app rail collapsed (hiding its expand toggle), overriding any user pin, but it never mutates the user's saved expanded/collapsed preference — that is restored as soon as they leave your route.

#### `sidebarPanel`

Renders richer inline content in a dedicated panel area below the company sidebar navigation sections. Use this for mini-widgets, summary cards, quick-action panels, or at-a-glance status views that need more vertical space than a nav link. Receives `context.companyId` set to the active company via `useHostContext()`. Requires the `ui.sidebar.register` capability.

#### `settingsPage`

Replaces the auto-generated JSON Schema settings form with a custom React component. Use this when the default form is insufficient — for example, when your plugin needs multi-step configuration, OAuth flows, "Test Connection" buttons, or rich input controls. This is an instance settings surface, so it mounts without a company context. The component is responsible for reading and writing config through the bridge (via `usePluginData` and `usePluginAction`).

#### `companySettingsPage`

A company-scoped settings page mounted at `/:companyPrefix/company/settings/:routePath`. The required `routePath` also creates its Company Settings sidebar entry. Receives the active `companyId` and `companyPrefix`. Requires the `instance.settings.register` capability.

#### `dashboardWidget`

A card or section rendered on the main dashboard. Use this for at-a-glance metrics, status indicators, or summary views that surface plugin data alongside core Paperclip information. Receives `PluginHostContextProps` with `context.companyId` set to the active company. Requires the `ui.dashboardWidget.register` capability.

#### `detailTab`

An additional tab on a project or task detail page. Receives `PluginDetailTabProps` with `context.companyId` set to the active company and `context.entityId` / `context.entityType` guaranteed to be non-null. Specify the mounted entity types through `entityTypes`. Requires the `ui.detailTab.register` capability.

#### `taskDetailView`

A specialized slot rendered in the context of a task detail view. Similar to `detailTab` but designed for inline content within the task detail layout rather than a separate tab. Receives `context.companyId`, `context.entityId`, and `context.entityType` like `detailTab`. Requires the `ui.detailTab.register` capability.

#### `projectSidebarItem`

A link or small component rendered **once per project** under that project's row in the sidebar Projects list. Use this to add project-scoped navigation entries (e.g. "Files", "Linear Sync") that deep-link into a plugin detail tab: `/:company/projects/:projectRef?tab=plugin:<key>:<slotId>`. Receives `PluginProjectSidebarItemProps` with `context.companyId` set to the active company, `context.entityId` set to the project id, and `context.entityType` set to `"project"`. Use the optional `order` field in the manifest slot to control sort position. Requires the `ui.sidebar.register` capability.

#### `globalToolbarButton`

A button rendered in the global top bar (breadcrumb bar) that appears on every page. Use this for company-wide actions that are not scoped to a specific entity — for example, a universal search trigger, a global sync status indicator, or a floating action that applies across the whole workspace. Receives only `context.companyId` and `context.companyPrefix`; no entity context is available. Requires the `ui.action.register` capability.

#### `toolbarButton`

A button rendered on project or task detail pages. Use this for short-lived actions scoped to the current entity. Receives `context.companyId`, `context.entityId`, and `context.entityType`; the required `entityTypes` controls which mounted pages receive it. Requires the `ui.action.register` capability.

### Launcher actions and render options

| Launcher action | Description |
|-----------------|-------------|
| `navigate` | Navigate to a route (plugin or host). |
| `openModal` | Open a modal. |
| `openDrawer` | Open a drawer. |
| `openPopover` | Open a popover. |
| `performAction` | Run an action (e.g. call plugin). |
| `deepLink` | Open an absolute HTTP(S) URL in a new tab. |

| Render option | Values | Description |
|---------------|--------|-------------|
| `environment` | `hostOverlay` | The concrete host-owned modal, drawer, or popover container. |
| `bounds` | `inline`, `compact`, `default`, `wide`, `full` | Size hint for the host-owned overlay. |

`openModal`, `openDrawer`, and `openPopover` require `render` metadata and use
the named `action.target` UI export. `navigate`, `deepLink`, and
`performAction` must not declare `render`; only `performAction` accepts
`action.params`. This keeps the manifest limited to behavior the host actually
executes.

### Capabilities

Declare in `manifest.capabilities`. Grouped by scope:

| Scope | Capability |
|-------|------------|
| **Company** | `companies.read` |
| | `projects.read` |
| | `tasks.read` |
| | `agents.read` |
| | `goals.read` |
| | `goals.create` |
| | `goals.update` |
| | `access.members.read` |
| | `access.invites.read` |
| | `authorization.grants.read` |
| | `authorization.policies.read` |
| | `authorization.audit.read` |
| | `database.namespace.read` |
| | `tasks.create` |
| | `tasks.update` |
| | `tasks.withdraw` |
| | `projects.managed` |
| | `routines.managed` |
| | `skills.managed` |
| | `agents.pause` |
| | `agents.resume` |
| | `agents.managed` |
| | `activity.log.write` |
| | `metrics.write` |
| | `telemetry.track` |
| | `database.namespace.migrate` |
| | `database.namespace.write` |
| **Instance** | `instance.settings.register` |
| | `plugin.state.read` |
| | `plugin.state.write` |
| **Runtime** | `events.subscribe` |
| | `events.emit` |
| | `jobs.schedule` |
| | `webhooks.receive` |
| | `api.routes.register` |
| | `http.outbound` |
| | `http.private-network` |
| | `local.folders` |
| | `runtime.context.read` |
| | `runtime.prompt.observe` |
| | `runtime.records.read` |
| **Agent** | `agent.tools.register` |
| | `access.members.write` |
| | `access.invites.write` |
| | `authorization.grants.write` |
| | `authorization.policies.write` |
| **UI** | `ui.sidebar.register` |
| | `ui.page.register` |
| | `ui.detailTab.register` |
| | `ui.dashboardWidget.register` |
| | `ui.action.register` |

Full list in code: import `PLUGIN_CAPABILITIES` from `@paperclipai/plugin-sdk`.

### Restricted Database Namespace

Trusted orchestration plugins can declare a host-owned PostgreSQL namespace:

```ts
database: {
  migrationsDir: "migrations",
  coreReadTables: ["tasks"],
}
```

Declare `database.namespace.migrate` and `database.namespace.read`; add
`database.namespace.write` when the worker needs runtime writes. Migrations run
before worker startup, are checksum-recorded, and may create or alter objects
only inside the plugin namespace. Runtime `ctx.db.query()` allows `SELECT` from
`ctx.db.namespace` plus manifest-whitelisted `public` core tables. Runtime
`ctx.db.execute()` allows `INSERT`, `UPDATE`, and `DELETE` only against the
plugin namespace.

### Trusted Local Folders

Trusted local plugins can request operator-configured folders per company:

```ts
export const manifest = {
  // ...
  capabilities: ["local.folders"],
  localFolders: [
    {
      folderKey: "content-root",
      displayName: "Content root",
      access: "readWrite",
      requiredDirectories: ["sources", "pages"],
      requiredFiles: ["schema.md"],
    },
  ],
};
```

The host stores the selected path in company-scoped plugin settings and exposes
readiness through:

- `GET /api/plugins/:pluginId/companies/:companyId/local-folders`
- `GET /api/plugins/:pluginId/companies/:companyId/local-folders/:folderKey/status`
- `POST /api/plugins/:pluginId/companies/:companyId/local-folders/:folderKey/validate`
- `PUT /api/plugins/:pluginId/companies/:companyId/local-folders/:folderKey`

Worker code should access files through `ctx.localFolders.readText()` and
`ctx.localFolders.writeTextAtomic()`. Relative paths must stay inside the
configured root; symlinks that escape the root are rejected.

### Scoped API Routes

Manifest-declared `apiRoutes` expose JSON routes under
`/api/plugins/:pluginId/api/*` without letting a plugin claim core paths:

```ts
apiRoutes: [
  {
    routeKey: "initialize",
    method: "POST",
    path: "/tasks/:taskId/smoke",
    companyResolution: { from: "task", param: "taskId" },
  },
]
```

`manifest.apiRoutes` and `onApiRequest(input)` must either both be present or
both be absent. The host
performs auth, company access, capability, and route matching before dispatch.
Every route declares `companyResolution`; task resolution names an exact
`:param` in the route path, and GET routes cannot resolve from a request body.
The worker receives route params, query, parsed JSON body,
sanitized headers, actor context, and `companyId`; responses are JSON `{ status?,
headers?, body? }`.

## Task Orchestration APIs

Workflow plugins can use `ctx.tasks` for orchestration-grade task operations without importing host server internals.

Plugin work enters the same canonical task runtime as board work. Register a
versioned creator callback, then create a task with an immutable request and
an explicit invokable agent owner:

```ts
await ctx.tasks.registerCreatorCallback(
  { key: "mission-updates", version: "1" },
  async (delivery) => {
    await persistMissionUpdate(delivery);
    return { deliveryId: delivery.deliveryId, accepted: true };
  },
);

const child = await ctx.tasks.create({
  companyId,
  request: "Implement and verify the approved feature slice.",
  ownerAgentId: workerAgentId,
  callbackKey: "mission-updates",
  callbackVersion: "1",
  parentId: missionTaskId,
  title: "Implement feature slice",
  projectId,
  priority: "high",
});
```

The host records the installed plugin and callback as the immutable creator.
Plugins cannot own tasks or supply mutable origin, lifecycle, blocker,
workspace, or assignee aliases.

Creator updates are message-only or a reassign to another invokable agent:

```ts
await ctx.tasks.update(
  child.id,
  { kind: "message", message: "The acceptance criteria changed; include the new edge case." },
  companyId,
);

await ctx.tasks.update(
  child.id,
  { kind: "reassign", ownerAgentId: replacementAgentId },
  companyId,
);
```

Provider work starts by creating an ordinary task with an immutable request,
an explicit eligible owner, and a registered creator callback. Subsequent
creator messages use the narrow task-update contract; cancellation uses
`ctx.tasks.withdraw`. There is no direct wake operation.

Required capabilities:

| API | Capability |
|-----|------------|
| `ctx.tasks.list` / `get` | `tasks.read` |
| `ctx.tasks.registerCreatorCallback` / `create` | `tasks.create` |
| `ctx.tasks.update` | `tasks.update` |
| `ctx.tasks.withdraw` | `tasks.withdraw` |

Plugin-originated mutations are logged with immutable plugin creator and
operation provenance.

## UI quick start

```tsx
import { usePluginData, usePluginAction } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget() {
  const { data } = usePluginData<{ status: string }>("health");
  const ping = usePluginAction("ping");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <strong>Health</strong>
      <div>{data?.status ?? "unknown"}</div>
      <button onClick={() => void ping()}>Ping</button>
    </div>
  );
}
```

### Hooks reference

#### `usePluginData<T>(key, params?)`

Fetches data from the worker's registered `getData` handler. Re-fetches when `params` changes. Returns `{ data, loading, error, refresh }`.

```tsx
import { usePluginData, type PluginHostContextProps } from "@paperclipai/plugin-sdk/ui";

interface SyncStatus {
  lastSyncAt: string;
  syncedCount: number;
  healthy: boolean;
}

export function SyncStatusWidget({ context }: PluginHostContextProps) {
  const { data, loading, error, refresh } = usePluginData<SyncStatus>("sync-status", {
    companyId: context.companyId,
  });

  if (loading) return <div>Loading…</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <p>Status: {data!.healthy ? "Healthy" : "Unhealthy"}</p>
      <p>Synced {data!.syncedCount} items</p>
      <p>Last sync: {data!.lastSyncAt}</p>
      <button onClick={refresh}>Refresh</button>
    </div>
  );
}
```

#### `usePluginAction(key)`

Returns an async function that calls the worker's `performAction` handler. Throws `PluginBridgeError` on failure.

```tsx
import { useState } from "react";
import { usePluginAction, type PluginBridgeError } from "@paperclipai/plugin-sdk/ui";

export function ResyncButton() {
  const resync = usePluginAction("resync");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      await resync({});
    } catch (err) {
      setError((err as PluginBridgeError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button onClick={handleClick} disabled={busy}>
        {busy ? "Syncing..." : "Resync Now"}
      </button>
      {error && <p style={{ color: "red" }}>{error}</p>}
    </div>
  );
}
```

#### `useHostContext()`

Reads the active company, project, entity, and user context. Use this to scope data fetches and actions.

```tsx
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

export function TaskLinearLink({ context }: PluginDetailTabProps) {
  const { companyId, entityId, entityType } = context;
  const { data } = usePluginData<{ url: string }>("linear-link", {
    companyId,
    taskId: entityId,
  });

  if (!data?.url) return <p>No linked Linear ticket.</p>;
  return <a href={data.url} target="_blank" rel="noopener">View in Linear</a>;
}
```

#### `useHostNavigation()`

Routes Paperclip-internal plugin links through the host router without a full document reload. Use `linkProps()` for anchors so the browser still gets a real `href` for copy-link, modifier-click, middle-click, and open-in-new-tab behavior.

```tsx
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";

export function WikiSidebarLink() {
  const hostNavigation = useHostNavigation();
  return <a {...hostNavigation.linkProps("/wiki")}>Wiki</a>;
}
```

`linkProps("/wiki")` resolves against the active company prefix, so in company `PAP` it renders `href="/PAP/wiki"`. Already-prefixed paths such as `/PAP/wiki` are not prefixed again. For button-style commands, call `hostNavigation.navigate("/tasks/PAP-123")`.

Avoid raw same-origin `href`s or `window.location.assign()` for Paperclip-internal navigation from plugin UI. Those bypass the host router and can reload the whole app. External links should keep normal anchors with `target="_blank"` and `rel="noopener noreferrer"` as appropriate.

### UI authoring note

The host provides selected shared UI components through `@paperclipai/plugin-sdk/ui`.
Plugins can also use normal React components, their own CSS, or small design
primitives inside the plugin package.

Use the shared components when the plugin needs to look and behave like a native
Paperclip surface:

| Component | Use when |
|---|---|
| `MarkdownBlock` | Rendering markdown from plugin or host data |
| `MarkdownEditor` | Editing markdown with the host editor treatment |
| `FileTree` | Showing serializable workspace/wiki/import paths |
| `TasksList` | Embedding a company-scoped native task list |
| `OwnerPicker` | Selecting the required agent owner for ordinary plugin-created tasks |
| `ProjectPicker` | Selecting a project with the same picker as the new task pane |
| `ManagedRoutinesList` | Showing plugin-managed routines in settings UI |

#### Shared Markdown Components

Plugin UI can render markdown and edit markdown using the same host components
used by Paperclip task comments and documents:

```tsx
import { MarkdownBlock, MarkdownEditor } from "@paperclipai/plugin-sdk/ui";

export function WikiPageEditor() {
  const [body, setBody] = useState("# Wiki page");

  return (
    <>
      <MarkdownBlock content={body} />
      <MarkdownEditor value={body} onChange={setBody} bordered />
    </>
  );
}
```

`MarkdownBlock` can opt into Obsidian-style wikilinks when a plugin owns the
target URL shape:

```tsx
<MarkdownBlock
  content={"See [[wiki/entities/paperclip|Paperclip]]."}
  enableWikiLinks
  wikiLinkRoot="/wiki/page"
/>
```

#### Shared FileTree

Plugin UI can render the host file tree without importing host internals:

```tsx
import { FileTree, type FileTreeNode } from "@paperclipai/plugin-sdk/ui";

const nodes: FileTreeNode[] = [
  { name: "AGENTS.md", path: "AGENTS.md", kind: "file", children: [] },
  {
    name: "wiki",
    path: "wiki",
    kind: "dir",
    children: [
      { name: "index.md", path: "wiki/index.md", kind: "file", children: [] },
    ],
  },
];

export function WikiFiles() {
  return (
    <FileTree
      nodes={nodes}
      expandedPaths={["wiki"]}
      selectedFile="wiki/index.md"
      onToggleDir={(path) => console.log("toggle", path)}
      onSelectFile={(path) => console.log("select", path)}
    />
  );
}
```

#### Shared Owner and Project Pickers

Use `OwnerPicker` and `ProjectPicker` when a plugin needs to create or configure
ordinary task work. Both are controlled components and load their options from
the host for the provided company. `OwnerPicker` emits only the canonical agent
owner payload; it does not expose user-assignee compatibility.

```tsx
import { OwnerPicker, ProjectPicker } from "@paperclipai/plugin-sdk/ui";

export function AssignmentControls({ companyId }: { companyId: string }) {
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [projectId, setProjectId] = useState("");

  return (
    <>
      <OwnerPicker
        companyId={companyId}
        value={ownerAgentId}
        onChange={(value, selection) => {
          setOwnerAgentId(value);
          console.log(selection.ownerAgentId);
        }}
      />
      <ProjectPicker
        companyId={companyId}
        value={projectId}
        onChange={setProjectId}
      />
    </>
  );
}
```

### Slot component props

Each slot type receives a typed props object with `context: PluginHostContext`. Import from `@paperclipai/plugin-sdk/ui`.

| Slot type | Props interface | `context` extras |
|-----------|----------------|------------------|
| `page` | `PluginHostContextProps` | — |
| `sidebar` | `PluginHostContextProps` | — |
| `routeSidebar` | `PluginHostContextProps` | — |
| `sidebarPanel` | `PluginHostContextProps` | — |
| `settingsPage` | `PluginHostContextProps` | — |
| `companySettingsPage` | `PluginHostContextProps` | — |
| `dashboardWidget` | `PluginHostContextProps` | — |
| `globalToolbarButton` | `PluginHostContextProps` | — |
| `detailTab` | `PluginDetailTabProps` | `entityId: string`, mounted `entityType` |
| `taskDetailView` | `PluginDetailTabProps` | `entityId: string`, `entityType: "task"` |
| `toolbarButton` | `PluginDetailTabProps` | `entityId: string`, mounted `entityType` |
| `projectSidebarItem` | `PluginProjectSidebarItemProps` | `entityId: string`, `entityType: "project"` |

Example detail tab with entity context:

```tsx
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

export function TaskMetricsTab({ context }: PluginDetailTabProps) {
  const { data, loading } = usePluginData<Record<string, string>>("task-metrics", {
    taskId: context.entityId,
    companyId: context.companyId,
  });

  if (loading) return <div>Loading…</div>;
  if (!data) return <p>No metrics available.</p>;

  return (
    <dl>
      {Object.entries(data).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
```

## Launcher surfaces and modals

V1 does not provide a dedicated `modal` slot. Plugins can either:

- declare concrete UI mount points in `ui.slots`
- declare host-rendered entry points in `ui.launchers`

Supported launcher placement zones are exactly `sidebar`, `globalToolbarButton`, and `toolbarButton`. The first two are company-scoped. `toolbarButton` launchers require `entityTypes` and mount only on project and task detail pages.

Declarative launcher example:

```json
{
  "ui": {
    "launchers": [
      {
        "id": "sync-project",
        "displayName": "Sync",
        "placementZone": "toolbarButton",
        "entityTypes": ["project"],
        "action": {
          "type": "openDrawer",
          "target": "sync-project"
        },
        "render": {
          "environment": "hostOverlay",
          "bounds": "wide"
        }
      }
    ]
  }
}
```

The host returns launcher metadata from `GET /api/plugins/ui-contributions` alongside slot declarations.

When a launcher opens a host-owned overlay, `useHostContext()`,
`usePluginData()`, and `usePluginAction()` receive the current
`hostOverlay` render environment through the bridge, together with the active
launcher id and bounds.

## Project sidebar item

Plugins can add a link under each project in the sidebar via the `projectSidebarItem` slot. This is the recommended slot-based launcher pattern for project-scoped workflows because it can deep-link into a richer plugin tab. The component is rendered once per project with that project’s id in `context.entityId`. Declare the slot and capability in your manifest:

```json
{
  "ui": {
    "slots": [
      {
        "type": "projectSidebarItem",
        "id": "files",
        "displayName": "Files",
        "exportName": "FilesLink",
        "entityTypes": ["project"]
      }
    ]
  },
  "capabilities": ["ui.sidebar.register", "ui.detailTab.register"]
}
```

Minimal React component that links to the project’s plugin tab (see project detail tabs in the spec):

```tsx
import {
  useHostNavigation,
  type PluginProjectSidebarItemProps,
} from "@paperclipai/plugin-sdk/ui";

export function FilesLink({ context }: PluginProjectSidebarItemProps) {
  const hostNavigation = useHostNavigation();
  const projectId = context.entityId;
  const projectRef = projectId; // or resolve from host; entityId is project id
  return (
    <a {...hostNavigation.linkProps(`/projects/${projectRef}?tab=plugin:your-plugin:files`)}>
      Files
    </a>
  );
}
```

Use optional `order` in the slot to sort among other project sidebar items. See §19.5.1 in the plugin spec and project detail plugin tabs (§19.3) for the full flow.

## Toolbar launcher with a local modal

Two toolbar slot types are available depending on where the button should appear:

- **`globalToolbarButton`** — renders in the top bar on every page, scoped to the company. No entity context. Use for workspace-wide actions.
- **`toolbarButton`** — renders on project and task detail pages. Receives `entityId` and `entityType`. Declare `entityTypes` to control which page receives the button.

For short-lived actions, mount the appropriate slot type and open a plugin-owned modal inside the component. Use `useHostContext()` to scope the action to the current company or entity.

Project-scoped example (appears only on project detail pages):

```json
{
  "ui": {
    "slots": [
      {
        "type": "toolbarButton",
        "id": "sync-toolbar-button",
        "displayName": "Sync",
        "exportName": "SyncToolbarButton",
        "entityTypes": ["project"]
      }
    ]
  },
  "capabilities": ["ui.action.register"]
}
```

```tsx
import { useState } from "react";
import {
  useHostContext,
  usePluginAction,
} from "@paperclipai/plugin-sdk/ui";

export function SyncToolbarButton() {
  const context = useHostContext();
  const syncProject = usePluginAction("sync-project");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function confirm() {
    if (!context.projectId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await syncProject({ projectId: context.projectId });
      setOpen(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Sync
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !submitting && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-background p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold">Sync this project?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Queue a sync for <code>{context.projectId}</code>.
            </p>
            {errorMessage ? (
              <p className="mt-2 text-sm text-destructive">{errorMessage}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void confirm()} disabled={submitting}>
                {submitting ? "Running…" : "Run sync"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
```

Prefer deep-linkable tabs and pages for primary workflows. Reserve plugin-owned modals for confirmations, pickers, and compact editors.

## Testing utilities

```ts
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.js";
import manifest from "../src/manifest.js";

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);
await harness.emit(
  "task.board.comment.created",
  { taskId: "task_1", commentId: "comment_1" },
  { entityId: "comment_1", entityType: "task_comment" },
);
```

## Bundler presets

```ts
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
// presets.esbuild.worker / presets.esbuild.manifest / presets.esbuild.ui
```
