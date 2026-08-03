import type { AcpPromptSettlement } from "@paperclipai/adapter-utils/acp-subprocess";
import type {
  SessionCompactionSettings,
} from "@paperclipai/shared";
import { z } from "zod";

/**
 * Versioned, Paperclip-owned structural metadata placed on the canonical
 * request/assistant pair. The text itself remains solely in Session messages.
 */
export const PAPERCLIP_SESSION_COMPACTION_VERSION =
  "paperclip-session-compaction/v1" as const;
export const PAPERCLIP_SESSION_COMPACTION_RUN_CONTEXT_VERSION =
  "paperclip-recovery-compaction-run/v1" as const;

export const sessionCompactionScopeSchema = z
  .object({
    kind: z.enum(["turns-recovery", "comments-recovery"]),
    id: z.string().min(1),
    audience: z.enum(["turns", "comments"]),
    sourceHighWaterSeq: z.number().int().min(0),
  })
  .strict()
  .superRefine((scope, issue) => {
    const valid =
      (scope.kind === "turns-recovery" && scope.audience === "turns") ||
      (scope.kind === "comments-recovery" && scope.audience === "comments");
    if (!valid) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Recovery compaction scope and audience must match",
        path: ["audience"],
      });
    }
  });

export const persistedSessionCompactionSettingsSchema = z
  .object({
    auto: z.boolean().optional(),
    prune: z.boolean().optional(),
    reserved: z.number().int().min(0).optional(),
    tail_turns: z.number().int().min(0).optional(),
    preserve_recent_tokens: z.number().int().min(0).optional(),
    modelRef: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** Immutable model/profile and limits used by one maintenance run. */
export const persistedSessionCompactionModelSchema = z
  .object({
    modelRef: z.string().min(1).max(500),
    targetModelId: z.string().min(1),
    targetModelValue: z.string().min(1),
    contextTokenLimit: z.number().int().positive(),
    inputTokenLimit: z.number().int().positive().optional(),
    outputTokenLimit: z.number().int().positive(),
  })
  .strict()
  .superRefine((model, issue) => {
    if (model.outputTokenLimit > model.contextTokenLimit) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Compaction output limit exceeds its context limit",
        path: ["outputTokenLimit"],
      });
    }
    if (
      model.inputTokenLimit !== undefined &&
      model.inputTokenLimit > model.contextTokenLimit
    ) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Compaction input limit exceeds its context limit",
        path: ["inputTokenLimit"],
      });
    }
  });

export const sessionCompactionSourceSchema = z
  .object({
    runId: z.string().uuid(),
    runKind: z.enum(["productive", "consult"]),
    refId: z.string().uuid(),
    refOrdinal: z.number().int().min(0),
    segmentOrdinal: z.number().int().min(0),
    latestFinishedAssistantMessageId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Closed immutable snapshot stored on the unique recovery-prompt control.
 * It contains no prompt, summary, selected row copies, or provider payload.
 */
export const sessionCompactionRunContextSchema = z
  .object({
    version: z.literal(PAPERCLIP_SESSION_COMPACTION_RUN_CONTEXT_VERSION),
    issueId: z.string().uuid(),
    sessionId: z.string().min(1),
    ownershipEpoch: z.number().int().positive(),
    contextEpoch: z.number().int().min(0),
    executionLineageId: z.string().uuid(),
    targetAgentId: z.string().uuid(),
    adapterConfigRevisionId: z.string().uuid(),
    executionWorkspaceBindingId: z.string().uuid(),
    scope: sessionCompactionScopeSchema,
    source: sessionCompactionSourceSchema,
    settings: persistedSessionCompactionSettingsSchema,
    model: persistedSessionCompactionModelSchema,
  })
  .strict();

export type SessionCompactionRunContext = z.infer<
  typeof sessionCompactionRunContextSchema
>;
export type PersistedSessionCompactionModel = z.infer<
  typeof persistedSessionCompactionModelSchema
>;

export function sessionCompactionEnvelope(
  context: SessionCompactionRunContext,
  runId: string,
  controlId: string,
) {
  return {
    version: PAPERCLIP_SESSION_COMPACTION_VERSION,
    trigger: "recovery" as const,
    role: "request-marker" as const,
    runID: runId,
    controlID: controlId,
    scope: context.scope,
    source: context.source,
  } as const;
}

export interface SessionCompactionPromptLifecycle {
  onSessionActivated?(): Promise<void>;
  onPromptTransmissionBegan?(): Promise<void>;
}

export interface SessionCompactionSummaryResult {
  readonly text: string;
  /** The complete stable ACP stop-plus-terminal-occupancy settlement. */
  readonly settlement: AcpPromptSettlement;
}

export interface SessionCompactionSummarizer {
  summarize(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly ownershipEpoch: number;
    readonly adapterConfigRevisionId: string;
    readonly executionWorkspaceBindingId: string;
    readonly prompt: string;
    readonly model: PersistedSessionCompactionModel;
    readonly lifecycle: SessionCompactionPromptLifecycle;
    readonly signal?: AbortSignal;
  }): Promise<SessionCompactionSummaryResult>;
}

export interface SessionCompactionModelResolver {
  /** Validate an operator-selected override against the company catalog. */
  validateConfiguredModel(input: {
    readonly companyId: string;
    readonly modelRef: string;
  }): Promise<void>;
  resolve(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly agentId: string;
    readonly ownershipEpoch: number;
    readonly adapterConfigRevisionId: string;
    readonly executionWorkspaceBindingId: string;
    readonly requestedModelRef: string | null;
    readonly triggerModel: PersistedSessionCompactionModel;
  }): Promise<PersistedSessionCompactionModel>;
}

export class SessionCompactionConflict extends Error {
  readonly code = "session_compaction_conflict";

  constructor(message: string) {
    super(message);
    this.name = "SessionCompactionConflict";
  }
}

export class SessionCompactionProviderFailure extends Error {
  readonly code = "session_compaction_provider_failure";

  constructor(
    message: string,
    readonly errorKind: string,
    readonly retryable: boolean,
    readonly partialText = "",
    readonly promptTransmitted = false,
  ) {
    super(message);
    this.name = "SessionCompactionProviderFailure";
  }
}

export class SessionCompactionRecoveryRejected extends Error {
  readonly code = "session_compaction_recovery_rejected";

  constructor(
    message: string,
    readonly reason:
      | "auto_disabled"
      | "budget_hard_stop"
      | "compaction_failed"
      | "source_changed",
  ) {
    super(message);
    this.name = "SessionCompactionRecoveryRejected";
  }
}

export function sparseSessionCompactionSettings(
  value: SessionCompactionSettings | null | undefined,
): SessionCompactionSettings {
  return persistedSessionCompactionSettingsSchema.parse(value ?? {});
}
