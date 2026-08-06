# Local Plugin Development

This is the short happy-path guide for developing a Paperclip plugin from a folder on your machine. You will scaffold a plugin, run it in watch mode, install it into a running Paperclip instance from an absolute local path, and edit code with the plugin worker reloading after each rebuild.

For the full alpha surface — manifest fields, capabilities, managed agents/projects/routines/skills, UI slots, scoped API routes — see [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md).

If your plugin has background-like recurring work, model it as managed resources:
declare managed routines plus managed agents/projects/skills, then reconcile those
resources in worker actions. This gives operators visible work items, budgets,
pause controls, and consistent audits instead of hidden daemon behavior.

## Prerequisites

- Node.js >=22.13.0 and `pnpm`.
- A local Paperclip checkout you can run from source. Local plugin installs read source from disk, so the running server must be able to see the path you give it.

## The five steps

```bash
# 1. Start Paperclip locally
pnpm paperclipai run

# 2. Scaffold a plugin outside the Paperclip repo
paperclipai plugin init @acme/hello-plugin --category connector --output ~/dev/paperclip-plugins

# 3. Install dependencies and start the watch build
cd ~/dev/paperclip-plugins/hello-plugin
pnpm install
pnpm dev

# 4. In another terminal, install the plugin from its absolute path
paperclipai plugin install --local ~/dev/paperclip-plugins/hello-plugin

# 5. Confirm it loaded
paperclipai plugin list
paperclipai plugin inspect <plugin-installation-id>
```

That's the loop. The rest of this page explains what each step does and what to expect when you edit code.

### 1. Start Paperclip

```bash
pnpm paperclipai run
```

Paperclip listens on `http://127.0.0.1:3100` by default. The CLI talks to that server, so leave it running.

