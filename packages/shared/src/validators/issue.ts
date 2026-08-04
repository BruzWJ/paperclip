import { z } from "zod";
import {
  ISSUE_EXECUTION_DECISION_OUTCOMES,
  ISSUE_EXECUTION_MONITOR_CLEAR_REASONS,
  ISSUE_EXECUTION_MONITOR_KINDS,
  ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES,
  ISSUE_EXECUTION_MONITOR_STATE_STATUSES,
  ISSUE_EXECUTION_POLICY_MODES,
  ISSUE_EXECUTION_STAGE_TYPES,
  ISSUE_EXECUTION_STATE_STATUSES,
  ISSUE_COMMENT_AUTHOR_TYPES,
  ISSUE_COMMENT_METADATA_ROW_TYPES,
  ISSUE_COMMENT_PRESENTATION_KINDS,
  ISSUE_COMMENT_PRESENTATION_TONES,
  ISSUE_MONITOR_SCHEDULED_BY,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
} from "../constants.js";
import {
  lowTrustReviewPresetPolicySchema,
  sourceTrustMetadataSchema,
  trustAuthorizationPolicySchema,
} from "./trust-policy.js";
import { multilineTextSchema } from "./text.js";
import {
  decodeIssueDisposition,
  normalizeContextAccess,
  type ContextAccess,
} from "../issue-runtime.js";

export const issueBlockedInboxStateSchema = z.enum([
  "needs_attention",
  "awaiting_decision",
  "external_wait",
]);

export const issueBlockedInboxSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const issueBlockedInboxReasonSchema = z.enum([
  "blocked_chain_stalled",
  "pending_board_decision",
  "pending_user_decision",
  "external_owner_action",
]);

export const issueBlockedInboxIssueRefSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string().nullable(),
  boardPresentationStatus: z.enum(ISSUE_STATUSES),
  priority: z.enum(ISSUE_PRIORITIES),
  ownerAgentId: z.string().uuid().nullable(),
  ownerUserId: z.string().nullable(),
}).strict();

export const issueBlockedInboxAttentionSchema = z.object({
  kind: z.literal("blocked"),
  state: issueBlockedInboxStateSchema,
  reason: issueBlockedInboxReasonSchema,
  severity: issueBlockedInboxSeveritySchema,
  stoppedSinceAt: z.string().datetime().nullable(),
  owner: z.object({
    type: z.enum(["agent", "user", "board", "external", "unknown"]),
    agentId: z.string().uuid().nullable(),
    userId: z.string().nullable(),
    label: z.string().nullable(),
  }).strict(),
  action: z.object({
    label: z.string().trim().min(1),
    detail: z.string().nullable(),
  }).strict(),
  sourceIssue: issueBlockedInboxIssueRefSchema.nullable(),
  leafIssue: issueBlockedInboxIssueRefSchema.nullable(),
  approvalId: z.string().uuid().nullable(),
  sampleIssueIdentifier: z.string().nullable(),
  redaction: z.object({
    externalDetailsRedacted: z.boolean(),
    secretFieldsOmitted: z.literal(true),
  }).strict(),
}).strict();

export const ISSUE_EXECUTION_WORKSPACE_PREFERENCES = [
  "inherit",
  "shared_workspace",
  "isolated_workspace",
  "operator_branch",
  "reuse_existing",
  "agent_default",
] as const;

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const issueExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional(),
    environmentId: z.string().uuid().optional().nullable(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict();

const issueExecutionStagePrincipalBaseSchema = z.object({
  type: z.enum(["agent", "user"]),
  agentId: z.string().uuid().optional().nullable(),
  userId: z.string().optional().nullable(),
});

export const issueExecutionStagePrincipalSchema = issueExecutionStagePrincipalBaseSchema
  .superRefine((value, ctx) => {
    if (value.type === "agent") {
      if (!value.agentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
      }
      if (value.userId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
      }
      return;
    }
    if (!value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
    }
    if (value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
    }
  });

export const issueExecutionStageParticipantSchema = issueExecutionStagePrincipalBaseSchema.extend({
  id: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.type === "agent") {
    if (!value.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants require agentId", path: ["agentId"] });
    }
    if (value.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent participants cannot set userId", path: ["userId"] });
    }
    return;
  }
  if (!value.userId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants require userId", path: ["userId"] });
  }
  if (value.agentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "User participants cannot set agentId", path: ["agentId"] });
  }
});

