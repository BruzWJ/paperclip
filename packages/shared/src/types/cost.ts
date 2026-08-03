import type {
  AcpCostCursorState,
  IssueExecutionRunKind,
} from "./issue-execution-run.js";
import type { AcpCostUnavailableReason } from "../acp-cost.js";
import type { BudgetCurrency, MoneyAmount } from "../money.js";

export type AcpPromptCostKind = "known" | "unavailable";
export type AcpPromptAccountingKind = "base" | "steering" | "compaction";

/** Canonical cost fact for exactly one protocol-settled ACP prompt. */
export interface CostEvent {
  id: string;
  accountingId: string;
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  runKind: IssueExecutionRunKind;
  promptKind: AcpPromptAccountingKind;
  refId: string | null;
  runOrdinal: number | null;
  segmentOrdinal: number | null;
  compactionControlId: string | null;
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

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
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
