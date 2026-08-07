export type ExecutionWorkspaceStrategyType =
  | "project_primary"
  | "adapter_managed"
  | "cloud_sandbox";

export type ExecutionWorkspaceMode =
  | "shared_workspace"
  | "adapter_managed"
  | "cloud_sandbox";

export type ExecutionWorkspaceProviderType =
  | "local_fs"
  | "adapter_managed"
  | "cloud_sandbox";

export type ExecutionWorkspaceStatus =
  | "active"
  | "idle"
  | "in_review"
  | "archived"
  | "cleanup_failed";

export type WorkspaceRuntimeDesiredState = "running" | "stopped" | "manual";
export type WorkspaceRuntimeServiceStateMap = Record<string, WorkspaceRuntimeDesiredState>;
export type WorkspaceCommandKind = "service" | "job";

export interface WorkspaceCommandSource {
  type: "paperclip";
  key: "commands" | "services" | "jobs";
  index: number;
}

export interface WorkspaceCommandDefinition {
  id: string;
  name: string;
  kind: WorkspaceCommandKind;
  command: string | null;
  cwd: string | null;
  lifecycle: "shared" | "ephemeral" | null;
  serviceIndex: number | null;
  disabledReason: string | null;
  rawConfig: Record<string, unknown>;
  source: WorkspaceCommandSource;
}

export interface ExecutionWorkspaceConfig {
  provisionCommand: string | null;
  teardownCommand: string | null;
  cleanupCommand: string | null;
  workspaceRuntime: Record<string, unknown> | null;
  desiredState: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}

export interface ProjectWorkspaceRuntimeConfig {
  workspaceRuntime: Record<string, unknown> | null;
  desiredState: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}

export interface WorkspaceRuntimeControlTarget {
  workspaceCommandId?: string | null;
  runtimeServiceId?: string | null;
  serviceIndex?: number | null;
}

export interface ExecutionWorkspaceSummary {
  id: string;
  name: string;
  mode: ExecutionWorkspaceMode;
  status: ExecutionWorkspaceStatus;
  cwd: string | null;
  branchName: string | null;
  projectWorkspaceId: string | null;
  lastUsedAt: Date;
}

export interface ExecutionWorkspace {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  sourceIssueId: string | null;
  mode: ExecutionWorkspaceMode;
  strategyType: ExecutionWorkspaceStrategyType;
  name: string;
  status: ExecutionWorkspaceStatus;
  cwd: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  providerType: ExecutionWorkspaceProviderType;
  providerRef: string | null;
  derivedFromExecutionWorkspaceId: string | null;
  lastUsedAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  cleanupEligibleAt: Date | null;
  cleanupReason: string | null;
  config: ExecutionWorkspaceConfig | null;
  metadata: Record<string, unknown> | null;
  runtimeServices?: WorkspaceRuntimeService[];
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceRuntimeService {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: Date;
  startedAt: Date;
  stoppedAt: Date | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  configIndex?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkspaceRealizationTransport = "local" | "ssh" | "sandbox" | "plugin";

export type WorkspaceRealizationSyncStrategy =
  | "none"
  | "ssh_git_import_export"
  | "sandbox_archive_upload_download"
  | "provider_defined";

export interface WorkspaceRealizationRequest {
  version: 1;
  adapterType: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  runId: string;
  requestedMode: string | null;
  source: {
    kind: "project_primary" | "issue_execution";
    localPath: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    strategy: "project_primary";
    branchName: string | null;
    worktreePath: string | null;
  };
  runtimeOverlay: {
    provisionCommand: string | null;
    teardownCommand: string | null;
    cleanupCommand: string | null;
    workspaceRuntime: Record<string, unknown> | null;
  };
}

export interface WorkspaceRealizationRecord {
  version: 1;
  transport: WorkspaceRealizationTransport;
  provider: string | null;
  environmentId: string;
  leaseId: string;
  providerLeaseId: string | null;
  local: {
    path: string;
    source: WorkspaceRealizationRequest["source"]["kind"];
    strategy: WorkspaceRealizationRequest["source"]["strategy"];
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
    worktreePath: string | null;
  };
  remote: {
    path: string | null;
    host?: string | null;
    port?: number | null;
    username?: string | null;
    sandboxId?: string | null;
  };
  sync: {
    strategy: WorkspaceRealizationSyncStrategy;
    prepare: string;
    syncBack: string | null;
  };
  bootstrap: {
    command: string | null;
  };
  rebuild: {
    executionWorkspaceId: string | null;
    mode: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    localPath: string;
    remotePath: string | null;
    providerLeaseId: string | null;
    metadata: Record<string, unknown>;
  };
  summary: string;
}