> **Verifying branch behavior?** If you are testing a plugin against routes or
> data shapes that only exist on a feature branch, the server you install into
> must be the one running that branch's code. A long-lived control-plane host
> may be on older code and silently return `API route not found` for routes the
> branch added, which makes the plugin look broken when the real problem is the
> test target. See [Targeting a branch / issue-workspace runtime](#targeting-a-branch--issue-workspace-runtime)
> before you install.

### 2. Scaffold the plugin

```bash
paperclipai plugin init @acme/hello-plugin --category connector --output ~/dev/paperclip-plugins
```

This creates `~/dev/paperclip-plugins/hello-plugin/` with `src/manifest.ts`, `src/worker.ts`, `src/ui/index.tsx`, an esbuild watch config, a Vitest config, and a snapshot of `@paperclipai/plugin-sdk` from your local Paperclip checkout. You can run the package and tests without publishing anything to npm.

Useful flags:

- `--category <connector|workspace|automation|ui>` — required manifest category.
- `--template <standard|environment>` — generated structure; `standard` is the default, while `environment` adds the distinct environment-driver lifecycle.
- `--display-name`, `--description`, `--author` — manifest metadata.
- `--sdk-path <absolute-path>` — point at a specific `packages/plugins/sdk` checkout if you have more than one.

When `plugin init` finishes, it prints the next four commands literally. You can copy them.

### 3. Install dependencies and run the watch build

```bash
cd ~/dev/paperclip-plugins/hello-plugin
pnpm install
pnpm dev
```

`pnpm dev` runs `esbuild --watch` against the plugin source and emits `dist/manifest.js`, `dist/worker.js`, and `dist/ui/`. Leave it running. Every time you save, esbuild rebuilds the affected output file.

### 4. Install from the absolute path

```bash
paperclipai plugin install --local ~/dev/paperclip-plugins/hello-plugin
```

The install source is explicit. `--local` resolves the argument against the
current working directory and sends
`{ "source": "local", "path": "/absolute/path/to/plugin" }` to
`POST /api/plugins/install`. Without `--local`, the argument is always an npm
package name and the CLI sends
`{ "source": "npm", "packageName": "@scope/package", "version": "..." }`.
Paperclip does not infer the source from path syntax or filesystem contents.

Before it installs, the CLI probes `GET /api/health` on the instance it is configured to talk to and prints the **target diagnostics** so you can confirm *which* Paperclip you are installing into. You will see a confirmation like:

```
Target Paperclip: http://127.0.0.1:3100
  health: status=ok  version=0.1.0  exposure=private
Installing plugin from local path: /Users/you/dev/paperclip-plugins/hello-plugin
✓ Installed acme.hello-plugin v0.1.0 (ready)
Local plugin installs run trusted local code from your machine.
Keep `pnpm dev` running in /Users/you/dev/paperclip-plugins/hello-plugin;
Paperclip watches rebuilt dist output and reloads the plugin worker.
```

Read that first line. If the API URL, version, or exposure is not the instance
you expect, stop and re-point the CLI (see
[Targeting a branch / issue-workspace runtime](#targeting-a-branch--issue-workspace-runtime))
before trusting the result. Pass `--no-verify-target` to skip the probe, or run
`paperclipai plugin target` to see the same diagnostics without installing
anything.

Relative local paths are resolved against the current working directory, so
`paperclipai plugin install --local .` from inside the plugin folder works too.

### 5. Inspect

```bash
paperclipai plugin list
paperclipai plugin inspect <plugin-installation-id>
```

`list` shows each installation UUID, plugin key, status, version, and short
error. `inspect` accepts only that installation UUID and prints the same record
with the full last error if there is one. Both accept `--json` if you want to
script against them.

## Targeting a branch / issue-workspace runtime

The five-step loop above assumes one Paperclip on `http://127.0.0.1:3100`. That breaks down the moment your plugin depends on **server code that only exists on a branch**. Examples:

- a new scoped API route the plugin calls (e.g. a `GET /api/companies/:companyId/...` endpoint the branch adds),
- a new field in an existing response the plugin reads,
- a new managed-resource capability the worker reconciles.

If you install the plugin into a long-lived control-plane host that is still on older code, the route or field is missing there. The plugin falls back or errors, and it *looks* like a plugin bug when the real problem is that you tested against the wrong runtime. To verify "what the published plugin will actually do," install into a Paperclip service that is **serving your branch**.

### How the CLI chooses its target

The CLI resolves the API base URL in this order (highest priority first):

1. `--api-base <url>` flag on the command,
2. `PAPERCLIP_BOARD_API_URL` environment variable,
3. the active CLI context profile's `apiBase`,
4. inferred default `http://<PAPERCLIP_SERVER_HOST|localhost>:<PAPERCLIP_SERVER_PORT|config.server.port|3100>`.

So the API URL is explicit and overridable — the gap was never that you *couldn't* point at a branch server, it was that nothing told you which server you ended up on. `paperclipai plugin target` and the pre-install probe close that gap.

### Run the branch service and install into it

```bash
# 1. From the branch checkout (e.g. an issue worktree), run that branch's server.
#    Pick a port that does not collide with any control-plane instance.
PAPERCLIP_SERVER_PORT=3120 pnpm dev          # or: pnpm paperclipai run

# 2. Confirm the CLI will talk to that exact branch service before installing.
paperclipai plugin target --api-base http://127.0.0.1:3120
# Target Paperclip: http://127.0.0.1:3120
#   health: status=ok  version=<branch-version>  exposure=private

# 3. Install the local-path plugin into that service (not the default host).
paperclipai plugin install --local ~/dev/paperclip-plugins/hello-plugin \
  --api-base http://127.0.0.1:3120

# Prefer setting it once for the shell instead of repeating --api-base:
export PAPERCLIP_BOARD_API_URL=http://127.0.0.1:3120
paperclipai plugin target
paperclipai plugin install --local ~/dev/paperclip-plugins/hello-plugin
```

`plugin target` and the install-time probe both read `GET /api/health`, which
returns the server `version` and `deploymentExposure`. Compare that `version`
against the branch you expect to be running. If the diagnostics show a
different URL, an unexpected version, or `health: unreachable`, you are about
to test against the wrong instance—fix the target before reading anything into
the plugin's behavior.

### End-to-end check that the branch route is actually served

When the behavior you care about is a branch-only route, hit it directly against the same target you installed into, so you prove the route exists there rather than inferring it from plugin output:

```bash
# Same base URL you installed into; expect JSON, not "API route not found".
curl -s "http://127.0.0.1:3120/api/companies/<companyId>/<branch-route>" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_API_KEY" | head
```

If that returns the route's JSON, the branch runtime is serving the route and the plugin is exercising real published behavior. If it returns `API route not found`, the service on that port is not running your branch code — restart the branch server (step 1) and re-check `plugin target` before continuing.

### Why not just patch the control-plane host?

You can, but you usually should not. The control-plane host is shared and may be deliberately pinned to a released version. Spinning up the branch service on its own port and pointing the CLI at it keeps your in-progress plugin work isolated, reproducible, and honest about which code it ran against. When you are done, publish the plugin as an npm package and install that form against the host you will actually ship on.

## Reload semantics, honestly

Paperclip watches the installed manifest's worker entrypoint after a local
install. Declaration and UI artifacts have separate reload semantics.

What that means in practice:

- **Worker code:** save a `.ts` file → esbuild rewrites `dist/worker.js` → Paperclip debounces ~500ms and reloads the complete plugin runtime (host binding, migrations, jobs, and worker). The next worker call uses the new code. There is no in-process hot module replacement.
- **Manifest:** rebuilding `dist/manifest.js` does not mutate the installed manifest. Reinstall or upgrade the plugin to apply declaration changes.
- **Plugin UI:** save a `.tsx` file → esbuild rewrites `dist/ui/` → hard-reload the Paperclip page to load the rebuilt bundle.
- **Without `pnpm dev`:** source edits do not reach the worker or UI artifacts. Restart `pnpm dev` (or run `pnpm build` once) before expecting changes.

The package's own build scripts own compilation. Paperclip never compiles a
local-path plugin during installation. Run the package's `dev` watcher or
`build` command before installing it.

## Local path plugins vs npm packages

Both go through the same install endpoint, but they mean different things:

- **Local path plugins are trusted local code.** Paperclip executes worker code from disk under the same trust boundary as the rest of the running instance. This is meant for developing or operating a plugin against a checkout you control. There is no signature check, no sandboxing of worker code, and no provenance metadata beyond the path. Do not install local-path plugins you did not write.
- **npm packages are the deployable artifact.** `paperclipai plugin install @acme/plugin-foo` (optionally `--version 1.2.3`) installs from your configured npm registry, version-pins, and produces an install record that other operators can reproduce. Ship plugins this way.

When you are done iterating locally, publish the package and reinstall the npm-package form so the install reflects what you will ship.

## Common things to do next

- **Restart cleanly:** `paperclipai plugin disable <plugin-installation-id>` pauses the plugin without uninstalling it. `paperclipai plugin enable <plugin-installation-id>` brings that installation back. `paperclipai plugin uninstall <plugin-installation-id>` deletes the installation, its managed package tree, operational state, settings, jobs, webhooks, and custom database objects.
- **Inspect installed plugins:** `paperclipai plugin list` and `paperclipai plugin inspect <plugin-installation-id>` report the packages this instance actually installed.
- **Go deeper:** [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md) covers worker capabilities, managed agents/projects/routines/skills, plugin database namespaces, scoped API routes, and the shared UI components in `@paperclipai/plugin-sdk/ui`. [`PLUGIN_SPEC.md`](./PLUGIN_SPEC.md) is the longer-form specification, including future ideas that are not yet implemented.
- **Routine-first automation:** If your plugin should produce periodic issue work, prefer managed routines and `ctx.routines.managed` reconciliation over custom process loops or unobserved cron code.

## Troubleshooting

- **Install fails or the installation enters `error` status.** Run `paperclipai plugin inspect <plugin-installation-id>` for the last error. The most common causes are (1) the plugin has not built yet — run `pnpm dev` or `pnpm build` first, (2) `paperclipPlugin.manifest` points at a module that does not exist, or (3) the manifest failed validation. The Paperclip server log has the full validation error.
- **Edits do not seem to reload.** Confirm `pnpm dev` is still running and writing to the installed manifest's entrypoint paths. If you rename an entrypoint, update `src/manifest.ts`, rebuild, and reinstall or upgrade the plugin.
- **Worker restarts but UI is stale.** Confirm the UI build rewrote `dist/ui/`, then hard-reload the page.
- **Path arguments fail on Windows.** Quote paths that contain spaces, and prefer absolute paths over `~`-prefixed paths in non-bash shells.
- **Plugin behaves as if a route or field is missing (e.g. `API route not found`, empty data, or a fallback path triggering unexpectedly).** You are probably installed into a Paperclip instance that does not run your branch code. Run `paperclipai plugin target` and compare the reported API URL and `version` against the branch service you meant to test. See [Targeting a branch / issue-workspace runtime](#targeting-a-branch--issue-workspace-runtime) to run the branch server and point the CLI at it explicitly.
