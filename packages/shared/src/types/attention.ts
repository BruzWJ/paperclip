import type { InboxDismissalKind } from "./inbox-dismissal.js";
import type { BudgetCurrency, MoneyAmount } from "../money.js";

export type AttentionSourceKind =
  | "approval"
  | "join_request"
  | "review"
  | "budget_alert"
  | "mention_board";

export type AttentionSubjectKind =
  | "approval"
  | "issue"
  | "join_request"
  | "run"
  | "budget_incident"
  | "agent";

export type AttentionSeverity = "critical" | "high" | "medium" | "low";

export interface AttentionSubject {
  kind: AttentionSubjectKind;
  id: string;
  companyId: string;
  title: string | null;
  identifier: string | null;
  status: string | null;
  href: string | null;
  metadata?: Record<string, unknown>;
}

export interface AttentionDecisionVerb {
  id: string;
  label: string;
  description: string | null;
}

export interface AttentionProjectRef {
  id: string;
  name: string;
  urlKey: string;
  color: string | null;
  icon: string | null;
}

export interface AttentionWorkspaceRef {
  id: string;
  name: string;
}

export interface AttentionDetailImage {
  assetId: string;
  alt?: string | null;
}

export interface AttentionItemDismissal {
  kind: InboxDismissalKind;
  dismissedAt: string;
  snoozedUntil: string | null;
  isActive: boolean;
}

export type AttentionItemDetail =
  | {
      kind: "approval";
      approvalType: string;
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "budget";
      observedPercent: number;
      budgetCurrency: BudgetCurrency;
      observedAmount: MoneyAmount;
      limitAmount: MoneyAmount;
      images: AttentionDetailImage[];
    }
  | {
      kind: "generic";
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    };

export interface AttentionItem {
  id: string;
  companyId: string;
  sourceKind: AttentionSourceKind;
  subject: AttentionSubject;
  whyNow: string;
  decisionVerbs: AttentionDecisionVerb[];
  inlineResolvable: boolean;
  entryRule: string;
  exitRule: string;
  dedupKey: string;
  dismissalKey: string;
  dismissal: AttentionItemDismissal | null;
  severity: AttentionSeverity;
  rank: number;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
  relatedIssue: AttentionSubject | null;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
  detail: AttentionItemDetail | null;
  trainingExampleId: string | null;
}

export interface AttentionFeed {
  companyId: string;
  generatedAt: string;
  totalCount: number;
  countsBySourceKind: Record<AttentionSourceKind, number>;
  items: AttentionItem[];
}
