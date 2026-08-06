export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  enableStreamlinedLeftNavigation: boolean;
  enableApps: boolean;
  enablePipelines: boolean;
  enableCases: boolean;
  enableConferenceRoomChat: boolean;
  enableIssueWatchdogs: boolean;
  enableExperimentalFileViewer: boolean;
  enableCloudSync: boolean;
  enableExternalObjects: boolean;
  enableSmokeLab: boolean;
  enableSummaries: boolean;
  enableDecisions: boolean;
  enableGoalsSidebarLink: boolean;
  enableServerInfoDebugView: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
  /**
   * Worktree preview instances (`PAPERCLIP_IN_WORKTREE=true`) suppress the
   * issue-execution scheduler by default so previews never self-execute issues. When
   * this is enabled the worktree-instance scheduling suppression is lifted so
   * runs actually execute inside the preview. Ignored outside a worktree.
   */
  enableWorktreeRunExecution: boolean;
  /**
   * Server-managed cutoff recorded when worktree run execution is enabled in
   * this instance. Client PATCH payloads must not control this value.
   */
  worktreeRunExecutionActivatedAt: string | null;
  /**
   * Server-managed instance id captured with the cutoff so copied settings rows
   * from another instance fail closed.
   */
  worktreeRunExecutionActivationInstanceId: string | null;
}

export interface InstanceSettings {
  id: string;
  defaultEnvironmentId: string | null;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
