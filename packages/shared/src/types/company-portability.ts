import type { AgentEnvConfig } from "./secrets.js";
import type { RoutineVariable } from "./routine.js";
import type { TaskCommentAuthorType, PermissionKey } from "../constants.js";
import type {
  AgentContextGrantKey,
  AgentMentionReachGrantKey,
  AgentVisibleTaskStatus,
  TaskDisposition,
  PaperclipActionKey,
} from "../task-runtime.js";
import type { TaskCommentMetadata, TaskCommentPresentation } from "./task.js";
import type { BudgetCurrency, MoneyAmount } from "../money.js";
import type { AgentAdapterAcpConfiguration } from "./agent.js";

export interface CompanyPortabilityInclude {
  company: boolean;
  agents: boolean;
  projects: boolean;
  tasks: boolean;
}

export interface CompanyPortabilityEnvInput {
  key: string;
  description: string | null;
  projectSlug: string | null;
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  defaultValue: string | null;
  portability: "portable" | "system_dependent";
}

export type CompanyPortabilityFileEntry =
  | string
  | {
      encoding: "base64";
      data: string;
      contentType?: string | null;
    };

export interface CompanyPortabilityCompanyManifestEntry {
  path: string;
  name: string;
  description: string | null;
  brandColor: string | null;
  logoPath: string | null;
  budgetCurrency: BudgetCurrency;
  budgetMonthlyAmount: MoneyAmount;
  attachmentMaxBytes: number | null;
  requireBoardApprovalForNewAgents: boolean;
}

/** Package-internal ordering expressed with manifest slugs. */
export interface CompanyPortabilitySidebarOrder {
  agents: string[];
  projects: string[];
}

/** UUID order supplied when exporting live resources into package slugs. */
export interface CompanyPortabilityExportSidebarOrder {
  agents?: string[];
  projects?: string[];
}

export interface CompanyPortabilityProjectManifestEntry {
  slug: string;
  name: string;
  path: string;
  description: string | null;
  ownerAgentSlug: string | null;
  leadAgentSlug: string | null;
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  status: string | null;
  env: AgentEnvConfig | null;
  metadata: Record<string, unknown> | null;
}

export interface CompanyPortabilityTaskRoutineTriggerManifestEntry {
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  signingMode: string | null;
  replayWindowSec: number | null;
}

export interface CompanyPortabilityTaskRoutineManifestEntry {
  concurrencyPolicy: string | null;
  catchUpPolicy: string | null;
  variables?: RoutineVariable[] | null;
  triggers: CompanyPortabilityTaskRoutineTriggerManifestEntry[];
}

export interface CompanyPortabilityTaskCommentManifestEntry {
  body: string;
  authorType: TaskCommentAuthorType;
  authorAgentSlug: string | null;
  authorUserId: string | null;
  presentation: TaskCommentPresentation | null;
  metadata: TaskCommentMetadata | null;
  createdAt: string | null;
}

export interface CompanyPortabilityTaskManifestEntry {
  slug: string;
  title: string | null;
  path: string;
  projectSlug: string | null;
  ownerAgentSlug: string;
  request: string;
  recurring: boolean;
  routine: CompanyPortabilityTaskRoutineManifestEntry | null;
  lifecycleStatus: AgentVisibleTaskStatus;
  disposition: TaskDisposition | null;
  boardPresentationStatus: string;
  priority: string | null;
  labelIds: string[];
  billingCode: string | null;
  comments: CompanyPortabilityTaskCommentManifestEntry[];
  metadata: Record<string, unknown> | null;
}

export interface CompanyPortabilityAgentManifestEntry {
  slug: string;
  name: string;
  path: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  reportsToSlug: string | null;
  reportsToExistingAgentId: string | null;
  reportsToExistingAgentSlug: string | null;
  adapterRevision: {
    sourceRevisionId: string;
    acpConfiguration: AgentAdapterAcpConfiguration;
  };
  contextGrants: Record<AgentContextGrantKey, boolean>;
  actionGrants: Record<PaperclipActionKey, boolean>;
  mentionReachGrants: Record<AgentMentionReachGrantKey, boolean>;
  permissionGrants: Array<{
    permissionKey: PermissionKey;
    scope: Record<string, unknown> | null;
  }>;
  budgetMonthlyAmount: MoneyAmount;
}

