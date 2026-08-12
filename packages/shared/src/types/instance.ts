export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
  enableServerInfoDebugView: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableWorktreeRunExecution: boolean;
  worktreeRunExecutionActivatedAt: string | null;
  worktreeRunExecutionActivationInstanceId: string | null;
}
