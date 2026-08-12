import type { BudgetWindowKind, PauseReason, ProjectStatus } from "../constants.js";
import type { AgentEnvConfig } from "./secrets.js";
import type { MoneyAmount } from "../money.js";

export interface ProjectGoalRef {
  id: string;
  title: string;
}

/**
 * Lightweight per-project budget summary surfaced on the projects list payload
 * Reflects the active canonical budget policy scoped to the project.
 */
export interface ProjectBudgetSummary {
  limitAmount: MoneyAmount;
  windowKind: BudgetWindowKind;
}

/**
 * Board-managed source and local execution location for a project.
 *
 * Runtime-only workspace records and service controls intentionally stay out
 * of this projection.
 */
export interface ProjectCodebase {
  workspaceId: string | null;
  repoUrl: string | null;
  localFolder: string | null;
}

export interface ProjectManagedByPlugin {
  id: string;
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  resourceKind: "project";
  resourceKey: string;
  defaultsJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  companyId: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  env: AgentEnvConfig | null;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  managedByPlugin?: ProjectManagedByPlugin | null;
  /**
   * Number of tasks in the project. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  taskCount?: number;
  /**
   * Active budget for the project, when set. Populated by the projects list
   * endpoint (IA Phase 4 — PAP-60); omitted on single-project payloads.
   */
  budget?: ProjectBudgetSummary | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