export interface CompanyPortabilityManifest {
  schemaVersion: 5;
  generatedAt: string;
  source: {
    companyId: string;
    companyName: string;
  } | null;
  includes: CompanyPortabilityInclude;
  company: CompanyPortabilityCompanyManifestEntry | null;
  sidebar: CompanyPortabilitySidebarOrder | null;
  agents: CompanyPortabilityAgentManifestEntry[];
  projects: CompanyPortabilityProjectManifestEntry[];
  tasks: CompanyPortabilityTaskManifestEntry[];
  envInputs: CompanyPortabilityEnvInput[];
}

export interface CompanyPortabilityExportResult {
  rootPath: string;
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  warnings: string[];
  paperclipExtensionPath: string;
}

export interface CompanyPortabilityExportPreviewFile {
  path: string;
  kind: "company" | "agent" | "project" | "task" | "extension" | "readme" | "other";
}

export interface CompanyPortabilityExportPreviewResult {
  rootPath: string;
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  fileInventory: CompanyPortabilityExportPreviewFile[];
  counts: {
    files: number;
    agents: number;
    projects: number;
    tasks: number;
  };
  warnings: string[];
  paperclipExtensionPath: string;
}

export type CompanyPortabilitySource =
  | {
      type: "inline";
      rootPath?: string | null;
      files: Record<string, CompanyPortabilityFileEntry>;
    }
  | {
      type: "github";
      url: string;
    };

export type CompanyPortabilityImportTarget =
  | {
      mode: "new_company";
      newCompanyName?: string | null;
    }
  | {
      mode: "existing_company";
      companyId: string;
    };

export type CompanyPortabilityAgentSelection = "all" | string[];

export type CompanyPortabilityCollisionStrategy = "rename" | "skip" | "replace";

export interface CompanyPortabilityPreviewRequest {
  source: CompanyPortabilitySource;
  include?: Partial<CompanyPortabilityInclude>;
  target: CompanyPortabilityImportTarget;
  agents?: CompanyPortabilityAgentSelection;
  collisionStrategy?: CompanyPortabilityCollisionStrategy;
  nameOverrides?: Record<string, string>;
  selectedFiles?: string[];
  adapterOverrides?: Record<string, CompanyPortabilityAdapterOverride>;
}

export interface CompanyPortabilityPreviewAgentPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingAgentId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewProjectPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingProjectId: string | null;
  reason: string | null;
}

export interface CompanyPortabilityPreviewTaskPlan {
  slug: string;
  action: "create" | "skip";
  plannedTitle: string;
  reason: string | null;
}

export interface CompanyPortabilityPreviewResult {
  include: CompanyPortabilityInclude;
  targetCompanyId: string | null;
  targetCompanyName: string | null;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgentSlugs: string[];
  plan: {
    companyAction: "none" | "create" | "update";
    agentPlans: CompanyPortabilityPreviewAgentPlan[];
    projectPlans: CompanyPortabilityPreviewProjectPlan[];
    taskPlans: CompanyPortabilityPreviewTaskPlan[];
  };
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  envInputs: CompanyPortabilityEnvInput[];
  warnings: string[];
  errors: string[];
}

export interface CompanyPortabilityAdapterOverride {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface CompanyPortabilityImportRequest extends CompanyPortabilityPreviewRequest {
  secretValues?: Record<string, string>;
}

export interface CompanyPortabilityImportResult {
  company: {
    id: string;
    name: string;
    action: "created" | "updated" | "unchanged";
  };
  agents: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  projects: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  envInputs: CompanyPortabilityEnvInput[];
  warnings: string[];
}

export interface CompanyPortabilityExportRequest {
  include?: Partial<CompanyPortabilityInclude>;
  agents?: string[];
  projects?: string[];
  tasks?: string[];
  projectTasks?: string[];
  selectedFiles?: string[];
  sidebarOrder?: CompanyPortabilityExportSidebarOrder;
}
