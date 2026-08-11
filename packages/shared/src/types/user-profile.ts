import type { TaskPriority, TaskStatus } from "../constants.js";
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
  touchedTasks: number;
  createdTasks: number;
  completedTasks: number;
  assignedOpenTasks: number;
  commentCount: number;
  activityCount: number;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

export interface UserProfileDailyPoint {
  date: string;
  activityCount: number;
  completedTasks: number;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

export interface UserProfileTaskSummary {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: TaskStatus;
  priority: TaskPriority;
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
  recentTasks: UserProfileTaskSummary[];
  recentActivity: UserProfileActivitySummary[];
  topAgents: UserProfileAgentUsage[];
}
