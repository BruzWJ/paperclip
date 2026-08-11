import type {
  AcpCostCursorState,
  TaskExecutionRunKind,
} from "./task-execution-run.js";
import type { AcpCostUnavailableReason } from "../acp-cost.js";
import type { BudgetCurrency, MoneyAmount } from "../money.js";

export type AcpPromptCostKind = "known" | "unavailable";
export type AcpPromptAccountingKind = "base" | "steering";

/** Canonical cost fact for exactly one protocol-settled ACP prompt. */
export interface CostEvent {
  id: string;
  accountingId: string;
  companyId: string;
  taskId: string;
  agentId: string;
  runId: string;
  runKind: TaskExecutionRunKind;
  promptKind: AcpPromptAccountingKind;
  refId: string | null;
  runOrdinal: number | null;
  segmentOrdinal: number | null;
  budgetCurrency: BudgetCurrency;
  kind: AcpPromptCostKind;
  unavailableReason: AcpCostUnavailableReason | null;
  observedCumulativeAmount: MoneyAmount | null;
  observedCurrency: string | null;
  knownDeltaAmount: MoneyAmount | null;
  cursorBeforeState: AcpCostCursorState;
  cursorBeforeAmount: MoneyAmount | null;
  cursorBeforeCurrency: BudgetCurrency | null;
  cursorAfterState: "known" | "unavailable";
  cursorAfterAmount: MoneyAmount | null;
  cursorAfterCurrency: BudgetCurrency | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  companyId: string;
  budgetCurrency: BudgetCurrency;
  knownSpendAmount: MoneyAmount;
  budgetMonthlyAmount: MoneyAmount;
  remainingAmount: MoneyAmount;
  utilizationPercent: number;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

export interface TaskCostSummary {
  taskId: string;
  taskCount: number;
  includeDescendants: boolean;
  budgetCurrency: BudgetCurrency;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
  runCount: number;
  runtimeMs: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  budgetCurrency: BudgetCurrency;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  budgetCurrency: BudgetCurrency;
  knownCostAmount: MoneyAmount;
  pricedPromptCount: number;
  unpricedPromptCount: number;
}
