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

interface GitWorktreeBranchIncoherenceEvidenceBase {
  reason: "git_worktree_branch_incoherence";
  fingerprint: string;
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

export type GitWorktreeBranchIncoherenceEvidence =
  GitWorktreeBranchIncoherenceEvidenceBase & (
    | {
        sourceTaskId: string;
        sourceIdentifier: string;
      }
    | {
        sourceTaskId: null;
        sourceIdentifier: null;
      }
  );
