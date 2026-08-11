# Plugin Authoring Guide

This guide describes the current way to create a Paperclip plugin in this repo.
The normative runtime contract is [PLUGIN_SPEC.md](./PLUGIN_SPEC.md); this guide
organizes that contract as an authoring workflow.

> **New to plugins?** Start with the short [Local Plugin Development guide](./LOCAL_PLUGIN_DEVELOPMENT.md) — it walks the CLI happy path (`plugin init` → `pnpm dev` → `plugin install --local <path>`) end to end. Come back here for the full manifest surface, worker capabilities, and UI components.

## Current reality

- Treat plugin workers and plugin UI as trusted code.
- Plugin UI runs as same-origin JavaScript inside the main Paperclip app.
- Worker-side host APIs are capability-gated.
- Plugin UI is not sandboxed by manifest capabilities.
- Plugin database migrations are restricted to a host-derived plugin namespace.
- Plugin-managed surfaces are first-class records (agents, projects, routines, and
  skills) rather than private plugin-only state.
- Plugin-owned JSON API routes must be declared in the manifest and are mounted
  only under `/api/plugins/:pluginId/api/*`.
- The host provides a small shared React component kit through
  `@paperclipai/plugin-sdk/ui`; use it for common Paperclip controls before
  building custom versions.

## Scaffold a plugin

Use the CLI scaffold command:

```bash
paperclipai plugin init @yourscope/plugin-name --category connector --output /absolute/path/to/plugin-repos
```

That creates `<output>/plugin-name/` with:

- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/index.tsx`
- `tests/plugin.spec.ts`
- `esbuild.config.mjs`

Inside this monorepo, the scaffold uses `workspace:*` for `@paperclipai/plugin-sdk`.

Outside this monorepo, the scaffold snapshots `@paperclipai/plugin-sdk` from the local Paperclip checkout into a `.paperclip-sdk/` tarball so you can build and test a plugin without publishing anything to npm first. Pass `--sdk-path /absolute/path/to/paperclip/packages/plugins/sdk` if you have more than one Paperclip checkout.

## Local development workflow

See the short [Local Plugin Development guide](./LOCAL_PLUGIN_DEVELOPMENT.md) for the full happy path (`pnpm dev` → `paperclipai plugin install --local <absolute-path>` → `paperclipai plugin list`) and reload semantics.

Minimum verification from the generated plugin folder:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Supported surface

Worker:

- instance config and trusted local folders
- events and jobs
- managed outbound HTTP
- canonical runtime context and redacted runtime records
- activity, metrics, telemetry, and structured logs
- scoped state and plugin-owned entities
- database namespace via `ctx.db`
- scoped JSON API routes declared with `apiRoutes`
- projects and plugin-managed projects
- companies
- tasks, comments, namespaced `plugin:<pluginKey>` origins, blocker relations, and callback-bound ordinary-task creation
- agents and plugin-managed agents
- plugin-managed routines
- plugin-managed skills
- goals
- access membership/invites and authorization policy/grant administration
- data/actions
- agent tools

Manifest-backed worker handlers also cover webhooks and blocking before-prompt
observation.
UI launchers and slots are declared under `manifest.ui` and run through the
separate browser SDK.

### Plugin database declarations

First-party or otherwise trusted orchestration plugins can declare:

```ts
database: {
  migrationsDir: "migrations",
  coreReadTables: ["tasks"],
}
```

Required capabilities are `database.namespace.migrate` and
`database.namespace.read`; add `database.namespace.write` for runtime mutations.
The host derives `ctx.db.namespace`, runs SQL files in filename order before the
worker starts, records checksums in `plugin_migrations`, and rejects changed
already-applied migrations.

Migration SQL may create or alter objects only inside `ctx.db.namespace`. It may
reference whitelisted `public` core tables for foreign keys or read-only views,
but may not mutate/alter/drop/truncate public tables, create extensions,
triggers, untrusted languages, or runtime multi-statement SQL. Runtime
`ctx.db.query()` is restricted to `SELECT`; runtime `ctx.db.execute()` is
restricted to namespace-local `INSERT`, `UPDATE`, and `DELETE`.

### Scoped plugin API routes

Plugins can expose JSON-only routes under their own namespace:

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

The host resolves the plugin, checks that it is ready, enforces
`api.routes.register`, matches the declared method/path, resolves company access,
and dispatches to the worker's `onApiRequest` handler.
Every route declares `companyResolution`; task resolution names an exact
`:param` in the route path, and GET routes cannot resolve from a request body.
The worker receives sanitized headers, route params, query, parsed JSON
body, actor context, and company id. Do not use plugin routes to claim core
paths; they always remain under `/api/plugins/:pluginId/api/*`.

## Instance configuration

`instanceConfigSchema` describes one configuration for the installed plugin,
not one configuration per company. An instance administrator edits it once at
**Instance Settings → Plugins → your plugin**. Workers read it with
`await ctx.config.get()`; there is no `companyId` argument.

```ts
const config = await ctx.config.get();
const apiSecret = String(config.apiSecret ?? "");
```

Paperclip stores this administrator-provided object directly in the installed
plugin's `plugin_config` row. The core does not interpret plugin-specific
fields. Company IDs still scope business records, events, tools, local folders,
and other company operations; they never select the installed plugin's URL or
credential.

## Managed Paperclip resources

Plugins that provide durable Paperclip business objects should declare them in
the manifest and let the host create or relink the actual records per company.
Do this for plugin-owned agents, projects, routines, and skills.
Do not hide long-lived work behind private plugin state when it should be visible
to the board, scoped to a company, audited, budgeted, and assigned like normal
Paperclip work.

Content-oriented plugins, such as source ingestion or durable knowledge
systems, should use the same pattern: managed projects for operation tasks,
managed agents plus managed skills for LLM work, and managed routines for
ingest, lint, refresh, or maintenance runs.

Use these surfaces:

- Managed agents: declare top-level `agents[]` and require
  `agents.managed`. Use this when the plugin provides a named worker the board
  should see in the org, budget, pause, configure, assign ordinary tasks to,
  and inspect. Managed agents are normal Paperclip agents with plugin ownership
  metadata, not background plugin workers or provider-session owners.
- Managed projects: declare top-level `projects[]` and require
  `projects.managed`. Use this when the plugin needs a stable company-scoped
  project for its tasks, routines, or workspace-oriented UI. Keep plugin work
  in a project instead of scattering generated tasks across unrelated projects.
- Managed routines: declare top-level `routines[]` and require
  `routines.managed`. Use this for scheduled, webhook, or manually triggered
  jobs that should create visible Paperclip tasks. Prefer managed routines over
  plugin `jobs[]` for recurring business work; plugin jobs are for plugin
  runtime maintenance that does not need a board-visible task trail.
- Managed skills: declare top-level `skills[]` and require `skills.managed`.
  Use this for reusable plugin capabilities that should be surfaced to operators and
  selected for ordinary managed agents.

Managed resources are resolved by stable plugin keys, not hardcoded database
ids. In a worker action or data handler, call `ctx.agents.managed.reconcile()`,
`ctx.projects.managed.reconcile()`, `ctx.routines.managed.reconcile()`, and
`ctx.skills.managed.reconcile()` for
the current `companyId`. `reconcile()` creates the missing resource, relinks a
recoverable binding, or returns the existing resource. `reset()` reapplies the
manifest defaults when the operator wants to restore the plugin's suggested
configuration.

Declare dependencies between managed resources with refs. A routine can point
at a managed agent through `assigneeRef` and at a managed project through
`projectRef`. Reconcile the referenced agent and project before reconciling the
routine; if a ref is still missing, the routine resolution reports
`missing_refs` instead of guessing.

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "example.research-plugin",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Research Plugin",
  description: "Creates a managed research agent and scheduled research routine.",
  author: "Example",
  categories: ["automation"],
  capabilities: [
    "agents.managed",
    "projects.managed",
    "routines.managed",
    "skills.managed",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  agents: [
    {
      agentKey: "researcher",
      displayName: "Researcher",
      title: "Research Agent",
      capabilities: "Runs recurring research briefs for this company.",
    },
  ],
  projects: [
    {
      projectKey: "research",
      displayName: "Research",
      description: "Recurring research work created by the Research Plugin.",
      status: "in_progress",
    },
  ],
  routines: [
    {
      routineKey: "weekly-brief",
      title: "Weekly research brief",
      description: "Create a short research brief for the board.",
      assigneeRef: { resourceKind: "agent", resourceKey: "researcher" },
      projectRef: { resourceKind: "project", resourceKey: "research" },
      priority: "medium",
      triggers: [
        {
          kind: "schedule",
          label: "Monday morning",
          cronExpression: "0 9 * * 1",
          timezone: "America/Chicago",
          enabled: false,
        },
      ],
    },
  ],
  skills: [
    {
      skillKey: "weekly-brief-skills",
      displayName: "Weekly Briefer",
      description: "Reusable skill for the managed research workflow.",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Research",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
```

In the worker, expose a small setup action or settings-page action that
reconciles the resources for the selected company:

```ts
import { definePlugin } from "@paperclipai/plugin-sdk";

export default definePlugin({
  setup(ctx) {
    ctx.actions.register("setup-company", async (_params, context) => {
      const companyId = context.actor.companyId;
      if (!companyId) throw new Error("This action requires a company context");

      const project = await ctx.projects.managed.reconcile("research", companyId);
      const agent = await ctx.agents.managed.reconcile("researcher", companyId);
      const routine = await ctx.routines.managed.reconcile("weekly-brief", companyId);
      const skill = await ctx.skills.managed.reconcile("weekly-brief-skills", companyId);

      return { project, agent, routine, skill };
    });
  },
});
```

Authoring rules:

- Treat action parameters as plugin input, not authority. Read the authenticated
  company only from the immutable `context.actor.companyId` supplied to the
  action handler.
- Keep keys stable once published. Renaming `agentKey`, `projectKey`,
  `routineKey`, or `skillKey` creates a new managed resource from the host's
  point of view.
- Use managed agents for plugin-provided labor. Provider work starts only by
  creating an ordinary task with an explicit eligible owner through
  `ctx.tasks.create`; plugins cannot invoke an agent or open an agent session
  directly.
- A managed-agent declaration does not choose, infer, or default an AI
  adapter. The board must attach an explicit immutable revision referencing an
  installed, conformance-approved data-only ACP adapter before that agent is
  runnable. Plugins cannot supply a command, HTTP endpoint, provider SDK,
  credential, native-session selector, or provider-specific response mapping.
- Use managed routines for recurring or externally triggered work that should
  produce tasks. Schedule, webhook, and API triggers are visible routine
  triggers, and each run has the normal Paperclip task/audit trail.
- Use managed skills for reusable operator-visible capabilities that are shared
  by managed agents. Reconcile skill declarations by `skillKey` and keep the
  declared skill markdown and files in sync with agent behavior.
- Use managed projects to keep plugin-generated work organized and to give
  project-scoped plugin UI a stable home.
- Keep defaults conservative. Managed declarations are suggestions owned by the
  plugin, but the resulting resources are normal Paperclip records that the
  operator can inspect, pause, and adjust.

## Privileged system plugins

Paperclip also supports administrator-approved infrastructure plugins without
adding product-specific core endpoints. These capabilities are deliberately
broader than ordinary connector capabilities:

| Capability | Generic host contract |
| --- | --- |
| `agent.tools.register` | Every declared tool is discovered from the ready installation manifest and compiled directly for all agents. The per-prompt DB compiler is the only tool catalog; no per-agent selection or in-memory registration is involved. |
| `runtime.context.read` | An exact live tool handler can resolve its opaque `runContext` or ask whether a target task is reachable under the agent's existing context-access matrix. |
| `runtime.records.read` | The worker can read company-scoped provider-safe run/comment projections and snapshot-bounded canonical Session identity/messages/events. Mutable Session-head metadata is excluded; message deltas can key on creation or model-visible update sequence. |
| `runtime.prompt.observe` | The worker receives a blocking `onBeforePrompt` callback for every exact provider prompt, may synchronize against the bounded canonical snapshot, and returns `null` or one non-empty `{ prependText }` contribution. Paperclip prepends successful contributions only to the outbound request; the canonical Session message remains unchanged. |
| `http.private-network` | The managed HTTP client may reach loopback/private addresses while retaining DNS pinning and other HTTP protections. Also requires `http.outbound`. |

Tools use the unambiguous MCP-safe provider name `pluginId__toolName` and
execute through the normal prompt-capability gateway.
The host revalidates the installation, manifest capability, company scope,
exact compiled tool name, and immutable tool-call binding when a tool is
called. Before-prompt hooks run synchronously in installation order before the
execution target or prompt capability is minted. Hook failure, an invalid
result, or a concurrent disable/upgrade fails closed before provider
transmission. The hook receives Paperclip Session/run/source identities and the
effective context matrix, never the opaque provider-native session handle.

Use these capabilities only when an ordinary selected tool and ordinary
company APIs cannot implement the requirement. Do not add a domain-specific
Paperclip route solely to serve one plugin; add a generic, capability-gated,
company-fenced worker contract when the host primitive is broadly reusable.

UI:

- `usePluginData`
- `usePluginAction`
- `usePluginToast`
- `useHostContext`
- typed slot props from `@paperclipai/plugin-sdk/ui`

Mount surfaces currently wired in the host include:

- `page`
- `settingsPage`
- `companySettingsPage`
- `dashboardWidget`
- `sidebar`
- `routeSidebar`
- `sidebarPanel`
- `detailTab`
- `taskDetailView`
- `projectSidebarItem`
- `globalToolbarButton`
- `toolbarButton`

Entity-scoped mounts are exact: `detailTab` supports `project` and `task`;
`taskDetailView` supports only `task`; `projectSidebarItem` supports only
`project`; and `toolbarButton` supports `project` and `task`.
Launcher placements are limited to `sidebar`, `globalToolbarButton`, and
`toolbarButton`; launcher toolbar buttons mount only for `project` and `task`.
Launcher component actions (`openModal`, `openDrawer`, and `openPopover`) require
the sole mounted render environment, `hostOverlay`. Navigation, external
`deepLink`, and worker `performAction` launchers do not accept render metadata;
only `performAction` accepts action parameters.

### `routeSidebar` and the app sidebar

A `routeSidebar` slot gives a plugin page route its own contextual navigation.
It **coexists** with the main app sidebar rather than replacing it: while your
route is active the host collapses the app `<Sidebar/>` to its 64px icon rail
(still hover/peek-able) and renders your sidebar in a second pane, yielding
`[ app rail ][ your sidebar ][ content ]`.

Because the host drives this collapse, a plugin should **not** mount
`RequestCollapsedSidebar` or otherwise try to collapse the app sidebar itself —
doing so is redundant and fights the host. While your route is active the app
rail is forced collapsed (its expand toggle is hidden), overriding any user pin
— a secondary sidebar always collapses the primary. This force never changes the
user's saved expanded/collapsed preference, so the host restores exactly what
the user chose as soon as they navigate away.

## Shared host components

Use shared components from `@paperclipai/plugin-sdk/ui` when the plugin needs a
Paperclip-native control. The host owns the implementation, so plugins inherit
the board's current styling, ordering, recent selections, and dark-mode behavior
without importing `apps/ui/src` internals.

Prefer shared components for common Paperclip UX patterns to reduce drift and
deprecation risk, especially for task/assignment flows and routine or sidebar-like
plugin screens.

Currently exposed components include:

- `MarkdownBlock` and `MarkdownEditor` for rendered and editable markdown.
- `FileTree` for serializable file and directory trees.
- `TasksList` for a native company-scoped task table.
- `OwnerPicker` for the required agent owner of an ordinary plugin-created
  task. Its controlled value is an agent id or `""` before selection, and its
  payload is `{ ownerAgentId }`; it exposes no user-assignee compatibility.
- `ProjectPicker` for the same project selector used in the new task pane.
  Use the controlled project id value, or `""` for no project.
- `ManagedRoutinesList` for plugin-owned routine settings pages.

```tsx
import { OwnerPicker, ProjectPicker } from "@paperclipai/plugin-sdk/ui";

export function PluginAssignmentControls({ companyId }: { companyId: string }) {
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [projectId, setProjectId] = useState("");

  return (
    <>
      <OwnerPicker
        companyId={companyId}
        value={ownerAgentId}
        onChange={(value) => setOwnerAgentId(value)}
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

## File and path UI

Plugin UI often needs to render a file tree or accept a folder path. Pick the
surface that matches the data the plugin actually has.

### When to use the shared `FileTree`

Use `FileTree` from `@paperclipai/plugin-sdk/ui` whenever the plugin only needs
to render a serializable file/directory list and react to selection or
expand/collapse. The host owns the implementation, so plugin UI inherits the
board's icons, indent, focus ring, and dark-mode styling without importing host
internals.

```tsx
import {
  FileTree,
  type FileTreeNode,
} from "@paperclipai/plugin-sdk/ui";

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

export function WikiTree() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["wiki"]));
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <FileTree
      nodes={nodes}
      selectedFile={selected}
      expandedPaths={expanded}
      onSelectFile={(path) => setSelected(path)}
      onToggleDir={(path) =>
        setExpanded((current) => {
          const next = new Set(current);
          next.has(path) ? next.delete(path) : next.add(path);
          return next;
        })
      }
    />
  );
}
```

Boundary rules:

- Keep the prop surface serializable (`nodes`, `expandedPaths`, `checkedPaths`,
  `fileBadges`, `fileTones`). Do not pass arbitrary render functions across the
  plugin/host boundary in v1; the supported escape hatches are
  `fileBadges` (status pill keyed by path) and `fileTones` (row tone keyed by
  path).
- Do not import the host's `FileTree.tsx` or any `apps/ui/src/*` module. The SDK
  declaration is the only supported import path for plugin UI.
- The shared `FileTree` is for rendering and selection. Plugin-specific editors,
  ingest flows, query forms, and lint runs stay inside the plugin and do not
  belong as `FileTree` props.

### When to declare `localFolders`

When the plugin needs operator-configured filesystem roots — typically for
trusted local plugins like wiki tooling — declare `localFolders[]` on the
manifest and add the `local.folders` capability. The host renders a settings
surface for the operator to set the absolute path, validates the path
server-side (containment, symlinks, required files/directories), and exposes
`ctx.localFolders.readText()` and `ctx.localFolders.writeTextAtomic()` in the
worker.

```ts
export const manifest = {
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

Use this when:

- The data lives outside the plugin's configured folder.
- Reads and writes need a company-scoped folder selection.
- The operator picks the path once in plugin settings and the worker resolves
  files relative to that root.

Do not use `localFolders` to grant the UI direct browser-side access to the
filesystem — there is no such capability. The browser still goes through the
worker via `getData` / `performAction`, and the worker only exposes paths it
chose to expose.

### Mixing surfaces

A single plugin can use more than one of these. A plugin can render its own
serializable file tree through `FileTree` with lazy loading. Pick the boundary
per data source, not per plugin.

## Company routes

Plugins may declare a `page` slot with `routePath` to own a company route like:

```text
/:companyPrefix/<routePath>
```

Rules:

- `routePath` must be a single lowercase slug
- it cannot collide with reserved host routes
- it cannot duplicate another installed plugin page route

## Publishing guidance

- Use npm packages as the deployment artifact.
- Treat repo-local example installs as a development workflow only.
- Prefer keeping plugin UI self-contained inside the package.
- Do not rely on host design-system components or undocumented app internals.
- GitHub repository installs are not a first-class workflow today. For local development, use a checked-out local path. For production, publish to npm or a private npm-compatible registry.

## Verification before delivery

At minimum:

```bash
pnpm --filter <your-plugin-package> typecheck
pnpm --filter <your-plugin-package> test
pnpm --filter <your-plugin-package> build
```

If you changed host integration too, also run:

```bash
pnpm typecheck
pnpm test:run
pnpm build
```
