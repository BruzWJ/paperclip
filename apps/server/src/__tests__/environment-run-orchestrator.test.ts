import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Environment,
  EnvironmentLease,
  ExecutionWorkspace,
} from "@paperclipai/shared";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() =>
  vi.fn(),
);
const mockGetEnvironmentById = vi.hoisted(() => vi.fn());
const mockUpdateLeaseMetadata = vi.hoisted(() => vi.fn());
const mockGetExecutionWorkspaceById = vi.hoisted(() => vi.fn());
const mockUpdateExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockDeriveExecutionTargetDigest = vi.hoisted(() =>
  vi.fn(() => "execution-target-digest"),
);

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget:
    mockResolveEnvironmentExecutionTarget,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: vi.fn(() => ({
    getById: mockGetEnvironmentById,
    updateLeaseMetadata: mockUpdateLeaseMetadata,
  })),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: vi.fn(() => ({
    getById: mockGetExecutionWorkspaceById,
    update: mockUpdateExecutionWorkspace,
  })),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agent-adapter-config-revisions.js", () => ({
  deriveAgentExecutionTargetDigest:
    mockDeriveExecutionTargetDigest,
}));

import {
  EnvironmentRunError,
  environmentRunOrchestrator,
} from "../services/environment-run-orchestrator.js";

function makeEnvironment(): Environment {
  return {
    id: "env-plugin-1",
    name: "Plugin Environment",
    description: null,
    driver: "plugin",
    status: "active",
    config: {
      pluginKey: "acme.environments",
      driverKey: "workspace-driver",
      driverConfig: {},
    },
    envVars: {},
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeLease(
  overrides: Partial<EnvironmentLease> = {},
): EnvironmentLease {
  return {
    id: "lease-plugin-1",
    companyId: "company-1",
    environmentId: "env-plugin-1",
    executionWorkspaceId: "workspace-1",
    issueId: "issue-1",
    runId: "run-1",
    status: "active",
    leasePolicy: "ephemeral",
    provider: "plugin:acme.environments:workspace-driver",
    providerLeaseId: "provider-lease-1",
    acquiredAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: {
      driver: "plugin",
      pluginId: "plugin-installation-1",
      pluginKey: "acme.environments",
      driverKey: "workspace-driver",
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeWorkspace(): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    sourceIssueId: "issue-1",
    mode: "shared_workspace",
    strategyType: "project_primary",
    name: "Issue Workspace",
    status: "active",
    cwd: "/host/workspace",
    repoUrl: "https://example.test/repository.git",
    baseRef: "main",
    branchName: null,
    providerType: "local_fs",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeDb(binding: {
  executionWorkspaceId: string;
  absoluteCwd: string;
} | null = {
  executionWorkspaceId: "workspace-1",
  absoluteCwd: "/host/workspace",
}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() =>
            Promise.resolve(binding ? [binding] : []),
          ),
        })),
      })),
    })),
  } as never;
}

function makeRuntime(input: {
  environment?: Environment;
  lease?: EnvironmentLease;
  lifecycle?: string[];
  releaseRunLeases?: EnvironmentRuntimeService["releaseRunLeases"];
} = {}): EnvironmentRuntimeService {
  const environment = input.environment ?? makeEnvironment();
  const lease = input.lease ?? makeLease();
  const lifecycle = input.lifecycle ?? [];
  return {
    acquireRunLease: vi.fn(async () => {
      lifecycle.push("acquire");
      return {
        environment,
        lease,
        leaseContext: {
          executionWorkspaceId: "workspace-1",
          executionWorkspaceMode: "shared_workspace",
        },
      };
    }),
    realizeWorkspace: vi.fn(async () => {
      lifecycle.push("realize");
      return {
        cwd: "/plugin/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "plugin",
            remote: { path: "/plugin/workspace" },
          },
        },
      };
    }),
    execute: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
    releaseRunLeases:
      input.releaseRunLeases ??
      vi.fn(async (_runId, status) => {
        lifecycle.push(`release:${status}`);
        return [
          {
            environment,
            lease: makeLease({
              status,
              releasedAt: new Date(
                "2026-01-01T00:01:00.000Z",
              ),
            }),
            leaseContext: {
              executionWorkspaceId: "workspace-1",
              executionWorkspaceMode: "shared_workspace",
            },
          },
        ];
      }),
  } as unknown as EnvironmentRuntimeService;
}

function acquisitionInput(runId: string) {
  const environment = makeEnvironment();
  return {
    companyId: "company-1",
    environmentId: environment.id,
    executionTargetDriver: environment.driver,
    executionTargetDigest: "execution-target-digest",
    adapterType: "fixture-agent-alpha",
    allowedDrivers: [environment.driver],
    issueId: "issue-1",
    runId: runId,
    agentId: "agent-1",
    executionWorkspaceBindingId: "binding-1",
  };
}