export const issueExecutionStageSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(ISSUE_EXECUTION_STAGE_TYPES),
  approvalsNeeded: z.literal(1).optional().default(1),
  participants: z.array(issueExecutionStageParticipantSchema).default([]),
});

export const issueExecutionMonitorPolicySchema = z.object({
  nextCheckAt: z.string().datetime(),
  notes: z.string().max(500).optional().nullable().default(null),
  scheduledBy: z.enum(ISSUE_MONITOR_SCHEDULED_BY).optional().default("owner"),
  kind: z.enum(ISSUE_EXECUTION_MONITOR_KINDS).optional().nullable().default(null),
  serviceName: z.string().trim().min(1).max(120).optional().nullable().default(null),
  externalRef: z.string().trim().min(1).max(500).optional().nullable().default(null),
  timeoutAt: z.string().datetime().optional().nullable().default(null),
  maxAttempts: z.number().int().positive().max(100).optional().nullable().default(null),
  recoveryPolicy: z.enum(ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES).optional().nullable().default(null),
});

export const issueExecutionPolicySchema = z.object({
  mode: z.enum(ISSUE_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z.boolean().optional().default(true),
  stages: z.array(issueExecutionStageSchema).default([]),
  monitor: issueExecutionMonitorPolicySchema.optional().nullable(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export const updateIssueExecutionPolicySchema = z
  .object({
    executionPolicy: issueExecutionPolicySchema.nullable(),
  })
  .strict();

export const issueExecutionMonitorStateSchema = z.object({
  status: z.enum(ISSUE_EXECUTION_MONITOR_STATE_STATUSES),
  nextCheckAt: z.string().datetime().nullable(),
  lastTriggeredAt: z.string().datetime().nullable(),
  attemptCount: z.number().int().nonnegative().default(0),
  notes: z.string().max(500).nullable(),
  scheduledBy: z.enum(ISSUE_MONITOR_SCHEDULED_BY).nullable(),
  kind: z.enum(ISSUE_EXECUTION_MONITOR_KINDS).nullable().optional().default(null),
  serviceName: z.string().trim().min(1).max(120).nullable().optional().default(null),
  externalRef: z.string().trim().min(1).max(500).nullable().optional().default(null),
  timeoutAt: z.string().datetime().nullable().optional().default(null),
  maxAttempts: z.number().int().positive().max(100).nullable().optional().default(null),
  recoveryPolicy: z.enum(ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES).nullable().optional().default(null),
  clearedAt: z.string().datetime().nullable(),
  clearReason: z.enum(ISSUE_EXECUTION_MONITOR_CLEAR_REASONS).nullable(),
});

export const issueReviewRequestSchema = z.object({
  instructions: z.string().trim().min(1).max(20000),
}).strict();

export const decideIssueExecutionStageSchema = z
  .object({
    outcome: z.enum(ISSUE_EXECUTION_DECISION_OUTCOMES),
    body: z.string().trim().min(1).max(20000),
    reviewRequest: issueReviewRequestSchema.optional().nullable(),
    idempotencyKey: z.string().trim().min(1).max(255),
  })
  .strict();

export type UpdateIssueExecutionPolicy = z.input<
  typeof updateIssueExecutionPolicySchema
>;

export type DecideIssueExecutionStage = z.input<
  typeof decideIssueExecutionStageSchema
>;

export const issueExecutionStateSchema = z.object({
  status: z.enum(ISSUE_EXECUTION_STATE_STATUSES),
  currentStageId: z.string().uuid().nullable(),
  currentStageIndex: z.number().int().nonnegative().nullable(),
  currentStageType: z.enum(ISSUE_EXECUTION_STAGE_TYPES).nullable(),
  currentParticipant: issueExecutionStagePrincipalSchema.nullable(),
  returnOwner: issueExecutionStagePrincipalSchema.nullable(),
  reviewRequest: issueReviewRequestSchema.nullable().optional().default(null),
  completedStageIds: z.array(z.string().uuid()).default([]),
  lastDecisionId: z.string().uuid().nullable(),
  lastDecisionOutcome: z.enum(ISSUE_EXECUTION_DECISION_OUTCOMES).nullable(),
  monitor: issueExecutionMonitorStateSchema.optional().nullable(),
});

const rawIssueCreationContextAccessSchema = z
  .object({
    carry_context: z.boolean().optional(),
    read_issue_comments: z.boolean().optional(),
    read_issue_agent_run: z.boolean().optional(),
    list_sub_issues: z.boolean().optional(),
    read_sub_issue_comments: z.boolean().optional(),
    read_sub_issue_agent_run: z.boolean().optional(),
    list_company_issues: z.boolean().optional(),
    read_company_issue_comments: z.boolean().optional(),
    read_company_issue_agent_run: z.boolean().optional(),
  })
  .strict();

export const issueCreationContextAccessSchema =
  rawIssueCreationContextAccessSchema.transform(
    (value): ContextAccess | null => normalizeContextAccess(value),
  );

export const issueDispositionSchema = z
  .object({
    message: z.string().refine((value) => value.trim().length > 0, {
      message: "Disposition message must contain non-whitespace text",
    }),
    structuredResult: z.unknown().optional(),
  })
  .strict()
  .transform((value) => decodeIssueDisposition(value));

const immutableIssueRequestSchema = z
  .string()
  .max(200_000)
  .refine((value) => value.trim().length > 0, {
    message: "Request must contain non-whitespace text",
  });

const canonicalIssueCreateBaseSchema = z
  .object({
    request: immutableIssueRequestSchema,
    ownerAgentId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(240).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    projectWorkspaceId: z.string().uuid().nullable().optional(),
    executionWorkspaceId: z.string().uuid().nullable().optional(),
    executionWorkspacePreference: z
      .enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES)
      .nullable()
      .optional(),
    executionWorkspaceSettings:
      issueExecutionWorkspaceSettingsSchema.nullable().optional(),
    goalId: z.string().uuid().nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    contextAccessMask: issueCreationContextAccessSchema.nullable().optional(),
  })
  .strict();

export const createIssueInputSchema = canonicalIssueCreateBaseSchema;

export const createIssueSchema = canonicalIssueCreateBaseSchema;

export type CreateIssue = z.infer<typeof createIssueSchema>;

export const upsertIssueWatchdogSchema = z.object({}).strict();

export type UpsertIssueWatchdog = z.infer<typeof upsertIssueWatchdogSchema>;

export const createChildIssueSchema = canonicalIssueCreateBaseSchema.omit({
  parentId: true,
});

export type CreateChildIssue = z.infer<typeof createChildIssueSchema>;

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

const issueMutationIdempotencyKeySchema = z.string().trim().min(1).max(255);

export const updateIssueTitleSchema = z.object({
  title: z.string().trim().min(1).max(240).nullable(),
}).strict();

export type UpdateIssueTitle = z.infer<typeof updateIssueTitleSchema>;

export const reassignIssueSchema = z.object({
  ownerAgentId: z.string().uuid(),
  idempotencyKey: issueMutationIdempotencyKeySchema,
}).strict();

export type ReassignIssue = z.infer<typeof reassignIssueSchema>;

const opaqueIssueMessageSchema = z.string().max(200_000);

const issueFormMessageSchema = opaqueIssueMessageSchema
  .refine((value) => value.trim().length > 0, {
    message: "Issue form message must contain non-whitespace text",
  });

/** Exact named-user creator route body. */
export const commitIssueCreatorFormSchema = z
  .object({
    issueId: z.string().uuid(),
    message: issueFormMessageSchema,
  })
  .strict();

export type CommitIssueCreatorForm = z.infer<
  typeof commitIssueCreatorFormSchema
>;

export const commitIssueOwnerFormSchema = z
  .object({
    issueId: z.string().uuid(),
    message: issueFormMessageSchema,
    status: z
      .enum(["open", "blocked", "done", "cancelled"])
      .optional(),
    structuredResult: z.unknown().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const terminal =
      value.status === "done" || value.status === "cancelled";
    if (Object.hasOwn(value, "structuredResult") && !terminal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "structuredResult is accepted only for done or cancelled",
        path: ["structuredResult"],
      });
    }
  });

export type CommitIssueOwnerForm = z.infer<
  typeof commitIssueOwnerFormSchema
>;

export const selfAssignIssueWithdrawalSchema = z
  .object({
    idempotencyKey: issueMutationIdempotencyKeySchema,
  })
  .strict();

export type SelfAssignIssueWithdrawal = z.infer<
  typeof selfAssignIssueWithdrawalSchema
>;

export const reopenIssueSchema = z.object({
  reason: multilineTextSchema
    .pipe(z.string().max(20_000))
    .refine((value) => value.trim().length > 0, {
      message: "Reopen reason must contain non-whitespace text",
    }),
  idempotencyKey: issueMutationIdempotencyKeySchema,
}).strict();

export type ReopenIssue = z.infer<typeof reopenIssueSchema>;

export type IssueExecutionWorkspaceSettings = z.infer<typeof issueExecutionWorkspaceSettingsSchema>;

const commentMetadataLabelSchema = z.string().trim().min(1).max(120);
const commentMetadataTextSchema = z.string().trim().min(1).max(2000);

export const issueCommentAuthorTypeSchema = z.enum(ISSUE_COMMENT_AUTHOR_TYPES);

export const issueCommentPresentationSchema = z.object({
  kind: z.enum(ISSUE_COMMENT_PRESENTATION_KINDS).default("message"),
  tone: z.enum(ISSUE_COMMENT_PRESENTATION_TONES).default("neutral"),
  title: z.string().trim().min(1).max(160).nullable().optional(),
  detailsDefaultOpen: z.boolean().optional().default(false),
}).strict();

export type IssueCommentPresentation = z.infer<typeof issueCommentPresentationSchema>;

const issueCommentMetadataBaseRowSchema = z.object({
  type: z.enum(ISSUE_COMMENT_METADATA_ROW_TYPES),
  label: commentMetadataLabelSchema.nullable().optional(),
});

const issueCommentMetadataTextRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("text"),
  text: commentMetadataTextSchema,
}).strict();

const issueCommentMetadataCodeRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("code"),
  code: z.string().min(1).max(4000),
  language: z.string().trim().min(1).max(40).nullable().optional(),
}).strict();

const issueCommentMetadataKeyValueRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("key_value"),
  label: commentMetadataLabelSchema,
  value: commentMetadataTextSchema,
}).strict();

const issueCommentMetadataIssueLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("issue_link"),
  issueId: z.string().uuid().nullable().optional(),
  identifier: z.string().trim().min(1).max(80).nullable().optional(),
  title: z.string().trim().min(1).max(240).nullable().optional(),
}).strict();

const issueCommentMetadataAgentLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("agent_link"),
  agentId: z.string().uuid(),
  name: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

const issueCommentMetadataRunLinkRowSchema = issueCommentMetadataBaseRowSchema.extend({
  type: z.literal("run_link"),
  runId: z.string().uuid(),
  title: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

export const issueCommentMetadataRowSchema = z.discriminatedUnion("type", [
  issueCommentMetadataTextRowSchema,
  issueCommentMetadataCodeRowSchema,
  issueCommentMetadataKeyValueRowSchema,
  issueCommentMetadataIssueLinkRowSchema,
  issueCommentMetadataAgentLinkRowSchema,
  issueCommentMetadataRunLinkRowSchema,
]).superRefine((value, ctx) => {
  if (value.type === "issue_link" && !value.issueId && !value.identifier) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Issue link rows require issueId or identifier",
      path: ["issueId"],
    });
  }
});

