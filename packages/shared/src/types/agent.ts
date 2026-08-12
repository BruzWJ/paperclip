import type {
  PauseReason,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";
import type { AgentOrgChainHealth } from "../agent-eligibility.js";
import type {
  AgentAdapterAcpConfigurationInput,
} from "../validators/agent-adapter-revision.js";
import type { MoneyAmount } from "../money.js";

/** Canonical persisted shape; immutability is enforced by revision append-only writes. */
export type AgentAdapterAcpConfiguration =
  AgentAdapterAcpConfigurationInput;

export interface AgentAdapterConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  revisionNumber: number;
  acpConfiguration: AgentAdapterAcpConfiguration;
  digest: string;
  parentRevisionId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface AgentAccessState {
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  title: string | null;
}

export interface AgentPluginManagementBinding {
  id: string;
  companyId: string;
  pluginId: string;
  pluginKey: string;
  resourceKey: string;
  lifecycleState:
    | "active"
    | "triage_paused"
    | "adopted"
    | "terminated";
  originalDeclarationRef: Record<string, unknown> | null;
  lifecycleReason: string | null;
  triagePausedAt: Date | null;
  adoptedAt: Date | null;
  terminatedAt: Date | null;
  lifecycleActorType: string | null;
  lifecycleActorId: string | null;
  lifecycleAudit: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  currentAdapterConfigRevisionId: string | null;
  budgetMonthlyAmount: MoneyAmount;
  knownSpendAmount: MoneyAmount;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  errorReason?: string | null;
  instruction: string | null;
  orgChainHealth?: AgentOrgChainHealth;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Safe board-facing projection of an agent that is control-plane eligible to
 * own newly dispatched task work and has a current configuration revision.
 * Runtime configuration and revision identity deliberately stay server-side;
 * executable readiness is evaluated when a run launches.
 */
export interface InvokableTaskOwnerCatalogEntry {
  id: string;
  name: string;
  title: string | null;
  icon: string | null;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
  pluginManagement: AgentPluginManagementBinding | null;
}
