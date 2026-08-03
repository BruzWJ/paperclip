import type { MoneyAmount } from "../money.js";
import type { IssueExecutionRunStatus } from "./issue-execution-run.js";

/**
 * Agent-scoped operational accounting only. Conversational continuity and
 * provider-native session state are owned by the issue Session graph and ACP
 * target correlation respectively.
 */
export interface AgentRuntimeState {
  agentId: string;
  companyId: string;
  adapterType: string;
  lastRunId: string | null;
  lastRunStatus: IssueExecutionRunStatus | null;
  lastContextUsedTokens: number | null;
  lastContextWindowTokens: number | null;
  peakContextUsedTokens: number;
  aggregateKnownCostAmount: MoneyAmount;
  unpricedPromptCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
