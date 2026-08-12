import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  pluginPackageNameSchema,
  type PluginCatalogEntryDto,
} from "@paperclipai/shared";
import { isPathContained } from "./plugin-paths.js";

const execFileAsync = promisify(execFile);
const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(serviceDir, "../../../../");
const PLUGIN_BUILD_TIMEOUT_MS = 120_000;
const SKIPPED_DIRECTORY_NAMES = new Set(["dist", "node_modules"]);

type BuildRunner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number },
) => Promise<unknown>;

export interface PluginCatalogServiceOptions {
  /** Explicit roots are used by focused tests and do not require checkout markers. */
  repoRoot?: string;
  runBuild?: BuildRunner;
}

interface CatalogPackage {
  entry: PluginCatalogEntryDto;
  packageJsonPath: string;
  packageRoot: string;
}

export class PluginCatalogOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginCatalogOperationError";
  }
}

function nonblankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function titleCasePluginName(packageName: string): string {
  const localName = packageName.split("/").pop() ?? packageName;
  return localName
    .replace(/^paperclip-plugin-/, "")
    .replace(/^plugin-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function firstStringLiteral(source: string, key: string): string | null {
  const match = source.match(
    new RegExp(`\\b${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`, "s"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function pathIsFileOrDirectory(filePath: string): Promise<boolean> {
  try {
    const value = await stat(filePath);
    return value.isFile() || value.isDirectory();
  } catch {
    return false;
  }
}

async function isSourceCheckout(repoRoot: string): Promise<boolean> {
  return (
    (await pathIsFileOrDirectory(path.join(repoRoot, ".git"))) &&
    (await pathIsFile(path.join(repoRoot, "pnpm-workspace.yaml")))
  );
}

async function findPackageJsonFiles(pluginRoot: string): Promise<string[]> {
  const packageJsonFiles: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        SKIPPED_DIRECTORY_NAMES.has(entry.name)
      ) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === "package.json") {
        packageJsonFiles.push(entryPath);
      }
    }
  }

  await walk(pluginRoot);
  return packageJsonFiles;
}

async function sourceManifestMetadata(
  packageRoot: string,
  manifestDeclaration: string,
): Promise<{ displayName?: string; description?: string }> {
  const sourceDeclaration = manifestDeclaration
    .replace(/^\.\/dist\//, "./src/")
    .replace(/\.js$/, ".ts");
  if (path.isAbsolute(sourceDeclaration)) return {};

  const sourcePath = path.resolve(packageRoot, sourceDeclaration);
  if (
    !isPathContained(packageRoot, sourcePath) ||
    !(await pathIsFile(sourcePath))
  ) {
    return {};
  }

  try {
    const canonicalSourcePath = await realpath(sourcePath);
    if (!isPathContained(packageRoot, canonicalSourcePath)) return {};
    const source = await readFile(canonicalSourcePath, "utf8");
    return {
      displayName: firstStringLiteral(source, "displayName") ?? undefined,
      description: firstStringLiteral(source, "description") ?? undefined,
    };
  } catch {
    return {};
  }
}

async function declaredManifestIsBuilt(
  packageRoot: string,
  manifestPath: string,
): Promise<boolean> {
  if (!(await pathIsFile(manifestPath))) return false;
  try {
    const canonicalManifest = await realpath(manifestPath);
    return (
      isPathContained(packageRoot, canonicalManifest) &&
      (await stat(canonicalManifest)).isFile()
    );
  } catch {
    return false;
  }
}

async function inspectPackage(
  repoRoot: string,
  pluginRoot: string,
  packageJsonPath: string,
): Promise<CatalogPackage | null> {
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  const packageNameResult = pluginPackageNameSchema.safeParse(packageJson.name);
  const version = nonblankString(packageJson.version);
  const pluginDeclaration = packageJson.paperclipPlugin;
  if (
    !packageNameResult.success ||
    !version ||
    !pluginDeclaration ||
    typeof pluginDeclaration !== "object" ||
    Array.isArray(pluginDeclaration)
  ) {
    return null;
  }

  const manifestDeclaration = nonblankString(
    (pluginDeclaration as Record<string, unknown>).manifest,
  );
  if (!manifestDeclaration || path.isAbsolute(manifestDeclaration)) return null;

  const packageRoot = await realpath(path.dirname(packageJsonPath)).catch(
    () => null,
  );
  if (!packageRoot || !isPathContained(pluginRoot, packageRoot)) return null;
  const manifestPath = path.resolve(packageRoot, manifestDeclaration);
  if (!isPathContained(packageRoot, manifestPath)) return null;

  const metadata = await sourceManifestMetadata(
    packageRoot,
    manifestDeclaration,
  );
  const relativePath = path
    .relative(repoRoot, packageRoot)
    .split(path.sep)
    .join("/");
  const description =
    metadata.description ??
    nonblankString(packageJson.description) ??
    `Local Paperclip plugin from ${relativePath}.`;

  return {
    entry: {
      packageName: packageNameResult.data,
      version,
      displayName:
        metadata.displayName ?? titleCasePluginName(packageNameResult.data),
      description,
      relativePath,
      kind: relativePath.startsWith("packages/plugins/examples/")
        ? "example"
        : "first_party",
      built: await declaredManifestIsBuilt(packageRoot, manifestPath),
    },
    packageJsonPath,
    packageRoot,
  };
}

export function pluginCatalogService(
  options: PluginCatalogServiceOptions = {},
) {
  const configuredRepoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const requireCheckoutMarkers = options.repoRoot === undefined;
  const runBuild: BuildRunner =
    options.runBuild ??
    (async (file, args, execOptions) => {
      await execFileAsync(file, [...args], execOptions);
    });
  const operationTails = new Map<string, Promise<void>>();

  async function resolveRoots(): Promise<{
    repoRoot: string;
    pluginRoot: string;
  } | null> {
    if (
      requireCheckoutMarkers &&
      !(await isSourceCheckout(configuredRepoRoot))
    ) {
      return null;
    }
    const repoRoot = await realpath(configuredRepoRoot).catch(() => null);
    if (!repoRoot) {
      throw new PluginCatalogOperationError(
        "Plugin catalog is unavailable in this source checkout",
      );
    }
    const pluginRoot = await realpath(
      path.join(repoRoot, "packages", "plugins"),
    ).catch(() => null);
    if (!pluginRoot || !isPathContained(repoRoot, pluginRoot)) {
      throw new PluginCatalogOperationError(
        "Plugin catalog is unavailable in this source checkout",
      );
    }
    return { repoRoot, pluginRoot };
  }

  async function discover(): Promise<CatalogPackage[]> {
    const roots = await resolveRoots();
    if (!roots) return [];

    let packageJsonFiles: string[];
    try {
      packageJsonFiles = await findPackageJsonFiles(roots.pluginRoot);
    } catch {
      throw new PluginCatalogOperationError(
        "Plugin catalog could not be read from this source checkout",
      );
    }

    const inspected = await Promise.all(
      packageJsonFiles.map((packageJsonPath) =>
        inspectPackage(roots.repoRoot, roots.pluginRoot, packageJsonPath),
      ),
    );
    const packages = inspected.filter(
      (entry): entry is CatalogPackage => entry !== null,
    );
    const nameCounts = new Map<string, number>();
    for (const pluginPackage of packages) {
      nameCounts.set(
        pluginPackage.entry.packageName,
        (nameCounts.get(pluginPackage.entry.packageName) ?? 0) + 1,
      );
    }

    return packages
      .filter(
        (pluginPackage) =>
          nameCounts.get(pluginPackage.entry.packageName) === 1,
      )
      .sort((left, right) => {
        if (left.entry.kind !== right.entry.kind) {
          return left.entry.kind === "first_party" ? -1 : 1;
        }
        return (
          left.entry.displayName.localeCompare(right.entry.displayName) ||
          left.entry.packageName.localeCompare(right.entry.packageName)
        );
      });
  }

  async function serialize<T>(
    packageName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = operationTails.get(packageName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    operationTails.set(packageName, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (operationTails.get(packageName) === current) {
        operationTails.delete(packageName);
      }
    }
  }

  return {
    list: async (): Promise<PluginCatalogEntryDto[]> =>
      (await discover()).map(({ entry }) => entry),

    install: async <T>(
      packageName: string,
      dependencies: {
        isInstalled(): Promise<boolean>;
        install(packageRoot: string): Promise<T>;
      },
    ): Promise<T> =>
      serialize(packageName, async () => {
        const selected = (await discover()).find(
          (entry) => entry.entry.packageName === packageName,
        );
        if (!selected) {
          throw new PluginCatalogOperationError(
            `Catalog plugin not found: ${packageName}`,
          );
        }

        let alreadyInstalled: boolean;
        try {
          alreadyInstalled = await dependencies.isInstalled();
        } catch {
          throw new PluginCatalogOperationError(
            `Could not verify catalog plugin installation state: ${packageName}`,
          );
        }
        if (alreadyInstalled) {
          throw new PluginCatalogOperationError(
            `Plugin package is already installed: ${packageName}`,
          );
        }

        const roots = await resolveRoots();
        if (!roots) {
          throw new PluginCatalogOperationError(
            `Catalog plugin not found: ${packageName}`,
          );
        }
        try {
          await runBuild("pnpm", ["--filter", packageName, "build"], {
            cwd: roots.repoRoot,
            timeout: PLUGIN_BUILD_TIMEOUT_MS,
          });
        } catch {
          throw new PluginCatalogOperationError(
            `Failed to build catalog plugin: ${packageName}`,
          );
        }

        const rebuilt = await inspectPackage(
          roots.repoRoot,
          roots.pluginRoot,
          selected.packageJsonPath,
        );
        if (
          !rebuilt ||
          rebuilt.entry.packageName !== packageName ||
          rebuilt.entry.relativePath !== selected.entry.relativePath ||
          !rebuilt.entry.built
        ) {
          throw new PluginCatalogOperationError(
            `Catalog plugin build did not produce its declared manifest: ${packageName}`,
          );
        }

        try {
          return await dependencies.install(rebuilt.packageRoot);
        } catch {
          throw new PluginCatalogOperationError(
            `Failed to install catalog plugin: ${packageName}`,
          );
        }
      }),
  };
}
