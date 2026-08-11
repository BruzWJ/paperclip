import type {
  TaskStatus,
  TaskTreeControlMode,
  TaskTreeHoldReleasePolicyStrategy,
  TaskTreeHoldStatus,
} from "../constants.js";

export interface TaskTreeHoldReleasePolicy {
  strategy: TaskTreeHoldReleasePolicyStrategy;
  note?: string | null;
}

export interface TaskTreePreviewRun {
  id: string;
  taskId: string;
  agentId: string;
  status: "queued" | "running";
  startedAt: Date | null;
  createdAt: Date;
}

export interface TaskTreePreviewAgent {
  agentId: string;
  taskCount: number;
  activeRunCount: number;
}

export interface TaskTreePreviewTask {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: TaskStatus;
  parentId: string | null;
  depth: number;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  activeRun: TaskTreePreviewRun | null;
  activeHoldIds: string[];
  action: TaskTreeControlMode;
  skipped: boolean;
  skipReason: string | null;
}

export interface TaskTreePreviewWarning {
  code: string;
  message: string;
  taskIds?: string[];
}

export interface TaskTreePreviewTotals {
  totalTasks: number;
  affectedTasks: number;
  skippedTasks: number;
  activeRuns: number;
  queuedRuns: number;
  affectedAgents: number;
}

export interface TaskTreeControlPreview {
  companyId: string;
  rootTaskId: string;
  mode: TaskTreeControlMode;
  generatedAt: Date;
  releasePolicy: TaskTreeHoldReleasePolicy | null;
  totals: TaskTreePreviewTotals;
  countsByStatus: Partial<Record<TaskStatus, number>>;
  tasks: TaskTreePreviewTask[];
  skippedTasks: TaskTreePreviewTask[];
  activeRuns: TaskTreePreviewRun[];
  affectedAgents: TaskTreePreviewAgent[];
  warnings: TaskTreePreviewWarning[];
}

export interface TaskTreeHoldMember {
  id: string;
  companyId: string;
  holdId: string;
  taskId: string;
  parentTaskId: string | null;
  depth: number;
  taskIdentifier: string | null;
  taskTitle: string | null;
  taskStatus: TaskStatus;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  activeRunId: string | null;
  activeRunStatus: string | null;
  skipped: boolean;
  skipReason: string | null;
  createdAt: Date;
}

export interface TaskTreeHold {
  id: string;
  companyId: string;
  rootTaskId: string;
  mode: TaskTreeControlMode;
  status: TaskTreeHoldStatus;
  reason: string | null;
  releasePolicy: TaskTreeHoldReleasePolicy | null;
  createdByActorType: "user" | "agent" | "system";
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  releasedAt: Date | null;
  releasedByActorType: "user" | "agent" | "system" | null;
  releasedByAgentId: string | null;
  releasedByUserId: string | null;
  releasedByRunId: string | null;
  releaseReason: string | null;
  releaseMetadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  members?: TaskTreeHoldMember[];
}