describe("environmentRunOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEnvironmentById.mockResolvedValue(makeEnvironment());
    mockGetExecutionWorkspaceById.mockResolvedValue(makeWorkspace());
    mockUpdateLeaseMetadata.mockImplementation(
      async (_leaseId, metadata) =>
        makeLease({ metadata }),
    );
    mockUpdateExecutionWorkspace.mockImplementation(
      async (_workspaceId, patch) => ({
        ...makeWorkspace(),
        ...patch,
      }),
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  it.each([
    ["productive", "productive-run-1"],
    ["consult", "consult-run-1"],
  ])(
    "uses the same acquire-realize-target-release lifecycle for %s work",
    async (_kind, runId) => {
      const lifecycle: string[] = [];
      const runtime = makeRuntime({ lifecycle });
      mockResolveEnvironmentExecutionTarget.mockImplementation(
        async (input) => {
          lifecycle.push("target");
          expect(input.realizedCwd).toBe("/plugin/workspace");
          expect(input.lease.id).toBe("lease-plugin-1");
          return {
            kind: "remote",
            transport: "plugin",
            pluginKey: "acme.environments",
            driverKey: "workspace-driver",
            remoteCwd: "/plugin/workspace",
            environmentId: "env-plugin-1",
            leaseId: "lease-plugin-1",
          };
        },
      );
      const orchestrator = environmentRunOrchestrator(makeDb(), {
        environmentRuntime: runtime,
      });

      const acquired =
        await orchestrator.acquireExecutionTargetForRun(
          acquisitionInput(runId),
        );

      expect(lifecycle).toEqual([
        "acquire",
        "realize",
        "target",
      ]);
      expect(runtime.acquireRunLease).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: runId,
          persistedExecutionWorkspace:
            expect.objectContaining({ id: "workspace-1" }),
        }),
      );
      expect(runtime.realizeWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          environment:
            expect.objectContaining({ driver: "plugin" }),
          workspace: expect.objectContaining({
            localPath: "/host/workspace",
          }),
        }),
      );
      expect(acquired.executionTarget).toMatchObject({
        transport: "plugin",
        remoteCwd: "/plugin/workspace",
      });

      await acquired.releaseExecutionTarget();
      await acquired.releaseExecutionTarget();
      expect(lifecycle).toEqual([
        "acquire",
        "realize",
        "target",
        "release:released",
      ]);
    },
  );

  it("releases the acquired lease as failed when target resolution fails", async () => {
    const lifecycle: string[] = [];
    const runtime = makeRuntime({ lifecycle });
    mockResolveEnvironmentExecutionTarget.mockRejectedValue(
      new Error("plugin worker stopped"),
    );
    const orchestrator = environmentRunOrchestrator(makeDb(), {
      environmentRuntime: runtime,
    });

    await expect(
      orchestrator.acquireExecutionTargetForRun(
        acquisitionInput("productive-run-failure"),
      ),
    ).rejects.toMatchObject({
      code: "transport_resolution_failed",
    });
    expect(lifecycle).toEqual([
      "acquire",
      "realize",
      "release:failed",
    ]);
  });

  it("fails and releases the plugin lease when realization omits the exact cwd", async () => {
    const lifecycle: string[] = [];
    const runtime = makeRuntime({ lifecycle });
    vi.mocked(runtime.realizeWorkspace).mockImplementation(
      async () => {
        lifecycle.push("realize");
        return {
          cwd: null,
          metadata: {},
        } as never;
      },
    );
    const orchestrator = environmentRunOrchestrator(makeDb(), {
      environmentRuntime: runtime,
    });

    await expect(
      orchestrator.acquireExecutionTargetForRun(
        acquisitionInput("productive-run-no-plugin-cwd"),
      ),
    ).rejects.toMatchObject({
      code: "workspace_realization_failed",
    });
    expect(lifecycle).toEqual([
      "acquire",
      "realize",
      "release:failed",
    ]);
    expect(
      mockResolveEnvironmentExecutionTarget,
    ).not.toHaveBeenCalled();
  });

  it("rejects target digest drift before binding resolution or lease acquisition", async () => {
    const db = makeDb();
    const runtime = makeRuntime();
    const orchestrator = environmentRunOrchestrator(db, {
      environmentRuntime: runtime,
    });

    await expect(
      orchestrator.acquireExecutionTargetForRun({
        ...acquisitionInput("productive-run-drift"),
        executionTargetDigest: "stale-digest",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof EnvironmentRunError &&
        error.code === "unsupported_environment",
    );
    expect(db.select).not.toHaveBeenCalled();
    expect(runtime.acquireRunLease).not.toHaveBeenCalled();
  });

  it("rejects a missing immutable workspace binding before lease acquisition", async () => {
    const runtime = makeRuntime();
    const orchestrator = environmentRunOrchestrator(
      makeDb(null),
      { environmentRuntime: runtime },
    );

    await expect(
      orchestrator.acquireExecutionTargetForRun(
        acquisitionInput("productive-run-no-workspace"),
      ),
    ).rejects.toMatchObject({
      code: "workspace_realization_failed",
    });
    expect(runtime.acquireRunLease).not.toHaveBeenCalled();
  });
});
