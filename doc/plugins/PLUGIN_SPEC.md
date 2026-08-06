# Paperclip Plugin System Specification

Status: current plugin-system specification

This document specifies Paperclip's plugin architecture and complements the
implementation map in [doc/SPEC-implementation.md](../SPEC-implementation.md).

## Deployment boundaries

The plugin runtime's deployment model is:

- self-hosted
- single-node or otherwise filesystem-persistent

Current limitations to keep in mind:

- Plugin UI bundles currently run as same-origin JavaScript inside the main Paperclip app. Treat plugin UI as trusted code, not a sandboxed frontend capability boundary.
- Manifest capabilities currently gate worker-side host RPC calls. They do not prevent plugin UI code from calling ordinary Paperclip HTTP APIs directly.
- Runtime installs assume a writable local filesystem for the plugin package directory and plugin data directory.
- Runtime npm installs assume `npm` is available in the running environment and that the host can reach the configured package registry.
- Published npm packages are the intended install artifact for deployed plugins.
- The repo example plugins under `packages/plugins/examples/` are development conveniences. They work from a source checkout and should not be assumed to exist in a generic published build unless they are explicitly shipped with that build.
- Dynamic plugin install is not yet cloud-ready for horizontally scaled or ephemeral deployments. There is no shared artifact store, install coordination, or cross-node distribution layer yet.
- The current runtime ships a small host-provided plugin UI component kit through `@paperclipai/plugin-sdk/ui`.
- Scoped plugin API routes are JSON-only and must be declared in `apiRoutes`.
  They mount under `/api/plugins/:pluginId/api/*`; plugins cannot shadow core
  API routes.

In practice, that means the current implementation is a good fit for local development and self-hosted persistent deployments, but not yet for multi-instance cloud plugin distribution.

## 1. Scope

This spec covers:

- plugin packaging and installation
- runtime model
- trust model
- capability system
- UI extension surfaces
- plugin settings UI
- agent tool contributions
- event, job, and webhook surfaces
- plugin-to-plugin communication
- local tooling approach for workspace plugins
- Postgres persistence for extensions
- uninstall and data lifecycle
- plugin observability
- plugin development and testing
- operator workflows
- hot plugin lifecycle (no server restart)
- SDK and protocol versioning rules

This spec does not cover:

- a public marketplace
- cloud/SaaS multi-tenancy
- unrestricted or cross-namespace third-party schema migrations
- iframe-sandboxed plugin UI (plugins render as ES modules in host extension slots)

## 2. Core Assumptions

Paperclip plugin design is based on the following assumptions:

1. Plugin installation is global to the instance.
2. Company scope remains a runtime authorization boundary, not an install or
   enable boundary.
3. Plugins are administrator-trusted code, but host services still enforce
   the exact invocation company and actor authority.
4. Board governance, approval gates, budget hard-stops, and core issue invariants remain owned by Paperclip core.
5. Projects already have a real workspace model via `project_workspaces`, and local/runtime plugins should build on that instead of inventing a separate workspace abstraction.

## 3. Goals

The plugin system must:

1. Let operators install global instance-wide plugins.
2. Let plugins add major capabilities without editing Paperclip core.
3. Keep core governance and auditing intact.
4. Support both local/runtime plugins and external SaaS connectors.
5. Support plugin categories such as:
   - revenue tracking
   - knowledge base
   - issue tracker sync
   - metrics/dashboards
   - file/project tooling
6. Use simple, explicit, typed contracts.
7. Keep failures isolated so one plugin does not crash the entire instance.

## 4. Non-Goals

Plugins must not:

1. Allow arbitrary plugins to override core routes or core invariants.
2. Allow arbitrary plugins to mutate approval, auth, issue checkout, or budget enforcement logic.
3. Allow plugins to run unrestricted or cross-namespace DB migrations.
4. Depend on project-local plugin folders such as `.paperclip/plugins`.
5. Depend on automatic install-and-execute behavior at server startup from arbitrary config files.

## 5. Terminology

### 5.1 Instance

The single Paperclip deployment an operator installs and controls.

### 5.2 Company

A first-class Paperclip business object inside the instance.

### 5.3 Project Workspace

A workspace attached to a project through `project_workspaces`.
Plugins resolve workspace paths from this model to locate local directories for file, terminal, git, and process operations.

### 5.4 Plugin

An installable instance-wide extension package loaded through the Paperclip plugin runtime.

Examples:

- Linear sync
- GitHub Issues sync
- Grafana widgets
- Stripe revenue sync
- file browser
- terminal
- git workflow

### 5.5 Plugin Worker

The runtime process used for a plugin.
In this spec, third-party plugins run out-of-process by default.

### 5.6 Capability

A named permission the host grants to a plugin.
Plugins may only call host APIs that are covered by granted capabilities.

## 6. Plugin Runtime

Plugins are:

- globally installed per instance
- loaded through the plugin runtime
- additive
- capability-gated
- isolated from core via a stable SDK and host protocol

Plugin categories:

- `connector`
- `workspace`
- `automation`
- `ui`

A plugin may declare more than one category.

## 7. Project Workspaces

Paperclip already has a concrete workspace model:

- projects expose `workspaces`
- projects expose `primaryWorkspace`
- the database contains `project_workspaces`
- project routes already manage workspaces

Plugins that need local tooling (file browsing, git, terminals, process tracking) can resolve workspace paths through the project workspace APIs and then operate on the filesystem, spawn processes, and run git commands directly. The host does not wrap these operations — plugins own their own implementations.

## 8. Installation Model

Plugin installation is global and operator-driven.

There is no per-company install or enable state. A ready installation is active
instance-wide. Company-scoped settings store only plugin feature data such as
trusted local-folder bindings.

If a plugin needs business-object-specific mappings, those are stored as plugin configuration or plugin state.

Examples:

- one global Linear plugin install
- mappings from company A to Linear team X and company B to Linear team Y
- one global git plugin install
- per-project workspace state stored under `project_workspace`

## 8.1 On-Disk Layout

Plugins live under the Paperclip instance directory.

Suggested layout:

- `~/.paperclip/instances/default/plugins/install-<id>/package.json`
- `~/.paperclip/instances/default/plugins/install-<id>/node_modules/`
- `~/.paperclip/instances/default/data/plugins/<plugin-id>/`

Each npm installation has an immutable dependency tree. A candidate is written
to a new install root, validated, and then referenced by the registry; it never
mutates another plugin's active tree. Unreferenced roots are reconciled at
startup. Package install directories and plugin data directories are separate.

This on-disk model is the reason the current implementation expects a persistent writable host filesystem. Cloud-safe artifact replication is future work.

## 8.2 Operator Commands

Paperclip exposes these CLI commands:

- `pnpm paperclipai plugin list`
- `pnpm paperclipai plugin install <npm-package-name> [--version <version>]`
- `pnpm paperclipai plugin install --local <path>`
- `pnpm paperclipai plugin inspect <plugin-installation-id>`
- `pnpm paperclipai plugin enable <plugin-installation-id>`
- `pnpm paperclipai plugin disable <plugin-installation-id>`
- `pnpm paperclipai plugin uninstall <plugin-installation-id>`
- `pnpm paperclipai plugin upgrade <plugin-installation-id> [--version <version>]`

These commands are instance-level operations. Every lifecycle command accepts
only the immutable installation UUID; a manifest plugin key is not a route or
CLI identifier alias.

## 8.3 Install Process

The REST request is one strict discriminated union:

```ts
type PluginInstallRequest =
  | { source: "npm"; packageName: string; version?: string }
  | { source: "local"; path: string };
```

The source is never inferred from path syntax, filesystem contents, or package
name. The install process is:

1. Resolve the exact declared npm package/version or local package path.
2. Install into the instance plugin directory.
3. Read and validate plugin manifest.
4. Reject incompatible plugin API versions.
5. Display requested capabilities to the operator.
6. Persist install record in Postgres.
7. Start plugin worker and run health/validation.
8. Mark plugin `ready` or `error`.

