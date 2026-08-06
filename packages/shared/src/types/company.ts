import type { CompanyStatus, PauseReason } from "../constants.js";
import type { BudgetCurrency, MoneyAmount } from "../money.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetCurrency: BudgetCurrency;
  budgetMonthlyAmount: MoneyAmount;
  knownSpendAmount: MoneyAmount;
  attachmentMaxBytes: number;
  defaultResponsibleUserId: string | null;
  requireBoardApprovalForNewAgents: boolean;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
