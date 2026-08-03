import type {
  IssueStatus,
  SummarySlotKey,
  SummarySlotScopeKind,
  SummarySlotStatus,
} from "../constants.js";
import type { DocumentFormat } from "./issue.js";

export interface SummarySlot {
  id: string;
  companyId: string;
  scopeKind: SummarySlotScopeKind;
  scopeId: string | null;
  slotKey: SummarySlotKey;
  routineId: string | null;
  documentId: string | null;
  status: SummarySlotStatus;
  failureReason: string | null;
  generatingIssueId: string | null;
  lastGeneratedAt: Date | string | null;
  lastGeneratedByAgentId: string | null;
  lastModel: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SummarySlotDocument {
  id: string;
  companyId: string;
  title: string | null;
  format: DocumentFormat;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SummarySlotRevision {
  id: string;
  companyId: string;
  documentId: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  sourceIssueCommentId: string | null;
  createdAt: Date | string;
}

export interface SummarySlotIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: IssueStatus;
  ownerAgentId?: string | null;
}

export interface SummarySlotScopeSelector {
  scopeKind: SummarySlotScopeKind;
  scopeId?: string | null;
  slotKey: SummarySlotKey;
}

export interface GetSummarySlotResponse {
  slot: SummarySlot | null;
  document: SummarySlotDocument | null;
  generatingIssue: SummarySlotIssueRef | null;
}

export interface ListSummarySlotRevisionsResponse {
  slot: SummarySlot | null;
  revisions: SummarySlotRevision[];
}

export interface RefreshSummarySlotRequest {
  scopeId?: string | null;
  /** Required only to configure a slot that does not yet have a routine. */
  ownerAgentId?: string;
}

export interface RefreshSummarySlotResponse {
  slot: SummarySlot;
  generatingIssue: SummarySlotIssueRef;
  alreadyGenerating: boolean;
}
