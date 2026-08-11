import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  executionWorkspaces,
  issueExecutionWorkspaceBindings,
  type Db,
} from "@paperclipai/db";
import type { AcpxLocalWorkspaceTarget } from "@paperclipai/adapter-utils/acpx-runtime";
import { logActivity } from "./activity-log.js";
import {
  localRunLeaseService,
  type LocalRunLease,
  type LocalRunLeaseRecord,
  type LocalRunLeaseService,
  type LocalRunLeaseStatus,
} from "./local-run-leases.js";

export type LocalExecutionErrorCode =
  | "lease_acquire_failed"
  | "workspace_binding_unavailable"
  | "lease_release_failed";

export class LocalExecutionTargetError extends Error {
  readonly code: LocalExecutionErrorCode;
  readonly cause?: unknown;

  constructor(
    code: LocalExecutionErrorCode,
    message: string,
    details?: { cause?: unknown },
  ) {
    super(message);
    this.name = "LocalExecutionTargetError";
    this.code = code;
    this.cause = details?.cause;
  }
}

export interface LocalExecutionTargetAcquisitionResult {
  readonly lease: LocalRunLease;
  readonly executionTarget: AcpxLocalWorkspaceTarget;
  releaseExecutionTarget(failed?: boolean): Promise<void>;
}

export interface LocalExecutionReleaseResult {
  readonly released: LocalRunLeaseRecord[];
  readonly errors: Array<{ leaseId: string; error: unknown }>;
}

export interface ManagedLocalWorkspaceSafeguardInput {
  readonly workspace: {
    readonly id: string;
    readonly cwd: string;
    readonly branchName: string;
  };
  readonly issueId: string;
  readonly runId: string;
}

