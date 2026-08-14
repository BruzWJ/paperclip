import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { executionWorkspaces } from "@paperclipai/db";
import type { ExecutionWorkspace, GitWorktreeBranchAncestryVerdict } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { stableStringify } from "./canonical-json.js";

export { stableStringify };

export type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;

export const execFileAsync = promisify(execFile);

export const WORKSPACE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";

export type ExecutionWorkspaceBranchReconcileMode = "forward";

export type ExecutionWorkspaceBranchReconcileActor = {
  actorType: "system";
  actorId: string;
  runId: string | null;
};

export type ExecutionWorkspaceBranchReconcileInspection = {
  fingerprint: string;
  worktreePath: string;
  repoRoot: string;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  cleanliness: "clean" | "dirty" | "unknown";
  statusEntryCount: number | null;
  plainLanguageReason: string;
};

export type ExecutionWorkspaceBranchReconcileResult = {
  workspace: ExecutionWorkspace;
  boundTaskId: string;
  boundOwnershipEpoch: number;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
  auditCommentId: string | null;
};

export type ExecutionWorkspaceGitWorktreeContention = {
  claimedByWorkspaceId: string;
  claimedByTaskId: string;
  claimedByTaskIdentifier: string;
  activeRun: {
    id: string;
    status: "queued" | "running";
    taskId: string;
    taskNumber: number;
    taskIdentifier: string;
  } | null;
} | null;

export type ExecutionWorkspaceCurrentBinding = {
  id: string;
  companyId: string;
  taskId: string;
  sessionId: string;
  ownershipEpoch: number;
  executionWorkspaceId: string;
  absoluteCwd: string;
  taskNumber: number;
  taskIdentifier: string;
  taskTitle: string | null;
  taskStatus: string;
  taskUpdatedAt: Date;
};

export function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function runGit(args: string[], cwd: string) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

export async function readGitStdout(args: string[], cwd: string): Promise<string | null> {
  const output = await runGit(args, cwd);
  return output.stdout.trim() || null;
}

export function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

export function fingerprintWorkspaceBranchIncoherence(input: {
  taskId: string;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        version: 1,
        reason: WORKSPACE_BRANCH_INCOHERENCE_REASON,
        taskId: input.taskId,
        executionWorkspaceId: input.executionWorkspaceId,
        worktreePath: path.resolve(input.worktreePath),
        expectedBranch: input.expectedBranch,
        actualBranch: input.actualBranch,
        cleanliness: input.cleanliness,
        expectedHeadSha: input.expectedHeadSha,
        actualHeadSha: input.actualHeadSha,
      }),
    )
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

