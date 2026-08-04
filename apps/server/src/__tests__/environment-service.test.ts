import { describe, expect, it } from "vitest";
import { environmentService } from "../services/environments.js";
import { createMockDb } from "./helpers/mock-db.js";

const now = new Date("2026-01-02T03:04:05.000Z");

function environmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "environment-1",
    name: "Remote sandbox",
    description: null,
    driver: "sandbox",
    status: "active",
    config: { provider: "kubernetes" },
    envVars: {},
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    companyId: "company-1",
    environmentId: "environment-1",
    executionWorkspaceId: null,
    issueId: "issue-1",
    runId: "run-1",
    status: "active",
    leasePolicy: "ephemeral",
    provider: "kubernetes",
    providerLeaseId: "provider-lease-1",
    acquiredAt: now,
    lastUsedAt: now,
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: { pod: "paperclip-run" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("environmentService", () => {
  it("maps persisted environment records without leaking mutable references", async () => {
    const row = environmentRow({
      config: { provider: "kubernetes", nested: true },
      envVars: { NODE_ENV: "test" },
      metadata: { managedByPaperclip: true },
    });
    const mock = createMockDb({ select: [[row]] });

    const result = await environmentService(mock.db).getById("environment-1");

    expect(result).toEqual(row);
    expect(result?.config).not.toBe(row.config);
    expect(result?.envVars).not.toBe(row.envVars);
    expect(result?.metadata).not.toBe(row.metadata);
  });

  it("creates, releases, and maps leases through explicit persistence calls", async () => {
    const active = leaseRow();
    const released = leaseRow({
      status: "released",
      releasedAt: now,
      cleanupStatus: "success",
    });
    const mock = createMockDb({
      insert: [[active]],
      update: [[released]],
    });
    const service = environmentService(mock.db);

    await expect(service.acquireLease({
      companyId: "company-1",
      environmentId: "environment-1",
      issueId: "issue-1",
      runId: "run-1",
      provider: "kubernetes",
      providerLeaseId: "provider-lease-1",
      metadata: { pod: "paperclip-run" },
    })).resolves.toMatchObject({ id: "lease-1", status: "active", runId: "run-1" });

    await expect(service.releaseLease("lease-1", "released", {
      cleanupStatus: "success",
    })).resolves.toMatchObject({ id: "lease-1", status: "released", cleanupStatus: "success" });

    expect(mock.remaining("insert")).toBe(0);
    expect(mock.remaining("update")).toBe(0);
  });

  it("releases every active lease for a run in one bounded update", async () => {
    const mock = createMockDb({
      update: [[
        leaseRow({ id: "lease-1", status: "failed", failureReason: "runtime failed" }),
        leaseRow({ id: "lease-2", status: "failed", environmentId: "environment-2" }),
      ]],
    });

    const released = await environmentService(mock.db).releaseLeasesForRun("run-1", "failed");

    expect(released.map((lease) => lease.id)).toEqual(["lease-1", "lease-2"]);
    expect(released.every((lease) => lease.status === "failed")).toBe(true);
    expect(mock.calls.filter((call) => call.operation === "update" && call.method === "update")).toHaveLength(1);
  });

  it("aggregates static references and active runtime use into deletion readiness", async () => {
    const mock = createMockDb({
      select: [
        [{ id: "environment-1", driver: "local" }],
        [{ count: 1 }],
        [{ count: "2" }],
        [{ count: 3 }],
        [{ count: 4 }],
        [{ count: 5 }],
        [{ count: 6 }],
        [{ count: 7 }],
        [{ count: 8 }],
      ],
    });

    const result = await environmentService(mock.db).getDeleteBlastRadius("environment-1");

    expect(result).toEqual({
      environmentId: "environment-1",
      canDelete: false,
      deleteBlockedReasons: ["managed_local", "instance_default"],
      staticReferences: {
        isManagedLocal: true,
        isInstanceDefault: true,
        agentDefaultCount: 2,
        executionWorkspaceSelectionCount: 3,
        issueSelectionCount: 4,
        projectSelectionCount: 5,
        secretBindingCount: 6,
      },
      activeRuntimeUse: {
        activeLeaseCount: 7,
        activeCustomImageSetupSessionCount: 8,
        hasActiveRuntimeUse: true,
      },
    });
    expect(mock.remaining("select")).toBe(0);
  });

  it("maps named unique constraints to stable conflicts", async () => {
    const duplicateName = Object.assign(new Error("duplicate"), {
      constraint: "environments_name_idx",
    });
    const mock = createMockDb({ insert: [duplicateName] });

    await expect(environmentService(mock.db).create({
      name: "Remote sandbox",
      driver: "sandbox",
      status: "active",
      config: {},
      metadata: null,
    })).rejects.toMatchObject({ status: 409 });
  });
});
