/**
 * Persisted local working-directory identity for an issue ownership epoch.
 *
 * Ordinary reservations always use `shared_workspace`. Branch fields exist
 * only so the explicitly retained managed-worktree safeguards can validate a
 * workspace that already carries managed branch metadata.
 */
export interface ExecutionWorkspace {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  cwd: string;
  repoUrl: string | null;
  /** Null for normal shared local folders. */
  branchName: string | null;
  lastUsedAt: Date;
  createdAt: Date;
}
