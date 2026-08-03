import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  environmentRuntimeService,
  type EnvironmentRuntimeDriver,
} from "../services/environment-runtime.js";
import { createMockDb } from "./helpers/mock-db.js";

const environmentServiceMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  listLeases: vi.fn(),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: vi.fn(() => environmentServiceMocks),
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const runId = "run_environment_contract";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-01T12:00:00.000Z");

function environment(driver: string): Environment {
  return {
    id: environmentId,
    companyId,
    name: `${driver} contract`,
    description: null,
    driver,
    status: "active",
    config: {},
    metadata: null,
    createdAt: now,
    updatedAt: now,
  } as Environment;
}

function lease(driver: string, status: "active" | "released" = "active"): EnvironmentLease {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    companyId,
    environmentId,
    executionWorkspaceId: workspaceId,
    issueId: null,
    runId,
    status,
    leasePolicy: "ephemeral",
    provider: driver,
    providerLeaseId: driver === "local" ? null : `${driver}://lease-1`,
    acquiredAt: now,
    lastUsedAt: now,
    expiresAt: null,
    releasedAt: status === "released" ? now : null,
    failureReason: null,
    cleanupStatus: "not_required",
    metadata: {
      driver,
      executionWorkspaceMode: "isolated",
    },
    createdAt: now,
    updatedAt: now,
  } as EnvironmentLease;
}

function driverContract(driver: string) {
  const acquireRunLease = vi.fn(async () => lease(driver));
  const releaseRunLease = vi.fn(async () => lease(driver, "released"));
  return {
    implementation: {
      driver,
      acquireRunLease,
      releaseRunLease,
    } satisfies EnvironmentRuntimeDriver,
    acquireRunLease,
    releaseRunLease,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(["local", "sandbox", "ssh"])(
  "environment runtime %s driver contract",
  (driverKey) => {
    it("passes the canonical lease context through acquire and release", async () => {
      const targetEnvironment = environment(driverKey);
      const activeLease = lease(driverKey);
      const harness = createMockDb({ select: [[activeLease], []] });
      const contract = driverContract(driverKey);
      environmentServiceMocks.getById.mockResolvedValue(targetEnvironment);
      const runtime = environmentRuntimeService(harness.db, {
        drivers: [contract.implementation],
      });

      await expect(runtime.acquireRunLease({
        companyId,
        environment: targetEnvironment,
        issueId: null,
        agentId: "55555555-5555-4555-8555-555555555555",
        runId,
        persistedExecutionWorkspace: {
          id: workspaceId,
          mode: "isolated",
        },
        adapterType: "codex",
      })).resolves.toEqual({
        environment: targetEnvironment,
        lease: activeLease,
        leaseContext: {
          executionWorkspaceId: workspaceId,
          executionWorkspaceMode: "isolated",
        },
      });

      expect(contract.acquireRunLease).toHaveBeenCalledWith({
        companyId,
        environment: targetEnvironment,
        issueId: null,
        agentId: "55555555-5555-4555-8555-555555555555",
        runId,
        executionWorkspaceId: workspaceId,
        executionWorkspaceMode: "isolated",
        adapterType: "codex",
        applyCustomImageTemplate: false,
      });

      await expect(runtime.releaseRunLeases(runId)).resolves.toEqual([{
        environment: targetEnvironment,
        lease: lease(driverKey, "released"),
        leaseContext: {
          executionWorkspaceId: workspaceId,
          executionWorkspaceMode: "isolated",
        },
      }]);
      expect(contract.releaseRunLease).toHaveBeenCalledWith({
        environment: targetEnvironment,
        lease: activeLease,
        status: "released",
      });
      await expect(runtime.releaseRunLeases(runId)).resolves.toEqual([]);
      expect(harness.remaining("select")).toBe(0);
    });
  },
);

describe("environment runtime driver admission", () => {
  it("rejects an inactive environment before invoking its driver", async () => {
    const harness = createMockDb();
    const contract = driverContract("local");
    const runtime = environmentRuntimeService(harness.db, {
      drivers: [contract.implementation],
    });

    await expect(runtime.acquireRunLease({
      companyId,
      environment: { ...environment("local"), status: "paused" },
      issueId: null,
      runId,
      persistedExecutionWorkspace: null,
    })).rejects.toThrow('Environment "local contract" is not active');

    expect(contract.acquireRunLease).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it("fails closed when an environment driver is not registered", async () => {
    const harness = createMockDb();
    const runtime = environmentRuntimeService(harness.db, { drivers: [] });

    await expect(runtime.acquireRunLease({
      companyId,
      environment: environment("unknown"),
      issueId: null,
      runId,
      persistedExecutionWorkspace: null,
    })).rejects.toThrow(
      'Environment driver "unknown" is not registered in the environment runtime yet',
    );

    expect(harness.calls).toEqual([]);
  });
});