export async function getGitWorktreeBranchAncestryVerdict(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<GitWorktreeBranchAncestryVerdict> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return "unknown";

  try {
    await runGit(["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha], input.repoRoot);
    return "ancestor";
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : null;
    return code === 1 ? "diverged" : "unknown";
  }
}

export function explainGitWorktreeBranchReconcileInspection(input: {
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  if (!input.fromSha || !input.toSha) {
    return `Paperclip could not determine branch ancestry because "${input.fromBranch}" or "${input.toBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.fromSha === input.toSha) {
    return `The recorded branch "${input.fromBranch}" and checked-out branch "${input.toBranch}" resolve to the same commit.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.fromBranch}" is an ancestor of the checked-out branch "${input.toBranch}".`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.fromBranch}" is not an ancestor of the checked-out branch "${input.toBranch}".`;
  }
  return `Paperclip could not determine whether "${input.toBranch}" is forward of "${input.fromBranch}".`;
}

export async function inspectExecutionWorkspaceBranchForReconcile(
  workspace: Pick<ExecutionWorkspace, "id" | "cwd" | "branchName">,
  taskId: string,
): Promise<ExecutionWorkspaceBranchReconcileInspection> {
  const fromBranch = readNullableString(workspace.branchName);
  if (!fromBranch) {
    throw unprocessable("Execution workspace has no recorded branch to reconcile");
  }

  // Ordinary shared folders leave branchName null. A non-null recorded branch
  // is the explicit opt-in metadata for the retained reconciliation safeguard.
  const worktreePath = workspace.cwd;

  const repoRoot = await readGitStdout(["rev-parse", "--show-toplevel"], worktreePath).catch(() => null);
  if (!repoRoot) {
    throw unprocessable("Execution workspace path is not inside a git repository");
  }

  const toBranch = await readGitStdout(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath).catch(
    () => null,
  );
  if (!toBranch) {
    throw unprocessable("Execution workspace is detached; Paperclip cannot reconcile it to a branch name");
  }

  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], worktreePath)
    .then((output) => output.stdout)
    .catch(() => null);
  const statusLines =
    status === null
      ? null
      : status
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
  const cleanliness: ExecutionWorkspaceBranchReconcileInspection["cleanliness"] =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";

  const fromSha = await readGitStdout(
    ["rev-parse", "--verify", `refs/heads/${fromBranch}^{commit}`],
    repoRoot,
  ).catch(() => null);
  const toSha = await readGitStdout(["rev-parse", "HEAD"], worktreePath).catch(() => null);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot,
    expectedHeadSha: fromSha,
    actualHeadSha: toSha,
  });

  return {
    fingerprint: fingerprintWorkspaceBranchIncoherence({
      taskId,
      executionWorkspaceId: workspace.id,
      worktreePath,
      expectedBranch: fromBranch,
      actualBranch: toBranch,
      cleanliness,
      expectedHeadSha: fromSha,
      actualHeadSha: toSha,
    }),
    worktreePath: path.resolve(worktreePath),
    repoRoot: path.resolve(repoRoot),
    fromBranch,
    toBranch,
    fromSha,
    toSha,
    ancestryVerdict,
    cleanliness,
    statusEntryCount: statusLines?.length ?? null,
    plainLanguageReason: explainGitWorktreeBranchReconcileInspection({
      fromBranch,
      toBranch,
      fromSha,
      toSha,
      ancestryVerdict,
    }),
  };
}

export function formatBranchReconcileAuditComment(input: {
  mode: ExecutionWorkspaceBranchReconcileMode;
  reason: string | null;
  workspaceId: string;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
}) {
  return [
    "Execution workspace branch reconciled.",
    "",
    `- Workspace: \`${input.workspaceId}\``,
    `- Mode: \`${input.mode}\``,
    `- From branch: \`${formatBranchForMessage(input.inspection.fromBranch)}\``,
    `- To branch: \`${formatBranchForMessage(input.inspection.toBranch)}\``,
    `- From SHA: \`${input.inspection.fromSha ?? "unknown"}\``,
    `- To SHA: \`${input.inspection.toSha ?? "unknown"}\``,
    `- Verdict: \`${input.inspection.ancestryVerdict}\``,
    `- Fingerprint: \`${input.inspection.fingerprint}\``,
    ...(input.reason ? [`- Operator reason: ${input.reason}`] : []),
  ].join("\n");
}

export function assertBranchReconcileWorkspaceIsSafe(input: {
  inspection: ExecutionWorkspaceBranchReconcileInspection;
}) {
  if (input.inspection.cleanliness !== "clean") {
    throw unprocessable("Execution workspace branch reconciliation requires a clean worktree", {
      inspection: input.inspection,
    });
  }
}

export function assertLockedBranchReconcileWorkspaceStillMatchesInspection(input: {
  lockedRow: ExecutionWorkspaceRow;
  inspectedRow: ExecutionWorkspaceRow;
  inspection: ExecutionWorkspaceBranchReconcileInspection;
}) {
  const lockedPath = readNullableString(input.lockedRow.cwd);
  const lockedBranch = readNullableString(input.lockedRow.branchName);
  const currentPath = lockedPath ? path.resolve(lockedPath) : null;

  if (
    input.lockedRow.projectWorkspaceId !== input.inspectedRow.projectWorkspaceId ||
    lockedBranch !== input.inspection.fromBranch ||
    currentPath !== input.inspection.worktreePath
  ) {
    throw conflict(
      "Execution workspace changed during branch reconciliation; retry with the latest workspace state",
      {
        workspaceId: input.lockedRow.id,
        expected: {
          projectWorkspaceId: input.inspectedRow.projectWorkspaceId,
          branchName: input.inspection.fromBranch,
          worktreePath: input.inspection.worktreePath,
        },
        current: {
          projectWorkspaceId: input.lockedRow.projectWorkspaceId,
          branchName: lockedBranch,
          worktreePath: currentPath,
        },
      },
    );
  }
}

export function toExecutionWorkspace(row: ExecutionWorkspaceRow): ExecutionWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    cwd: row.cwd,
    repoUrl: row.repoUrl ?? null,
    branchName: row.branchName ?? null,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}
