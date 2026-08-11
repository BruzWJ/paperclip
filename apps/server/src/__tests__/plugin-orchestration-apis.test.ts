// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: requestWakeup, requestWakeups, agentSessions
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import {
  createPluginHostServicesTestOptions,
  createPluginManifestFake,
  noopPluginEventDelivery,
} from "./helpers/plugin-host-services.js";

const hostMocks = vi.hoisted(() => ({
  assertPluginInstallationRequestScope: vi.fn(async () => undefined),
  getCompanySettings: vi.fn(async () => null as Record<string, unknown> | null),
  upsertCompanySettings: vi.fn(async () => undefined),
  resolveManagedProject: vi.fn(async () => ({
    status: "missing",
    projectId: null,
    project: null,
  })),
}));

vi.mock("../services/plugin-task-authorization.js", () => ({
    assertPluginInstallationRequestScope:
      hostMocks.assertPluginInstallationRequestScope,
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getCompanySettings: hostMocks.getCompanySettings,
    upsertCompanySettings: hostMocks.upsertCompanySettings,
  }),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({
    resolveManagedProject: hostMocks.resolveManagedProject,
  }),
}));

import {
  buildHostServices,
  type PluginTaskControlPlane,
} from "../services/plugin-host-services.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => undefined,
        subscribe: () => undefined,
      };
    },
  } as never;
}

function createPluginTaskControlPlaneStub(
  overrides: Partial<PluginTaskControlPlane> = {},
): PluginTaskControlPlane {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => {
      throw new Error("Unexpected plugin task creation");
    }),
    update: vi.fn(async () => {
      throw new Error("Unexpected plugin task update");
    }),
    withdraw: vi.fn(async () => {
      throw new Error("Unexpected plugin task withdrawal");
    }),
    ...overrides,
  };
}

const pluginId = "00000000-0000-4000-8000-000000000001";
const companyId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";

function services(input: {
  pluginKey?: string;
  manifest?: Record<string, unknown>;
  pluginTaskControlPlane?: PluginTaskControlPlane;
} = {}) {
  return buildHostServices(
    createMockDb().db,
    pluginId,
    createEventBusStub(),
    noopPluginEventDelivery,
    createPluginHostServicesTestOptions({
      manifest: input.manifest
        ? input.manifest as never
        : createPluginManifestFake({
            id: input.pluginKey ?? "paperclip.missions",
          }),
      pluginTaskControlPlane:
        input.pluginTaskControlPlane ?? createPluginTaskControlPlaneStub(),
    }),
  );
}

