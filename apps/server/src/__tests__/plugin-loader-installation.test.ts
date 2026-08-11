import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const installPluginInTransactionMock = vi.hoisted(() => vi.fn());
const registryMock = vi.hoisted(() => ({
  list: vi.fn(),
  listByStatus: vi.fn(),
  failInterruptedWebhookDeliveries: vi.fn(),
}));
const jobStoreMock = vi.hoisted(() => ({
  cancelAllNonTerminalRuns: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("../services/plugin-registry.js", () => ({
  installPluginInTransaction: installPluginInTransactionMock,
  lockPluginInstallationInTransaction: vi.fn(),
  lockPluginRegistryClaimsInTransaction: vi.fn(),
  pluginRegistryService: () => registryMock,
}));

import {
  pluginLoader,
  type PluginRuntimeServices,
} from "../services/plugin-loader.js";

const packageName = "paperclip-plugin-install-test";
const manifest = {
  id: "paperclip.install-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Install Test",
  description: "Exercises isolated managed installation roots.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["tasks.read"],
  entrypoints: { worker: "./worker.js" },
};
let materializedManifest: Record<string, unknown> = manifest;

const tempRoots: string[] = [];

function bindPackageValidationRuntime(loader: ReturnType<typeof pluginLoader>): void {
  loader.bindRuntimeServices({
    instanceInfo: {
      instanceId: "instance-test",
      hostVersion: "1.0.0",
      deploymentExposure: "private",
    },
    jobStore: jobStoreMock,
  } as PluginRuntimeServices);
}

function materializeNpmPackage(args: string[]): void {
  const prefixIndex = args.indexOf("--prefix");
  const installRoot = args[prefixIndex + 1];
  if (!installRoot) throw new Error("npm invocation omitted --prefix");
  const packageRoot = path.join(installRoot, "node_modules", packageName);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version: materializedManifest.version,
    paperclipPlugin: { manifest: "./manifest.mjs" },
  }));
  writeFileSync(
    path.join(packageRoot, "manifest.mjs"),
    `export default ${JSON.stringify(materializedManifest)};`,
  );
}

