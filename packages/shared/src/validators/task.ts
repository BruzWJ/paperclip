import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import {
  TASK_EXECUTION_DECISION_OUTCOMES,
  TASK_EXECUTION_MONITOR_CLEAR_REASONS,
  TASK_EXECUTION_MONITOR_KINDS,
  TASK_EXECUTION_MONITOR_RECOVERY_POLICIES,
  TASK_EXECUTION_MONITOR_STATE_STATUSES,
  TASK_EXECUTION_POLICY_MODES,
  TASK_EXECUTION_STAGE_TYPES,
  TASK_EXECUTION_STATE_STATUSES,
  TASK_COMMENT_AUTHOR_TYPES,
  TASK_COMMENT_METADATA_ROW_TYPES,
  TASK_COMMENT_PRESENTATION_KINDS,
  TASK_COMMENT_PRESENTATION_TONES,
  TASK_MONITOR_SCHEDULED_BY,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "../constants.js";
import {
  lowTrustReviewPresetPolicySchema,
  sourceTrustMetadataSchema,
  trustAuthorizationPolicySchema,
} from "./trust-policy.js";
import { multilineTextSchema } from "./text.js";
import { decodeTaskDisposition } from "../task-runtime.js";

export const taskBlockedInboxStateSchema = z.enum([
  "needs_attention",
  "awaiting_decision",
  "external_wait",
]);

export const taskBlockedInboxSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const taskBlockedInboxReasonSchema = z.enum([
  "blocked_chain_stalled",
  "pending_board_decision",
  "pending_user_decision",
  "external_owner_action",
]);

export const taskBlockedInboxTaskRefSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string().nullable(),
  boardPresentationStatus: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  ownerAgentId: z.string().uuid().nullable(),
  ownerUserId: z.string().nullable(),
}).strict();

export const taskBlockedInboxAttentionSchema = z.object({
  kind: z.literal("blocked"),
  state: taskBlockedInboxStateSchema,
  reason: taskBlockedInboxReasonSchema,
  severity: taskBlockedInboxSeveritySchema,
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
  sourceTask: taskBlockedInboxTaskRefSchema.nullable(),
  leafTask: taskBlockedInboxTaskRefSchema.nullable(),
  approvalId: z.string().uuid().nullable(),
  sampleTaskIdentifier: z.string().nullable(),
  redaction: z.object({
    externalDetailsRedacted: z.boolean(),
    secretFieldsOmitted: z.literal(true),
  }).strict(),
}).strict();

const taskExecutionStagePrincipalBaseSchema = z.object({
  type: z.enum(["agent", "user"]),
  agentId: z.string().uuid().optional().nullable(),
  userId: z.string().optional().nullable(),
});

export const taskExecutionStagePrincipalSchema = taskExecutionStagePrincipalBaseSchema
  .superRefine((value, ctx) => {
    if (value.type === "agent") {
      if (!value.agentId) {
        addValidationDetail(ctx, { message: "Agent participants require agentId", path: ["agentId"] });
      }
      if (value.userId) {
        addValidationDetail(ctx, { message: "Agent participants cannot set userId", path: ["userId"] });
      }
      return;
    }
    if (!value.userId) {
      addValidationDetail(ctx, { message: "User participants require userId", path: ["userId"] });
    }
    if (value.agentId) {
      addValidationDetail(ctx, { message: "User participants cannot set agentId", path: ["agentId"] });
    }
  });

export const taskExecutionStageParticipantSchema = taskExecutionStagePrincipalBaseSchema.extend({
  id: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.type === "agent") {
    if (!value.agentId) {
      addValidationDetail(ctx, { message: "Agent participants require agentId", path: ["agentId"] });
    }
    if (value.userId) {
      addValidationDetail(ctx, { message: "Agent participants cannot set userId", path: ["userId"] });
    }
    return;
  }
  if (!value.userId) {
    addValidationDetail(ctx, { message: "User participants require userId", path: ["userId"] });
  }
  if (value.agentId) {
    addValidationDetail(ctx, { message: "User participants cannot set agentId", path: ["agentId"] });
  }
});

