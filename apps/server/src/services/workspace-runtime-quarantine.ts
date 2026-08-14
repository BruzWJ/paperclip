import type { Db } from "@paperclipai/db";
import {
  type GitWorktreeBranchAncestryVerdict,
  type GitWorktreeInProgressOperation,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { appendCanonicalControlNotice } from "./task-session-producers.js";
import {
  type ExecutionWorkspaceTaskRef,
  gitErrorIncludes,
  runGit,
  runSafeguardGitOperation,
  WorkspaceRuntimeValidationFailure,
} from "./workspace-runtime-process.js";
import * as branchInspection from "./workspace-runtime-branch-inspection.js";

export function formatDirtyQuarantineContentionRefusal(
  contention: branchInspection.GitWorktreeBranchContention,
) {
  const activeRunText = contention.activeRun
    ? ` with active run ${contention.activeRun.id}`
    : " with no active run";
  return `dirty quarantine repair refused because workspace ${contention.claimedByWorkspaceId} already claims the live branch${activeRunText}`;
}

export function formatDirtyQuarantineFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    gitErrorIncludes(error, "index.lock") ||
    gitErrorIncludes(error, "index lock") ||
    gitErrorIncludes(error, "another git process") ||
    gitErrorIncludes(error, "Unable to create")
  ) {
    return `dirty quarantine repair aborted because git reported index contention: ${message}`;
  }
  return `dirty quarantine repair failed: ${message}`;
}

