export type GitWorktreeBranchAncestryVerdict =
  | "ancestor"
  | "diverged"
  | "unknown";

export type GitWorktreeInProgressOperation =
  | "rebase"
  | "merge"
  | "cherry_pick"
  | "revert"
  | "bisect";

export interface GitWorktreeBranchIncoherenceEvidence {
  reason: "git_worktree_branch_incoherence";
  fingerprint: string;
  sourceTaskId: string | null;
  sourceIdentifier: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  repoRoot: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  inProgressOperation?: GitWorktreeInProgressOperation | null;
  statusEntryCount: number | null;
  dirtyPathSample: string[];
  contention: {
    claimedByWorkspaceId: string;
    claimedByTaskId: string | null;
    claimedByTaskIdentifier: string | null;
    activeRun: {
      id: string;
      status: "queued" | "running";
      taskId: string | null;
      taskIdentifier: string | null;
    } | null;
  } | null;
  provenance: {
    expectedBranchRef: string;
    actualBranchRef: string | null;
    registeredBranchRef: string | null;
    registeredPathFound: boolean;
    registeredBranchMatchesHead: boolean;
    expectedBranchExists: boolean;
    actualBranchExists: boolean | null;
    expectedHeadSha: string | null;
    actualHeadSha: string | null;
    sameHead: boolean;
    ancestryVerdict: GitWorktreeBranchAncestryVerdict;
    plainLanguageReason: string;
  };
  safeRepair: {
    eligible: boolean;
    attempted: boolean;
    succeeded: boolean;
    reason: string;
  };
}