export const taskExecutionStageSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(TASK_EXECUTION_STAGE_TYPES),
  approvalsNeeded: z.literal(1).optional().default(1),
  participants: z.array(taskExecutionStageParticipantSchema).default([]),
});

export const taskExecutionMonitorPolicySchema = z.object({
  nextCheckAt: z.string().datetime(),
  notes: z.string().max(500).optional().nullable().default(null),
  scheduledBy: z.enum(TASK_MONITOR_SCHEDULED_BY).optional().default("owner"),
  kind: z.enum(TASK_EXECUTION_MONITOR_KINDS).optional().nullable().default(null),
  serviceName: z.string().trim().min(1).max(120).optional().nullable().default(null),
  externalRef: z.string().trim().min(1).max(500).optional().nullable().default(null),
  timeoutAt: z.string().datetime().optional().nullable().default(null),
  maxAttempts: z.number().int().positive().max(100).optional().nullable().default(null),
  recoveryPolicy: z.enum(TASK_EXECUTION_MONITOR_RECOVERY_POLICIES).optional().nullable().default(null),
});

export const taskExecutionPolicySchema = z.object({
  mode: z.enum(TASK_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z.boolean().optional().default(true),
  stages: z.array(taskExecutionStageSchema).default([]),
  monitor: taskExecutionMonitorPolicySchema.optional().nullable(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export const updateTaskExecutionPolicySchema = z
  .object({
    executionPolicy: taskExecutionPolicySchema.nullable(),
  })
  .strict();

export const taskExecutionMonitorStateSchema = z.object({
  status: z.enum(TASK_EXECUTION_MONITOR_STATE_STATUSES),
  nextCheckAt: z.string().datetime().nullable(),
  lastTriggeredAt: z.string().datetime().nullable(),
  attemptCount: z.number().int().nonnegative().default(0),
  notes: z.string().max(500).nullable(),
  scheduledBy: z.enum(TASK_MONITOR_SCHEDULED_BY).nullable(),
  kind: z.enum(TASK_EXECUTION_MONITOR_KINDS).nullable().optional().default(null),
  serviceName: z.string().trim().min(1).max(120).nullable().optional().default(null),
  externalRef: z.string().trim().min(1).max(500).nullable().optional().default(null),
  timeoutAt: z.string().datetime().nullable().optional().default(null),
  maxAttempts: z.number().int().positive().max(100).nullable().optional().default(null),
  recoveryPolicy: z.enum(TASK_EXECUTION_MONITOR_RECOVERY_POLICIES).nullable().optional().default(null),
  clearedAt: z.string().datetime().nullable(),
  clearReason: z.enum(TASK_EXECUTION_MONITOR_CLEAR_REASONS).nullable(),
});

export const taskReviewRequestSchema = z.object({
  instructions: z.string().trim().min(1).max(20000),
}).strict();

export const decideTaskExecutionStageSchema = z
  .object({
    outcome: z.enum(TASK_EXECUTION_DECISION_OUTCOMES),
    body: z.string().trim().min(1).max(20000),
    reviewRequest: taskReviewRequestSchema.optional().nullable(),
    idempotencyKey: z.string().trim().min(1).max(255),
  })
  .strict();

export type UpdateTaskExecutionPolicy = z.input<
  typeof updateTaskExecutionPolicySchema
>;

export type DecideTaskExecutionStage = z.input<
  typeof decideTaskExecutionStageSchema
>;

export const taskExecutionStateSchema = z.object({
  status: z.enum(TASK_EXECUTION_STATE_STATUSES),
  currentStageId: z.string().uuid().nullable(),
  currentStageIndex: z.number().int().nonnegative().nullable(),
  currentStageType: z.enum(TASK_EXECUTION_STAGE_TYPES).nullable(),
  currentParticipant: taskExecutionStagePrincipalSchema.nullable(),
  returnOwner: taskExecutionStagePrincipalSchema.nullable(),
  reviewRequest: taskReviewRequestSchema.nullable().optional().default(null),
  completedStageIds: z.array(z.string().uuid()).default([]),
  lastDecisionId: z.string().uuid().nullable(),
  lastDecisionOutcome: z.enum(TASK_EXECUTION_DECISION_OUTCOMES).nullable(),
  monitor: taskExecutionMonitorStateSchema.optional().nullable(),
});

export const taskDispositionSchema = z
  .object({
    message: z.string().refine((value) => value.trim().length > 0, {
      message: "Disposition message must contain non-whitespace text",
    }),
    structuredResult: z.unknown().optional(),
  })
  .strict()
  .transform((value) => decodeTaskDisposition(value));

const immutableTaskRequestSchema = z
  .string()
  .max(200_000)
  .refine((value) => value.trim().length > 0, {
    message: "Request must contain non-whitespace text",
  });

const canonicalTaskCreateBaseSchema = z
  .object({
    request: immutableTaskRequestSchema,
    ownerAgentId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(240).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    projectWorkspaceId: z.string().uuid().nullable().optional(),
    goalId: z.string().uuid().nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
  })
  .strict();

export const createTaskInputSchema = canonicalTaskCreateBaseSchema;

export const createTaskSchema = canonicalTaskCreateBaseSchema;

export type CreateTask = z.infer<typeof createTaskSchema>;

export const createChildTaskSchema = canonicalTaskCreateBaseSchema.omit({
  parentId: true,
});

export type CreateChildTask = z.infer<typeof createChildTaskSchema>;

export const createTaskLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateTaskLabel = z.infer<typeof createTaskLabelSchema>;

const taskMutationIdempotencyKeySchema = z.string().trim().min(1).max(255);

export const updateTaskTitleSchema = z.object({
  title: z.string().trim().min(1).max(240).nullable(),
}).strict();

export type UpdateTaskTitle = z.infer<typeof updateTaskTitleSchema>;

export const reassignTaskSchema = z.object({
  ownerAgentId: z.string().uuid(),
  idempotencyKey: taskMutationIdempotencyKeySchema,
}).strict();

export type ReassignTask = z.infer<typeof reassignTaskSchema>;

const opaqueTaskMessageSchema = z.string().max(200_000);

const taskFormMessageSchema = opaqueTaskMessageSchema
  .refine((value) => value.trim().length > 0, {
    message: "Task form message must contain non-whitespace text",
  });

/** Exact named-user creator route body. */
export const commitTaskCreatorFormSchema = z
  .object({
    taskId: z.string().uuid(),
    message: taskFormMessageSchema,
  })
  .strict();

export type CommitTaskCreatorForm = z.infer<
  typeof commitTaskCreatorFormSchema
>;

export const commitTaskOwnerFormSchema = z
  .object({
    taskId: z.string().uuid(),
    message: taskFormMessageSchema,
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
      addValidationDetail(ctx, {
        message:
          "structuredResult is accepted only for done or cancelled",
        path: ["structuredResult"],
      });
    }
  });

export type CommitTaskOwnerForm = z.infer<
  typeof commitTaskOwnerFormSchema
>;

export const selfAssignTaskWithdrawalSchema = z
  .object({
    idempotencyKey: taskMutationIdempotencyKeySchema,
  })
  .strict();

export type SelfAssignTaskWithdrawal = z.infer<
  typeof selfAssignTaskWithdrawalSchema
>;

export const reopenTaskSchema = z.object({
  reason: multilineTextSchema
    .pipe(z.string().max(20_000))
    .refine((value) => value.trim().length > 0, {
      message: "Reopen reason must contain non-whitespace text",
    }),
  idempotencyKey: taskMutationIdempotencyKeySchema,
}).strict();

export type ReopenTask = z.infer<typeof reopenTaskSchema>;


const commentMetadataLabelSchema = z.string().trim().min(1).max(120);
const commentMetadataTextSchema = z.string().trim().min(1).max(2000);

export const taskCommentAuthorTypeSchema = z.enum(TASK_COMMENT_AUTHOR_TYPES);

export const taskCommentPresentationSchema = z.object({
  kind: z.enum(TASK_COMMENT_PRESENTATION_KINDS).default("message"),
  tone: z.enum(TASK_COMMENT_PRESENTATION_TONES).default("neutral"),
  title: z.string().trim().min(1).max(160).nullable().optional(),
  detailsDefaultOpen: z.boolean().optional().default(false),
}).strict();

export type TaskCommentPresentation = z.infer<typeof taskCommentPresentationSchema>;

const taskCommentMetadataBaseRowSchema = z.object({
  type: z.enum(TASK_COMMENT_METADATA_ROW_TYPES),
  label: commentMetadataLabelSchema.nullable().optional(),
});

const taskCommentMetadataTextRowSchema = taskCommentMetadataBaseRowSchema.extend({
  type: z.literal("text"),
  text: commentMetadataTextSchema,
}).strict();

const taskCommentMetadataCodeRowSchema = taskCommentMetadataBaseRowSchema.extend({
  type: z.literal("code"),
  code: z.string().min(1).max(4000),
  language: z.string().trim().min(1).max(40).nullable().optional(),
}).strict();

const taskCommentMetadataKeyValueRowSchema = taskCommentMetadataBaseRowSchema.extend({
  type: z.literal("key_value"),
  label: commentMetadataLabelSchema,
  value: commentMetadataTextSchema,
}).strict();

const taskCommentMetadataTaskLinkRowSchema = taskCommentMetadataBaseRowSchema.extend({
  type: z.literal("task_link"),
  taskId: z.string().uuid().nullable().optional(),
  identifier: z.string().trim().min(1).max(80).nullable().optional(),
  title: z.string().trim().min(1).max(240).nullable().optional(),
}).strict();

const taskCommentMetadataAgentLinkRowSchema = taskCommentMetadataBaseRowSchema.extend({
  type: z.literal("agent_link"),
  agentId: z.string().uuid(),
  name: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

const taskCommentMetadataRunLinkRowSchema = taskCommentMetadataBaseRowSchema.extend({
  type: z.literal("run_link"),
  runId: z.string().uuid(),
  title: z.string().trim().min(1).max(160).nullable().optional(),
}).strict();

export const taskCommentMetadataRowSchema = z.discriminatedUnion("type", [
  taskCommentMetadataTextRowSchema,
  taskCommentMetadataCodeRowSchema,
  taskCommentMetadataKeyValueRowSchema,
  taskCommentMetadataTaskLinkRowSchema,
  taskCommentMetadataAgentLinkRowSchema,
  taskCommentMetadataRunLinkRowSchema,
]).superRefine((value, ctx) => {
  if (value.type === "task_link" && !value.taskId && !value.identifier) {
    addValidationDetail(ctx, {
      message: "Task link rows require taskId or identifier",
      path: ["taskId"],
    });
  }
});

export const taskCommentMetadataSectionSchema = z.object({
  title: z.string().trim().min(1).max(160).nullable().optional(),
  rows: z.array(taskCommentMetadataRowSchema).min(1).max(50),
}).strict();

export const taskCommentMetadataSchema = z.object({
  version: z.literal(1),
  sourceRunId: z.string().uuid().nullable().optional(),
  sections: z.array(taskCommentMetadataSectionSchema).min(1).max(20),
}).strict();

export type TaskCommentMetadata = z.infer<typeof taskCommentMetadataSchema>;

export const boardTaskCommentAuthorSchema = z.object({
  type: taskCommentAuthorTypeSchema,
  label: z.string().min(1).max(240),
  agentId: z.string().uuid().nullable(),
  userId: z.string().min(1).nullable(),
  pluginKey: z.string().min(1).nullable(),
}).strict();

export const boardTaskCommentParentReferenceSchema = z.object({
  authorLabel: z.string().min(1).max(240),
  excerpt: z.string().max(120),
}).strict();

const boardTaskCommentTimestampSchema = z.union([
  z.date(),
  z.string().datetime(),
]);

export const boardTaskCommentSchema = z.object({
  id: z.string().uuid(),
  author: boardTaskCommentAuthorSchema,
  body: z.string(),
  presentation: taskCommentPresentationSchema.nullable(),
  metadata: taskCommentMetadataSchema.nullable(),
  sourceTrust: sourceTrustMetadataSchema.nullable(),
  runState: z.enum(["queued", "working", "terminal"]).nullable(),
  canonicalSequence: z.number().int().nonnegative(),
  immediateParentDisplayReference:
    boardTaskCommentParentReferenceSchema.nullable(),
  createdAt: boardTaskCommentTimestampSchema,
  updatedAt: boardTaskCommentTimestampSchema,
}).strict();

export const boardTaskRunSegmentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("reasoning"), text: z.string() }).strict(),
  z.object({
    type: z.literal("tool"),
    name: z.string().min(1),
    status: z.enum(["pending", "running", "completed", "error"]),
  }).strict(),
]);

export const boardTaskRunSegmentEntrySchema = z.object({
  kind: z.literal("run_segment"),
  id: z.string().regex(/^segment_[a-f0-9]{32}$/),
  author: boardTaskCommentAuthorSchema,
  parts: z.array(boardTaskRunSegmentPartSchema),
  status: z.enum(["working", "complete", "error"]),
  canonicalSequence: z.number().int().nonnegative(),
  immediateParentDisplayReference:
    boardTaskCommentParentReferenceSchema.nullable(),
  createdAt: boardTaskCommentTimestampSchema,
  updatedAt: boardTaskCommentTimestampSchema,
}).strict();

export const boardTaskCommentEntrySchema = boardTaskCommentSchema.extend({
  kind: z.literal("comment"),
}).strict();

export const boardTaskThreadEntrySchema = z.discriminatedUnion("kind", [
  boardTaskCommentEntrySchema,
  boardTaskRunSegmentEntrySchema,
]);

export const boardTaskCommentGroupSchema = z.object({
  root: boardTaskCommentSchema,
  replyCount: z.number().int().nonnegative(),
  runSegmentCount: z.number().int().nonnegative(),
  entries: z.array(boardTaskThreadEntrySchema),
  entriesNextCursor: z.string().min(1).nullable(),
}).strict();

export const boardTaskCommentGroupPageSchema = z.object({
  groups: z.array(boardTaskCommentGroupSchema),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const boardTaskCommentThreadPageSchema = z.object({
  entries: z.array(boardTaskThreadEntrySchema),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const createTaskUserCommentSchema = z.object({
  message: opaqueTaskMessageSchema
    .refine((value) => value.trim().length > 0, {
      message: "Comment must contain non-whitespace text",
    }),
  idempotencyKey: taskMutationIdempotencyKeySchema,
  mention: z.object({
    targetAgentId: z.string().uuid(),
    ownershipEpoch: z.number().int().positive(),
  }).strict().nullable().optional(),
  replyToCommentId: z.string().uuid().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mention != null && value.replyToCommentId != null) {
    addValidationDetail(ctx, {
      message: "A comment cannot mention an agent and reply to a comment at the same time",
      path: ["replyToCommentId"],
    });
  }
});

export type CreateTaskUserComment = z.infer<typeof createTaskUserCommentSchema>;

export const taskDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");


export const linkTaskApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkTaskApproval = z.infer<typeof linkTaskApprovalSchema>;

export const createTaskAttachmentMetadataSchema = z.object({
  taskCommentId: z.string().uuid().optional().nullable(),
});

export type CreateTaskAttachmentMetadata = z.infer<typeof createTaskAttachmentMetadataSchema>;

export const TASK_DOCUMENT_FORMATS = ["markdown"] as const;

export const taskDocumentFormatSchema = z.enum(TASK_DOCUMENT_FORMATS);

export const upsertTaskDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: taskDocumentFormatSchema,
  body: multilineTextSchema.pipe(z.string().max(524288)),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export const restoreTaskDocumentRevisionSchema = z.object({});

export type TaskDocumentFormat = z.infer<typeof taskDocumentFormatSchema>;
export type UpsertTaskDocument = z.infer<typeof upsertTaskDocumentSchema>;
export type RestoreTaskDocumentRevision = z.infer<typeof restoreTaskDocumentRevisionSchema>;
