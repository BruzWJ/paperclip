import path from "node:path";
import { Command, Option } from "commander";
import {
  PLUGIN_CATEGORIES,
  PLUGIN_SCAFFOLD_TEMPLATES,
  pluginPackageDirectoryName,
  scaffoldPluginProject,
  shellQuote,
  type ScaffoldPluginOptions,
} from "../../../../plugins/create-paperclip-plugin/src/index.js";
import pc from "picocolors";
import type {
  PluginDetailDto,
  PluginInstallRequest,
  PluginRecordDto,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/** Subset of `GET /api/health` we surface as install/target diagnostics. */
interface TargetHealth {
  status?: string;
  version?: string;
  deploymentExposure?: string;
}

/** Result of probing the Paperclip instance the CLI is about to talk to. */
interface TargetDiagnostics {
  apiBase: string;
  reachable: boolean;
  health?: TargetHealth;
  error?: string;
}


// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

interface PluginListOptions extends BaseClientOptions {
  status?: string;
}

interface PluginInstallOptions extends BaseClientOptions {
  local?: boolean;
  version?: string;
  /** When false, skip the pre-install target-host health probe. Defaults true. */
  verifyTarget?: boolean;
}

interface PluginUpgradeOptions extends BaseClientOptions {
  version?: string;
}

interface PluginInitOptions {
  output?: string;
  template?: ScaffoldPluginOptions["template"];
  category: ScaffoldPluginOptions["category"];
  displayName?: string;
  description?: string;
  author?: string;
  sdkPath?: string;
  json?: boolean;
}

interface PluginJsonOptions extends BaseClientOptions {
  payloadJson?: string;
}

interface PluginCompanyOptions extends PluginJsonOptions {
  companyId?: string;
}

interface PluginInitResult {
  outputDir: string;
  nextCommands: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHomePath(packageArg: string): string {
  if (!packageArg.startsWith("~")) return packageArg;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.resolve(home, packageArg.slice(1).replace(/^[\\/]/, ""));
}

/**
 * Resolve a local path argument to an absolute path so the server can find the
 * plugin on disk regardless of where the user ran the CLI.
 */
function resolveLocalPluginPath(packageArg: string, cwd = process.cwd()): string {
  if (path.isAbsolute(packageArg)) return packageArg;
  if (packageArg.startsWith("~")) return expandHomePath(packageArg);
  return path.resolve(cwd, packageArg);
}

export function buildPluginInstallRequest(
  packageArg: string,
  opts: Pick<PluginInstallOptions, "local" | "version"> = {},
  deps: { cwd?: string } = {},
): PluginInstallRequest {
  if (opts.local && opts.version) {
    throw new Error("--version is only supported for npm package installs, not local plugin paths.");
  }

  if (opts.local) {
    return {
      source: "local",
      path: resolveLocalPluginPath(packageArg, deps.cwd),
    };
  }

  if (
    path.isAbsolute(packageArg)
    || packageArg.startsWith("./")
    || packageArg.startsWith("../")
    || packageArg.startsWith("~")
  ) {
    throw new Error("Local plugin paths require --local.");
  }

  return {
    source: "npm",
    packageName: packageArg,
    ...(opts.version ? { version: opts.version } : {}),
  };
}

export function renderLocalPluginInstallHint(packagePath: string): string {
  return [
    pc.dim("Plugins installed from local paths execute code from your machine."),
    pc.dim(`Keep ${pc.cyan("pnpm dev")} running in ${packagePath}; Paperclip watches rebuilt dist output and reloads the plugin worker.`),
  ].join("\n");
}

/**
 * Probe `GET /api/health` on the instance the CLI is configured to talk to so a
 * developer can confirm *which* Paperclip they are about to install into. This
 * exists because a local-path plugin can otherwise be silently installed into a
 * stale control-plane host that does not serve the branch's routes; surfacing
 * the API URL plus the server version/status catches that mismatch before the
 * plugin is exercised against the wrong runtime.
 */
export async function probeTargetDiagnostics(
  api: { apiBase: string; get(path: string): Promise<TargetHealth | null> },
): Promise<TargetDiagnostics> {
  try {
    const health = await api.get("/api/health");
    return {
      apiBase: api.apiBase,
      reachable: true,
      health: health ?? undefined,
    };
  } catch (err) {
    return {
      apiBase: api.apiBase,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Render the target-host diagnostics as human-readable lines. Pure so it can be
 * unit-tested without a live server.
 */
export function formatTargetDiagnostics(diag: TargetDiagnostics): string {
  const lines = [pc.dim(`Target Paperclip: ${pc.cyan(diag.apiBase)}`)];

  if (!diag.reachable) {
    lines.push(pc.yellow(`  health: unreachable${diag.error ? ` (${diag.error.split("\n")[0]})` : ""}`));
    lines.push(
      pc.dim(
        `  Verify the right instance is running, then pass ${pc.cyan("--api-base <url>")} or set ${pc.cyan("PAPERCLIP_BOARD_API_URL")} if it lives elsewhere.`,
      ),
    );
    return lines.join("\n");
  }

  const health = diag.health ?? {};
  const detailParts: string[] = [];
  if (health.status) detailParts.push(`status=${health.status}`);
  if (health.version) detailParts.push(`version=${health.version}`);
  if (health.deploymentExposure) detailParts.push(`exposure=${health.deploymentExposure}`);

  lines.push(
    pc.dim(`  health: ${detailParts.length > 0 ? detailParts.join("  ") : "ok (no details exposed)"}`),
  );
  return lines.join("\n");
}

function formatPlugin(p: PluginRecordDto): string {
  const statusColor =
    p.status === "ready"
      ? pc.green(p.status)
      : p.status === "error"
        ? pc.red(p.status)
        : pc.dim(p.status);

  const parts = [
    `key=${pc.bold(p.pluginKey)}`,
    `status=${statusColor}`,
    `version=${p.manifestJson.version}`,
    `id=${pc.dim(p.id)}`,
  ];

  if (p.lastError) {
    parts.push(`error=${pc.red(p.lastError.slice(0, 80))}`);
  }

  return parts.join("  ");
}

function requirePluginRecord(
  record: PluginRecordDto | null,
  operation: string,
): PluginRecordDto {
  if (record === null) {
    throw new Error(`Plugin ${operation} returned an empty response.`);
  }
  return record;
}

export function buildPluginInitScaffoldOptions(
  packageName: string,
  opts: PluginInitOptions,
  cwd = process.cwd(),
): ScaffoldPluginOptions {
  const outputRoot = path.resolve(cwd, opts.output ?? ".");
  const outputDir = path.resolve(outputRoot, pluginPackageDirectoryName(packageName));

  return {
    pluginName: packageName,
    outputDir,
    template: opts.template,
    category: opts.category,
    displayName: opts.displayName,
    description: opts.description,
    author: opts.author,
    sdkPath: opts.sdkPath,
  };
}

export function buildPluginInitNextCommands(outputDir: string): string[] {
  const quotedOutputDir = shellQuote(outputDir);
  return [
    `cd ${quotedOutputDir}`,
    "pnpm install",
    "pnpm dev",
    `paperclipai plugin install --local ${quotedOutputDir}`,
  ];
}

export function renderPluginInitSuccess(result: PluginInitResult): string {
  return [
    pc.green(`✓ Created plugin scaffold at ${result.outputDir}`),
    "",
    "Next commands:",
    ...result.nextCommands.map((command) => `  ${pc.cyan(command)}`),
  ].join("\n");
}

export function runPluginInitCommand(packageName: string, opts: PluginInitOptions): PluginInitResult {
  const scaffoldOptions = buildPluginInitScaffoldOptions(packageName, opts);
  const outputDir = scaffoldPluginProject(scaffoldOptions);
  return {
    outputDir,
    nextCommands: buildPluginInitNextCommands(outputDir),
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").description("Plugin lifecycle management");

  // -------------------------------------------------------------------------
  // plugin init <package-name>
  // -------------------------------------------------------------------------
  plugin
    .command("init <packageName>")
    .description("Scaffold a local Paperclip plugin project")
    .option("--output <dir>", "Directory to create the plugin folder in")
    .addOption(
      new Option("--template <template>", "Starter template")
        .choices([...PLUGIN_SCAFFOLD_TEMPLATES])
        .default("standard"),
    )
    .addOption(
      new Option("--category <category>", "Manifest category")
        .choices([...PLUGIN_CATEGORIES])
        .makeOptionMandatory(),
    )
    .option("--display-name <name>", "Manifest display name")
    .option("--description <description>", "Manifest description")
    .option("--author <author>", "Manifest author")
    .option("--sdk-path <path>", "Local @paperclipai/plugin-sdk package path")
    .option("--json", "Output raw JSON")
    .action((packageName: string, opts: PluginInitOptions) => {
      try {
        const result = runPluginInitCommand(packageName, opts);

        if (opts.json) {
          printOutput(result, { json: true });
          return;
        }

        console.log(renderPluginInitSuccess(result));
      } catch (err) {
        handleCommandError(err);
      }
    });

  // -------------------------------------------------------------------------
  // plugin list
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("list")
      .description("List installed plugins")
      .option("--status <status>", "Filter by status (ready, error, disabled)")
      .action(async (opts: PluginListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
          const plugins = await ctx.api.get<PluginRecordDto[]>(`/api/plugins${qs}`);

          if (ctx.json) {
            printOutput(plugins, { json: true });
            return;
          }

          const rows = plugins ?? [];
          if (rows.length === 0) {
            console.log(pc.dim("No plugins installed."));
            return;
          }

          for (const p of rows) {
            console.log(formatPlugin(p));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin install <package-name-or-path>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("install <package>")
      .description(
        "Install an npm plugin, or use --local to install from a filesystem path.\n" +
          "  Examples:\n" +
          "    paperclipai plugin install --local ./my-plugin      # local path\n" +
          "    paperclipai plugin install @acme/plugin-linear      # npm package\n" +
          "    paperclipai plugin install @acme/plugin-linear --version 1.2.3",
      )
      .option("-l, --local", "Install <package> as a local filesystem path", false)
      .option("--version <version>", "Specific npm version to install (npm packages only)")
      .option(
        "--no-verify-target",
        "Skip the pre-install probe that reports which Paperclip instance the plugin installs into",
      )
      .action(async (packageArg: string, opts: PluginInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          const installRequest = buildPluginInstallRequest(packageArg, opts);

          // Make the install target explicit before sending the plugin to it. A
          // local-path plugin can otherwise be silently installed into a stale
          // control-plane host that lacks this branch's routes; printing the API
          // URL + server version/health lets the developer catch that mismatch.
          let target: TargetDiagnostics | undefined;
          if (opts.verifyTarget !== false) {
            target = await probeTargetDiagnostics(ctx.api);
            if (!ctx.json) {
              console.log(formatTargetDiagnostics(target));
            }
          }

          if (!ctx.json) {
            console.log(
              pc.dim(
                installRequest.source === "local"
                  ? `Installing plugin from local path: ${installRequest.path}`
                  : `Installing plugin: ${installRequest.packageName}${opts.version ? `@${opts.version}` : ""}`,
              ),
            );
          }

          const installedPlugin = requirePluginRecord(
            await ctx.api.post<PluginRecordDto>("/api/plugins/install", installRequest),
            "install",
          );

          if (ctx.json) {
            printOutput({ ...installedPlugin, ...(target ? { target } : {}) }, { json: true });
            return;
          }

          console.log(
            pc.green(
              `✓ Installed ${pc.bold(installedPlugin.pluginKey)} v${installedPlugin.manifestJson.version} (${installedPlugin.status})`,
            ),
          );

          if (installedPlugin.lastError) {
            console.log(pc.red(`  Warning: ${installedPlugin.lastError}`));
          }

          if (installRequest.source === "local") {
            console.log(renderLocalPluginInstallHint(installRequest.path));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin target
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("target")
      .description(
        "Show which Paperclip instance plugin commands will talk to.\n" +
          "  Reports the resolved API URL plus the server status/version/mode from\n" +
          "  GET /api/health so you can confirm you are installing into the branch\n" +
          "  runtime and not a stale control-plane host.",
      )
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const diag = await probeTargetDiagnostics(ctx.api);

          if (ctx.json) {
            printOutput(diag, { json: true });
            return;
          }

          console.log(formatTargetDiagnostics(diag));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin uninstall <plugin-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("uninstall <pluginId>")
      .description("Uninstall a plugin and delete its installation-owned data")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          if (!ctx.json) {
            console.log(pc.dim(`Uninstalling plugin: ${pluginId}`));
          }

          await ctx.api.delete<void>(
            `/api/plugins/${encodeURIComponent(pluginId)}`,
          );

          if (ctx.json) {
            printOutput({ pluginId }, { json: true });
            return;
          }

          console.log(pc.green(`✓ Uninstalled ${pc.bold(pluginId)}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin enable <plugin-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("enable <pluginId>")
      .description("Enable a disabled or errored plugin")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = requirePluginRecord(
            await ctx.api.post<PluginRecordDto>(
              `/api/plugins/${encodeURIComponent(pluginId)}/enable`,
            ),
            "enable",
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`✓ Enabled ${pc.bold(pluginId)} — status: ${result.status}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin disable <plugin-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("disable <pluginId>")
      .description("Disable a running plugin without uninstalling it")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = requirePluginRecord(
            await ctx.api.post<PluginRecordDto>(
              `/api/plugins/${encodeURIComponent(pluginId)}/disable`,
            ),
            "disable",
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.dim(`Disabled ${pc.bold(pluginId)} — status: ${result.status}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin inspect <plugin-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("inspect <pluginId>")
      .description("Show full details for an installed plugin")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = requirePluginRecord(
            await ctx.api.get<PluginDetailDto>(
              `/api/plugins/${encodeURIComponent(pluginId)}`,
            ),
            "inspect",
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(formatPlugin(result));
          if (result.lastError) {
            console.log(`\n${pc.red("Last error:")}\n${result.lastError}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addPluginGet(plugin, "ui-contributions", "List plugin UI contributions", "/api/plugins/ui-contributions");
  addPluginSubGet(plugin, "logs", "Get plugin logs", "logs");
  addPluginUpgrade(plugin);
  addPluginConfigGet(plugin, "config", "Get instance-wide plugin config");
  addPluginConfigPost(plugin, "config:set", "Set instance-wide plugin config", "config");
  addPluginConfigPost(plugin, "config:test", "Test instance-wide plugin config", "config/test");
  addPluginSubGet(plugin, "jobs", "List plugin jobs", "jobs");
  addPluginJobGet(plugin, "job:runs", "List plugin job runs", "runs");
  addPluginJobPost(plugin, "job:trigger", "Trigger a plugin job", "trigger");
  addPluginWebhookPost(plugin);
  addPluginSubGet(plugin, "dashboard", "Get plugin dashboard data", "dashboard");
  addPluginLocalFolderGet(plugin, "local-folders", "List plugin local folder bindings");
  addPluginLocalFolderKeyGet(plugin, "local-folder:status", "Get plugin local folder status", "status");
  addPluginLocalFolderKeyPost(plugin, "local-folder:validate", "Validate plugin local folder binding", "validate");
  addPluginLocalFolderKeyPut(plugin, "local-folder:set", "Set plugin local folder binding");
}

function addPluginGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).action(async (opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(path), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginSubGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin installation UUID").action(async (pluginId: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginUpgrade(parent: Command): void {
  addCommonClientOptions(
    parent
      .command("upgrade")
      .description("Upgrade a plugin")
      .argument("<pluginId>", "Plugin installation UUID")
      .option("--version <version>", "Specific npm version to install")
      .action(async (pluginId: string, opts: PluginUpgradeOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/upgrade`, {
              ...(opts.version ? { version: opts.version } : {}),
            }),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addPluginConfigGet(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin installation UUID")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/config`),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addPluginConfigPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin installation UUID")
      .option("--payload-json <json>", "JSON payload", "{}")
      .action(async (pluginId: string, opts: PluginJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = parseJson(opts.payloadJson ?? "{}") as Record<string, unknown>;
          printOutput(
            await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`, payload),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addPluginJobGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin installation UUID").argument("<jobId>", "Job ID").action(async (pluginId: string, jobId: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/${suffix}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginJobPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin installation UUID").argument("<jobId>", "Job ID").option("--payload-json <json>", "JSON payload", "{}").action(async (pluginId: string, jobId: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginWebhookPost(parent: Command): void {
  addCommonClientOptions(parent.command("webhook").description("Deliver a plugin webhook").argument("<pluginId>", "Plugin installation UUID").argument("<endpointKey>", "Webhook endpoint key").option("--payload-json <json>", "JSON payload", "{}").action(async (pluginId: string, endpointKey: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/webhooks/${encodeURIComponent(endpointKey)}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginLocalFolderGet(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin installation UUID")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (pluginId: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin installation UUID")
      .argument("<folderKey>", "Local folder key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}/${suffix}`),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin installation UUID")
      .argument("<folderKey>", "Local folder key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--payload-json <json>", "JSON payload", "{}")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.post(
              `/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}/${suffix}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyPut(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin installation UUID")
      .argument("<folderKey>", "Local folder key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.put(
              `/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
