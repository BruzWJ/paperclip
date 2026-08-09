import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_CATEGORIES,
  pluginPackageNameSchema,
  type PluginCategory,
} from "@paperclipai/shared";

export { PLUGIN_CATEGORIES };
export type { PluginCategory };

export const PLUGIN_SCAFFOLD_TEMPLATES = ["standard"] as const;
export type PluginScaffoldTemplate = (typeof PLUGIN_SCAFFOLD_TEMPLATES)[number];

export interface ScaffoldPluginOptions {
  pluginName: string;
  outputDir: string;
  template?: PluginScaffoldTemplate;
  displayName?: string;
  description?: string;
  author?: string;
  category: PluginCategory;
  sdkPath?: string;
}

/** Return the canonical output-directory basename for an npm package name. */
export function pluginPackageDirectoryName(pluginName: string): string {
  return pluginName.replace(/^@[^/]+\//, "");
}

/** Convert an npm package name into a manifest-safe plugin id. */
function packageToManifestId(pluginName: string): string {
  if (!pluginName.startsWith("@")) {
    return pluginName;
  }

  return pluginName.slice(1).replace("/", ".");
}

/** Build a human-readable display name from package name tokens. */
function makeDisplayName(pluginName: string): string {
  const raw = pluginPackageDirectoryName(pluginName).replace(/[._-]+/g, " ").trim();
  return raw
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function writeFile(target: string, content: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function getLocalSdkPackagePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "sdk");
}

function getRepoRootFromSdkPath(sdkPath: string): string {
  return path.resolve(sdkPath, "..", "..", "..");
}

function getLocalSharedPackagePath(sdkPath: string): string {
  return path.resolve(getRepoRootFromSdkPath(sdkPath), "packages", "shared");
}

function isInsideDir(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function packLocalPackage(packagePath: string, outputDir: string): string {
  const packageJsonPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Package package.json not found at ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
    throw new Error(`Package name is required in ${packageJsonPath}`);
  }
  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error(`Package version is required in ${packageJsonPath}`);
  }
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  const tarballFileName = `${packageName.replace(/^@/, "").replace("/", "-")}-${packageVersion}.tgz`;
  const sdkBundleDir = path.join(outputDir, ".paperclip-sdk");

  fs.mkdirSync(sdkBundleDir, { recursive: true });
  execFileSync("pnpm", ["build"], { cwd: packagePath, stdio: "pipe" });
  execFileSync("pnpm", ["pack", "--pack-destination", sdkBundleDir], { cwd: packagePath, stdio: "pipe" });

  const tarballPath = path.join(sdkBundleDir, tarballFileName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Packed tarball was not created at ${tarballPath}`);
  }

  return tarballPath;
}

/**
 * Generate a complete Paperclip plugin starter project.
 *
 * Output includes manifest/worker/UI entries, SDK harness tests, and an esbuild
 * configuration for build and watch workflows.
 */
export function scaffoldPluginProject(options: ScaffoldPluginOptions): string {
  const template = options.template ?? "standard";
  if (!PLUGIN_SCAFFOLD_TEMPLATES.includes(template)) {
    throw new Error(
      `Invalid template '${template}'. Expected one of: ${PLUGIN_SCAFFOLD_TEMPLATES.join(", ")}`,
    );
  }

  const parsedPackageName = pluginPackageNameSchema.safeParse(options.pluginName);
  if (!parsedPackageName.success) {
    throw new Error(parsedPackageName.error.issues[0]?.message ?? "Invalid plugin package name");
  }

  if (!PLUGIN_CATEGORIES.includes(options.category)) {
    throw new Error(`Invalid category '${options.category}'. Expected one of: ${PLUGIN_CATEGORIES.join(", ")}`);
  }

  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(outputDir)) {
    throw new Error(`Directory already exists: ${outputDir}`);
  }

  const displayName = options.displayName ?? makeDisplayName(options.pluginName);
  const description = options.description ?? "A Paperclip plugin";
  const author = options.author ?? "Plugin Author";
  const category = options.category;
  const manifestId = packageToManifestId(options.pluginName);
  const localSdkPath = path.resolve(options.sdkPath ?? getLocalSdkPackagePath());
  const localSharedPath = getLocalSharedPackagePath(localSdkPath);
  const repoRoot = getRepoRootFromSdkPath(localSdkPath);
  const useWorkspaceSdk = isInsideDir(outputDir, repoRoot);

  fs.mkdirSync(outputDir, { recursive: true });

  const packedSharedTarball = useWorkspaceSdk ? null : packLocalPackage(localSharedPath, outputDir);
  const sdkDependency = useWorkspaceSdk
    ? "workspace:*"
    : `file:${toPosixPath(path.relative(outputDir, packLocalPackage(localSdkPath, outputDir)))}`;

  const packageJson = {
    name: options.pluginName,
    version: "0.1.0",
    type: "module",
    description,
    scripts: {
      build: "node ./esbuild.config.mjs",
      dev: "node ./esbuild.config.mjs --watch",
      test: "vitest run --config ./vitest.config.ts",
      typecheck: "tsc --noEmit"
    },
    paperclipPlugin: {
      manifest: "./dist/manifest.js"
    },
    keywords: ["paperclip", "plugin", category],
    author,
    license: "MIT",
    ...(packedSharedTarball
      ? {
        pnpm: {
          overrides: {
            "@paperclipai/shared": `file:${toPosixPath(path.relative(outputDir, packedSharedTarball))}`,
          },
        },
      }
      : {}),
    devDependencies: {
      "@paperclipai/plugin-sdk": sdkDependency,
      "@types/node": "^24.6.0",
      "@types/react": "^19.0.8",
      esbuild: "^0.27.3",
      typescript: "^5.7.3",
      vitest: "^3.0.5"
    },
    peerDependencies: {
      react: ">=18"
    }
  };

  writeFile(path.join(outputDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: "dist",
      rootDir: "."
    },
    include: ["src", "tests"],
    exclude: ["dist", "node_modules"]
  };

  writeFile(path.join(outputDir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);

  writeFile(
    path.join(outputDir, "esbuild.config.mjs"),
    `import esbuild from "esbuild";
import { rmSync } from "node:fs";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

rmSync("dist", { recursive: true, force: true });
const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
`,
  );

  writeFile(
    path.join(outputDir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
`,
  );

  writeFile(
    path.join(outputDir, "src", "manifest.ts"),
    `import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: ${quote(manifestId)},
  apiVersion: 1,
  version: "0.1.0",
  displayName: ${quote(displayName)},
  description: ${quote(description)},
  author: ${quote(author)},
  categories: [${quote(category)}],
  capabilities: [
    "ui.dashboardWidget.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: ${quote(`${displayName} Health`)},
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
`,
  );

  writeFile(
    path.join(outputDir, "src", "worker.ts"),
    `import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    ctx.actions.register("ping", async () => {
      await ctx.logger.info("Ping action invoked");
      return { pong: true, at: new Date().toISOString() };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
`,
  );

  writeFile(
    path.join(outputDir, "src", "ui", "index.tsx"),
    `import { usePluginAction, usePluginData, type PluginHostContextProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
};

export function DashboardWidget(_props: PluginHostContextProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");
  const ping = usePluginAction("ping");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>${displayName}</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      <button onClick={() => void ping()}>Ping Worker</button>
    </div>
  );
}
`,
  );

  writeFile(
    path.join(outputDir, "tests", "plugin.spec.ts"),
    `import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin scaffold", () => {
  it("exports a structurally valid canonical manifest", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toEqual(manifest);
  });

  it("registers its data and actions", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<{ status: string }>("health");
    expect(data.status).toBe("ok");

    const action = await harness.performAction<{ pong: boolean }>(
      "ping",
      {},
      { actor: { type: "user", userId: "user-1", companyId: "company-1" } },
    );
    expect(action.pong).toBe(true);
  });
});
`,
  );

  writeFile(
    path.join(outputDir, "README.md"),
    `# ${displayName}

${description}

## Development

\`\`\`bash
pnpm install
pnpm dev            # watch builds
pnpm test
\`\`\`

\`pnpm dev\` rebuilds the worker, manifest, and UI bundles into \`dist/\`.
When this package is installed from a local path, Paperclip watches that rebuilt
output and reloads the plugin worker. Local installs run trusted code from this
folder on your machine.

${sdkDependency.startsWith("file:")
  ? `This scaffold snapshots \`@paperclipai/plugin-sdk\` and its internal \`@paperclipai/shared\` dependency from a local Paperclip checkout at:\n\n\`${toPosixPath(localSdkPath)}\`\n\nThe packed tarballs live in \`.paperclip-sdk/\` for local development. Before publishing this plugin, switch the SDK dependency to a published package version and remove the local shared-package override once they are available on npm.\n\n`
  : ""}

## Install Into Paperclip

\`\`\`bash
paperclipai plugin install --local ${shellQuote(toPosixPath(outputDir))}
\`\`\`

## Build Options

- \`pnpm build\` uses esbuild presets from \`@paperclipai/plugin-sdk/bundlers\`.
`,
  );

  writeFile(path.join(outputDir, ".gitignore"), "dist\nnode_modules\n.paperclip-sdk\n");

  return outputDir;
}
