import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginCatalogService } from "../services/plugin-catalog.js";

const cleanupRoots = new Set<string>();

async function createRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-catalog-"));
  cleanupRoots.add(repoRoot);
  await mkdir(path.join(repoRoot, "packages", "plugins"), { recursive: true });
  return repoRoot;
}

async function createPlugin(
  repoRoot: string,
  relativePath: string,
  options: {
    name?: string;
    version?: string;
    manifest?: string;
    built?: boolean;
    declaration?: boolean;
  } = {},
) {
  const packageRoot = path.join(repoRoot, relativePath);
  const manifest = options.manifest ?? "./dist/manifest.js";
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: options.name ?? `@paperclipai/plugin-${randomUUID().slice(0, 8)}`,
    version: options.version ?? "0.1.0",
    description: "Package description",
    ...(options.declaration === false
      ? {}
      : { paperclipPlugin: { manifest } }),
  }), "utf8");
  await writeFile(path.join(packageRoot, "src", "manifest.ts"), [
    "export default {",
    '  displayName: "Fixture Plugin",',
    '  description: "Manifest description",',
    "};",
  ].join("\n"), "utf8");
  if (options.built) {
    const manifestPath = path.resolve(packageRoot, manifest);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, "export default {};\n", "utf8");
  }
  return packageRoot;
}

afterEach(async () => {
  for (const root of cleanupRoots) {
    await rm(root, { recursive: true, force: true });
  }
  cleanupRoots.clear();
});

