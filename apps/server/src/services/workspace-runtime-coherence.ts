import type { Db } from "@paperclipai/db";
import { executionWorkspaceService } from "./execution-workspaces.js";
import {
  type ExecutionWorkspaceTaskRef,
  formatShortSha,
  runGit,
  runSafeguardGitOperation,
} from "./workspace-runtime-process.js";
import {
  branchIncoherenceValidationFailure,
  formatBranchForMessage,
  GIT_IN_PROGRESS_OPERATION_LABELS,
  type GitWorktreeBranchCoherenceResult,
  inspectGitWorktreeBranchIncoherence,
} from "./workspace-runtime-branch-inspection.js";
import {
  formatDirtyQuarantineContentionRefusal,
  logForwardBranchReconcileActivity,
  quarantineDirtyWorktreeBranchIncoherence,
} from "./workspace-runtime-quarantine.js";
export {
  findRegisteredGitWorktreeByPath,
  parseGitWorktreeListPorcelain,
  resolvePathForWorktreeComparison,
} from "./workspace-runtime-worktree-registry.js";

export async function ensureGitWorktreeBranchCoherent(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId?: string | null;
  actualBranchName?: string | null;
  runId?: string | null;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
}): Promise<GitWorktreeBranchCoherenceResult> {
  const expectedBranchName = input.expectedBranchName?.trim();
  if (!expectedBranchName) return { branchName: null, reconciledForward: false, warnings: [] };

  const currentBranch =
    input.actualBranchName !== undefined
      ? input.actualBranchName
      : await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath).catch(() => null);
  if (currentBranch === expectedBranchName) {
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      warnings: [],
    };
  }

  const evidence = await inspectGitWorktreeBranchIncoherence({
    db: input.db ?? null,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName,
    actualBranchName: currentBranch,
    sourceTask: input.sourceTask,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
  });

  if (evidence.cleanliness === "dirty") {
    if (!input.enableWorkspaceDirtyQuarantineRepair) {
      evidence.safeRepair.eligible = false;
      evidence.safeRepair.reason = "dirty workspace quarantine repair is disabled in General settings";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!input.db) {
      evidence.safeRepair.reason =
        "dirty quarantine repair requires database access for claimant checks and audit";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.registeredPathFound) {
      evidence.safeRepair.reason = "dirty quarantine repair requires a registered git worktree path";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.expectedBranchExists) {
      evidence.safeRepair.reason = "dirty quarantine repair requires the recorded branch to exist";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (evidence.contention) {
      evidence.safeRepair.eligible = false;
      evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(evidence.contention);
      throw branchIncoherenceValidationFailure(evidence);
    }
    evidence.safeRepair.eligible = true;
    evidence.safeRepair.attempted = true;
    evidence.safeRepair.reason =
      "dirty worktree can be quarantined on a rescue branch before restoring the recorded branch";
    const result = await quarantineDirtyWorktreeBranchIncoherence({
      db: input.db,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName,
      sourceTask: input.sourceTask,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      runId: input.runId ?? null,
      evidence,
    });
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = result.clearedInProgressOperation
      ? `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}; interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} state cleared`
      : `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}`;
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      dirtyQuarantineRepair: result,
      warnings: [
        `Execution workspace dirty worktree state was quarantined on rescue branch "${result.rescueBranch}" (${formatShortSha(result.rescueCommitSha)}; ${result.fileCount} ${result.fileCount === 1 ? "file" : "files"}) before restoring recorded branch "${expectedBranchName}".${result.clearedInProgressOperation ? ` An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} was also cleared; its in-flight state is preserved on the rescue branch.` : ""}`,
      ],
    };
  }

  if (
    !input.enableWorkspaceBranchReconcileForward &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead
  ) {
    evidence.safeRepair.eligible = false;
    evidence.safeRepair.reason = "forward branch reconciliation is disabled in General settings";
    throw branchIncoherenceValidationFailure(evidence);
  }

  if (
    input.enableWorkspaceBranchReconcileForward &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.cleanliness === "clean" &&
    currentBranch
  ) {
    const reason =
      "Automatic forward reconciliation: recorded branch is an ancestor of the checked-out branch.";
    if (!input.executionWorkspaceId) {
      evidence.safeRepair.reason = "forward reconciliation requires a persisted execution workspace id";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!input.db) {
      evidence.safeRepair.reason =
        "forward reconciliation requires database access to update the execution workspace record";
      throw branchIncoherenceValidationFailure(evidence);
    }
    try {
      const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
        input.executionWorkspaceId,
        {
          mode: "forward",
          taskId: evidence.sourceTaskId,
          reason,
          actor: {
            actorType: "system",
            actorId: "workspace_runtime",
            runId: input.runId ?? null,
          },
        },
      );
      await logForwardBranchReconcileActivity({
        db: input.db,
        companyId: result.workspace.companyId,
        executionWorkspaceId: result.workspace.id,
        sourceTaskId: result.boundTaskId,
        runId: input.runId ?? null,
        mode: "forward",
        reason,
        fromBranch: result.inspection.fromBranch,
        toBranch: result.inspection.toBranch,
        fromSha: result.inspection.fromSha,
        toSha: result.inspection.toSha,
        ancestryVerdict: result.inspection.ancestryVerdict,
        fingerprint: result.inspection.fingerprint,
        auditCommentId: result.auditCommentId,
      });
      return {
        branchName: result.inspection.toBranch,
        reconciledForward: true,
        warnings: [],
      };
    } catch (error) {
      evidence.safeRepair.reason = `forward reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }
  }

  if (!evidence.safeRepair.eligible) {
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.attempted = true;
  const warningPrefix = `Execution workspace branch metadata was self-healed from "${expectedBranchName}" to "${formatBranchForMessage(currentBranch)}" at ${input.worktreePath}.`;
  if (
    currentBranch &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead
  ) {
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason =
      "clean worktree adopted the checked-out branch because it is forward of the recorded branch";
    return {
      branchName: currentBranch,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The checked-out branch contains the recorded branch plus newer commits, so Paperclip adopted it for subsequent runs.`,
      ],
    };
  }

  if (
    currentBranch === null &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.provenance.actualHeadSha
  ) {
    try {
      await runSafeguardGitOperation({
        args: ["checkout", "-B", expectedBranchName, evidence.provenance.actualHeadSha],
        cwd: input.worktreePath,
        metadata: {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          expectedBranchName,
          actualBranchName: currentBranch,
          branchIncoherenceRepair: true,
          detachedHeadRepair: true,
          fingerprint: evidence.fingerprint,
          sourceTaskId: evidence.sourceTaskId,
          executionWorkspaceId: evidence.executionWorkspaceId,
        },
        successMessage: `Reattached detached git worktree HEAD at ${input.worktreePath} to ${expectedBranchName}\n`,
        failureLabel: `git checkout -B ${expectedBranchName} ${formatShortSha(evidence.provenance.actualHeadSha)}`,
      });
    } catch (error) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `safe detached HEAD reattachment failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    const repairedBranch = await runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      input.worktreePath,
    ).catch(() => null);
    if (repairedBranch !== expectedBranchName) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `reattach completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean detached worktree HEAD was reattached to the recorded branch";
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The detached HEAD contained the recorded branch plus newer commits, so Paperclip moved the recorded branch to that HEAD.`,
      ],
    };
  }

  try {
    await runSafeguardGitOperation({
      args: ["checkout", expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        expectedBranchName,
        actualBranchName: currentBranch,
        branchIncoherenceRepair: true,
        fingerprint: evidence.fingerprint,
        sourceTaskId: evidence.sourceTaskId,
        executionWorkspaceId: evidence.executionWorkspaceId,
      },
      successMessage: `Repaired clean git worktree branch mismatch at ${input.worktreePath}: checked out ${expectedBranchName}\n`,
      failureLabel: `git checkout ${expectedBranchName}`,
    });
  } catch (error) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `safe checkout failed: ${error instanceof Error ? error.message : String(error)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  const repairedBranch = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    input.worktreePath,
  ).catch(() => null);
  if (repairedBranch !== expectedBranchName) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `checkout completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.succeeded = true;
  evidence.safeRepair.reason = "clean worktree checked out the recorded branch";
  return {
    branchName: expectedBranchName,
    reconciledForward: false,
    warnings: [
      `Execution workspace branch metadata was self-healed by checking out recorded branch "${expectedBranchName}" at ${input.worktreePath}.`,
    ],
  };
}