export const issueCommentMetadataSectionSchema = z.object({
  title: z.string().trim().min(1).max(160).nullable().optional(),
  rows: z.array(issueCommentMetadataRowSchema).min(1).max(50),
}).strict();

export const issueCommentMetadataSchema = z.object({
  version: z.literal(1),
  sourceRunId: z.string().uuid().nullable().optional(),
  sections: z.array(issueCommentMetadataSectionSchema).min(1).max(20),
}).strict();

export type IssueCommentMetadata = z.infer<typeof issueCommentMetadataSchema>;

export const boardIssueCommentAuthorSchema = z.object({
  type: issueCommentAuthorTypeSchema,
  label: z.string().min(1).max(240),
  agentId: z.string().uuid().nullable(),
  userId: z.string().min(1).nullable(),
  pluginKey: z.string().min(1).nullable(),
}).strict();

export const boardIssueCommentParentReferenceSchema = z.object({
  authorLabel: z.string().min(1).max(240),
  excerpt: z.string().max(120),
}).strict();

const boardIssueCommentTimestampSchema = z.union([
  z.date(),
  z.string().datetime(),
]);

export const boardIssueCommentSchema = z.object({
  id: z.string().uuid(),
  author: boardIssueCommentAuthorSchema,
  body: z.string(),
  presentation: issueCommentPresentationSchema.nullable(),
  metadata: issueCommentMetadataSchema.nullable(),
  sourceTrust: sourceTrustMetadataSchema.nullable(),
  runState: z.enum(["queued", "working", "terminal"]).nullable(),
  canonicalSequence: z.number().int().nonnegative(),
  immediateParentDisplayReference:
    boardIssueCommentParentReferenceSchema.nullable(),
  createdAt: boardIssueCommentTimestampSchema,
  updatedAt: boardIssueCommentTimestampSchema,
}).strict();

