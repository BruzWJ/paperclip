import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonSchema, PaperclipPluginManifestV1, PluginInstallRequest } from "@paperclipai/shared";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { assertJsonSchemaCompiles } from "./plugin-config-validator.js";
import { execFileAsync, type ResolvedPluginPackage, type ParsedSemver } from "./plugin-loader-contracts.js";
import { resolveManagedInstallPackageDir } from "./plugin-loader-runtime-lifecycle.js";
import { type PluginLoaderContext } from "./plugin-loader.js";
import { buildPluginLoaderRuntimeLifecycle } from "./plugin-loader-runtime-lifecycle.js";

import { resolvePluginPath } from "./plugin-paths.js";

interface ManifestValidationDetail {
  path: (string | number)[];
  message: string;
}

function rejectInvalidManifest(details: ManifestValidationDetail[]): never {
  const summary = details
    .map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message))
    .join("; ");
  throw badRequest(`Invalid plugin manifest: ${summary}`, details);
}

function declaredInputSchemas(manifest: PaperclipPluginManifestV1): Array<{
  path: (string | number)[];
  schema: JsonSchema;
}> {
  return [
    ...(manifest.instanceConfigSchema
      ? [
          {
            path: ["instanceConfigSchema"],
            schema: manifest.instanceConfigSchema,
          },
        ]
      : []),
    ...(manifest.tools ?? []).map((tool, index) => ({
      path: ["tools", index, "parametersSchema"],
      schema: tool.parametersSchema,
    })),
  ];
}

