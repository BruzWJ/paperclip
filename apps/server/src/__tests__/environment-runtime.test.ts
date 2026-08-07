import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  environmentRuntimeService,
  findReusableSandboxLeaseId,
  type EnvironmentRuntimeDriver,
} from "../services/environment-runtime.js";
import { createMockDb } from "./helpers/mock-db.js";

const environmentMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => environmentMocks,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const environmentId = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-000000000003";
const issueId = "00000000-0000-4000-8000-000000000004";
const agentId = "00000000-0000-4000-8000-000000000005";
const runId = "00000000-0000-4000-8000-000000000006";
const now = new Date("2026-07-30T18:00:00.000Z");

function environment(driver = "contract-driver", status = "active"): Environment {
  return {
    id: environmentId,
    companyId,
    name: "Runtime contract",
    description: null,
    driver,
    status,
    config: {},
    metadata: null,
    createdAt: now,
    updatedAt: now,
  } as Environment;
}

function lease(input: {
  driver?: string;
  status?: EnvironmentLease["status"];
  policy?: EnvironmentLease["leasePolicy"];
} = {}): EnvironmentLease {
  const driver = input.driver ?? "contract-driver";
  const status = input.status ?? "active";
  return {
    id: "00000000-0000-4000-8000-000000000020",
    companyId,
    environmentId,
    executionWorkspaceId: workspaceId,
    issueId,
    runId,
    status,
    leasePolicy: input.policy ?? "ephemeral",
    provider: driver,
    providerLeaseId: "provider-lease-1",
    acquiredAt: now,
    lastUsedAt: now,
    expiresAt: null,
    releasedAt: status === "released" ? now : null,
    failureReason: null,
    cleanupStatus: "not_required",
    metadata: { driver, executionWorkspaceMode: "shared_workspace" },
    createdAt: now,
    updatedAt: now,
  } as EnvironmentLease;
}

function driverContract(driver = "contract-driver") {
  const acquired = lease({ driver });
  const released = lease({ driver, status: "released" });
  const destroyed = lease({ driver, status: "released", policy: "reuse_by_environment" });
  const calls = {
    acquire: vi.fn(async () => acquired),
    release: vi.fn(async () => released),
    resume: vi.fn(async () => ({ providerLeaseId: "resumed" })),
    destroy: vi.fn(async () => destroyed),
    realize: vi.fn(async () => ({ cwd: "/workspace", metadata: { ready: true } })),
    execute: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    supportsCancel: vi.fn(() => true),
    syncIn: vi.fn(async () => ({ operations: [] })),
    syncOut: vi.fn(async () => ({ operations: [] })),
    supportsSync: vi.fn(() => true),
  };
  const implementation = {
    driver,
    acquireRunLease: calls.acquire,
    releaseRunLease: calls.release,
    resumeRunLease: calls.resume,
    destroyRunLease: calls.destroy,
    realizeWorkspace: calls.realize,
    execute: calls.execute,
    cancelExecution: calls.cancel,
    supportsExecutionCancellation: calls.supportsCancel,
    syncIn: calls.syncIn,
    syncOut: calls.syncOut,
    supportsSync: calls.supportsSync,
  } as EnvironmentRuntimeDriver;
  return { implementation, calls, acquired, released, destroyed };
}

beforeEach(() => {
  vi.clearAllMocks();
  environmentMocks.getById.mockResolvedValue(environment());
  environmentMocks.releaseLease.mockResolvedValue(null);
});

describe("findReusableSandboxLeaseId", () => {
  it("matches reusable plugin-backed leases by their complete provider configuration", () => {
    expect(findReusableSandboxLeaseId({
      config: {
        provider: "fake-plugin",
        image: "template-b",
        timeoutMs: 300_000,
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-a",
          metadata: {
            provider: "fake-plugin",
            image: "template-a",
            timeoutMs: 300_000,
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-b",
          metadata: {
            provider: "fake-plugin",
            image: "template-b",
            timeoutMs: 300_000,
            reuseLease: true,
          },
        },
      ],
    })).toBe("sandbox-b");
  });

  it("does not reuse a lease whose image identity differs", () => {
    expect(findReusableSandboxLeaseId({
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true },
      leases: [{
        providerLeaseId: "debian-lease",
        metadata: { provider: "fake", image: "debian:12", reuseLease: true },
      }],
    })).toBeNull();
  });
});

