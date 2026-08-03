import type { IssuePriority, IssueStatus } from "../constants.js";
import type { BudgetCurrency, MoneyAmount } from "../money.js";

export interface UserProfileIdentity {
  id: string;
  slug: string;
  name: string | null;
  email: string | null;
  image: string | null;
  membershipRole: string | null;
  membershipStatus: string;
  joinedAt: Date;
}

export interface UserProfileWindowStats {
  key: "last7" | "last30" | "all";
  label: string;
  touchedIssues: number;
  createdIssues: number;
  completedIssues: number;
  assignedOpenIssues: number;
  commentCount: number;
  activityCount: number;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

export interface UserProfileDailyPoint {
  date: string;
  activityCount: number;
  completedIssues: number;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

export interface UserProfileIssueSummary {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: IssueStatus;
  priority: IssuePriority;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface UserProfileActivitySummary {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface UserProfileAgentUsage {
  agentId: string;
  agentName: string | null;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

export interface UserProfileResponse {
  user: UserProfileIdentity;
  budgetCurrency: BudgetCurrency;
  stats: UserProfileWindowStats[];
  daily: UserProfileDailyPoint[];
  recentIssues: UserProfileIssueSummary[];
  recentActivity: UserProfileActivitySummary[];
  topAgents: UserProfileAgentUsage[];
}
