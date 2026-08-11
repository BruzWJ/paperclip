import type { MoneyAmount } from "../money.js";
import type { TaskExecutionRunStatus } from "./task-execution-run.js";

/**
 * Agent-scoped operational accounting only. Conversational continuity and
 * provider-native session state are owned by the task Session graph and ACP
 * target correlation respectively.
 */
export interface AgentRuntimeState {
  agentId: string;
  companyId: string;
  adapterType: string;
  lastRunId: string | null;
  lastRunStatus: TaskExecutionRunStatus | null;
  lastContextUsedTokens: number | null;
  lastContextWindowTokens: number | null;
  peakContextUsedTokens: number;
  aggregateKnownCostAmount: MoneyAmount;
  unpricedPromptCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
