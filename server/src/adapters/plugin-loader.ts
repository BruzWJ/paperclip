/**
 * External adapter plugin loader.
 *
 * Loads external adapter packages from the adapter-plugin-store and returns
 * their ServerAdapterModule instances. The caller (registry.ts) is
 * responsible for registering them.
 *
 * This avoids circular initialization: plugin-loader imports only
 * adapter-utils, never registry.ts.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateServerAdapterModule,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  adapterImplementationIdentityKey,
  isAdapterImplementationIdentity,
  type AdapterImplementationIdentity,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipHomeDir } from "../home-paths.js";

import {
  listAdapterPlugins,
  getAdapterPluginByType,
  getAdapterPluginsDir,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import {
  attachAdapterImplementationIdentity,
  createAdapterImplementationIdentity,
  digestAdapterArtifact,
} from "./implementation-identity.js";

const RETAINED_MANIFEST_VERSION =
  "paperclip.retained-adapter-implementation/v1" as const;

interface RetainedAdapterImplementationManifest {
  version: typeof RETAINED_MANIFEST_VERSION;
  identity: AdapterImplementationIdentity;
  artifactDirectory: "artifact";
  retainedAt: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolvePackageDir(record: Pick<AdapterPluginRecord, "localPath" | "packageName">): string {
  return record.localPath
    ? path.resolve(record.localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

function resolvePackageEntryPoint(packageDir: string): string {
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

  if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["."]) {
    const exp = pkg.exports["."];
    return typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
  }
  return pkg.main ?? "index.js";
}

function retainedImplementationsDir(): string {
  return path.resolve(
    resolvePaperclipHomeDir(),
    "adapter-plugins",
    "implementations",
  );
}

function retainedDirectoryName(
  identity: AdapterImplementationIdentity,
): string {
  return createHash("sha256")
    .update(adapterImplementationIdentityKey(identity), "utf8")
    .digest("hex");
}

function packageIdentityMetadata(
  packageDir: string,
): { packageName: string; packageVersion: string } {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    typeof parsed.name !== "string" ||
    !parsed.name.trim() ||
    typeof parsed.version !== "string" ||
    !parsed.version.trim()
  ) {
    throw new Error(
      "External adapter package requires exact package name and version metadata",
    );
  }
  return {
    packageName: parsed.name.trim(),
    packageVersion: parsed.version.trim(),
  };
}

function readRetainedManifest(
  implementationDir: string,
): RetainedAdapterImplementationManifest {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(implementationDir, "identity.json"), "utf8"),
  ) as Partial<RetainedAdapterImplementationManifest>;
  if (
    parsed.version !== RETAINED_MANIFEST_VERSION ||
    parsed.artifactDirectory !== "artifact" ||
    !isAdapterImplementationIdentity(parsed.identity) ||
    parsed.identity.origin !== "external" ||
    typeof parsed.retainedAt !== "string"
  ) {
    throw new Error("Retained adapter implementation manifest is invalid");
  }
  return parsed as RetainedAdapterImplementationManifest;
}

function verifyRetainedImplementation(
  implementationDir: string,
  expectedIdentity?: AdapterImplementationIdentity,
): {
  identity: AdapterImplementationIdentity;
  artifactDir: string;
} {
  const manifest = readRetainedManifest(implementationDir);
  if (
    expectedIdentity &&
    adapterImplementationIdentityKey(manifest.identity) !==
      adapterImplementationIdentityKey(expectedIdentity)
  ) {
    throw new Error("Retained adapter implementation identity changed");
  }
  const artifactDir = path.join(
    implementationDir,
    manifest.artifactDirectory,
  );
  if (
    digestAdapterArtifact(artifactDir) !==
    manifest.identity.artifactDigest
  ) {
    throw new Error("Retained adapter implementation content digest changed");
  }
  return { identity: manifest.identity, artifactDir };
}

function materializeExternalImplementation(
  packageDir: string,
  identity: AdapterImplementationIdentity,
): string {
  const root = retainedImplementationsDir();
  fs.mkdirSync(root, { recursive: true });
  const implementationDir = path.join(
    root,
    retainedDirectoryName(identity),
  );
  if (fs.existsSync(implementationDir)) {
    return verifyRetainedImplementation(implementationDir, identity).artifactDir;
  }

  const temporaryDir = fs.mkdtempSync(
    path.join(root, ".retaining-"),
  );
  try {
    const artifactDir = path.join(temporaryDir, "artifact");
    const sourceRoot = path.resolve(packageDir);
    fs.cpSync(sourceRoot, artifactDir, {
      recursive: true,
      dereference: false,
      filter(source) {
        if (path.resolve(source) === sourceRoot) return true;
        const relative = path.relative(sourceRoot, source);
        return !relative
          .split(path.sep)
          .some((segment) => segment === ".git" || segment === "node_modules");
      },
    });
    if (digestAdapterArtifact(artifactDir) !== identity.artifactDigest) {
      throw new Error(
        "Adapter package changed while its implementation was materialized",
      );
    }
    const manifest: RetainedAdapterImplementationManifest = {
      version: RETAINED_MANIFEST_VERSION,
      identity,
      artifactDirectory: "artifact",
      retainedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(temporaryDir, "identity.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      fs.renameSync(temporaryDir, implementationDir);
    } catch (error) {
      if (!fs.existsSync(implementationDir)) throw error;
    }
  } finally {
    if (fs.existsSync(temporaryDir)) {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  }
  return verifyRetainedImplementation(implementationDir, identity).artifactDir;
}

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

function validateAdapterModule(mod: unknown, packageName: string): ServerAdapterModule {
  const m = mod as Record<string, unknown>;
  const createServerAdapter = m.createServerAdapter;
  if (typeof createServerAdapter !== "function") {
    throw new Error(
      `Package "${packageName}" does not export createServerAdapter(). ` +
      `Ensure the package's main entry exports a createServerAdapter function.`,
    );
  }

  try {
    return validateServerAdapterModule(createServerAdapter());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid module: ${message}`,
      { cause: error },
    );
  }
}

async function loadMaterializedExternalAdapter(input: {
  artifactDir: string;
  identity: AdapterImplementationIdentity;
}): Promise<ServerAdapterModule> {
  const entryPoint = resolvePackageEntryPoint(input.artifactDir);
  const modulePath = path.resolve(input.artifactDir, entryPoint);
  const relativeEntryPoint = path.relative(input.artifactDir, modulePath);
  if (
    relativeEntryPoint.startsWith("..") ||
    path.isAbsolute(relativeEntryPoint)
  ) {
    throw new Error("Adapter package entry point escapes its retained artifact");
  }
  const moduleUrl = pathToFileURL(modulePath);
  moduleUrl.searchParams.set(
    "paperclipImplementation",
    input.identity.artifactDigest,
  );
  const mod = await import(moduleUrl.href);
  const adapterModule = validateAdapterModule(
    mod,
    input.identity.packageName,
  );
  if (adapterModule.type !== input.identity.adapterType) {
    throw new Error(
      "Retained adapter module type does not match its implementation identity",
    );
  }
  attachAdapterImplementationIdentity(adapterModule, input.identity);

  return adapterModule;
}

export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
): Promise<ServerAdapterModule> {
  const requestedPackageDir = localPath
    ? path.resolve(localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", packageName);
  const packageDir = fs.realpathSync(requestedPackageDir);

  const artifactDigest = digestAdapterArtifact(packageDir);
  const metadata = packageIdentityMetadata(packageDir);
  const buildIdentity = `${metadata.packageName}@${metadata.packageVersion}`;
  const entryPoint = resolvePackageEntryPoint(packageDir);
  const modulePath = path.resolve(packageDir, entryPoint);
  const moduleUrl = pathToFileURL(modulePath);
  moduleUrl.searchParams.set("paperclipTypeDiscovery", artifactDigest);
  const mod = await import(moduleUrl.href);
  const discoveredAdapter = validateAdapterModule(
    mod,
    metadata.packageName,
  );
  const identity = createAdapterImplementationIdentity({
    adapterType: discoveredAdapter.type,
    origin: "external",
    packageName: metadata.packageName,
    packageVersion: metadata.packageVersion,
    buildIdentity,
    artifactDigest,
  });
  const artifactDir = materializeExternalImplementation(packageDir, identity);
  if (digestAdapterArtifact(packageDir) !== artifactDigest) {
    throw new Error(
      "Adapter package changed while its implementation was loaded",
    );
  }

  logger.info(
    {
      packageName: metadata.packageName,
      packageVersion: metadata.packageVersion,
      packageDir,
      entryPoint,
      artifactDigest,
    },
    "Loading immutable external adapter implementation",
  );
  return loadMaterializedExternalAdapter({
    artifactDir,
    identity,
  });
}

async function loadFromRecord(record: AdapterPluginRecord): Promise<ServerAdapterModule | null> {
  try {
    return await loadExternalAdapterPackage(record.packageName, record.localPath);
  } catch (err) {
    logger.warn(
      { err, packageName: record.packageName, type: record.type },
      "Failed to dynamically load external adapter; skipping",
    );
    return null;
  }
}

/**
 * Reload an external adapter at runtime (dev iteration without server restart).
 * Busts the ESM module cache via a cache-busting query string.
 */
