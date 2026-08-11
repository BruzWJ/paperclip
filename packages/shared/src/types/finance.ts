import type {
  AgentAdapterType,
  FinanceDirection,
  FinanceEventKind,
  FinanceUnit,
} from "../constants.js";
import type { MoneyAmount } from "../money.js";

export interface FinanceEvent {
  id: string;
  companyId: string;
  agentId: string | null;
  taskId: string | null;
  projectId: string | null;
  goalId: string | null;
  billingCode: string | null;
  description: string | null;
  eventKind: FinanceEventKind;
  direction: FinanceDirection;
  biller: string;
  provider: string | null;
  executionAdapterType: AgentAdapterType | null;
  pricingTier: string | null;
  region: string | null;
  model: string | null;
  quantity: number | null;
  unit: FinanceUnit | null;
  amount: MoneyAmount;
  currency: string;
  estimated: boolean;
  externalInvoiceId: string | null;
  metadataJson: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface FinanceSummaryRow {
  currency: string;
  debitAmount: MoneyAmount;
  creditAmount: MoneyAmount;
  netDirection: FinanceDirection;
  netAmount: MoneyAmount;
  estimatedDebitAmount: MoneyAmount;
  eventCount: number;
}

export interface FinanceSummary {
  companyId: string;
  currencies: FinanceSummaryRow[];
}

export interface FinanceByBiller extends FinanceSummaryRow {
  biller: string;
  kindCount: number;
}

export interface FinanceByKind extends FinanceSummaryRow {
  eventKind: FinanceEventKind;
  billerCount: number;
}