describe("repo plugin catalog discovery", () => {
  it("lists declared first-party and example packages without exposing absolute paths", async () => {
    const repoRoot = await createRepo();
    await createPlugin(repoRoot, "packages/plugins/agentmemory", {
      name: "@paperclipai/plugin-agentmemory",
      built: true,
    });
    await createPlugin(repoRoot, "packages/plugins/examples/example", {
      name: "@paperclipai/plugin-example",
    });
    await createPlugin(repoRoot, "packages/plugins/sdk", {
      name: "@paperclipai/plugin-sdk",
      declaration: false,
    });
    await createPlugin(repoRoot, "packages/plugins/dist/ignored", {
      name: "@paperclipai/plugin-dist-ignored",
    });
    await createPlugin(repoRoot, "packages/plugins/node_modules/ignored", {
      name: "@paperclipai/plugin-dependency-ignored",
    });
    await createPlugin(repoRoot, "packages/plugins/.hidden/ignored", {
      name: "@paperclipai/plugin-hidden-ignored",
    });
    await createPlugin(repoRoot, "packages/plugins/escape", {
      name: "@paperclipai/plugin-escape",
      manifest: "../../outside.js",
    });

    const entries = await pluginCatalogService({ repoRoot }).list();

    expect(entries).toEqual([
      {
        packageName: "@paperclipai/plugin-agentmemory",
        version: "0.1.0",
        displayName: "Fixture Plugin",
        description: "Manifest description",
        relativePath: "packages/plugins/agentmemory",
        kind: "first_party",
        built: true,
      },
      {
        packageName: "@paperclipai/plugin-example",
        version: "0.1.0",
        displayName: "Fixture Plugin",
        description: "Manifest description",
        relativePath: "packages/plugins/examples/example",
        kind: "example",
        built: false,
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(repoRoot);
  });

  it("rescans the checkout on every list and excludes ambiguous package names", async () => {
    const repoRoot = await createRepo();
    const service = pluginCatalogService({ repoRoot });
    expect(await service.list()).toEqual([]);

    await createPlugin(repoRoot, "packages/plugins/one", {
      name: "@paperclipai/plugin-duplicate",
    });
    expect(await service.list()).toHaveLength(1);

    await createPlugin(repoRoot, "packages/plugins/two", {
      name: "@paperclipai/plugin-duplicate",
    });
    expect(await service.list()).toEqual([]);
  });

  it("never reads source metadata through a symlink outside the package", async () => {
    const repoRoot = await createRepo();
    const packageRoot = await createPlugin(repoRoot, "packages/plugins/symlink-metadata", {
      name: "@paperclipai/plugin-symlink-metadata",
    });
    const outsideSource = path.join(repoRoot, "outside-manifest.ts");
    await writeFile(outsideSource, [
      "export default {",
      '  displayName: "Leaked host metadata",',
      '  description: "This should never be read",',
      "};",
    ].join("\n"));
    await unlink(path.join(packageRoot, "src", "manifest.ts"));
    await symlink(outsideSource, path.join(packageRoot, "src", "manifest.ts"));

    const entries = await pluginCatalogService({ repoRoot }).list();

    expect(entries).toEqual([expect.objectContaining({
      packageName: "@paperclipai/plugin-symlink-metadata",
      displayName: "Symlink Metadata",
      description: "Package description",
    })]);
    expect(JSON.stringify(entries)).not.toContain("Leaked host metadata");
    expect(JSON.stringify(entries)).not.toContain("This should never be read");
  });

  it("surfaces an unavailable checkout catalog instead of reporting an empty list", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-catalog-missing-"));
    cleanupRoots.add(repoRoot);

    await expect(pluginCatalogService({ repoRoot }).list()).rejects.toThrow(
      "Plugin catalog is unavailable in this source checkout",
    );
  });
});

describe("repo plugin catalog installation", () => {
  it("runs the exact bounded workspace build then installs the canonical package root", async () => {
    const repoRoot = await createRepo();
    const packageName = "@paperclipai/plugin-install-fixture";
    const packageRoot = await createPlugin(repoRoot, "packages/plugins/install-fixture", {
      name: packageName,
    });
    const runBuild = vi.fn(async () => {
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "dist", "manifest.js"), "export default {};\n");
    });
    const install = vi.fn(async () => "installed");

    const result = await pluginCatalogService({ repoRoot, runBuild }).install(
      packageName,
      { isInstalled: async () => false, install },
    );

    expect(result).toBe("installed");
    expect(runBuild).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", packageName, "build"],
      { cwd: repoRoot, timeout: 120_000 },
    );
    expect(install).toHaveBeenCalledWith(packageRoot);
    expect(path.isAbsolute(install.mock.calls[0]![0])).toBe(true);
  });

  it("checks installed state before build and repeats that check inside the package lock", async () => {
    const repoRoot = await createRepo();
    const packageName = "@paperclipai/plugin-single-flight";
    const packageRoot = await createPlugin(repoRoot, "packages/plugins/single-flight", {
      name: packageName,
    });
    let installed = false;
    const runBuild = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "dist", "manifest.js"), "export default {};\n");
    });
    const service = pluginCatalogService({ repoRoot, runBuild });
    const dependencies = {
      isInstalled: async () => installed,
      install: async () => {
        installed = true;
        return "installed";
      },
    };

    const results = await Promise.allSettled([
      service.install(packageName, dependencies),
      service.install(packageName, dependencies),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(runBuild).toHaveBeenCalledTimes(1);
    expect(results[1]).toMatchObject({
      reason: { message: `Plugin package is already installed: ${packageName}` },
    });
  });

  it("requires the declared manifest after build and never exposes command diagnostics", async () => {
    const repoRoot = await createRepo();
    const packageName = "@paperclipai/plugin-build-failure";
    await createPlugin(repoRoot, "packages/plugins/build-failure", { name: packageName });

    const missingManifestService = pluginCatalogService({
      repoRoot,
      runBuild: vi.fn().mockResolvedValue(undefined),
    });
    await expect(missingManifestService.install(packageName, {
      isInstalled: async () => false,
      install: vi.fn(),
    })).rejects.toThrow(
      `Catalog plugin build did not produce its declared manifest: ${packageName}`,
    );

    const failedBuildService = pluginCatalogService({
      repoRoot,
      runBuild: vi.fn().mockRejectedValue(Object.assign(
        new Error("secret stderr /absolute/plugin/path"),
        { stderr: "SUPER_SECRET_ENV=value" },
      )),
    });
    const error = await failedBuildService.install(packageName, {
      isInstalled: async () => false,
      install: vi.fn(),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: `Failed to build catalog plugin: ${packageName}`,
    });
    expect(JSON.stringify(error)).not.toContain("SUPER_SECRET");
    expect((error as Error).message).not.toContain("/absolute/");
  });

  it("rejects a package identity changed by its build before installation", async () => {
    const repoRoot = await createRepo();
    const packageName = "@paperclipai/plugin-mutated-build";
    const packageRoot = await createPlugin(repoRoot, "packages/plugins/mutated-build", {
      name: packageName,
    });
    const install = vi.fn();
    const service = pluginCatalogService({
      repoRoot,
      runBuild: async () => {
        await mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await writeFile(path.join(packageRoot, "dist", "manifest.js"), "export default {};\n");
        await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
          name: "@paperclipai/plugin-replaced-during-build",
          version: "0.1.0",
          paperclipPlugin: { manifest: "./dist/manifest.js" },
        }));
      },
    });

    await expect(service.install(packageName, {
      isInstalled: async () => false,
      install,
    })).rejects.toThrow(
      `Catalog plugin build did not produce its declared manifest: ${packageName}`,
    );
    expect(install).not.toHaveBeenCalled();
  });
});
