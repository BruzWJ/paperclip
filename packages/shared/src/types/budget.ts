import type {
  BudgetIncidentResolutionAction,
  BudgetIncidentStatus,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
  PauseReason,
} from "../constants.js";
import type { BudgetCurrency, MoneyAmount } from "../money.js";

export interface BudgetPolicy {
  id: string;
  companyId: string;
  budgetCurrency: BudgetCurrency;
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind: BudgetWindowKind;
  limitAmount: MoneyAmount;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetPolicySummary {
  policyId: string;
  companyId: string;
  budgetCurrency: BudgetCurrency;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  windowKind: BudgetWindowKind;
  limitAmount: MoneyAmount;
  observedAmount: MoneyAmount;
  remainingAmount: MoneyAmount;
  utilizationPercent: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  status: "ok" | "warning" | "hard_stop";
  paused: boolean;
  pauseReason: PauseReason | null;
  windowStart: Date;
  windowEnd: Date;
}

export interface BudgetIncident {
  id: string;
  companyId: string;
  budgetCurrency: BudgetCurrency;
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  windowKind: BudgetWindowKind;
  windowStart: Date;
  windowEnd: Date;
  thresholdType: BudgetThresholdType;
  limitAmount: MoneyAmount;
  observedAmount: MoneyAmount;
  status: BudgetIncidentStatus;
  approvalId: string | null;
  approvalStatus: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetOverview {
  companyId: string;
  budgetCurrency: BudgetCurrency;
  policies: BudgetPolicySummary[];
  activeIncidents: BudgetIncident[];
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
}

export interface BudgetPolicyUpsertInput {
  scopeType: BudgetScopeType;
  scopeId: string;
  windowKind?: BudgetWindowKind;
  limitAmount: MoneyAmount;
  warnPercent?: number;
  hardStopEnabled?: boolean;
  notifyEnabled?: boolean;
  isActive?: boolean;
}

export interface BudgetIncidentResolutionInput {
  action: BudgetIncidentResolutionAction;
  limitAmount?: MoneyAmount;
  decisionNote?: string | null;
}