export function formatDirtyQuarantineAuditComment(input: {
  evidence: branchInspection.GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  claimant: branchInspection.GitWorktreeBranchContention | null;
}) {
  const dirtySample =
    input.evidence.dirtyPathSample.length > 0
      ? input.evidence.dirtyPathSample.map((entry) => `\`${entry}\``).join(", ")
      : "`none captured`";
  return [
    "Execution workspace dirty worktree quarantined before restore.",
    "",
    `- Source task: ${branchInspection.formatTaskReference(input.evidence.sourceIdentifier ?? input.sourceTask?.identifier ?? null)}`,
    `- Workspace: \`${input.evidence.executionWorkspaceId ?? "unpersisted"}\``,
    `- Worktree: \`${input.evidence.worktreePath}\``,
    `- Recorded branch: \`${input.evidence.expectedBranch}\``,
    `- Live branch: \`${branchInspection.formatBranchForMessage(input.evidence.actualBranch)}\``,
    `- Rescue branch: \`${input.rescueBranch}\``,
    `- Rescue commit: \`${input.rescueCommitSha}\``,
    `- Dirty file count: \`${input.fileCount}\``,
    `- Dirty path sample: ${dirtySample}`,
    ...(input.evidence.inProgressOperation
      ? [
          `- Interrupted operation: \`git ${branchInspection.GIT_IN_PROGRESS_OPERATION_LABELS[input.evidence.inProgressOperation]}\` (state cleared after rescue; resolution preserved on the rescue branch)`,
        ]
      : []),
    `- Fingerprint: \`${input.evidence.fingerprint}\``,
    input.claimant
      ? `- Claimant: workspace \`${input.claimant.claimedByWorkspaceId}\` on task ${branchInspection.formatTaskReference(input.claimant.claimedByTaskIdentifier)}${input.claimant.activeRun ? ` with active run \`${input.claimant.activeRun.id}\`` : " with no active run"}`
      : "- Claimant: none",
  ].join("\n");
}

export async function writeDirtyQuarantineAuditComments(input: {
  db: Db;
  companyId: string;
  evidence: branchInspection.GitWorktreeBranchIncoherenceEvidence;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  runId: string | null;
}): Promise<{
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}> {
  const body = formatDirtyQuarantineAuditComment({
    evidence: input.evidence,
    rescueBranch: input.rescueBranch,
    rescueCommitSha: input.rescueCommitSha,
    fileCount: input.fileCount,
    sourceTask: input.sourceTask,
    claimant: input.evidence.contention,
  });
  let sourceAuditCommentId: string | null = null;
  let claimantAuditCommentId: string | null = null;
  if (input.evidence.sourceTaskId) {
    const sourceNotice = await appendCanonicalControlNotice(input.db, {
      companyId: input.companyId,
      taskId: input.evidence.sourceTaskId,
      sourceKind: "workspace_dirty_quarantine",
      immutableSourceKey: `${input.evidence.fingerprint}:source:${input.rescueCommitSha}`,
      sourceRecordId: input.evidence.fingerprint,
      exactText: body,
      comment: {
        author: { kind: "system", source: "recovery" },
        producingRun: null,
      },
      allowTerminal: true,
    });
    sourceAuditCommentId = sourceNotice.comment?.id ?? null;
  }

  const claimantTaskId = input.evidence.contention?.claimedByTaskId ?? null;
  if (claimantTaskId && claimantTaskId !== input.evidence.sourceTaskId) {
    const claimantNotice = await appendCanonicalControlNotice(input.db, {
      companyId: input.companyId,
      taskId: claimantTaskId,
      sourceKind: "workspace_dirty_quarantine",
      immutableSourceKey: `${input.evidence.fingerprint}:claimant:${claimantTaskId}:${input.rescueCommitSha}`,
      sourceRecordId: input.evidence.fingerprint,
      exactText: body,
      comment: {
        author: { kind: "system", source: "recovery" },
        producingRun: null,
      },
      allowTerminal: true,
    });
    claimantAuditCommentId = claimantNotice.comment?.id ?? null;
  }

  return { sourceAuditCommentId, claimantAuditCommentId };
}

export async function logDirtyQuarantineActivity(input: {
  db: Db;
  companyId: string;
  evidence: branchInspection.GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  runId: string | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.runId,
    action: "execution_workspace.dirty_worktree_quarantined",
    entityType: input.evidence.executionWorkspaceId ? "execution_workspace" : "task",
    entityId: input.evidence.executionWorkspaceId ?? input.evidence.sourceTaskId ?? input.companyId,
    details: {
      reason: branchInspection.GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceTaskId: input.evidence.sourceTaskId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      worktreePath: input.evidence.worktreePath,
      expectedBranch: input.evidence.expectedBranch,
      actualBranch: input.evidence.actualBranch,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      contention: input.evidence.contention,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

export async function quarantineDirtyWorktreeBranchIncoherence(input: {
  db: Db;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId: string | null;
  runId: string | null;
  evidence: branchInspection.GitWorktreeBranchIncoherenceEvidence;
}): Promise<branchInspection.DirtyQuarantineRepairResult> {
  const companyId = await branchInspection.readTaskCompanyId(input.db, input.evidence.sourceTaskId);
  if (!companyId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a source task company for audit";
    throw branchInspection.branchIncoherenceValidationFailure(input.evidence);
  }

  const freshContention = await branchInspection.findGitWorktreeBranchContention({
    db: input.db,
    sourceTask: input.sourceTask,
    executionWorkspaceId: input.executionWorkspaceId,
    worktreePath: input.worktreePath,
    actualBranchName: input.evidence.actualBranch,
  });
  input.evidence.contention = freshContention;
  if (freshContention) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(freshContention);
    throw branchInspection.branchIncoherenceValidationFailure(input.evidence);
  }

  const rescueBranch = branchInspection.buildDirtyQuarantineRescueBranch(input.sourceTask);
  const fileCount = input.evidence.statusEntryCount ?? input.evidence.dirtyPathSample.length;
  const baseMetadata = {
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.evidence.actualBranch,
    branchIncoherenceDirtyQuarantineRepair: true,
    rescueBranch,
    fingerprint: input.evidence.fingerprint,
    sourceTaskId: input.evidence.sourceTaskId,
    executionWorkspaceId: input.evidence.executionWorkspaceId,
    fileCount,
    dirtyPathSample: input.evidence.dirtyPathSample,
    contention: input.evidence.contention,
  };

  let rescueBranchCreated = false;
  let expectedBranchRestored = false;
  try {
    await branchInspection.assertGitIndexIsUnlocked(input.worktreePath);
    await runSafeguardGitOperation({
      args: ["checkout", "-b", rescueBranch],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Created rescue branch ${rescueBranch} for dirty git worktree state at ${input.worktreePath}\n`,
      failureLabel: `git checkout -b ${rescueBranch}`,
    });
    rescueBranchCreated = true;
    await runSafeguardGitOperation({
      args: ["add", "-A"],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Staged dirty git worktree state for rescue branch ${rescueBranch}\n`,
      failureLabel: "git add -A",
    });
    await runSafeguardGitOperation({
      args: [
        "commit",
        "-m",
        "Paperclip dirty workspace rescue",
        "-m",
        [
          `Source-Task: ${input.evidence.sourceIdentifier ?? "unidentified-task"}`,
          `Run-Id: ${input.runId ?? "unknown"}`,
          `Recorded-Branch: ${input.expectedBranchName}`,
          `Live-Branch: ${branchInspection.formatBranchForMessage(input.evidence.actualBranch)}`,
          `Fingerprint: ${input.evidence.fingerprint}`,
        ].join("\n"),
      ],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Committed dirty git worktree state to rescue branch ${rescueBranch}\n`,
      failureLabel: "git commit dirty workspace rescue",
    });
    const rescueCommitSha = await runGit(["rev-parse", "HEAD"], input.worktreePath);
    await runSafeguardGitOperation({
      args: ["checkout", input.expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        ...baseMetadata,
        rescueCommitSha,
      },
      successMessage: `Restored recorded branch ${input.expectedBranchName} after dirty workspace rescue ${rescueBranch}\n`,
      failureLabel: `git checkout ${input.expectedBranchName}`,
    });
    expectedBranchRestored = true;

    // A run that died mid-rebase (or mid-merge/cherry-pick/revert/bisect)
    // leaves the operation's state directory behind even after the recorded
    // branch is checked out, which wedges the next git command in the
    // worktree. The rescue commit above already preserved the in-flight
    // resolution, so clearing the state metadata here loses nothing.
    let clearedInProgressOperation: GitWorktreeInProgressOperation | null = null;
    const lingeringOperation = await branchInspection.detectGitWorktreeInProgressOperation(
      input.worktreePath,
    );
    if (lingeringOperation) {
      const operationLabel = branchInspection.GIT_IN_PROGRESS_OPERATION_LABELS[lingeringOperation];
      const quitArgs = branchInspection.GIT_IN_PROGRESS_OPERATION_QUIT_ARGS[lingeringOperation];
      await runSafeguardGitOperation({
        args: quitArgs,
        cwd: input.worktreePath,
        metadata: {
          ...baseMetadata,
          clearedInProgressOperation: lingeringOperation,
        },
        successMessage: `Cleared interrupted git ${operationLabel} state after dirty workspace rescue ${rescueBranch}\n`,
        failureLabel: `git ${quitArgs.join(" ")}`,
      });
      const stillInProgress = await branchInspection.detectGitWorktreeInProgressOperation(input.worktreePath);
      if (stillInProgress) {
        input.evidence.safeRepair.succeeded = false;
        input.evidence.safeRepair.reason = `dirty quarantine repair could not clear the interrupted git ${branchInspection.GIT_IN_PROGRESS_OPERATION_LABELS[stillInProgress]} state`;
        throw branchInspection.branchIncoherenceValidationFailure(input.evidence);
      }
      clearedInProgressOperation = lingeringOperation;
    }

    const repairedBranch = await runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      input.worktreePath,
    ).catch(() => null);
    if (repairedBranch !== input.expectedBranchName) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason = `dirty quarantine repair checked out ${branchInspection.formatBranchForMessage(repairedBranch)} instead of ${input.expectedBranchName}`;
      throw branchInspection.branchIncoherenceValidationFailure(input.evidence);
    }
    const repairedStatus = await runGit(
      ["status", "--porcelain", "--untracked-files=all"],
      input.worktreePath,
    );
    if (repairedStatus.trim().length > 0) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason = "dirty quarantine repair completed but the worktree is still dirty";
      throw branchInspection.branchIncoherenceValidationFailure(input.evidence);
    }

    const comments = await writeDirtyQuarantineAuditComments({
      db: input.db,
      companyId,
      evidence: input.evidence,
      sourceTask: input.sourceTask,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      runId: input.runId,
    });
    await logDirtyQuarantineActivity({
      db: input.db,
      companyId,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      runId: input.runId,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    return {
      rescueBranch,
      rescueCommitSha,
      fileCount,
      clearedInProgressOperation,
      ...comments,
    };
  } catch (error) {
    if (rescueBranchCreated && !expectedBranchRestored) {
      await runGit(["checkout", input.expectedBranchName], input.worktreePath).catch(() => null);
    }
    if (error instanceof WorkspaceRuntimeValidationFailure) throw error;
    input.evidence.safeRepair.succeeded = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineFailure(error);
    throw branchInspection.branchIncoherenceValidationFailure(input.evidence);
  }
}

export async function logForwardBranchReconcileActivity(input: {
  db: Db;
  companyId: string;
  executionWorkspaceId: string;
  sourceTaskId: string | null;
  runId: string | null;
  mode: "forward";
  reason: string | null;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  fingerprint: string;
  auditCommentId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.runId,
    action: "execution_workspace.branch_reconciled",
    entityType: "execution_workspace",
    entityId: input.executionWorkspaceId,
    details: {
      mode: input.mode,
      reason: input.reason,
      fromBranch: input.fromBranch,
      toBranch: input.toBranch,
      fromSha: input.fromSha,
      toSha: input.toSha,
      ancestryVerdict: input.ancestryVerdict,
      fingerprint: input.fingerprint,
      sourceTaskId: input.sourceTaskId,
      auditCommentId: input.auditCommentId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}