describe("plugin orchestration APIs without a database process", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      tempRoots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })
      ),
    );
  });

  it("exposes only the retained plugin task control-plane surface", () => {
    const host = services();

    expect(Object.keys(host.tasks).sort()).toEqual([
      "create",
      "get",
      "list",
      "registerCreatorCallback",
      "update",
      "withdraw",
    ]);
    const taskSurface = host.tasks as unknown as Record<string, unknown>;
    expect(taskSurface.requestWakeup).toBeUndefined();
    expect(taskSurface.requestWakeups).toBeUndefined();
    expect(taskSurface.getOrchestrationSummary).toBeUndefined();
    expect(taskSurface.assertCheckoutOwner).toBeUndefined();
    expect(taskSurface.createComment).toBeUndefined();
    expect(taskSurface.setStatus).toBeUndefined();
    expect(taskSurface.updateDescription).toBeUndefined();

    const hostSurface = host as unknown as Record<string, unknown>;
    expect(hostSurface.agentSessions).toBeUndefined();
    expect((host.agents as unknown as Record<string, unknown>).invoke)
      .toBeUndefined();
  });

  it("requires a registered callback before forwarding immutable creation", async () => {
    const createdTask = {
      id: randomUUID(),
      companyId,
      request: "Investigate mission alpha",
      ownerAgentId: agentId,
    } as Awaited<ReturnType<PluginTaskControlPlane["create"]>>;
    const create = vi.fn(async () => createdTask);
    const host = services({
      pluginTaskControlPlane: createPluginTaskControlPlaneStub({ create }),
    });
    const input = {
      companyId,
      request: "Investigate mission alpha",
      ownerAgentId: agentId,
      callbackKey: "mission-progress",
      callbackVersion: "1",
      title: "Mission alpha",
    };
    const operation = { hostRpcOperationId: "rpc-create-1" };

    await expect(host.tasks.create(input, operation)).rejects.toThrow(
      "Creator callback is not registered: mission-progress@1",
    );
    expect(create).not.toHaveBeenCalled();

    await expect(host.tasks.registerCreatorCallback({
      callbackKey: " mission-progress ",
      callbackVersion: " 1 ",
    })).resolves.toEqual({
      callbackKey: "mission-progress",
      callbackVersion: "1",
      registered: true,
    });
    await expect(host.tasks.create(input, operation)).resolves.toBe(createdTask);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      ...input,
      pluginInstallationId: pluginId,
      pluginKey: "paperclip.missions",
      hostRpcOperationId: "rpc-create-1",
      callbackRegistrationActive: true,
    });
  });

  it("forwards only creator-message, reassignment, and withdrawal mutations", async () => {
    const taskId = randomUUID();
    const updatedTask = {
      id: taskId,
      companyId,
      request: "Investigate mission alpha",
      ownerAgentId: agentId,
    } as Awaited<ReturnType<PluginTaskControlPlane["update"]>>;
    const update = vi.fn(async () => updatedTask);
    const withdrawResult = {
      operationId: "rpc-withdraw-1",
      task: { ...updatedTask, status: "cancelled", lifecycleStatus: "cancelled" },
      retried: false,
    } as Awaited<ReturnType<PluginTaskControlPlane["withdraw"]>>;
    const withdraw = vi.fn(async () => withdrawResult);
    const host = services({
      pluginTaskControlPlane: createPluginTaskControlPlaneStub({
        update,
        withdraw,
      }),
    });

    await expect(host.tasks.update({
      taskId,
      companyId,
      input: { kind: "message", message: "Use the durable creator thread." },
    }, { hostRpcOperationId: "rpc-update-message-1" }))
      .resolves.toBe(updatedTask);
    await expect(host.tasks.update({
      taskId,
      companyId,
      input: { kind: "reassign", ownerAgentId: agentId },
    }, { hostRpcOperationId: "rpc-update-reassign-1" }))
      .resolves.toBe(updatedTask);
    await expect(host.tasks.withdraw({
      taskId,
      companyId,
      message: "Withdraw this plugin-created task.",
    }, { hostRpcOperationId: "rpc-withdraw-1" }))
      .resolves.toBe(withdrawResult);

    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      taskId,
      input: { kind: "message", message: "Use the durable creator thread." },
      pluginInstallationId: pluginId,
      hostRpcOperationId: "rpc-update-message-1",
    }));
    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      taskId,
      input: { kind: "reassign", ownerAgentId: agentId },
      pluginInstallationId: pluginId,
      hostRpcOperationId: "rpc-update-reassign-1",
    }));
    expect(withdraw).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskId,
      pluginInstallationId: pluginId,
      hostRpcOperationId: "rpc-withdraw-1",
    }));
  });

  it("initializes declared local-folder structure from an empty root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-folder-"));
    tempRoots.push(root);
    const declaration = {
      folderKey: "content-root",
      displayName: "Content root",
      access: "readWrite",
      requiredDirectories: ["raw", "content", "content/topics", ".paperclip"],
      requiredFiles: ["CONTENT.md", "AGENTS.md"],
    };
    const manifest = {
      id: localFolderPluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Content Store",
      description: "Local-file content store plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["local.folders"],
      entrypoints: { worker: "./dist/worker.js" },
      localFolders: [declaration],
    };
    const host = services({ pluginKey: localFolderPluginKey, manifest });
    hostMocks.getCompanySettings.mockResolvedValueOnce(null);

    const configured = await host.localFolders.configure({
      companyId,
      folderKey: "content-root",
      path: root,
    });
    expect(configured).toMatchObject({
      healthy: false,
      missingDirectories: [],
      missingFiles: ["CONTENT.md", "AGENTS.md"],
    });

    const persistedSettings = hostMocks.upsertCompanySettings.mock.calls[0]?.[2];
    expect((persistedSettings as { settingsJson: { localFolders: Record<string, unknown> } })
      .settingsJson.localFolders["content-root"]).toEqual({
        path: root,
      });
    await expect(host.localFolders.configure({
      companyId,
      folderKey: "content-root",
      path: root,
      access: "read",
    } as never)).rejects.toThrow("accepts only companyId, folderKey, and a non-empty path");
    expect(hostMocks.upsertCompanySettings).toHaveBeenCalledTimes(1);
    hostMocks.getCompanySettings.mockResolvedValue({
      settingsJson: (persistedSettings as { settingsJson: Record<string, unknown> })
        .settingsJson,
    });
    await fs.rm(path.join(root, "raw"), { recursive: true, force: true });
    await fs.rm(path.join(root, "content"), { recursive: true, force: true });
    await expect(host.localFolders.readText({
      companyId,
      folderKey: "content-root",
      relativePath: "CONTENT.md",
    })).rejects.toThrow("Local folder is not healthy");

    await host.localFolders.writeTextAtomic({
      companyId,
      folderKey: "content-root",
      relativePath: "CONTENT.md",
      contents: "# Content\n",
    });
    await host.localFolders.writeTextAtomic({
      companyId,
      folderKey: "content-root",
      relativePath: "AGENTS.md",
      contents: "# Agents\n",
    });

    await expect(host.localFolders.status({ companyId, folderKey: "content-root" }))
      .resolves.toMatchObject({ healthy: true });
    await expect(fs.stat(path.join(root, "content/topics"))).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(root, "CONTENT.md"), "utf8"))
      .resolves.toBe("# Content\n");
  });

  it("rejects local-folder access for undeclared manifest keys", async () => {
    const host = services({
      pluginKey: "paperclip.local-folders",
      manifest: {
        id: "paperclip.local-folders",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Local Folders",
        description: "Local folder fixture",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [{
          folderKey: "content-root",
          displayName: "Content root",
          access: "readWrite",
        }],
      },
    });

    await expect(host.localFolders.configure({
      companyId,
      folderKey: "ssh",
      path: "/tmp",
    })).rejects.toThrow("Local folder key is not declared");
    await expect(host.localFolders.status({ companyId, folderKey: "ssh" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(host.localFolders.readText({
      companyId,
      folderKey: "ssh",
      relativePath: "id_rsa",
    })).rejects.toThrow("Local folder key is not declared");
    await expect(host.localFolders.writeTextAtomic({
      companyId,
      folderKey: "ssh",
      relativePath: "id_rsa",
      contents: "secret",
    })).rejects.toThrow("Local folder key is not declared");
  });

  it("forwards managed-project resolution without overwriting it in the host layer", async () => {
    const projectId = randomUUID();
    const created = {
      status: "created",
      projectId,
      project: {
        id: projectId,
        companyId,
        name: "Mission Operations",
        description: "Plugin operation inspection area",
      },
    };
    const resolved = {
      status: "resolved",
      projectId,
      project: {
        ...created.project,
        name: "Renamed by operator",
        description: "User-owned text",
      },
    };
    hostMocks.resolveManagedProject
      .mockResolvedValueOnce({ status: "missing", projectId: null, project: null })
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(resolved);
    const host = services({ pluginKey: "paperclip.missions" });

    await expect(host.projects.getManaged({ companyId, projectKey: "operations" }))
      .resolves.toMatchObject({ status: "missing", projectId: null });
    await expect(host.projects.reconcileManaged({ companyId, projectKey: "operations" }))
      .resolves.toBe(created);
    await expect(host.projects.reconcileManaged({ companyId, projectKey: "operations" }))
      .resolves.toBe(resolved);

    expect(hostMocks.resolveManagedProject).toHaveBeenNthCalledWith(1, {
      companyId,
      pluginId,
      pluginKey: "paperclip.missions",
      projectKey: "operations",
      createIfMissing: false,
    });
    expect(hostMocks.resolveManagedProject).toHaveBeenNthCalledWith(2, {
      companyId,
      pluginId,
      pluginKey: "paperclip.missions",
      projectKey: "operations",
    });
    expect(resolved.project.name).toBe("Renamed by operator");
    expect(resolved.project.description).toBe("User-owned text");
  });
});

const localFolderPluginKey = "paperclip.local-folder-fixture";
