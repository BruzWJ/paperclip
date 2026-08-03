export const FEEDBACK_TARGET_TYPES = ["issue_comment", "issue_document_revision"] as const;
export type FeedbackTargetType = (typeof FEEDBACK_TARGET_TYPES)[number];

export const FEEDBACK_VOTE_VALUES = ["up", "down"] as const;
export type FeedbackVoteValue = (typeof FEEDBACK_VOTE_VALUES)[number];

export const FEEDBACK_DATA_SHARING_PREFERENCES = ["allowed", "not_allowed", "prompt"] as const;
export type FeedbackDataSharingPreference = (typeof FEEDBACK_DATA_SHARING_PREFERENCES)[number];

export const DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE: FeedbackDataSharingPreference = "prompt";

export const FEEDBACK_TRACE_STATUSES = ["local_only", "pending", "sent", "failed"] as const;
export type FeedbackTraceStatus = (typeof FEEDBACK_TRACE_STATUSES)[number];

export const DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION = "feedback-data-sharing-v1";

export interface FeedbackVote {
  id: string;
  companyId: string;
  issueId: string;
  targetType: FeedbackTargetType;
  targetId: string;
  authorUserId: string;
  vote: FeedbackVoteValue;
  reason: string | null;
  sharedWithLabs: boolean;
  sharedAt: Date | null;
  consentVersion: string | null;
  redactionSummary: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackTraceTargetSummary {
  label: string;
  excerpt: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date | null;
  documentKey: string | null;
  documentTitle: string | null;
  revisionNumber: number | null;
}

export interface FeedbackTrace {
  id: string;
  companyId: string;
  feedbackVoteId: string;
  issueId: string;
  projectId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  authorUserId: string;
  targetType: FeedbackTargetType;
  targetId: string;
  vote: FeedbackVoteValue;
  status: FeedbackTraceStatus;
  destination: string | null;
  exportId: string | null;
  consentVersion: string | null;
  schemaVersion: string;
  bundleVersion: string;
  payloadVersion: string;
  payloadDigest: string | null;
  payloadSnapshot: Record<string, unknown> | null;
  targetSummary: FeedbackTraceTargetSummary;
  redactionSummary: Record<string, unknown> | null;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  exportedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FeedbackTraceBundleCaptureStatus = "full" | "partial" | "unavailable";

export interface FeedbackTraceBundleFile {
  path: string;
  contentType: string;
  encoding: "utf8";
  byteLength: number;
  sha256: string;
  source:
    | "paperclip_issue_session_trace";
  contents: string;
}

export interface FeedbackTraceBundle {
  traceId: string;
  exportId: string | null;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  adapterType: string | null;
  captureStatus: FeedbackTraceBundleCaptureStatus;
  notes: string[];
  envelope: Record<string, unknown>;
  surface: Record<string, unknown> | null;
  paperclipRun: Record<string, unknown> | null;
  privacy: Record<string, unknown> | null;
  integrity: Record<string, unknown>;
  files: FeedbackTraceBundleFile[];
}