For the current implementation, this install flow should be read as a single-host workflow. A successful install writes packages to the local host, and other app nodes will not automatically receive that plugin unless a future shared distribution mechanism is added.

## 9. Load Order And Precedence

Load order must be deterministic.

1. Paperclip core
2. administrator-installed plugins sorted by:
   - explicit operator-configured order if present
   - otherwise manifest `id`

Rules:

- plugin contributions are additive by default
- plugins may not override core routes or core actions by name collision
- UI slot IDs are automatically namespaced by plugin ID (e.g. `paperclip.linear:sync-health-widget`), so cross-plugin collisions are structurally impossible
- if a single plugin declares duplicate slot IDs within its own manifest, the host must reject at install time

## 10. Package Contract

Each plugin package must export a manifest, a worker entrypoint, and optionally a UI bundle.

Suggested package layout:

- `dist/manifest.js`
- `dist/worker.js`
- `dist/ui/` (optional, contains the plugin's frontend bundle)

Suggested `package.json` keys:

```json
{
  "name": "@paperclip/plugin-linear",
  "version": "0.1.0",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js"
  }
}
```

## 10.1 Manifest Shape

Normative manifest shape:

```ts
export interface PaperclipPluginManifestV1 {
  id: string;
  apiVersion: 1;
  version: string;
  displayName: string;
  description: string;
  author: string;
  categories: Array<"connector" | "workspace" | "automation" | "ui">;
  minimumHostVersion?: string;
  capabilities: string[];
  entrypoints: {
    worker: string;
    ui?: string;
  };
  instanceConfigSchema?: JsonSchema;
  jobs?: PluginJobDeclaration[];
  webhooks?: PluginWebhookDeclaration[];
  tools?: Array<{
    name: string;
    displayName: string;
    description: string;
    parametersSchema: JsonSchema;
  }>;
  database?: PluginDatabaseDeclaration;
  apiRoutes?: PluginApiRouteDeclaration[];
  environmentDrivers?: PluginEnvironmentDriverDeclaration[];
  agents?: PluginManagedAgentDeclaration[];
  projects?: PluginManagedProjectDeclaration[];
  routines?: PluginManagedRoutineDeclaration[];
  skills?: PluginManagedSkillDeclaration[];
  localFolders?: PluginLocalFolderDeclaration[];
  ui?: {
    launchers?: PluginLauncherDeclaration[];
    slots?: Array<{
      type: "page"
        | "detailTab"
        | "issueDetailView"
        | "dashboardWidget"
        | "sidebar"
        | "routeSidebar"
        | "sidebarPanel"
        | "projectSidebarItem"
        | "globalToolbarButton"
        | "toolbarButton"
        | "settingsPage"
        | "companySettingsPage";
      id: string;
      displayName: string;
      /** Which export name in the UI bundle provides this component */
      exportName: string;
      /** Required by entity-scoped slots */
      entityTypes?: Array<"project" | "issue" | "execution_workspace" | "project_workspace">;
      /** Required by page, routeSidebar, and companySettingsPage */
      routePath?: string;
    }>;
  };
}
```

Rules:

- `id` must be globally unique
- `id` should normally equal the npm package name
- `apiVersion` must match the host-supported plugin API version
- `minimumHostVersion` is the only host-version lower bound
- `capabilities` must be static and install-time visible
- config schema must be JSON Schema compatible
- all entrypoints are relative package paths and cannot escape the installed package root
- `entrypoints.ui` points to the directory containing the built `index.js` UI entry module
- `ui.slots` declares which extension slots the plugin fills, so the host knows what to mount without loading the bundle eagerly; each slot references an `exportName` from the UI bundle
- declare managed declarations with the matching `*.managed` capability:
  - `agents` → `agents.managed`
  - `projects` → `projects.managed`
  - `routines` → `routines.managed`
  - `skills` → `skills.managed`

## 11. Agent Tools

Plugins may contribute tools that Paperclip agents can use during runs.

### 11.1 Tool Declaration

Plugins declare tools in their manifest:

```ts
tools?: Array<{
  name: string;
  displayName: string;
  description: string;
  parametersSchema: JsonSchema;
}>;
```

Provider-visible tool names use the reserved MCP-safe form `pluginId__toolName`
(for example `linear__search-issues`). Manifest plugin IDs and tool names cannot
contain `__`, and the combined name cannot exceed 128 characters, so plugins
cannot shadow core tools or each other's tools.

### 11.2 Tool Execution

When an agent invokes a plugin tool during a run, the host routes the call to the plugin worker via an `executeTool` RPC method:

- `executeTool(input)` receives the tool name, parsed parameters, and an opaque
  host-issued run-context handle. A plugin declaring `runtime.context.read` may
  resolve canonical identity for that exact live invocation or ask the host to
  evaluate issue reach; the worker cannot manufacture or reuse the handle.

The worker executes the tool logic and returns a typed result. The host enforces capability gates — a plugin must declare `agent.tools.register` to contribute tools, and individual tools may require additional capabilities (e.g. `http.outbound` for tools that call external APIs).

### 11.3 Tool Availability

Installing a plugin is an administrator trust decision. Every tool declared by
a ready plugin with `agent.tools.register` is available to every agent. Plugin tools are a
direct runtime source; they are not copied into the company-tool catalog and do
not require per-agent selection, profiles, approval rules, or reconciliation.

The database-backed runtime compiler is the sole tool-discovery and schema
authority. It re-reads the exact ready installation, current manifest
declaration, and company-scoped request authority before every list and call. Execution then
routes the compiled bare handler name directly to that installation's live
worker; there is no parallel in-memory plugin-tool registry.
Agents still use ordinary Paperclip list/read tools to discover issue IDs, and
a plugin's capability-gated host reads enforce company and context reach.

Plugin tools appear in the agent's tool list alongside core tools but are visually distinguished in the UI as plugin-contributed.

### 11.4 Constraints

- Plugin tools must not override or shadow core tools by name.
- Plugin tools must be idempotent where possible.
- Tool execution is subject to the same timeout and resource limits as other plugin worker calls.
- Tool results are included in run logs.

## 12. Runtime Model

## 12.1 Process Model

Third-party plugins run out-of-process by default.

Default runtime:

- Paperclip server starts one worker process per installed plugin
- the worker process is a Node process
- host and worker communicate over JSON-RPC on stdio

This design provides:

- failure isolation
- clearer logging boundaries
- easier resource limits
- a cleaner trust boundary than arbitrary in-process execution

## 12.2 Host Responsibilities

The host is responsible for:

- package install
- manifest validation
- capability enforcement
- process supervision
- job scheduling
- webhook routing
- activity log writes
- UI route registration

## 12.3 Worker Responsibilities

The plugin worker is responsible for:

- validating its own config
- handling domain events
- handling scheduled jobs
- handling webhooks
- serving data and handling actions for the plugin's own UI via `getData` and `performAction`
- invoking host services through the SDK
- reporting health information

## 12.4 Failure Policy

If a worker fails:

- mark plugin status `error`
- surface error in plugin health UI
- keep the rest of the instance running
- retry start with bounded backoff
- do not drop other plugins or core services

## 12.5 Graceful Shutdown Policy

When the host needs to stop a plugin worker (for upgrade, uninstall, or instance shutdown):

1. The host begins scheduler unregistration, whose synchronous pre-await phase fences new job admission. The worker manager then synchronously changes the worker to `stopping`, fences every other new host-to-worker call, and sends `shutdown()`.
2. On receipt, the worker synchronously closes host-request intake. It rejects later requests while continuing to accept responses to worker-to-host calls made by handlers that were already accepted.
3. The worker waits for that exact accepted-handler set, runs `onShutdown()` once, responds to `shutdown()`, and exits. The worker adds no independent timeout; the manager owns the one stop deadline.
4. If the worker has not exited within 10 seconds, the host sends SIGTERM. If it remains alive 5 seconds later, the host sends SIGKILL.
5. After the bounded worker stop attempt, the host revokes the activation-scoped worker-to-host binding and awaits the already-started scheduler unregistration. Unregistration waits every already-admitted local execution through its terminal database write, cancels only residual non-terminal runs, and keeps admission fenced until a later successful scheduler registration. The host then disposes the binding.
6. Gracefully drained calls retain their ordinary results. Calls still pending when forced termination occurs fail as unavailable.

Keeping the activation-scoped binding available during the bounded drain lets
already-accepted handlers complete their authorized host calls. Revocation is
synchronous immediately after the stop attempt, including when termination
fails, so a surviving worker cannot call host services during residual
cleanup. Teardown attempts every cleanup step and reports their combined
failure; a later lifecycle request retries the remaining cleanup before the
plugin can become ready again.

## 13. Host-Worker Protocol

The stdio transport accepts only identified requests and their matching
responses; id-less messages are invalid. Blank NDJSON lines are ignored. Any
malformed non-blank host input makes the worker
send one parse-error response and terminate. Any malformed non-blank worker
output makes the host terminate that worker, reject its pending calls, and
apply the ordinary crash-restart policy.

The host must support the following worker RPC methods.

Required methods:

- `initialize(input)`
- `health()`
- `shutdown()`

Optional methods:

- `validateConfig(input)`
- `beforePrompt(input)`
- `onEvent(input)`
- `runJob(input)`
- `handleWebhook(input)`
- `handleApiRequest(input)`
- `getData(input)`
- `performAction(input)`
- `executeTool(input)`
- `issues.creatorCallback.deliver(input)`
- `detectExternalObjects(input)`
- `resolveExternalObject(input)`
- `environmentValidateConfig(input)`
- `environmentProbe(input)`
- `environmentAcquireLease(input)`
- `environmentResumeLease(input)`
- `environmentReleaseLease(input)`
- `environmentDestroyLease(input)`
- `environmentRealizeWorkspace(input)`
- `environmentExecute(input)`
- `environmentCancelExecution(input)`
- `environmentSyncIn(input)`
- `environmentSyncOut(input)`
- `environmentStartInteractiveSetup(input)`
- `environmentGetInteractiveSetup(input)`
- `environmentCaptureTemplate(input)`
- `environmentCancelInteractiveSetup(input)`
- `environmentDeleteTemplate(input)`

### 13.1 `initialize`

Called once on worker startup.

Input includes:

- plugin manifest
- instance info
- host API version
- host-derived database namespace, or `null` when the plugin declares no database

Before reporting ready, the worker validates one concrete runtime contract:

- every `manifest.jobs[].jobKey` has exactly one `ctx.jobs.register` handler,
  with no undeclared handlers;
- `manifest.webhooks` is non-empty exactly when `onWebhook` is implemented;
- `manifest.apiRoutes` is non-empty exactly when `onApiRequest` is implemented;
- every manifest tool has exactly one handler, with no undeclared handlers.

Missing, undeclared, or duplicate registrations reject activation.

### 13.2 `health`

Returns:

- status
- current error if any
- optional plugin-reported diagnostics

### 13.3 `validateConfig`

Runs only when an instance administrator explicitly requests draft validation.
It is advisory and does not own persistence.

Returns:

- `ok`
- warnings
- errors

### 13.4 `beforePrompt`

Runs synchronously for a ready installation that declares
`runtime.prompt.observe`. The host supplies the immutable source-message and
run/Session identity snapshot. The plugin returns either `null` or exactly one
non-empty `{ prependText: string }` contribution. Only after every hook and its
authority fence succeeds, the host prepends contributions in immutable
installation order to the outbound provider request. It never mutates or
replaces the canonical Session source message. A timeout, invalid result,
worker error, or concurrent lifecycle/authority change fails closed before
provider transmission.

### 13.5 `onEvent`

Receives one typed Paperclip domain event.

Delivery semantics:

- the producer calls `onEvent` only after its canonical transaction commits
- delivery is awaited, and handler failures are isolated and logged per plugin
- events are in-process best-effort warming signals; they are not persisted,
  replayed, or retried
- plugins must read canonical host state, rather than treating event delivery as
  a correctness boundary

### 13.6 `runJob`

Runs a declared scheduled job.

Each declared job key must have exactly one handler registered during `setup`.

The host provides:

- job key
- trigger source
- run id
- schedule metadata

### 13.7 `handleWebhook`

Receives inbound webhook payload routed by the host.

Webhook declarations and `onWebhook` must either both be present or both be
absent; there is no ready-without-a-handler fallback.

The host provides:

- endpoint key
- headers
- raw body
- parsed body if applicable
- request id

### 13.8 `getData`

Returns plugin data requested by the plugin's own UI components.

The plugin UI calls the host bridge, which forwards the request to the worker. The worker returns typed JSON that the plugin's own frontend components render.

Input includes:

- data key (plugin-defined, e.g. `"sync-health"`, `"issue-detail"`)
- context (company id, project id, entity id, etc.)
- optional query parameters

### 13.9 `performAction`

Runs an explicit plugin action initiated by the board UI.

The handler receives the plugin-defined parameters unchanged and one immutable
authenticated context. Company authority exists only at
`context.actor.companyId`; parameter fields such as `params.companyId` are
ordinary untrusted plugin input and must not be used for authorization.

Examples:

- "resync now"
- "link GitHub issue"
- "create branch from issue"
- "restart process"

### 13.10 `executeTool`

Runs a plugin-contributed agent tool during a run.

The host provides:

- tool name (without plugin namespace prefix)
- parsed parameters matching the tool's declared schema
- run context: agent ID, run ID, company ID, project ID

The worker executes the tool and returns a typed result (string content, structured data, or error).

## 14. SDK Surface

Plugins do not connect directly to Paperclip's core database. Restricted
plugin-owned SQL goes through the host-provided `ctx.db` client.

The SDK exposed to workers must provide typed host clients.

Required SDK clients:

- `ctx.config`
- `ctx.localFolders`
- `ctx.events`
- `ctx.jobs`
- `ctx.db`
- `ctx.http`
- `ctx.runtime`
- `ctx.activity`
- `ctx.state`
- `ctx.entities`
- `ctx.projects`
- `ctx.executionWorkspaces`
- `ctx.routines`
- `ctx.skills`
- `ctx.companies`
- `ctx.issues`
- `ctx.agents`
- `ctx.goals`
- `ctx.access`
- `ctx.authorization`
- `ctx.data`
- `ctx.actions`
- `ctx.tools`
- `ctx.metrics`
- `ctx.telemetry`
- `ctx.logger`

`ctx.data` and `ctx.actions` register handlers that the plugin's own UI calls through the host bridge. `ctx.data.register(key, handler)` backs `usePluginData(key)` on the frontend. `ctx.actions.register(key, handler)` backs `usePluginAction(key)`.

Plugins that need filesystem, git, terminal, or process operations handle those directly using standard Node APIs or libraries. The host provides project workspace metadata through `ctx.projects` so plugins can resolve workspace paths, but the host does not proxy low-level OS operations.

## 14.1 Issue Orchestration APIs

Trusted orchestration plugins create ordinary Paperclip issues through
`ctx.issues` instead of importing server internals. Creation requires an
immutable non-empty request, explicit invokable agent owner, and registered
versioned creator callback. Optional metadata is limited to title,
parent/project/goal, priority, and the false-only write-once context-access mask.

Plugins that perform durable work should declare managed Paperclip resources rather than using private plugin state:

- `agents` + `ctx.agents.managed.*` for named, invokable operators (`agents.managed` required)
- `projects` + `ctx.projects.managed.*` for stable, scoped issue/workspace ownership (`projects.managed` required)
- `routines` + `ctx.routines.managed.*` for schedule/webhook/manual execution with issue trails (`routines.managed` required)
- `skills` + `ctx.skills.managed.*` for reusable agent capabilities (`skills.managed` required)

Content-oriented plugins should follow this model instead of running
unmanaged background loops: make the LLM-facing worker an operator-visible
managed agent, attach reusable prompt/tool guidance as managed skills, keep
operation issues in a managed project, and drive recurring work through managed
routines.

Provider work starts only through `ctx.issues.create` with an explicit
eligible owner. Creator updates are either an exact message or reassignment to
another invokable agent. Creator cancellation uses `ctx.issues.withdraw`, which
is limited to the plugin's own nonterminal issue and produces no callback or
provider run.

The host records the installed plugin/callback identity as immutable creator
provenance. A plugin cannot supply origin aliases, own an issue, generically
patch lifecycle/request/title/metadata, mutate blocker relationships through
this surface, or invoke an agent directly.

Scoped API routes:

- `apiRoutes[]` declares `routeKey`, `method`, plugin-local `path`, and required
  `companyResolution`.
- The host enforces auth, company access, `api.routes.register`, route matching,
  and company scope before worker dispatch.
- The worker implements `onApiRequest(input)` and returns a JSON response shape
  `{ status?, headers?, body? }`.
- API route declarations and `onApiRequest` must either both be present or both
  be absent.
- Only safe request headers are forwarded; auth/cookie headers are never passed
  to the worker.

## 14.2 SDK Type Contract

`PluginContext`, `PluginDefinition`, and every RPC input/result are exported by
`@paperclipai/plugin-sdk`. The SDK declarations are the sole TypeScript shape;
this specification does not maintain a second handwritten interface.

## 15. Capability Model

Capabilities are mandatory and static.
Every plugin declares them up front.

The host enforces capabilities in the SDK layer and refuses calls outside the granted set.

## 15.1 Capability Categories

### Data Read

- `companies.read`
- `projects.read`
- `project.workspaces.read`
- `execution.workspaces.read`
- `issues.read`
- `agents.read`
- `goals.read`
- `access.members.read`
- `access.invites.read`
- `authorization.grants.read`
- `authorization.policies.read`
- `authorization.audit.read`
- `database.namespace.read`
- `external.objects.read`

### Data Write

- `goals.create`
- `goals.update`
- `issues.create`
- `issues.update`
- `issues.withdraw`
- `projects.managed`
- `routines.managed`
- `skills.managed`
- `agents.pause`
- `agents.resume`
- `agents.managed`
- `access.members.write`
- `access.invites.write`
- `authorization.grants.write`
- `authorization.policies.write`
- `activity.log.write`
- `metrics.write`
- `telemetry.track`
- `database.namespace.migrate`
- `database.namespace.write`
- `external.objects.detect`

### Plugin State

- `plugin.state.read`
- `plugin.state.write`

### Runtime / Integration

- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `webhooks.receive`
- `api.routes.register`
- `http.outbound`
- `http.private-network`
- `environment.drivers.register`
- `local.folders`
- `runtime.context.read`
- `runtime.prompt.observe`
- `runtime.records.read`

### Agent Tools

- `agent.tools.register`

### UI

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register`
- `ui.dashboardWidget.register`
- `ui.action.register`

## 15.2 Forbidden Capabilities

The host must not expose capabilities for:

- approval decisions
- budget override
- auth bypass
- issue checkout lock override
- direct DB access

## 15.3 Upgrade Rules

An upgrade may retain or remove approved capabilities. If its manifest adds a
capability, the host rejects the upgrade before replacing the ready worker.
The administrator may review the broader grant as a new installation; there is
no pending capability-escalation lifecycle state.

## 16. Event System

The host emits a deliberately small set of typed post-commit domain events that
plugins may subscribe to:

- `issue.board.comment.created`
- `agent.run.finished`
- `agent.run.failed`
- `agent.run.cancelled`

`issue.board.comment.created` means exactly a committed comment from the board
comment HTTP command. Session-projected agent comments do not emit it; the
terminal run events are the post-run warming signal for that production path.

Each event must include:

- event id
- event type
- occurred at
- actor metadata when applicable
- primary entity metadata
- typed payload

### 16.1 Event Filtering

Plugins may provide an optional filter when subscribing to events. The filter is evaluated by the host before dispatching to the worker, so filtered-out events never cross the process boundary.

Supported filter fields:

- `companyId` — only receive events for a specific company
- `agentId` — only receive terminal run events for a specific agent

Filters are optional. If omitted, the plugin receives all events of the
subscribed type. The two fields may be combined on terminal run events. The
host rejects `agentId` on `issue.board.comment.created`; plugin-scoped event
patterns may use it when the plugin event payload defines `agentId`.

### 16.2 Plugin-to-Plugin Events

Plugins may emit custom events using `ctx.events.emit(name, payload)`. Plugin-emitted events use a namespaced event type: `plugin.<pluginId>.<eventName>`.

Other plugins may subscribe to these events using the same `ctx.events.on()` API:

```ts
ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
  // react to the git plugin detecting a push
});
```

Rules:

- Plugin events require the `events.emit` capability.
- Plugin events are not core domain events — they do not appear in the core activity log unless the emitting plugin explicitly logs them.
- Plugin events use the same awaited, best-effort in-process delivery as core events. They are not persisted, replayed, or retried.
- The host must not allow plugins to emit events in the core namespace (events without the `plugin.` prefix).

## 17. Scheduled Jobs

Plugins may declare scheduled jobs in their manifest.

Job rules:

1. Each job has a stable `job_key`.
2. Every declared job has exactly one same-key handler registered during `setup`.
3. Undeclared, missing, and duplicate handlers reject worker activation.
4. The host is the scheduler of record.
5. The host prevents overlapping execution of the same plugin/job combination unless explicitly allowed later.
6. Every job run is recorded in Postgres.
7. An operator may trigger a new manual run after a failed run.
8. For recurring business workflows that should create visible Paperclip work, prefer managed routines and managed resources over jobs. Jobs remain useful for private plugin-runtime maintenance jobs.

## 18. Webhooks

Plugins may declare webhook endpoints in their manifest.

Webhook route shape:

- `POST /api/plugins/:pluginId/webhooks/:endpointKey`

Rules:

1. The host owns the public route.
2. Every declared endpoint is handled through the required `onWebhook` hook.
3. Signature verification happens in plugin code using credentials from its instance configuration.
4. Every delivery is recorded.
5. Webhook handling must be idempotent.

## 19. UI Extension Model

Plugins ship their own frontend UI as a bundled React module. The host loads plugin UI into designated extension slots and provides a bridge for the plugin frontend to communicate with its own worker backend and with host APIs.

### How Plugin UI Publishing Works In Practice

A plugin's `dist/ui/` directory contains a built React bundle. The host serves this bundle and loads it into the page when the user navigates to a plugin surface (a plugin page, a detail tab, a dashboard widget, etc.).

**The host provides, the plugin renders:**

1. The host defines **extension slots** — designated mount points in the UI where plugin components can appear (pages, tabs, widgets, sidebar entries, action bars).
2. The plugin's UI bundle exports named components for each slot it wants to fill.
3. The host mounts the plugin component into the slot, passing it a **host bridge** object.
4. The plugin component uses the bridge to fetch data from its own worker (via `getData`), call actions (via `performAction`), read host context (current company, project, entity), and use shared host UI components.

**Concrete example: a Linear plugin ships a dashboard widget.**

The plugin's UI bundle exports:

```tsx
// dist/ui/index.tsx
import {
  usePluginData,
  usePluginAction,
  MetricCard,
  StatusBadge,
  Spinner,
  type PluginHostContextProps,
} from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginHostContextProps) {
  const { data, loading } = usePluginData("sync-health", { companyId: context.companyId });
  const resync = usePluginAction("resync");

  if (loading) return <Spinner />;

  return (
    <div>
      <MetricCard label="Synced Issues" value={data.syncedCount} trend={data.trend} />
      {data.mappings.map(m => (
        <StatusBadge key={m.id} label={m.label} status={m.status} />
      ))}
      <button onClick={() => resync({})}>Resync Now</button>
    </div>
  );
}
```

**What happens at runtime:**

1. User opens the dashboard. The host sees that the Linear plugin registered a `DashboardWidget` export.
2. The host mounts the plugin's `DashboardWidget` component into the dashboard widget slot, passing `context` (current company, user, etc.) and the bridge.
3. `usePluginData("sync-health", ...)` calls through the bridge → host → plugin worker's `getData` RPC → returns JSON → the plugin component renders it however it wants.
4. When the user clicks "Resync Now", `usePluginAction("resync")` calls through the bridge → host → plugin worker's `performAction` RPC.

**What the host controls:**

- The host decides **where** plugin components appear (which slots exist and when they mount).
- The host provides the **bridge** — plugin UI cannot make arbitrary network requests or access host internals directly.
- The host enforces **capability gates** — if a plugin's worker does not have a capability, the bridge rejects the call even if the UI requests it.
- The host provides **shared components** via `@paperclipai/plugin-sdk/ui`; same-origin plugin components also inherit the host CSS custom properties.

**What the plugin controls:**

- The plugin decides **how** to render its data — it owns its React components, layout, interactions, and state management.
- The plugin decides **what data** to fetch and **what actions** to expose.
- The plugin can use any React patterns (hooks, context, third-party component libraries) inside its bundle.

### 19.0.1 Plugin UI SDK (`@paperclipai/plugin-sdk/ui`)

The SDK includes a `ui` subpath export that plugin frontends import. This subpath provides:

- **Bridge hooks**: `usePluginData(key, params)`, `usePluginAction(key)`, `useHostContext()`, `useHostNavigation()`
- **Shared components**: `MetricCard`, `StatusBadge`, `DataTable`, `MarkdownBlock`, `Spinner`, etc.
- **Type definitions**: `PluginHostContextProps`, `PluginDetailTabProps`, `PluginProjectSidebarItemProps`

Plugins are encouraged but not required to use the shared components. A plugin may render entirely custom UI as long as it communicates through the bridge.

`useHostNavigation()` is the supported way for plugin UI to navigate to
Paperclip-internal pages. It exposes `resolveHref(to)`, `navigate(to,
options?)`, and `linkProps(to, options?)`. Plugin links should prefer
`linkProps()` so anchors keep real `href` values for copy-link, modifier-click,
middle-click, and open-in-new-tab behavior while plain left-clicks route through
the host SPA router. The host resolves company-scoped paths against the active
company prefix without double-prefixing already-prefixed paths. Plugin UI should
not use raw same-origin `href`s or `window.location.assign()` for internal
Paperclip navigation because those can force a full document reload.

### 19.0.2 Bundle Isolation

Plugin UI bundles are loaded as standard ES modules, not iframed. This gives plugins full rendering performance and access to the host's CSS custom properties.

Isolation rules:

- Plugin bundles must not import from host internals. They may only import from `@paperclipai/plugin-sdk/ui` and their own dependencies.
- Plugin bundles must not access `window.fetch` or `XMLHttpRequest` directly for host API calls. All host communication goes through the bridge.
- The host may enforce Content Security Policy rules that restrict plugin network access to the bridge endpoint only.
- Plugin bundles must be statically analyzable — no dynamic `import()` of URLs outside the plugin's own bundle.

### 19.0.3 Bundle Serving

Plugin UI bundles must be pre-built ESM. The host does not compile or transform plugin UI code at runtime.

The host serves the plugin's `dist/ui/` directory as static assets under a namespaced path:

- `/_plugins/:pluginId/ui/*`

`pluginId` is the immutable installation UUID. Plugin keys are not accepted as
route aliases. The host resolves assets only from that installation's persisted
absolute package path and declared `entrypoints.ui` directory.

When the host renders an extension slot, it dynamically imports the plugin's UI
entry module from this path. Component registration is keyed by the exact
`pluginId + installation updatedAt + exportName` tuple. Before registering any
component, the host verifies that every declared slot export and every overlay
launcher target exists and is a React component function. A missing or invalid
export rejects that complete contribution revision; the host never mounts a
partial module or resolves a component registered by an older revision.

Local development uses the same built bundle contract: rebuild `dist/ui/` and
reload the mounted plugin UI. Plugin configuration never changes the asset
origin or package root used by this route.

## 19.1 Instance-Admin Routes

- `/:companyPrefix/company/settings/instance/plugins`
- `/:companyPrefix/company/settings/instance/plugins/:pluginId`

These routes are instance-admin surfaces. The company prefix supplies normal
board routing context; plugin installation and configuration remain
instance-wide.

## 19.2 Company-Context Routes

- `/:companyPrefix/:routePath/*`

Each `page` slot must claim one non-reserved `routePath`. The route is keyed
only by that manifest declaration; installation UUIDs and plugin keys are not
accepted as page-route aliases. A route path may be claimed by only one live
plugin installation.

### 19.2.1 Closed Host Mount Matrix

Every declared slot has one concrete production mount. Entity-scoped
declarations are accepted only for the entity kinds listed here.

| Slot | Host mount | Entity types | Capability |
| --- | --- | --- | --- |
| `page` | Company plugin route | — | `ui.page.register` |
| `routeSidebar` | Secondary sidebar for its paired `page` | — | `ui.sidebar.register` |
| `detailTab` | Project, issue, execution-workspace, and project-workspace detail tabs | `project`, `issue`, `execution_workspace`, `project_workspace` | `ui.detailTab.register` |
| `issueDetailView` | Inline issue detail region | `issue` | `ui.detailTab.register` |
| `dashboardWidget` | Company dashboard | — | `ui.dashboardWidget.register` |
| `sidebar` | Main company sidebar navigation | — | `ui.sidebar.register` |
| `sidebarPanel` | Main company sidebar panel region | — | `ui.sidebar.register` |
| `projectSidebarItem` | Each project row in the sidebar | `project` | `ui.sidebar.register` |
| `globalToolbarButton` | Global breadcrumb toolbar | — | `ui.action.register` |
| `toolbarButton` | Project, issue, and execution-workspace action rows | `project`, `issue`, `execution_workspace` | `ui.action.register` |
| `settingsPage` | Instance plugin settings detail | — | `instance.settings.register` |
| `companySettingsPage` | Company Settings route and sidebar | — | `instance.settings.register` |

Launcher placements are a separate closed vocabulary:

| Placement | Host mount | Entity types | Capability |
| --- | --- | --- | --- |
| `sidebar` | Main company sidebar navigation | — | `ui.sidebar.register` |
| `globalToolbarButton` | Global breadcrumb toolbar | — | `ui.action.register` |
| `toolbarButton` | Project and issue action rows | `project`, `issue` | `ui.action.register` |

Launcher actions are also a closed contract. `navigate` resolves a Paperclip
route, `deepLink` opens an absolute HTTP(S) URL in a new tab, and
`performAction` invokes a plugin worker action. Only `performAction` accepts
`action.params`. Component-rendering actions are exactly `openModal`,
`openDrawer`, and `openPopover`; each requires `render.environment` to be
`hostOverlay` and targets a named export from the plugin UI bundle. Non-overlay
actions cannot declare `render` metadata. The supported overlay bounds are
`inline`, `compact`, `default`, `wide`, and `full`.

`page`, `routeSidebar`, and `companySettingsPage` require a single-segment
`routePath`. A `routeSidebar` is valid only when it is the sole sidebar paired
with exactly one `page` in the same manifest using the same `routePath`.

## 19.3 Detail Tabs

Plugins may add tabs to:

- project detail
- issue detail
- execution-workspace detail
- project-workspace detail

Recommended route pattern:

- `/:companyPrefix/<entity>/:id?tab=<plugin-tab-id>`

## 19.4 Dashboard Widgets

Plugins may add cards or sections to the dashboard.

## 19.5 Sidebar Entries

Plugins may add sidebar links to:

- global plugin settings
- company-context plugin pages

### 19.5.1 Route Sidebars (`routeSidebar`)

A `routeSidebar` slot supplies a contextual sidebar for a plugin page route
(matched by `routePath`). It **coexists** with the main app sidebar rather than
replacing it: while the route is active the host collapses the app `<Sidebar/>`
to its 64px icon rail (still hover/peek-able) and renders the plugin's
`routeSidebar` in a secondary pane, producing the layout
`[ app rail ][ route sidebar ][ content ]`. The same model applies to the
host's own company-settings sidebar.

The host owns the collapse. Plugins must not mount `RequestCollapsedSidebar` or
otherwise attempt to collapse the app sidebar from a `routeSidebar` — the host
applies the collapse while the route is mounted and restores the previous state
on navigation away. The collapse is a **hard invariant**: while a secondary
sidebar is shown the app rail is forced collapsed and its expand/toggle
affordance is hidden, *overriding* any user pin. Crucially, this force is
ephemeral — it never mutates the user's persisted expanded/collapsed preference,
so navigating back to a normal route restores exactly what the user chose.
Precedence is therefore: secondary-sidebar force > explicit user pin >
route-requested collapse (`RequestCollapsedSidebar`) > default expanded.

## 19.6 Shared Components In `@paperclipai/plugin-sdk/ui`

The host SDK ships shared components that plugins can import to quickly build UIs that match the host's look and feel. These are convenience building blocks, not a requirement.

| Component | What it renders | Typical use |
|---|---|---|
| `MetricCard` | Single number with label, optional trend/sparkline | KPIs, counts, rates |
| `StatusBadge` | Inline status indicator (ok/warning/error/info) | Sync health, connection status |
| `DataTable` | Rows and columns with optional sorting and pagination | Issue lists, job history, process lists |
| `MarkdownBlock` | Rendered markdown text | Descriptions, help text, notes |
| `KeyValueList` | Label/value pairs in a definition-list layout | Entity metadata, config summary |
| `JsonTree` | Collapsible JSON tree for debugging | Raw API responses, plugin state inspection |
| `Spinner` | Loading indicator | Data fetch states |
| `FileTree` | Host-styled file/directory tree | Wiki pages, workspace files, import previews |
| `IssuesList` | Host issue list | Plugin pages that need a native issue view |
| `OwnerPicker` | Agent-only canonical issue-owner picker | Creating and reassigning ordinary plugin issues |
| `ProjectPicker` | Host project picker | Creating issues, scoping dashboards, filtering work |
| `ManagedRoutinesList` | Host routine list | Plugin settings pages that manage routines |

Plugins may also use entirely custom components. The shared components exist to reduce boilerplate and keep visual consistency, not to limit what plugins can render.

## 19.7 Error Propagation Through The Bridge

The bridge hooks must return structured errors so plugin UI can handle failures gracefully.

`usePluginData` returns:

```ts
{
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
}
```

`usePluginAction` returns an async function that either resolves with the result or throws a `PluginBridgeError`.

`PluginBridgeError` shape:

```ts
interface PluginBridgeError {
  code: "WORKER_UNAVAILABLE" | "CAPABILITY_DENIED" | "WORKER_ERROR" | "TIMEOUT" | "UNKNOWN";
  message: string;
  /** Original error details from the worker, if available */
  details?: unknown;
}
```

Error codes:

- `WORKER_UNAVAILABLE` — the plugin worker is not running (crashed, shutting down, not yet started)
- `CAPABILITY_DENIED` — the plugin does not have the required capability for this operation
- `WORKER_ERROR` — the worker returned an error from its `getData` or `performAction` handler
- `TIMEOUT` — the worker did not respond within the configured timeout
- `UNKNOWN` — unexpected bridge-level failure

The `@paperclipai/plugin-sdk/ui` subpath should also export an `ErrorBoundary` component that plugin authors can use to catch rendering errors without crashing the host page.

## 19.8 Plugin Settings UI

Each plugin that declares an `instanceConfigSchema` in its manifest gets one auto-generated instance settings form at `/:companyPrefix/company/settings/instance/plugins/:pluginId`. Only an instance administrator can read, test, or update it; no selected company is involved.

The auto-generated form supports:

- text inputs, number inputs, toggles, select dropdowns derived from schema types and enums
- nested objects rendered as fieldsets
- arrays rendered as repeatable field groups with add/remove controls
- validation messages derived from schema constraints (`required`, `minLength`, `pattern`, `minimum`, etc.)
- a "Test Configuration" action if the plugin declares a `validateConfig` RPC method — the host calls it and displays the result inline

The plugin hook is an explicit advisory draft check and cannot block an
administrator from repairing stored configuration. Persisted configuration is
checked again before a worker is activated.

For plugins that need richer settings UX beyond what JSON Schema can express, the plugin may declare a `settingsPage` slot in `ui.slots`. When present, the host renders the plugin's own React component instead of the auto-generated form. The plugin component communicates with its worker through the standard bridge to read and write config.

For plugins that need a company-scoped settings surface, declare a `companySettingsPage` slot with a `routePath`. The host renders a sidebar item under Company Settings and mounts the component at `/:companyPrefix/company/settings/:routePath`. The page receives `companyId` and `companyPrefix` in its host context. The exact host-owned settings segments `cloud-upstream`, `members`, `invites`, `secrets`, and `instance` are reserved and cannot be shadowed by plugin declarations.

## 20. Local Tooling

Plugins that need filesystem, git, terminal, or process operations implement those directly. The host does not wrap or proxy these operations.

The host provides workspace metadata through `ctx.projects` (list workspaces, get primary workspace, resolve workspace from issue or agent/run). Plugins use this metadata to resolve local paths and then operate on the filesystem, spawn processes, shell out to `git`, or open PTY sessions using standard Node APIs or any libraries they choose.

This keeps the host lean — it does not need to maintain a parallel API surface for every OS-level operation a plugin might need. Plugins own their own logic for file browsing, git workflows, terminal sessions, and process management.

## 21. Persistence And Postgres

## 21.1 Database Principles

1. Core Paperclip data stays in first-party tables.
2. Most plugin-owned data starts in generic extension tables.
3. Plugin data should scope to existing Paperclip objects before new tables are introduced.
4. Plugin migrations are restricted to the installation-owned namespace and
   explicitly declared read-only core tables.

## 21.2 Core Table Reuse

If data becomes part of the actual Paperclip product model, it should become a first-party table.

Examples:

- `project_workspaces` is already first-party
- if Paperclip later decides git state is core product data, it should become a first-party table too

## 21.3 Required Tables

### `plugins`

- `id` uuid pk
- `plugin_key` text unique not null
- `package_name` text not null
- `source` enum: `npm | local`
- `manifest_json` jsonb not null — sole authority for version, API version,
  categories, capabilities, and declarations
- `status` enum: `ready | disabled | error`
- `install_order` int not null
- `package_path` text not null
- `installed_at` timestamptz not null
- `updated_at` timestamptz not null
- `last_error` text null

Constraints and indexes:

- unique `plugin_key`
- unique `install_order`
- `status`

### `plugin_config`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `config_json` jsonb not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Constraints:

- unique `plugin_id`

### `plugin_state`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `scope_kind` enum: `instance | company | project | project_workspace | agent | issue | goal | run`
- `scope_id` uuid/text null
- `namespace` text not null
- `state_key` text not null
- `value_json` jsonb not null
- `updated_at` timestamptz not null

Constraints:

- unique `(plugin_id, scope_kind, scope_id, namespace, state_key)`

Examples:

- Linear external IDs keyed by `issue`
- GitHub sync cursors keyed by `project`
- file browser preferences keyed by `project_workspace`
- git branch metadata keyed by `project_workspace`
- process metadata keyed by `project_workspace` or `run`

### `plugin_jobs`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `job_key` text not null
- `schedule` five-field cron text not null
- `status` enum: `active | removed`
- `next_run_at` timestamptz null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Constraints:

- unique `(plugin_id, job_key)`

### `plugin_job_runs`

- `id` uuid pk
- `job_id` uuid fk `plugin_jobs.id` not null
- `plugin_id` uuid fk `plugins.id` not null
- `trigger` enum: `schedule | manual`
- `status` enum: `queued | running | succeeded | failed | cancelled`
- `duration_ms` int null
- `error` text null
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `created_at` timestamptz not null

Indexes:

- `plugin_id`
- `job_id`
- `status`

### `plugin_webhook_deliveries`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `webhook_key` text not null
- `status` enum: `pending | success | failed`
- `duration_ms` int null
- `error` text null
- `finished_at` timestamptz null
- `created_at` timestamptz not null

Request bodies and headers are delivered to the worker but never persisted.

Indexes:

- `plugin_id`
- `webhook_key`
- `status`

### `plugin_entities`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `company_id` uuid fk `companies.id` null for instance scope
- `entity_type` text not null
- `scope_kind` enum not null
- `scope_id` uuid/text null
- `external_id` text null
- `title` text null
- `status` text null
- `data` jsonb not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Constraints and indexes:

- unique nulls-not-distinct identity `(company_id, plugin_id, entity_type, scope_kind, scope_id, external_id)`
- `plugin_id`, `company_id`, `entity_type`, and `(scope_kind, scope_id)`

Use cases:

- imported Linear issues
- imported GitHub issues
- plugin-owned process records
- plugin-owned external metric bindings

## 21.4 Activity Log Changes

The activity log includes `plugin` in `actor_type`.

New actor enum:

- `agent`
- `user`
- `system`
- `plugin`

Plugin-originated mutations should write:

- `actor_type = plugin`
- `actor_id = <plugin-id>`
- details include `sourcePluginId` and `sourcePluginKey`
- details include `initiatingActorType`, `initiatingActorId`, and `initiatingRunId` when a user or agent run triggered the plugin work

## 21.5 Plugin Migrations

A manifest may declare `database.migrationsDir`. Before worker activation, the
host creates the installation-owned namespace and applies ordered `.sql` files
once, recording each file digest in `plugin_migrations`. Migration SQL is
validated before execution: it may define or backfill objects only inside that
namespace, may read only the explicitly declared core tables, and may not use
destructive statements, privileged features, or cross-namespace writes.

## 22. Secrets

Paperclip treats instance plugin configuration as opaque administrator-provided
JSON. Core does not interpret plugin-specific credential fields. Plugin code
must not write credentials to activity logs, webhook delivery rows, or error
messages.

## 23. Auditing

All plugin-originated mutating actions must be auditable.

Minimum requirements:

- activity log entry for every mutation
- job run history
- webhook delivery history
- plugin health page
- install/upgrade activity log entries

## 24. Operator UX

## 24.1 Global Settings

Global plugin settings page must show:

- installed plugins
- versions
- status
- requested capabilities
- current errors
- install/upgrade/remove actions

## 24.2 Plugin Settings Page

Each plugin may expose:

- config form derived from `instanceConfigSchema`
- health details
- recent job history
- recent webhook history
- capability list

Route:

- `/:companyPrefix/company/settings/instance/plugins/:pluginId`

## 24.3 Company-Context Plugin Page

Each plugin may expose a company-context main page:

- `/:companyPrefix/:routePath/*`

The `routePath` is required on the plugin's `page` slot and is the sole route
identity for that page.

## 24.4 Company Settings Plugin Page

Each ready plugin may expose a company settings page:

- `/:companyPrefix/company/settings/:routePath`

The host adds a matching Company Settings sidebar item using the slot `displayName`. Plugin settings route segments are single-segment slugs and must not collide with core company settings pages.

## 25. Uninstall And Data Lifecycle

When a plugin is uninstalled, the host must handle plugin-owned data explicitly.

### 25.1 Uninstall Process

1. In one locked database transaction, the host pauses active managed-agent bindings into board triage, terminalizes creator edges and deliveries with their escalation effects, and marks the installation `disabled`. This removes ready authority before fallible cleanup begins.
2. The host starts the scheduler admission fence, follows the graceful worker shutdown policy, revokes the activation-scoped host binding, awaits scheduler unregistration through terminal job writes and residual cancellation, and disposes that exact binding.
3. The host removes the installation's host-managed package tree. Operator-owned local source directories are never removed.
4. Only after teardown and package cleanup succeed does one locked transaction drop the installation-scoped custom database namespace, revoke ephemeral run-context handles, and delete the installation. Foreign-key cascades delete all installation-owned configuration, settings, state, jobs/runs, webhooks, migrations, logs, entities, and managed-resource bindings.
5. If teardown or package cleanup fails, the live `disabled` row remains. Repeating disable or uninstall retries cleanup without repeating the managed-agent and creator-edge transition.
6. Suspension cancellation intents and escalation execution refs are durable transaction outputs. Failed immediate reconciliation or dispatch notification is recovered by the instance's persisted-execution recovery loop; repeating the plugin lifecycle transition does not recreate those outputs.
7. Canonical comments, deliveries, withdrawals, run calls, and tool-selection audit rows retain immutable plugin actor/call UUIDs as values without a live installation foreign key. Optional live provenance links on external-object and secret-access records are cleared. The installation row itself is not retained.
8. Reinstalling the same plugin key creates a new installation row, id, operational state, and runtime namespace.

### 25.2 Upgrade Data Considerations

Generic `plugin_state.value_json` is not transformed automatically. If its shape changes between versions:

- The plugin worker is responsible for migrating its own state on first access after upgrade.
- Declared database migrations run before the upgraded worker starts; they do
  not rewrite generic plugin-state values.
- Plugins should version their state keys or use a schema version field inside `value_json` to detect and handle format changes.

### 25.3 Upgrade Lifecycle

When upgrading a plugin:

1. The host fetches an isolated candidate package and validates its manifest against the installation's approved capabilities. Any added capability rejects the candidate while the current runtime remains ready.
2. The host starts the scheduler admission fence, fences other new calls, sends `shutdown()` to the old worker, and drains its accepted work under Section 12.5. It then revokes the old activation's host binding and awaits scheduler unregistration through terminal job writes; only residual non-terminal runs are marked `cancelled`.
3. Only after complete teardown succeeds does the host atomically commit the candidate manifest and immutable package path as the canonical installation.
4. The host applies declared migrations and activates a fresh host binding, worker, and job registrations from the committed manifest.
5. The old unreferenced managed package tree is removed after commit. Failure to remove it does not roll back the new installation; startup reconciliation removes unreferenced managed trees.
6. A teardown or pre-commit persistence failure marks the installation `error` and discards the candidate. An activation failure leaves the committed installation in `error`. No failure path leaves a `ready` row paired with a known-stale runtime or a different manifest than that runtime loaded.

### 25.4 Hot Plugin Lifecycle

Plugin install, uninstall, upgrade, and config changes **must** take effect without restarting the Paperclip server. This is a normative requirement, not optional.

The architecture already supports this — plugins run as out-of-process workers with dynamic ESM imports, IPC bridges, and host-managed routing tables. This section makes the requirement explicit so implementations do not regress.

#### 25.4.1 Hot Install

When a plugin is installed at runtime:

1. The host resolves and validates the manifest without stopping existing services.
2. The host spawns a new worker process for the plugin.
3. The host registers the plugin's event subscriptions and job schedules. Webhooks and agent-tool declarations remain in the canonical installation manifest; dynamic request handling and the per-prompt run-tools compiler read that persisted authority directly.
4. The host loads the plugin's UI bundle path into the extension slot registry so the frontend can discover it on the next navigation or via a live notification.
5. The plugin enters `ready` status.

No other plugin or host service is interrupted.

#### 25.4.2 Hot Uninstall

When a plugin is uninstalled at runtime:

1. The host commits the `disabled` authority fence and its managed-agent/creator-delivery invariants (Section 25.1).
2. The host fences scheduler admission and other new runtime intake, drains accepted work, and then revokes the activation-scoped binding under the graceful shutdown policy (Section 12.5). Dynamic DB-backed webhooks, tools, and UI discovery stop resolving the installation as soon as it is non-ready.
3. The host removes its managed package tree, drops its custom database namespace, and deletes the installation with all installation-owned operational rows.
4. A failed teardown remains retryable from the `disabled` row; it never restores ready authority implicitly.

No server restart is needed.

#### 25.4.3 Hot Upgrade

When a plugin is upgraded at runtime:

1. The host follows the upgrade lifecycle (Section 25.3) — shut down old worker, start new worker.
2. Event subscriptions and job schedules are refreshed for the new worker. Webhooks and agent tools change with the committed installation manifest and need no in-memory registration swap.
3. If the new version ships an updated UI bundle, its installation timestamp changes the canonical entry-module cache key. The next contribution fetch imports the new bundle.
4. If the manifest `apiVersion` is unchanged and no new capabilities are added, the upgrade completes without operator interaction.

#### 25.4.4 Hot Config Change

When an instance administrator updates an installed plugin's config at runtime:

1. The host validates the draft against `instanceConfigSchema`.
2. For a ready plugin, the host fences new calls and completely drains its current runtime under Section 12.5 before changing `plugin_config`.
3. The host writes one installation-wide row to `plugin_config`, then activates a fresh runtime; `setup` reads that one coherent value through `ctx.config.get()`.
4. A teardown or persistence failure marks the formerly ready installation `error`; the old runtime cannot continue using host services. An activation failure also leaves the installation `error` for explicit recovery.
5. For a disabled or errored plugin, the host writes the validated config without activating it. Enabling later retries any stale teardown before changing the installation to `ready`.

#### 25.4.5 Frontend Cache Invalidation

The host imports the one canonical entry module at
`/_plugins/:pluginId/ui/index.js?v=<installation-updated-at>`. Content-hashed
chunks may use immutable caching; the entry module is always revalidated. The
same installation update timestamp is part of every registered component's
identity, so an upgraded contribution cannot fall back to an earlier module.

#### 25.4.6 Worker Process Management

The host's plugin process manager must support:

- starting a worker for a newly installed plugin without affecting other workers
- stopping a worker during uninstall without affecting other workers
- replacing a worker during upgrade (stop old, start new) atomically from the routing table's perspective
- restarting a worker after crash without operator intervention (with backoff)

Each worker process is independent. There is no shared process pool or batch restart mechanism.

## 26. Plugin Observability

### 26.1 Logging

Plugin workers use `await ctx.logger.*(...)` to emit structured logs. Each log is
an acknowledged worker-to-host request; acknowledgement means the host logging
service accepted it for persistence.

Log storage rules:

- Plugin logs are stored only in the `plugin_logs` table.
- Each log entry includes: plugin ID, timestamp, one canonical level (`debug`, `info`, `warn`, `error`, or `metric`), message, and optional structured metadata.
- `ctx.metrics.write` uses the same table with level `metric`.
- Logs are queryable from the plugin settings page in the UI.
- Worker stdout is reserved for the host protocol. Worker stderr is forwarded to the host logger and retained only as bounded worker-failure context; it is not an alternate plugin-log API.

### 26.2 Health Dashboard

The plugin settings page must show:

- current worker status (running, error, stopped)
- uptime since last restart
- recent log entries
- job run history with success/failure rates
- webhook delivery history with success/failure rates
- last health check result and diagnostics
- resource usage if available (memory, CPU)

## 27. Plugin Development And Testing

### 27.1 SDK Test Harness

`@paperclipai/plugin-sdk/testing` exports the test harness plugin authors use
for local development and testing.

The test harness provides:

- a mock host that implements the full SDK interface (`ctx.config`, `ctx.events`, `ctx.state`, etc.)
- ability to send synthetic events and verify handler responses
- ability to trigger job runs and verify side effects
- ability to simulate `getData` and `performAction` calls as if coming from the UI bridge
- ability to simulate `executeTool` calls as if coming from an agent run
- in-memory state and entity stores for assertions
- configurable capability sets for testing capability denial paths

Example usage:

```ts
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);

// Simulate an event
await harness.emit("issue.board.comment.created", {
  issueId: "iss-1",
  commentId: "comment-1",
});

// Verify state was written
const state = harness.getState({ scopeKind: "issue", scopeId: "iss-1", stateKey: "external-id" });
expect(state).toBeDefined();

// Simulate a UI data request
const data = await harness.getData("sync-health", { companyId: "comp-1" });
expect(data.syncedCount).toBeGreaterThan(0);
```

### 27.2 Local Plugin Development

For developing a plugin against a running Paperclip instance:

- The operator installs the plugin from a local path: `pnpm paperclipai plugin install --local ./path/to/plugin`
- The host watches the worker entrypoint for changes and reloads the complete plugin runtime on rebuild.
- UI changes are rebuilt into the declared UI bundle and appear after the UI remounts or reloads.
- The plugin settings page shows real-time logs from the worker for debugging.

### 27.3 Plugin Starter Template

The host should publish a starter template (`create-paperclip-plugin`) that scaffolds:

- `package.json` with the canonical `paperclipPlugin.manifest` entry
- manifest with placeholder values
- worker entry with SDK type imports and example event handler
- UI entry with example `DashboardWidget` using bridge hooks
- test file using the test harness
- build configuration (esbuild or similar) for both worker and UI bundles
- `.gitignore` and `tsconfig.json`

## 28. Example Mappings

This spec directly supports the following plugin types:

- `@paperclip/plugin-workspace-files`
- `@paperclip/plugin-terminal`
- `@paperclip/plugin-git`
- `@paperclip/plugin-linear`
- `@paperclip/plugin-github-issues`
- `@paperclip/plugin-grafana`
- `@paperclip/plugin-runtime-processes`
- `@paperclip/plugin-stripe`

## 29. Versioning

### 29.1 API Version Rules

1. The host supports exactly the current `PLUGIN_API_VERSION`.
2. A plugin manifest declares that exact `apiVersion`.
3. The host rejects every other version at install time; there is no
   multi-protocol dispatch path.
4. Plugin upgrades are explicit operator actions.
5. An upgrade that expands capabilities is rejected.

### 29.2 SDK Versioning

The host publishes a single SDK package for plugin authors:

- `@paperclipai/plugin-sdk` — the complete plugin SDK

The package uses exact subpath exports to separate runtime concerns:

- `@paperclipai/plugin-sdk` — worker-side SDK (context, events, state, tools, logger, and `definePlugin`)
- `@paperclipai/plugin-sdk/ui` — frontend SDK (bridge hooks, shared components, and UI types)
- `@paperclipai/plugin-sdk/testing` — plugin test harness
- `@paperclipai/plugin-sdk/bundlers` — canonical plugin build presets

A single package simplifies dependency management for plugin authors — one dependency, one version, one changelog. No other deep-import path is public.

The SDK follows semver. A published SDK release targets one exact plugin API
version, and the manifest has no separate `sdkVersion` range. A future protocol
version is a coordinated host, SDK, and specification change; V1 does not ship
parallel protocol handlers or a compatibility endpoint. Plugins may use
`minimumHostVersion` when they require a newer host release within the current
protocol.

### 29.3 Plugin Author Workflow

When a new SDK version is released:

1. Plugin author updates `@paperclipai/plugin-sdk` dependency.
2. Plugin author follows the migration guide to update code.
3. Plugin author keeps the exact supported `apiVersion` and raises
   `minimumHostVersion` only when required.
4. Plugin author publishes a new plugin version.
5. Operators explicitly upgrade the plugin on their instances.