describe("pluginLoader managed installation roots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installPluginInTransactionMock.mockReset();
    materializedManifest = manifest;
    registryMock.list.mockResolvedValue([]);
    registryMock.listByStatus.mockResolvedValue([]);
    registryMock.failInterruptedWebhookDeliveries.mockResolvedValue(0);
    jobStoreMock.cancelAllNonTerminalRuns.mockResolvedValue(0);
    execFileMock.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        materializeNpmPackage(args);
        callback(null, "", "");
      },
    );
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  async function expectManifestAdmissionFailure(
    candidate: Record<string, unknown>,
    expectedError: RegExp,
  ) {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-invalid-manifest-"));
    tempRoots.push(localPluginDir);
    materializedManifest = candidate;
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    const loader = pluginLoader(db as never, {
      localPluginDir,
      migrationDb: db as never,
    });
    bindPackageValidationRuntime(loader);

    await expect(loader.installPlugin({ source: "npm", packageName })).rejects.toThrow(expectedError);
    expect(installPluginInTransactionMock).not.toHaveBeenCalled();
    expect(await readdir(localPluginDir)).toEqual([]);
  }

  it("discards a validated npm tree when registry persistence rejects it", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-install-reject-"));
    tempRoots.push(localPluginDir);
    installPluginInTransactionMock.mockRejectedValue(new Error("Plugin already installed"));
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    const loader = pluginLoader(db as never, {
      localPluginDir,
      migrationDb: db as never,
    });
    bindPackageValidationRuntime(loader);

    await expect(loader.installPlugin({ source: "npm", packageName })).rejects.toThrow(
      "Plugin already installed",
    );

    expect(await readdir(localPluginDir)).toEqual([]);
  });

  it("persists the package path from one isolated immutable npm tree", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-install-ready-"));
    tempRoots.push(localPluginDir);
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    installPluginInTransactionMock.mockImplementation(async (_tx: unknown, input: Record<string, unknown>) => ({
      ...input,
      id: "11111111-1111-4111-8111-111111111111",
      pluginKey: manifest.id,
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
      lastError: null,
      installedAt: new Date(),
      updatedAt: new Date(),
    }));
    const loader = pluginLoader(db as never, {
      localPluginDir,
      migrationDb: db as never,
    });
    bindPackageValidationRuntime(loader);

    const plugin = await loader.installPlugin({ source: "npm", packageName });

    expect(plugin.status).toBe("ready");
    expect(path.dirname(path.dirname(path.dirname(plugin.packagePath)))).toBe(localPluginDir);
    expect(path.basename(path.dirname(path.dirname(plugin.packagePath)))).toMatch(/^install-/);
    expect(existsSync(plugin.packagePath)).toBe(true);
    expect(installPluginInTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("persists a required-config installation as disabled", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-install-config-"));
    tempRoots.push(localPluginDir);
    materializedManifest = {
      ...manifest,
      instanceConfigSchema: {
        type: "object",
        required: ["token"],
        properties: { token: { type: "string" } },
      },
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    installPluginInTransactionMock.mockImplementation(
      async (_tx: unknown, input: Record<string, unknown>, installedManifest: Record<string, unknown>) => ({
        ...input,
        id: "11111111-1111-4111-8111-111111111111",
        pluginKey: installedManifest.id,
        manifestJson: installedManifest,
        installOrder: 1,
        lastError: null,
        installedAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const loader = pluginLoader(db as never, {
      localPluginDir,
      migrationDb: db as never,
    });
    bindPackageValidationRuntime(loader);

    const plugin = await loader.installPlugin({ source: "npm", packageName });

    expect(plugin.status).toBe("disabled");
    expect(installPluginInTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "disabled" }),
      expect.objectContaining({ id: manifest.id }),
    );
  });

  it("rejects manifest input schemas that cannot compile", async () => {
    await expectManifestAdmissionFailure({
      ...manifest,
      capabilities: ["agent.tools.register"],
      instanceConfigSchema: { type: "object", required: "token" },
      tools: [{
        name: "lookup",
        displayName: "Lookup",
        description: "Lookup a record.",
        parametersSchema: { type: "object", properties: { query: { type: "invalid" } } },
      }],
    }, /instanceConfigSchema:.*tools\.0\.parametersSchema:/);
  });

  it("rejects a final namespaced tool name beyond the MCP limit", async () => {
    await expectManifestAdmissionFailure({
      ...manifest,
      id: "p",
      capabilities: ["agent.tools.register"],
      tools: [{
        name: `t${"a".repeat(125)}`,
        displayName: "Lookup",
        description: "Lookup a record.",
        parametersSchema: { type: "object" },
      }],
    }, /Provider-visible plugin tool name must satisfy the MCP name contract/);
  });

  it("reconciles only unreferenced managed roots before startup activation", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-reconcile-"));
    tempRoots.push(localPluginDir);
    const liveRoot = path.join(localPluginDir, "install-live");
    const orphanRoot = path.join(localPluginDir, "install-orphan");
    const livePackagePath = path.join(liveRoot, "node_modules", packageName);
    mkdirSync(livePackagePath, { recursive: true });
    mkdirSync(orphanRoot, { recursive: true });
    registryMock.list.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      pluginKey: manifest.id,
      packageName,
      packagePath: livePackagePath,
      source: "npm",
      status: "disabled",
      manifestJson: manifest,
    }]);
    const db = {} as never;
    const loader = pluginLoader(db, { localPluginDir, migrationDb: db });
    bindPackageValidationRuntime(loader);

    await loader.loadAll();

    expect(jobStoreMock.cancelAllNonTerminalRuns).toHaveBeenCalledWith(
      "Paperclip restarted before plugin job completed",
    );
    expect(registryMock.failInterruptedWebhookDeliveries).toHaveBeenCalledWith(
      "Paperclip restarted before webhook delivery completed",
    );
    expect(existsSync(liveRoot)).toBe(true);
    expect(existsSync(orphanRoot)).toBe(false);
  });
});
