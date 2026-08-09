import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalRunLease,
  LocalRunLeaseService,
} from "../services/local-run-leases.js";

const logActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({ logActivity }));

import {
  LocalExecutionTargetError,
  localExecutionOrchestrator,
} from "../services/local-execution-orchestrator.js";

const now = new Date("2026-08-09T12:00:00.000Z");
const lease: LocalRunLease = {
  id: "lease-1",
  companyId: "company-1",
  executionWorkspaceId: "workspace-1",
  issueId: "issue-1",
  runId: "run-1",
  status: "active",
  acquiredAt: now,
  lastUsedAt: now,
  releasedAt: null,
  failureReason: null,
  updatedAt: now,
};
const workspace = {
  id: "workspace-1",
  companyId: "company-1",
  cwd: "/host/workspace",
  branchName: null,
};

function makeDb(binding: {
  executionWorkspaceId: string;
  absoluteCwd: string;
  workspaceId: string;
  workspaceCompanyId: string;
  workspaceCwd: string;
  workspaceBranchName: string | null;
} | null = {
  executionWorkspaceId: workspace.id,
  absoluteCwd: workspace.cwd,
  workspaceId: workspace.id,
  workspaceCompanyId: workspace.companyId,
  workspaceCwd: workspace.cwd,
  workspaceBranchName: workspace.branchName,
}) {
  const query = {
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve(binding ? [binding] : [])),
  };
  return {
    select: vi.fn(() => ({ from: vi.fn(() => query) })),
  } as never;
}

function makeLeases() {
  const acquireRunLease = vi.fn(async () => ({
    lease,
  }));
  const releaseRunLeases = vi.fn(async (input: {
    status?: "released" | "failed";
  }) => [{
    lease: {
      ...lease,
      status: input.status ?? "released",
      releasedAt: now,
      failureReason:
        input.status === "failed" ? "provider execution failed" : null,
    },
  }]);
  return {
    service: { acquireRunLease, releaseRunLeases } as LocalRunLeaseService,
    acquireRunLease,
    releaseRunLeases,
  };
}

function acquisitionInput(runId = "run-1") {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    runId,
    agentId: "agent-1",
    executionWorkspaceBindingId: "binding-1",
  };
}

describe("localExecutionOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logActivity.mockResolvedValue(undefined);
  });

  it("acquires and idempotently releases a local lease for the exact binding", async () => {
    const { service, acquireRunLease, releaseRunLeases } = makeLeases();
    const managedWorkspaceSafeguards = vi.fn(async () => undefined);
    const acquired = await localExecutionOrchestrator(makeDb(), {
      localRunLeases: service,
      managedWorkspaceSafeguards,
    }).acquireExecutionTargetForRun(acquisitionInput());

    expect(acquired.executionTarget).toEqual({
      kind: "local",
      leaseId: lease.id,
    });
    expect(acquireRunLease).toHaveBeenCalledWith({
      companyId: "company-1",
      executionWorkspaceId: workspace.id,
      issueId: "issue-1",
      runId: "run-1",
    });

    await acquired.releaseExecutionTarget();
    await acquired.releaseExecutionTarget();
    expect(releaseRunLeases).toHaveBeenCalledTimes(1);
    expect(releaseRunLeases).toHaveBeenCalledWith({
      companyId: "company-1",
      runId: "run-1",
      status: "released",
      failureReason: undefined,
    });
    expect(logActivity).toHaveBeenCalledTimes(2);
    expect(managedWorkspaceSafeguards).not.toHaveBeenCalled();
  });

  it("runs both configurable safeguards before leasing a managed worktree", async () => {
    const { service, acquireRunLease } = makeLeases();
    const managedWorkspaceSafeguards = vi.fn(async () => undefined);
    const managed = {
      executionWorkspaceId: workspace.id,
      absoluteCwd: workspace.cwd,
      workspaceId: workspace.id,
      workspaceCompanyId: workspace.companyId,
      workspaceCwd: workspace.cwd,
      workspaceBranchName: "paperclip/issue-1",
    };

    await localExecutionOrchestrator(makeDb(managed), {
      localRunLeases: service,
      managedWorkspaceSafeguards,
    }).acquireExecutionTargetForRun(acquisitionInput());

    expect(managedWorkspaceSafeguards).toHaveBeenCalledWith({
      workspace: {
        id: workspace.id,
        cwd: workspace.cwd,
        branchName: "paperclip/issue-1",
      },
      issueId: "issue-1",
      runId: "run-1",
    });
    expect(managedWorkspaceSafeguards.mock.invocationCallOrder[0]).toBeLessThan(
      acquireRunLease.mock.invocationCallOrder[0]!,
    );
  });

  it("records failed lease state when provider execution fails", async () => {
    const { service, releaseRunLeases } = makeLeases();
    const acquired = await localExecutionOrchestrator(makeDb(), {
      localRunLeases: service,
    }).acquireExecutionTargetForRun(acquisitionInput());

    await acquired.releaseExecutionTarget(true);
    expect(releaseRunLeases).toHaveBeenCalledWith({
      companyId: "company-1",
      runId: "run-1",
      status: "failed",
      failureReason: "provider execution failed",
    });
  });

  it("rejects a missing exact workspace binding before lease acquisition", async () => {
    const { service, acquireRunLease } = makeLeases();
    await expect(
      localExecutionOrchestrator(makeDb(null), {
        localRunLeases: service,
      }).acquireExecutionTargetForRun(acquisitionInput()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LocalExecutionTargetError &&
        error.code === "workspace_binding_unavailable",
    );
    expect(acquireRunLease).not.toHaveBeenCalled();
  });
});