async function enforceManagedLocalWorkspaceSafeguards(
  db: Db,
  input: ManagedLocalWorkspaceSafeguardInput,
): Promise<void> {
  try {
    const [{ instanceSettingsService }, { ensureGitWorktreeBranchCoherent }] =
      await Promise.all([
        import("./instance-settings.js"),
        import("./workspace-runtime.js"),
      ]);
    const safeguards = await instanceSettingsService(db).getGeneral();
    await ensureGitWorktreeBranchCoherent({
      db,
      repoRoot: input.workspace.cwd,
      worktreePath: input.workspace.cwd,
      expectedBranchName: input.workspace.branchName,
      sourceIssue: {
        id: input.issueId,
        identifier: null,
      },
      executionWorkspaceId: input.workspace.id,
      runId: input.runId,
      enableWorkspaceBranchReconcileForward:
        safeguards.enableWorkspaceBranchReconcileForward,
      enableWorkspaceDirtyQuarantineRepair:
        safeguards.enableWorkspaceDirtyQuarantineRepair,
    });
  } catch (error) {
    if (error instanceof LocalExecutionTargetError) throw error;
    throw new LocalExecutionTargetError(
      "workspace_binding_unavailable",
      `Managed execution workspace safeguards failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * Acquires the invariant local execution target for an exact persisted issue
 * workspace binding. No configurable target catalog participates in this path.
 */
export function localExecutionOrchestrator(
  db: Db,
  options: {
    localRunLeases?: LocalRunLeaseService;
    managedWorkspaceSafeguards?: (
      input: ManagedLocalWorkspaceSafeguardInput,
    ) => Promise<void>;
  } = {},
) {
  const localRunLeases = options.localRunLeases ?? localRunLeaseService(db);
  const managedWorkspaceSafeguards =
    options.managedWorkspaceSafeguards ??
    ((input: ManagedLocalWorkspaceSafeguardInput) =>
      enforceManagedLocalWorkspaceSafeguards(db, input));

  async function resolveExecutionWorkspaceBinding(input: {
    companyId: string;
    issueId: string;
    executionWorkspaceBindingId: string;
  }) {
    const row = await db
      .select({
        executionWorkspaceId:
          issueExecutionWorkspaceBindings.executionWorkspaceId,
        absoluteCwd: issueExecutionWorkspaceBindings.absoluteCwd,
        workspaceId: executionWorkspaces.id,
        workspaceCompanyId: executionWorkspaces.companyId,
        workspaceCwd: executionWorkspaces.cwd,
        workspaceBranchName: executionWorkspaces.branchName,
      })
      .from(issueExecutionWorkspaceBindings)
      .innerJoin(
        executionWorkspaces,
        and(
          eq(
            executionWorkspaces.id,
            issueExecutionWorkspaceBindings.executionWorkspaceId,
          ),
          eq(executionWorkspaces.companyId, input.companyId),
        ),
      )
      .where(
        and(
          eq(
            issueExecutionWorkspaceBindings.id,
            input.executionWorkspaceBindingId,
          ),
          eq(issueExecutionWorkspaceBindings.companyId, input.companyId),
          eq(issueExecutionWorkspaceBindings.issueId, input.issueId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (
      !row ||
      row.executionWorkspaceId !== row.workspaceId ||
      row.workspaceCompanyId !== input.companyId ||
      !path.isAbsolute(row.absoluteCwd) ||
      row.workspaceCwd !== row.absoluteCwd
    ) {
      throw new LocalExecutionTargetError(
        "workspace_binding_unavailable",
        "Provider execution requires its exact persisted issue execution workspace binding.",
      );
    }
    return {
      id: row.workspaceId,
      companyId: row.workspaceCompanyId,
      cwd: row.workspaceCwd,
      branchName: row.workspaceBranchName ?? null,
    };
  }

  async function releaseForRun(input: {
    runId: string;
    companyId: string;
    agentId: string;
    status: Extract<LocalRunLeaseStatus, "released" | "failed">;
    failureReason?: string;
  }): Promise<LocalExecutionReleaseResult> {
    const result: LocalExecutionReleaseResult = { released: [], errors: [] };
    let releasedLeases: LocalRunLeaseRecord[];
    try {
      releasedLeases = await localRunLeases.releaseRunLeases({
        companyId: input.companyId,
        runId: input.runId,
        status: input.status,
        failureReason: input.failureReason,
      });
    } catch (error) {
      result.errors.push({ leaseId: "*", error });
      return result;
    }

    for (const released of releasedLeases) {
      try {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.runId,
          action: "execution.local_lease_released",
          entityType: "local_run_lease",
          entityId: released.lease.id,
          issueId: released.lease.issueId,
          details: {
            executionWorkspaceId: released.lease.executionWorkspaceId,
            issueId: released.lease.issueId,
            status: released.lease.status,
            failureReason:
              input.failureReason ?? released.lease.failureReason,
          },
        });
      } catch {
        // Lease release remains authoritative if audit logging is unavailable.
      }
      result.released.push(released);
    }
    return result;
  }

  async function acquireExecutionTargetForRun(input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
    executionWorkspaceBindingId: string;
  }): Promise<LocalExecutionTargetAcquisitionResult> {
    const persistedExecutionWorkspace =
      await resolveExecutionWorkspaceBinding(input);
    if (persistedExecutionWorkspace.branchName) {
      await managedWorkspaceSafeguards({
        workspace: {
          id: persistedExecutionWorkspace.id,
          cwd: persistedExecutionWorkspace.cwd,
          branchName: persistedExecutionWorkspace.branchName,
        },
        issueId: input.issueId,
        runId: input.runId,
      });
    }

    let acquired: LocalRunLeaseRecord;
    try {
      acquired = await localRunLeases.acquireRunLease({
        companyId: input.companyId,
        executionWorkspaceId: persistedExecutionWorkspace.id,
        issueId: input.issueId,
        runId: input.runId,
      });
    } catch (error) {
      throw new LocalExecutionTargetError(
        "lease_acquire_failed",
        `Failed to acquire the local run lease: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    let released = false;
    try {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        runId: input.runId,
        action: "execution.local_lease_acquired",
        entityType: "local_run_lease",
        entityId: acquired.lease.id,
        issueId: input.issueId,
        details: {
          executionWorkspaceId: acquired.lease.executionWorkspaceId,
          issueId: input.issueId,
        },
      });

      const executionTarget: AcpxLocalWorkspaceTarget = {
        kind: "local",
        leaseId: acquired.lease.id,
      };

      return {
        lease: acquired.lease,
        executionTarget,
        async releaseExecutionTarget(failed = false) {
          if (released) return;
          released = true;
          const result = await releaseForRun({
            runId: input.runId,
            companyId: input.companyId,
            agentId: input.agentId,
            status: failed ? "failed" : "released",
            ...(failed
              ? { failureReason: "provider execution failed" }
              : {}),
          });
          if (result.errors.length > 0) {
            throw new LocalExecutionTargetError(
              "lease_release_failed",
              "Failed to release the local run lease.",
              { cause: result.errors[0]?.error },
            );
          }
        },
      };
    } catch (error) {
      if (!released) {
        released = true;
        await releaseForRun({
          runId: input.runId,
          companyId: input.companyId,
          agentId: input.agentId,
          status: "failed",
          failureReason:
            error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  return { acquireExecutionTargetForRun };
}

export type LocalExecutionOrchestrator = ReturnType<
  typeof localExecutionOrchestrator
>;