export const boardIssueRunSegmentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("reasoning"), text: z.string() }).strict(),
  z.object({
    type: z.literal("tool"),
    name: z.string().min(1),
    status: z.enum(["pending", "running", "completed", "error"]),
  }).strict(),
]);

export const boardIssueRunSegmentEntrySchema = z.object({
  kind: z.literal("run_segment"),
  id: z.string().regex(/^segment_[a-f0-9]{32}$/),
  author: boardIssueCommentAuthorSchema,
  parts: z.array(boardIssueRunSegmentPartSchema),
  status: z.enum(["working", "complete", "error"]),
  canonicalSequence: z.number().int().nonnegative(),
  immediateParentDisplayReference:
    boardIssueCommentParentReferenceSchema.nullable(),
  createdAt: boardIssueCommentTimestampSchema,
  updatedAt: boardIssueCommentTimestampSchema,
}).strict();

export const boardIssueCommentEntrySchema = boardIssueCommentSchema.extend({
  kind: z.literal("comment"),
}).strict();

export const boardIssueThreadEntrySchema = z.discriminatedUnion("kind", [
  boardIssueCommentEntrySchema,
  boardIssueRunSegmentEntrySchema,
]);

export const boardIssueCommentGroupSchema = z.object({
  root: boardIssueCommentSchema,
  replyCount: z.number().int().nonnegative(),
  runSegmentCount: z.number().int().nonnegative(),
  entries: z.array(boardIssueThreadEntrySchema),
  entriesNextCursor: z.string().min(1).nullable(),
}).strict();

export const boardIssueCommentGroupPageSchema = z.object({
  groups: z.array(boardIssueCommentGroupSchema),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const boardIssueCommentThreadPageSchema = z.object({
  entries: z.array(boardIssueThreadEntrySchema),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const createIssueUserCommentSchema = z.object({
  message: opaqueIssueMessageSchema
    .refine((value) => value.trim().length > 0, {
      message: "Comment must contain non-whitespace text",
    }),
  idempotencyKey: issueMutationIdempotencyKeySchema,
  mention: z.object({
    targetAgentId: z.string().uuid(),
    ownershipEpoch: z.number().int().positive(),
  }).strict().nullable().optional(),
  replyToCommentId: z.string().uuid().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mention != null && value.replyToCommentId != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A comment cannot mention an agent and reply to a comment at the same time",
      path: ["replyToCommentId"],
    });
  }
});

export type CreateIssueUserComment = z.infer<typeof createIssueUserCommentSchema>;

export const issueDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");


export const linkIssueApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;

export const ISSUE_DOCUMENT_FORMATS = ["markdown"] as const;

export const issueDocumentFormatSchema = z.enum(ISSUE_DOCUMENT_FORMATS);

export const upsertIssueDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: issueDocumentFormatSchema,
  body: multilineTextSchema.pipe(z.string().max(524288)),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export const restoreIssueDocumentRevisionSchema = z.object({});

export type IssueDocumentFormat = z.infer<typeof issueDocumentFormatSchema>;
export type UpsertIssueDocument = z.infer<typeof upsertIssueDocumentSchema>;
export type RestoreIssueDocumentRevision = z.infer<typeof restoreIssueDocumentRevisionSchema>;