/** Parse the one manifest contract accepted by this host. */
function parsePluginManifest(input: unknown): PaperclipPluginManifestV1 {
  const result = pluginManifestV1Schema.safeParse(input);
  if (!result.success) {
    rejectInvalidManifest(
      result.error.errors.map((detail) => ({
        path: detail.path,
        message: detail.message,
      })),
    );
  }

  const schemaDiagnostics: ManifestValidationDetail[] = [];
  for (const declaration of declaredInputSchemas(result.data)) {
    try {
      assertJsonSchemaCompiles(declaration.schema);
    } catch (error) {
      schemaDiagnostics.push({
        path: declaration.path,
        message: `JSON Schema does not compile: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (schemaDiagnostics.length > 0) rejectInvalidManifest(schemaDiagnostics);
  return result.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the required package.json from a directory path.
 */
export async function readPackageJson(dir: string): Promise<Record<string, unknown>> {
  const pkgPath = path.join(dir, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf-8");
  } catch (err) {
    throw new Error(`Unable to read plugin package.json at ${pkgPath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed plugin package.json at ${pkgPath}: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Plugin package.json must contain a JSON object: ${pkgPath}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the manifest entrypoint from a package.json and package root.
 *
 * The spec defines a "paperclipPlugin" key in package.json with a "manifest"
 * subkey pointing to the manifest module.  This helper resolves the path.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export function resolveManifestPath(packageRoot: string, pkgJson: Record<string, unknown>): string {
  const paperclipPlugin = pkgJson["paperclipPlugin"];
  if (paperclipPlugin === null || typeof paperclipPlugin !== "object" || Array.isArray(paperclipPlugin)) {
    throw new Error("package.json must declare paperclipPlugin.manifest");
  }

  const manifestRelPath = (paperclipPlugin as Record<string, unknown>)["manifest"];
  if (typeof manifestRelPath !== "string" || manifestRelPath.trim().length === 0) {
    throw new Error("package.json must declare paperclipPlugin.manifest");
  }

  return resolvePluginPath(packageRoot, manifestRelPath, {
    label: "paperclipPlugin.manifest",
    kind: "file",
  });
}

export function parseSemver(version: string): ParsedSemver | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }

  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}

export function compareSemver(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (!leftParsed || !rightParsed) {
    throw new Error(`Invalid semver comparison: '${left}' vs '${right}'`);
  }

  const coreOrder = (["major", "minor", "patch"] as const)
    .map((key) => leftParsed[key] - rightParsed[key])
    .find((delta) => delta !== 0);
  if (coreOrder) {
    return coreOrder;
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }
  if (leftParsed.prerelease.length === 0) return 1;
  if (rightParsed.prerelease.length === 0) return -1;

  const maxLength = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftId = leftParsed.prerelease[index];
    const rightId = rightParsed.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;

    const diff = compareIdentifiers(leftId, rightId);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function buildPluginLoaderDiscovery(
  scope: PluginLoaderContext & ReturnType<typeof buildPluginLoaderRuntimeLifecycle>,
) {
  const { localPluginDir, log, requireRuntimeServices } = scope;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a plugin from npm or local path, then parse and validate its manifest.
   *
   * This internal helper encapsulates the core plugin retrieval and validation
   * logic used by both install and upgrade operations. It handles:
   * 1. Resolving the package from npm or local filesystem.
   * 2. Installing the package via npm if necessary.
   * 3. Reading and parsing the plugin manifest.
   * 4. Validating API version compatibility.
   * 5. Validating manifest capabilities.
   *
   * @param installOptions - Options specifying the package to fetch.
   * @returns The resolved package and validated manifest.
   */
  async function fetchAndValidate(installOptions: PluginInstallRequest): Promise<ResolvedPluginPackage> {
    const hostVersion = requireRuntimeServices("validate plugin package").instanceInfo.hostVersion;
    let managedInstallRoot: string | null = null;

    try {
      let resolvedPackagePath: string;

      if (installOptions.source === "local") {
        if (!path.isAbsolute(installOptions.path)) {
          throw new Error("Local plugin path must be absolute");
        }
        if (!existsSync(installOptions.path)) {
          throw new Error(`Local plugin path does not exist: ${installOptions.path}`);
        }
        resolvedPackagePath = realpathSync(installOptions.path);
      } else {
        const spec = installOptions.version
          ? `${installOptions.packageName}@${installOptions.version}`
          : installOptions.packageName;
        await mkdir(localPluginDir, { recursive: true });
        managedInstallRoot = await mkdtemp(path.join(localPluginDir, "install-"));

        log.info({ spec, installRoot: managedInstallRoot }, "plugin-loader: fetching plugin from npm");

        try {
          // A candidate gets its own immutable dependency tree. It cannot
          // alter any installed plugin before validation and persistence.
          await execFileAsync(
            "npm",
            ["install", "--prefix", managedInstallRoot, "--save", "--ignore-scripts", "--", spec],
            { timeout: 120_000 },
          );
        } catch (err) {
          throw new Error(`npm install failed for ${spec}: ${String(err)}`);
        }

        resolvedPackagePath = resolveManagedInstallPackageDir(managedInstallRoot, installOptions.packageName);
        if (!existsSync(resolvedPackagePath)) {
          throw new Error(`Package directory not found after installation: ${resolvedPackagePath}`);
        }
        resolvedPackagePath = realpathSync(resolvedPackagePath);
      }

      const pkgJson = await readPackageJson(resolvedPackagePath);
      const declaredPackageName = pkgJson["name"];
      const declaredPackageVersion = pkgJson["version"];
      if (typeof declaredPackageName !== "string" || declaredPackageName.trim().length === 0) {
        throw new Error(`Plugin package.json must declare a nonblank name: ${resolvedPackagePath}`);
      }
      if (installOptions.source === "npm" && declaredPackageName !== installOptions.packageName) {
        throw new Error(
          `Requested package name '${installOptions.packageName}' does not match package.json name '${declaredPackageName}'`,
        );
      }
      if (typeof declaredPackageVersion !== "string" || !parseSemver(declaredPackageVersion)) {
        throw new Error(`Plugin package.json must declare a valid semver version: ${resolvedPackagePath}`);
      }

      const manifestPath = resolveManifestPath(resolvedPackagePath, pkgJson);
      const manifest = await loadManifestFromPath(manifestPath);
      if (manifest.version !== declaredPackageVersion) {
        throw new Error(
          `Plugin manifest version '${manifest.version}' does not match package.json version '${declaredPackageVersion}'`,
        );
      }

      if (installOptions.source === "local") {
        log.info(
          { path: resolvedPackagePath, packageName: declaredPackageName },
          "plugin-loader: fetching plugin from local path",
        );
      }

      const minimumHostVersion = manifest.minimumHostVersion;
      if (minimumHostVersion && compareSemver(hostVersion, minimumHostVersion) < 0) {
        throw new Error(
          `Plugin ${manifest.id} requires host version ${minimumHostVersion} or newer, ` +
            `but this server is running ${hostVersion}`,
        );
      }

      return {
        packagePath: resolvedPackagePath,
        packageName: declaredPackageName,
        version: declaredPackageVersion,
        source: installOptions.source,
        manifest,
        managedInstallRoot,
      };
    } catch (err) {
      if (managedInstallRoot) {
        await rm(managedInstallRoot, { recursive: true, force: true }).catch((cleanupError) => {
          log.warn(
            { installRoot: managedInstallRoot, err: cleanupError },
            "plugin-loader: failed to discard rejected npm candidate",
          );
        });
      }
      throw err;
    }
  }

  /**
   * Attempt to load and validate a plugin manifest from a resolved path.
   * Returns the manifest on success or throws with a descriptive error.
   */
  async function loadManifestFromPath(manifestPath: string): Promise<PaperclipPluginManifestV1> {
    let raw: unknown;

    try {
      // Dynamic import works for both .js (ESM) and .cjs (CJS) manifests
      const manifestUrl = pathToFileURL(manifestPath);
      const manifestStat = await stat(manifestPath);
      manifestUrl.searchParams.set("mtime", String(Math.trunc(manifestStat.mtimeMs)));
      const mod = (await import(manifestUrl.href)) as Record<string, unknown>;
      if (!("default" in mod)) {
        throw new Error("Manifest module must provide a default export");
      }
      raw = mod["default"];
    } catch (err) {
      throw new Error(`Failed to load manifest module at ${manifestPath}: ${String(err)}`);
    }

    return parsePluginManifest(raw);
  }

  return { fetchAndValidate, loadManifestFromPath };
}
