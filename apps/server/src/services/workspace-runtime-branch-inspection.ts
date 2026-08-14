import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { type Db, tasks } from "@paperclipai/db";
import {
  type GitWorktreeBranchAncestryVerdict,
  type GitWorktreeBranchIncoherenceEvidence as SharedGitWorktreeBranchIncoherenceEvidence,
  type GitWorktreeInProgressOperation,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { executionWorkspaceService } from "./execution-workspaces.js";
import {
  executeProcess,
  type ExecutionWorkspaceTaskRef,
  localBranchExists,
  runGit,
  sanitizeBranchName,
  stableStringify,
  WorkspaceRuntimeValidationFailure,
} from "./workspace-runtime-process.js";
import { findRegisteredGitWorktreeByPath } from "./workspace-runtime-worktree-registry.js";

export const GIT_WORKTREE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";

export type GitWorktreeCleanliness = SharedGitWorktreeBranchIncoherenceEvidence["cleanliness"];

export type GitWorktreeBranchIncoherenceEvidence = SharedGitWorktreeBranchIncoherenceEvidence;

export type GitWorktreeBranchContention = NonNullable<GitWorktreeBranchIncoherenceEvidence["contention"]>;

export type GitWorktreeBranchCoherenceResult = {
  branchName: string | null;
  reconciledForward: boolean;
  dirtyQuarantineRepair?: DirtyQuarantineRepairResult | null;
  warnings: string[];
};

export type DirtyQuarantineRepairResult = {
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  clearedInProgressOperation: GitWorktreeInProgressOperation | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
};

export function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

export const GIT_IN_PROGRESS_OPERATION_MARKERS: ReadonlyArray<{
  operation: GitWorktreeInProgressOperation;
  marker: string;
}> = [
  { operation: "rebase", marker: "rebase-merge" },
  { operation: "rebase", marker: "rebase-apply" },
  { operation: "merge", marker: "MERGE_HEAD" },
  { operation: "cherry_pick", marker: "CHERRY_PICK_HEAD" },
  { operation: "revert", marker: "REVERT_HEAD" },
  { operation: "bisect", marker: "BISECT_LOG" },
];

export const GIT_IN_PROGRESS_OPERATION_LABELS: Record<GitWorktreeInProgressOperation, string> = {
  rebase: "rebase",
  merge: "merge",
  cherry_pick: "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

// `--quit` clears the interrupted operation's state directory without touching
// the working tree or moving HEAD, unlike `--abort` which resets both.
export const GIT_IN_PROGRESS_OPERATION_QUIT_ARGS: Record<GitWorktreeInProgressOperation, string[]> = {
  rebase: ["rebase", "--quit"],
  merge: ["merge", "--quit"],
  cherry_pick: ["cherry-pick", "--quit"],
  revert: ["revert", "--quit"],
  bisect: ["bisect", "reset", "HEAD"],
};

export async function detectGitWorktreeInProgressOperation(
  worktreePath: string,
): Promise<GitWorktreeInProgressOperation | null> {
  for (const { operation, marker } of GIT_IN_PROGRESS_OPERATION_MARKERS) {
    const markerPath = await runGit(["rev-parse", "--git-path", marker], worktreePath).catch(() => null);
    if (!markerPath) continue;
    if (existsSync(path.resolve(worktreePath, markerPath))) return operation;
  }
  return null;
}

export const DIRTY_PATH_SAMPLE_LIMIT = 5;

export function parseGitPorcelainPath(line: string) {
  const raw = line.trimEnd();
  if (raw.trim().length <= 3) return raw.trim();
  if (raw[1] === " " && raw[2] !== " ") return raw.slice(2).trim();
  return raw.slice(3).trim();
}

export function sampleDirtyStatusPaths(statusLines: string[] | null) {
  return (statusLines ?? [])
    .map(parseGitPorcelainPath)
    .filter((value) => value.length > 0)
    .slice(0, DIRTY_PATH_SAMPLE_LIMIT);
}

export function formatUtcBranchTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function buildDirtyQuarantineRescueBranch(sourceTask: ExecutionWorkspaceTaskRef | null) {
  const taskComponent = sanitizeBranchName(sourceTask?.identifier ?? "task");
  return sanitizeBranchName(`paperclip/rescue/${taskComponent}/${formatUtcBranchTimestamp()}`);
}

export function formatTaskReference(identifier: string | null | undefined) {
  if (!identifier) return "`unavailable task`";
  return `\`${identifier}\``;
}

export async function readTaskCompanyId(db: Db, taskId: string | null | undefined): Promise<string | null> {
  if (!taskId) return null;
  return db
    .select({ companyId: tasks.companyId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .then((rows) => rows[0]?.companyId ?? null);
}

export async function findGitWorktreeBranchContention(input: {
  db: Db | null | undefined;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  actualBranchName: string | null;
}): Promise<GitWorktreeBranchContention | null> {
  if (!input.db) return null;
  const companyId = await readTaskCompanyId(input.db, input.sourceTask?.id);
  if (!companyId) return null;
  return executionWorkspaceService(input.db).findGitWorktreeContention({
    companyId,
    worktreePath: input.worktreePath,
    liveBranchName: input.actualBranchName,
    excludingExecutionWorkspaceId: input.executionWorkspaceId,
  });
}

export async function assertGitIndexIsUnlocked(worktreePath: string) {
  const indexLockPath = await runGit(["rev-parse", "--git-path", "index.lock"], worktreePath).catch(
    () => null,
  );
  if (indexLockPath && existsSync(indexLockPath)) {
    throw new Error(`git index lock exists at ${indexLockPath}`);
  }
}

export function fingerprintWorkspaceBranchIncoherence(input: {
  taskId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: GitWorktreeCleanliness;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        version: 1,
        reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
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

  const proc = await executeProcess({
    command: "git",
    args: ["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha],
    cwd: input.repoRoot,
  }).catch(() => null);
  if (!proc) return "unknown";
  if (proc.code === 0) return "ancestor";
  if (proc.code === 1) return "diverged";
  return "unknown";
}

export function explainGitWorktreeBranchIncoherence(input: {
  expectedBranchName: string;
  actualBranchName: string | null;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  sameHead: boolean;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  const actualBranch = formatBranchForMessage(input.actualBranchName);
  if (!input.expectedHeadSha || !input.actualHeadSha) {
    return `Paperclip could not determine branch ancestry because the recorded branch "${input.expectedBranchName}" or checked-out branch "${actualBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.sameHead) {
    return `The recorded branch "${input.expectedBranchName}" and checked-out branch "${actualBranch}" resolve to the same commit, so the mismatch is branch metadata rather than commit divergence.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.expectedBranchName}" is an ancestor of the checked-out branch "${actualBranch}", so the checked-out branch is forward of the recorded branch.`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.expectedBranchName}" is not an ancestor of the checked-out branch "${actualBranch}", so Paperclip cannot prove a forward-only reconciliation.`;
  }
  return `Paperclip could not determine whether the checked-out branch "${actualBranch}" is forward of the recorded branch "${input.expectedBranchName}".`;
}

export async function inspectGitWorktreeBranchIncoherence(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string | null;
  sourceTask: ExecutionWorkspaceTaskRef | null;
  executionWorkspaceId?: string | null;
}): Promise<GitWorktreeBranchIncoherenceEvidence> {
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], input.worktreePath).catch(
    () => null,
  );
  const statusLines =
    status === null
      ? null
      : status
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length > 0);
  const dirtyPathSample = sampleDirtyStatusPaths(statusLines);
  const cleanliness: GitWorktreeCleanliness =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";
  const inProgressOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
  const expectedHeadSha = await runGit(
    ["rev-parse", "--verify", `refs/heads/${input.expectedBranchName}^{commit}`],
    input.repoRoot,
  ).catch(() => null);
  const actualHeadSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  const actualBranchExists = input.actualBranchName
    ? await localBranchExists(input.repoRoot, input.actualBranchName)
    : null;
  const registered = await findRegisteredGitWorktreeByPath(input.repoRoot, input.worktreePath);
  const actualBranchRef = input.actualBranchName ? `refs/heads/${input.actualBranchName}` : null;
  const registeredBranchRef = registered?.branch ?? null;
  const registeredBranchMatchesHead = Boolean(registered && registeredBranchRef === actualBranchRef);
  const sameHead = Boolean(expectedHeadSha && actualHeadSha && expectedHeadSha === actualHeadSha);
  const expectedBranchExists = Boolean(expectedHeadSha);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot: input.repoRoot,
    expectedHeadSha,
    actualHeadSha,
  });
  const basePlainLanguageReason = explainGitWorktreeBranchIncoherence({
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
    expectedHeadSha,
    actualHeadSha,
    sameHead,
    ancestryVerdict,
  });
  const plainLanguageReason = inProgressOperation
    ? `${basePlainLanguageReason} An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is still in progress in this worktree.`
    : basePlainLanguageReason;
  const canCheckoutRecordedBranch =
    cleanliness === "clean" && expectedBranchExists && sameHead && registeredBranchMatchesHead;
  const canAdoptForwardActualBranch =
    cleanliness === "clean" &&
    expectedBranchExists &&
    actualBranchExists === true &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const canAttachRecordedBranchToDetachedHead =
    cleanliness === "clean" &&
    expectedBranchExists &&
    input.actualBranchName === null &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const eligible =
    canCheckoutRecordedBranch || canAdoptForwardActualBranch || canAttachRecordedBranchToDetachedHead;
  const safeRepairReason = eligible
    ? canCheckoutRecordedBranch
      ? "clean worktree and expected branch points at the current HEAD"
      : canAdoptForwardActualBranch
        ? "clean worktree and checked-out branch is forward of the recorded branch"
        : "clean detached worktree HEAD is forward of the recorded branch"
    : cleanliness !== "clean"
      ? inProgressOperation
        ? `worktree is not clean and a git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is in progress`
        : "worktree is not clean"
      : !registered
        ? "worktree path is not registered"
        : !registeredBranchMatchesHead
          ? "registered worktree branch does not match HEAD"
          : !expectedBranchExists
            ? "expected branch does not exist"
            : !sameHead
              ? "expected branch and current HEAD differ"
              : "safe repair could not be proven";
  const fingerprint = fingerprintWorkspaceBranchIncoherence({
    taskId: input.sourceTask?.id ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    expectedHeadSha,
    actualHeadSha,
  });
  const contention = await findGitWorktreeBranchContention({
    db: input.db ?? null,
    sourceTask: input.sourceTask,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    actualBranchName: input.actualBranchName,
  });

  return {
    reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
    fingerprint,
    ...(input.sourceTask
      ? {
          sourceTaskId: input.sourceTask.id,
          sourceIdentifier: input.sourceTask.identifier,
        }
      : { sourceTaskId: null, sourceIdentifier: null }),
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: path.resolve(input.worktreePath),
    repoRoot: path.resolve(input.repoRoot),
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    inProgressOperation,
    statusEntryCount: statusLines?.length ?? null,
    dirtyPathSample,
    contention,
    provenance: {
      expectedBranchRef: `refs/heads/${input.expectedBranchName}`,
      actualBranchRef,
      registeredBranchRef,
      registeredPathFound: Boolean(registered),
      registeredBranchMatchesHead,
      expectedBranchExists,
      actualBranchExists,
      expectedHeadSha,
      actualHeadSha,
      sameHead,
      ancestryVerdict,
      plainLanguageReason,
    },
    safeRepair: {
      eligible,
      attempted: false,
      succeeded: false,
      reason: safeRepairReason,
    },
  };
}

export function branchIncoherenceValidationFailure(evidence: GitWorktreeBranchIncoherenceEvidence) {
  return new WorkspaceRuntimeValidationFailure(
    `Execution workspace git worktree expected branch "${evidence.expectedBranch}" but found "${formatBranchForMessage(evidence.actualBranch)}" at "${evidence.worktreePath}". Safe repair ${evidence.safeRepair.succeeded ? "succeeded" : "was not completed"}: ${evidence.safeRepair.reason}.`,
    {
      workspaceValidation: evidence,
    },
  );
}