export async function reloadExternalAdapter(
  type: string,
): Promise<ServerAdapterModule | null> {
  const record = getAdapterPluginByType(type);
  if (!record) return null;

  const adapterModule = await loadExternalAdapterPackage(
    record.packageName,
    record.localPath,
  );
  if (adapterModule.type !== type) {
    throw new Error(
      `Reloaded adapter changed type from ${type} to ${adapterModule.type}`,
    );
  }
  return adapterModule;
}

/**
 * Build all external adapter modules from the plugin store.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  const storeRecords = listAdapterPlugins();
  for (const record of storeRecords) {
    const adapter = await loadFromRecord(record);
    if (adapter) {
      results.push(adapter);
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, adapters: results.map((a) => a.type) },
      "Loaded external adapters from plugin store",
    );
  }

  return results;
}

/**
 * Loads every verified content-addressed implementation without selecting it.
 * Corrupt, missing, or no-longer-loadable retained packages are unavailable
 * rather than redirected to the current package with the same adapter type.
 */
export async function buildRetainedExternalAdapters(): Promise<
  ServerAdapterModule[]
> {
  const root = retainedImplementationsDir();
  if (!fs.existsSync(root)) return [];
  const results: ServerAdapterModule[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    const implementationDir = path.join(root, name);
    try {
      if (!fs.lstatSync(implementationDir).isDirectory()) continue;
      const verified = verifyRetainedImplementation(implementationDir);
      results.push(
        await loadMaterializedExternalAdapter({
          artifactDir: verified.artifactDir,
          identity: verified.identity,
        }),
      );
    } catch (error) {
      logger.warn(
        { error, implementationDir },
        "Retained adapter implementation is unavailable; historical revisions will fail closed",
      );
    }
  }
  return results;
}