describe("environment runtime driver boundary", () => {
  it("passes canonical run and workspace context to an injected driver", async () => {
    const harness = createMockDb();
    const contract = driverContract();
    const runtime = environmentRuntimeService(harness.db, {
      drivers: [contract.implementation],
    });

    await expect(runtime.acquireRunLease({
      companyId,
      environment: environment(),
      issueId,
      agentId,
      runId,
      persistedExecutionWorkspace: { id: workspaceId, mode: "shared_workspace" },
      adapterType: "codex",
    })).resolves.toEqual({
      environment: environment(),
      lease: contract.acquired,
      leaseContext: {
        executionWorkspaceId: workspaceId,
        executionWorkspaceMode: "shared_workspace",
      },
    });
    expect(contract.calls.acquire).toHaveBeenCalledWith({
      companyId,
      environment: environment(),
      issueId,
      agentId,
      runId,
      executionWorkspaceId: workspaceId,
      executionWorkspaceMode: "shared_workspace",
      adapterType: "codex",
    });
    expect(harness.calls).toEqual([]);
  });

  it("rejects inactive and unregistered environments before acquisition", async () => {
    const harness = createMockDb();
    const contract = driverContract();
    const runtime = environmentRuntimeService(harness.db, {
      drivers: [contract.implementation],
    });
    const input = {
      companyId,
      issueId,
      runId,
      persistedExecutionWorkspace: null,
    };

    await expect(runtime.acquireRunLease({
      ...input,
      environment: environment("contract-driver", "disabled"),
    })).rejects.toThrow("is not active");
    await expect(runtime.acquireRunLease({
      ...input,
      environment: environment("missing-driver"),
    })).rejects.toThrow('driver "missing-driver" is not registered');
    expect(contract.calls.acquire).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it("delegates lifecycle, command, cancellation, and sync operations", async () => {
    const harness = createMockDb();
    const contract = driverContract();
    const runtime = environmentRuntimeService(harness.db, {
      drivers: [contract.implementation],
    });
    const base = { environment: environment(), lease: contract.acquired };

    await expect(runtime.resumeRunLease(base)).resolves.toEqual({ providerLeaseId: "resumed" });
    await expect(runtime.destroyRunLease(base)).resolves.toEqual(contract.destroyed);
    await expect(runtime.realizeWorkspace({
      ...base,
      workspace: { localPath: "/workspace", mode: "shared_workspace" },
    })).resolves.toMatchObject({ cwd: "/workspace" });
    await expect(runtime.execute({
      ...base,
      executionId: "command-1",
      command: "git",
      args: ["status"],
    })).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(runtime.supportsExecutionCancellation(base)).toBe(true);
    await expect(runtime.cancelExecution({
      ...base,
      companyId,
      executionId: "command-1",
      reason: "operator_request",
    })).resolves.toEqual({ cancelled: true });
    expect(runtime.supportsSync(base)).toBe(true);
    await expect(runtime.syncIn({ ...base, operations: [] })).resolves.toEqual({ operations: [] });
    await expect(runtime.syncOut({ ...base, operations: [] })).resolves.toEqual({ operations: [] });

    expect(contract.calls.resume).toHaveBeenCalledWith(base);
    expect(contract.calls.destroy).toHaveBeenCalledWith(base);
    expect(contract.calls.execute).toHaveBeenCalledTimes(1);
    expect(contract.calls.cancel).toHaveBeenCalledTimes(1);
    expect(contract.calls.syncIn).toHaveBeenCalledTimes(1);
    expect(contract.calls.syncOut).toHaveBeenCalledTimes(1);
    expect(harness.calls).toEqual([]);
  });

  it("rejects cross-company cancellation before invoking a driver", async () => {
    const harness = createMockDb();
    const contract = driverContract();
    const runtime = environmentRuntimeService(harness.db, {
      drivers: [contract.implementation],
    });

    await expect(runtime.cancelExecution({
      environment: environment(),
      lease: contract.acquired,
      companyId: "00000000-0000-4000-8000-000000000099",
      executionId: "command-1",
      reason: "invalid_scope",
    })).rejects.toThrow("scope does not match");
    expect(contract.calls.cancel).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it("uses the lease-captured driver when releasing a run", async () => {
    const captured = driverContract("captured-driver");
    const row = lease({ driver: "captured-driver" });
    const harness = createMockDb({ select: [[row]] });
    environmentMocks.getById.mockResolvedValue(environment("replacement-driver"));
    const runtime = environmentRuntimeService(harness.db, {
      drivers: [captured.implementation],
    });

    await expect(runtime.releaseRunLeases(runId, "expired")).resolves.toEqual([{
      environment: environment("replacement-driver"),
      lease: captured.released,
      leaseContext: {
        executionWorkspaceId: workspaceId,
        executionWorkspaceMode: "shared_workspace",
      },
    }]);
    expect(captured.calls.release).toHaveBeenCalledWith({
      environment: environment("replacement-driver"),
      lease: row,
      status: "expired",
    });
    expect(harness.remaining("select")).toBe(0);
  });

  it("destroys scoped reusable leases and performs no query without a scope", async () => {
    const reusable = lease({ driver: "contract-driver", policy: "reuse_by_environment" });
    const unscoped = createMockDb();
    const contract = driverContract();
    const unscopedRuntime = environmentRuntimeService(unscoped.db, {
      drivers: [contract.implementation],
    });
    await expect(unscopedRuntime.destroyReusableSandboxLeases({ companyId })).resolves.toEqual([]);
    expect(unscoped.calls).toEqual([]);

    const harness = createMockDb({ select: [[reusable]] });
    environmentMocks.getById.mockResolvedValue(environment());
    const runtime = environmentRuntimeService(harness.db, {
      drivers: [contract.implementation],
    });
    await expect(runtime.destroyReusableSandboxLeases({
      companyId,
      issueId,
      failureReason: "workspace_deleted",
    })).resolves.toEqual([{
      environment: environment(),
      lease: contract.destroyed,
      leaseContext: {
        executionWorkspaceId: workspaceId,
        executionWorkspaceMode: "shared_workspace",
      },
    }]);
    expect(contract.calls.destroy).toHaveBeenCalledWith({
      environment: environment(),
      lease: reusable,
      failureReason: "workspace_deleted",
    });
    expect(harness.remaining("select")).toBe(0);
  });
});
