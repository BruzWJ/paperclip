import { createHash, randomUUID } from "node:crypto";
import {
  companies,
  issueExecutionAttempts,
  issueExecutionLeases,
  issueExecutionProcessFacts,
  issueSessionAssistantSources,
  issueSessionCompactionControls,
  issueSessionCompletedToolSources,
  issueSessionErrorToolSources,
  issueSessionMessages,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  IssueSessionMessage,
  SessionCompactionSettings,
  UpdateSessionCompactionSettings,
} from "@paperclipai/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
} from "drizzle-orm";
import type { LogActivityInput } from "./activity-log.js";
import { logActivity } from "./activity-log.js";
import {
  budgetService,
  type BudgetServiceHooks,
} from "./budgets.js";
import {
  attachIssueExecutionRunAttemptInTransaction,
  createIssueExecutionRunInTransaction,
  detachIssueExecutionRunAttemptInTransaction,
  lockIssueExecutionRunIfPresentInTransaction,
  lockIssueExecutionRunInTransaction,
  transitionIssueExecutionRunStatusInTransaction,
} from "./issue-execution-run-service.js";
import type {
  PostgresIssueExecutionFinalizationWriter,
} from "./issue-execution-finalization-postgres.js";
import type {
  IssueSessionRecoveryCandidate,
  IssueSessionRecoveryCompactionBoundary,
  PreparedIssueSessionRecoveryView,
} from "./issue-session-recovery-postgres.js";
import type {
  IssueSessionRecoveryCheckpoint,
  IssueSessionRecoveryMember,
} from "./issue-session-recovery.js";
import {
  reserveIssueSessionEventSequence,
  reserveIssueSessionMessageId,
} from "./issue-session/event-store.js";
import {
  publishIssueSessionEventInTx,
  publishIssueSessionToolPrunedEffectInTx,
} from "./issue-session/publication.js";
import {
  createIssueSessionCompaction,
  filterCompacted,
  isOverflow,
  serializeCompactionTranscript,
  usable,
  type Config,
  type MessagePart,
  type ProviderModel,
  type ToolPart,
  type WithParts,
} from "./issue-session-compaction/index.js";
import { buildPrompt } from "./issue-session-compaction/build-prompt.js";
import { buildCompactionPrompt } from "./issue-session-compaction/transcript.js";
import { estimate as estimateTokens } from "./issue-session-compaction/token.js";
import {
  deriveCanonicalCompactionSummaryText,
} from "./issue-session-compaction/summary-text.js";
import {
  SessionCompactionConflict,
  SessionCompactionProviderFailure,
  SessionCompactionRecoveryRejected,
  persistedSessionCompactionModelSchema,
  persistedSessionCompactionSettingsSchema,
  sessionCompactionRunContextSchema,
  sparseSessionCompactionSettings,
  type PersistedSessionCompactionModel,
  type SessionCompactionModelResolver,
  type SessionCompactionRunContext,
  type SessionCompactionSummarizer,
  type SessionCompactionSummaryResult,
} from "./issue-session-compaction-contract.js";
import {
  decodeStoredIssueSessionMessage,
} from "./issue-session/store.js";
import {
  settleAcpPromptInTransaction,
} from "./acp-prompt-settlement.js";

export {
  SessionCompactionConflict,
  SessionCompactionProviderFailure,
  SessionCompactionRecoveryRejected,
} from "./issue-session-compaction-contract.js";
export type {
  PersistedSessionCompactionModel,
  SessionCompactionModelResolver,
  SessionCompactionSummarizer,
  SessionCompactionSummaryResult,
} from "./issue-session-compaction-contract.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CompactionControl = typeof issueSessionCompactionControls.$inferSelect;

const DEFAULT_LEASE_MS = 30 * 60 * 1_000;

/**
 * Failure of the blocked productive/consult prompt is a separate typed owner.
 * It must settle exactly that source ref/segment and revoke its capability;
 * compaction cannot reproduce those run-control transitions locally.
 */
export interface SessionCompactionBlockedPromptFailureOwner {
  failBlockedPromptInTransaction(transaction: Transaction, input: {
    readonly candidate: IssueSessionRecoveryCandidate;
    readonly compactionRunId: string;
    readonly compactionControlId: string;
    readonly reason:
      | "recovery_compaction_budget_hard_stop"
      | "recovery_compaction_failed";
    readonly at: Date;
  }): Promise<void>;
}

export interface PostgresIssueSessionCompactionOptions {
  readonly workerId: string;
  readonly summarizer: SessionCompactionSummarizer;
  readonly modelResolver: SessionCompactionModelResolver;
  readonly finalizationWriter: PostgresIssueExecutionFinalizationWriter;
  readonly blockedPromptFailure: SessionCompactionBlockedPromptFailureOwner;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly leaseDurationMs?: number;
  readonly budgetHooks?: BudgetServiceHooks;
}

/** Exact worker-local identity of one active recovery-compaction ACP attempt. */
export interface IssueSessionCompactionAttemptCancellationSignal {
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly leaseGeneration: number;
}

interface LoadedCompactionMessages {
  readonly orderedMembers: readonly IssueSessionRecoveryMember[];
  readonly messages: WithParts[];
}

interface RecoveryCompactionPlan {
  readonly config: Config;
  readonly model: ProviderModel;
  readonly tokenCount: number;
  readonly usableTokens: number;
  readonly overLimit: boolean;
  readonly head: WithParts[];
  readonly tailStartMessageId: string | null;
  readonly previousSummary: string | undefined;
  readonly prompt: string;
}

interface ClaimedRecoveryCompaction {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly controlId: string;
  readonly context: SessionCompactionRunContext;
  readonly existing: boolean;
}

interface CompactionAttempt {
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly cancellation: IssueSessionCompactionAttemptCancellationSignal;
  readonly controller: AbortController;
}

interface LockedCompactionAttempt {
  readonly attempt: typeof issueExecutionAttempts.$inferSelect;
  readonly lease: typeof issueExecutionLeases.$inferSelect;
}

interface ActiveCompactionAttempt {
  readonly cancellation: IssueSessionCompactionAttemptCancellationSignal;
  readonly controller: AbortController;
}

interface RecoveryToolPrune {
  readonly assistantMessageId: string;
  readonly toolId: string;
  readonly compactedAt: Date;
}

class SessionCompactionAttemptFenceLost extends Error {
  readonly code = "session_compaction_attempt_fence_lost";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SessionCompactionAttemptFenceLost";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactNonempty(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new SessionCompactionConflict(`${label} must be exact and non-empty`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionCompactionConflict(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * One compaction attempt remains alive until either its work and teardown
 * finish or its lease fence is lost. A lost lease wins the returned error,
 * but the aborted provider lifecycle is still joined before control returns.
 */
export async function runSessionCompactionWithLeaseRenewal<T>(input: {
  readonly intervalMs: number;
  readonly controller: AbortController;
  readonly renew: () => Promise<void>;
  readonly work: () => Promise<T>;
}): Promise<T> {
  positiveInteger(input.intervalMs, "compaction lease renewal interval");
  const stop = new AbortController();
  const waitForRenewal = (): Promise<boolean> => {
    if (stop.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        stop.signal.removeEventListener("abort", stopped);
        resolve(true);
      }, input.intervalMs);
      function stopped() {
        clearTimeout(timer);
        resolve(false);
      }
      stop.signal.addEventListener("abort", stopped, { once: true });
    });
  };
  let rejectLeaseLoss!: (error: SessionCompactionAttemptFenceLost) => void;
  let renewalFailure: SessionCompactionAttemptFenceLost | null = null;
  const leaseLoss = new Promise<never>((_resolve, reject) => {
    rejectLeaseLoss = reject;
  });
  const renewal = (async () => {
    while (await waitForRenewal()) {
      try {
        await input.renew();
      } catch (cause) {
        const failure = cause instanceof SessionCompactionAttemptFenceLost
          ? cause
          : new SessionCompactionAttemptFenceLost(
              "Recovery compaction lease renewal failed closed",
              cause,
            );
        renewalFailure = failure;
        input.controller.abort("issue_session_compaction_lease_lost");
        rejectLeaseLoss(failure);
        return;
      }
    }
  })();
  const work = Promise.resolve().then(input.work);
  try {
    return await Promise.race([work, leaseLoss]);
  } finally {
    stop.abort();
    await renewal;
    if (renewalFailure !== null) {
      input.controller.abort("issue_session_compaction_lease_lost");
      await work.catch(() => undefined);
      throw renewalFailure;
    }
  }
}

export type SessionCompactionTerminalRecoveryDecision =
  | {
      readonly kind: "live";
    }
  | {
      readonly kind: "finalize";
      readonly attemptTerminalState: "settled" | "failed";
      readonly runStatus: "succeeded" | "failed" | "cancelled";
      readonly terminalReasonCode: string;
      readonly expireAttachedAttempt: boolean;
    };

/** Closed no-replay decision for one already-terminal compaction prompt. */
export function decideSessionCompactionTerminalRecovery(input: {
  readonly protocolSettlementState: "not_sent" | "settled" | "incomplete";
  readonly effectKind: "checkpoint" | "failed-compaction" | null;
  readonly failureKind: string | null;
  readonly attachedAttempt: {
    readonly state: string;
    readonly leaseState: string;
    readonly expiresAt: Date;
  } | null;
  readonly at: Date;
}): SessionCompactionTerminalRecoveryDecision {
  let attemptTerminalState: "settled" | "failed";
  let runStatus: "succeeded" | "failed" | "cancelled";
  let terminalReasonCode: string;
  if (input.effectKind === "checkpoint") {
    if (input.protocolSettlementState !== "settled") {
      throw new SessionCompactionConflict(
        "Recovery checkpoint does not own a protocol-settled prompt",
      );
    }
    attemptTerminalState = "settled";
    runStatus = "succeeded";
    terminalReasonCode = "recovery_compaction_completed";
  } else if (input.effectKind === "failed-compaction") {
    if (!input.failureKind) {
      throw new SessionCompactionConflict(
        "Failed recovery compaction has no terminal failure kind",
      );
    }
    attemptTerminalState = input.protocolSettlementState === "settled"
      ? "settled"
      : "failed";
    runStatus = input.protocolSettlementState === "settled" &&
        input.failureKind === "terminal_cancelled"
      ? "cancelled"
      : "failed";
    terminalReasonCode = input.failureKind;
  } else {
    if (
      input.protocolSettlementState !== "not_sent" ||
      !input.failureKind
    ) {
      throw new SessionCompactionConflict(
        "Terminal recovery compaction has no canonical result effect",
      );
    }
    attemptTerminalState = "failed";
    runStatus = "failed";
    terminalReasonCode = input.failureKind;
  }
  if (input.attachedAttempt) {
    if (
      input.attachedAttempt.state !== "running" ||
      input.attachedAttempt.leaseState !== "active"
    ) {
      throw new SessionCompactionConflict(
        "Terminal recovery compaction attachment is not an exact live attempt",
      );
    }
    if (input.attachedAttempt.expiresAt > input.at) return { kind: "live" };
  }
  return {
    kind: "finalize",
    attemptTerminalState,
    runStatus,
    terminalReasonCode,
    expireAttachedAttempt: input.attachedAttempt !== null,
  };
}

function settingsForDb(value: SessionCompactionSettings): Record<string, unknown> {
  return { ...persistedSessionCompactionSettingsSchema.parse(value) };
}

function configFor(settings: SessionCompactionSettings): Config {
  return {
    compaction: {
      ...(settings.auto !== undefined ? { auto: settings.auto } : {}),
      ...(settings.prune !== undefined ? { prune: settings.prune } : {}),
      ...(settings.reserved !== undefined
        ? { reserved: settings.reserved }
        : {}),
      ...(settings.tail_turns !== undefined
        ? { tail_turns: settings.tail_turns }
        : {}),
      ...(settings.preserve_recent_tokens !== undefined
        ? { preserve_recent_tokens: settings.preserve_recent_tokens }
        : {}),
    },
  };
}

function providerModel(model: PersistedSessionCompactionModel): ProviderModel {
  return {
    providerID: "paperclip-acp",
    id: model.targetModelId,
    api: { id: model.targetModelValue, npm: "paperclip-acp" },
    limit: {
      context: model.contextTokenLimit,
      ...(model.inputTokenLimit === undefined
        ? {}
        : { input: model.inputTokenLimit }),
      output: model.outputTokenLimit,
    },
  };
}

function triggerModelFromPromptRevision(
  candidate: IssueSessionRecoveryCandidate,
): PersistedSessionCompactionModel {
  const model = candidate.prompt.acpConfiguration.model;
  return persistedSessionCompactionModelSchema.parse({
    modelRef: model.id,
    targetModelId: model.id,
    targetModelValue: model.value,
    contextTokenLimit: model.limits.contextTokenLimit,
    ...(model.limits.inputTokenLimit === undefined
      ? {}
      : { inputTokenLimit: model.limits.inputTokenLimit }),
    outputTokenLimit: model.limits.outputTokenLimit,
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function millis(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function paperclipMetadata(message: IssueSessionMessage) {
  return record(record(message.metadata).paperclip);
}

function sourceKey(messageId: string, toolId: string): string {
  return `${messageId}\0${toolId}`;
}

function nonAssistantParts(message: Exclude<
  IssueSessionMessage,
  { type: "assistant" | "agent-switched" | "model-switched" | "compaction" }
>): MessagePart[] {
  if (message.type === "shell") {
    return [{ type: "text", text: message.command }];
  }
  const value = message.type === "user" || message.type === "synthetic" || message.type === "system"
    ? message.text
    : "";
  const parts: MessagePart[] = value.length > 0
    ? [{ type: "text", text: value }]
    : [];
  if (message.type === "user") {
    for (const file of message.files ?? []) {
      parts.push({
        type: "file",
        mime: file.mime,
        url: file.uri,
        ...(file.name === undefined ? {} : { filename: file.name }),
      });
    }
  }
  return parts;
}

function assistantParts(input: {
  readonly message: Extract<IssueSessionMessage, { type: "assistant" }>;
  readonly completedOutput: ReadonlyMap<string, string>;
  readonly errorOutput: ReadonlyMap<
    string,
    { readonly interrupted: boolean; readonly output: string | null }
  >;
  readonly pruned: ReadonlySet<string>;
}): MessagePart[] {
  return input.message.content.map((part): MessagePart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "reasoning") {
      return { type: "reasoning", text: part.text };
    }
    const key = sourceKey(input.message.id, part.id);
    const common = {
      type: "tool" as const,
      tool: part.name,
      callID: part.id,
    };
    if (part.state.status === "completed") {
      const output = input.completedOutput.get(key);
      if (output === undefined) {
        throw new SessionCompactionConflict(
          `Completed tool ${input.message.id}/${part.id} has no canonical source output`,
        );
      }
      return {
        ...common,
        state: {
          status: "completed",
          input: part.state.input,
          output,
          time: {
            start: millis(part.time.ran),
            end: millis(part.time.completed),
            ...(input.pruned.has(key) ? { compacted: 1 } : {}),
          },
        },
      };
    }
    if (part.state.status === "error") {
      const companion = input.errorOutput.get(key);
      return {
        ...common,
        state: {
          status: "error",
          input: part.state.input,
          error: part.state.error.message,
          metadata: companion
            ? {
                interrupted: companion.interrupted,
                ...(companion.interrupted && companion.output !== null
                  ? { output: companion.output }
                  : {}),
              }
            : {},
        },
      };
    }
    return {
      ...common,
      state: {
        status: part.state.status,
        input: part.state.input,
      },
    } as ToolPart;
  });
}

function messageWithParts(input: {
  readonly message: IssueSessionMessage;
  readonly completedOutput: ReadonlyMap<string, string>;
  readonly errorOutput: ReadonlyMap<
    string,
    { readonly interrupted: boolean; readonly output: string | null }
  >;
  readonly pruned: ReadonlySet<string>;
  readonly assistantErrorKind: ReadonlyMap<
    string,
    "aborted" | "other" | null
  >;
}): WithParts {
  const message = input.message;
  const paperclip = paperclipMetadata(message);
  const compaction = record(paperclip.compaction);
  if (message.type === "compaction") {
    throw new SessionCompactionConflict(
      "A prior compaction request marker entered recovery compaction",
    );
  }
  if (message.type === "agent-switched" || message.type === "model-switched") {
    return {
      info: { id: message.id, role: "auxiliary", kind: "control" },
      parts: [],
    };
  }
  if (message.type === "system" || message.type === "shell") {
    return {
      info: { id: message.id, role: "auxiliary", kind: message.type },
      parts: nonAssistantParts(message),
    };
  }
  if (message.type === "assistant") {
    const errorKind = input.assistantErrorKind.get(message.id);
    return {
      info: {
        id: message.id,
        role: "assistant",
        parentID: text(paperclip.parentID) || undefined,
        providerID: message.model.providerID,
        modelID: message.model.id,
        summary: paperclip.summary === true,
        finish: message.finish,
        error: errorKind === "aborted"
          ? { name: "MessageAbortedError" }
          : errorKind === "other"
            ? message.error ?? { name: "MessageError" }
            : message.error,
      },
      parts: assistantParts({ ...input, message }),
    };
  }
  if (
    message.type === "user" &&
    compaction.version === "paperclip-session-compaction/v1" &&
    compaction.role === "request-marker"
  ) {
    return {
      info: { id: message.id, role: "user", kind: "compaction-request" },
      parts: [{
        type: "compaction",
        auto: true,
        ...(typeof compaction.tail_start_id === "string"
          ? { tail_start_id: compaction.tail_start_id }
          : {}),
      }],
    };
  }
  return {
    info: {
      id: message.id,
      role: "user",
      kind: message.type === "synthetic" ? "synthetic" : "source",
    },
    parts: nonAssistantParts(message),
  };
}

function commentWithParts(
  member: Extract<IssueSessionRecoveryMember, { kind: "comment" }>,
): WithParts {
  if (member.authorKind === "agent") {
    return {
      info: { id: member.id, role: "assistant" },
      parts: [{ type: "text", text: member.body }],
    };
  }
  if (member.authorKind === "user") {
    return {
      info: { id: member.id, role: "user", kind: "source" },
      parts: [{ type: "text", text: member.body }],
    };
  }
  return {
    info: { id: member.id, role: "auxiliary", kind: "system" },
    parts: [{ type: "text", text: member.body }],
  };
}

function completedCompactionPairs(messages: readonly WithParts[]): {
  readonly hidden: ReadonlySet<number>;
  readonly previousSummary: string | undefined;
} {
  const requests = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.info.role === "user" &&
      message.parts.some((part) => part.type === "compaction")
    ) {
      requests.set(message.info.id, index);
    }
  }
  const pairs = messages.flatMap((message, assistantIndex) => {
    if (
      message.info.role !== "assistant" ||
      !message.info.summary ||
      !message.info.finish ||
      message.info.error
    ) {
      return [];
    }
    const userIndex = requests.get(message.info.parentID ?? "");
    if (userIndex === undefined) return [];
    const summary = message.parts
      .flatMap((part) => part.type === "text" ? [part.text.trim()] : [])
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return [{ userIndex, assistantIndex, summary: summary || undefined }];
  });
  return {
    hidden: new Set(pairs.flatMap((pair) => [pair.userIndex, pair.assistantIndex])),
    previousSummary: pairs.at(-1)?.summary,
  };
}

function recoveryIdentityDigest(
  candidate: IssueSessionRecoveryCandidate,
): string {
  return sha256(JSON.stringify({
    version: "paperclip-recovery-compaction-identity/v1",
    companyId: candidate.identity.companyId,
    issueId: candidate.identity.issueId,
    sessionId: candidate.identity.sessionId,
    ownershipEpoch: candidate.identity.ownershipEpoch,
    targetAgentId: candidate.identity.targetAgentId,
    laneKind: candidate.identity.laneKind,
    contextEpoch: candidate.identity.contextEpoch,
    executionLineageId: candidate.identity.executionLineageId,
    scopeKind: candidate.identity.scopeKind,
    scopeId: candidate.identity.scopeId,
    audience: candidate.identity.audience,
    sourceHighWaterSeq: candidate.identity.sourceHighWaterSeq,
    sourceRunId: candidate.identity.sourceRunId,
    sourceRefId: candidate.identity.sourceRefId,
    sourceRefOrdinal: candidate.identity.sourceRefOrdinal,
    sourceSegmentOrdinal: candidate.identity.sourceSegmentOrdinal,
    latestFinishedAssistantMessageId:
      candidate.latestFinishedAssistantMessageId,
  }));
}

function retainedMembers(
  members: readonly IssueSessionRecoveryMember[],
  tailStartMessageId: string | null,
): readonly IssueSessionRecoveryMember[] {
  if (tailStartMessageId === null) return Object.freeze([]);
  const start = members.findIndex((member) => member.id === tailStartMessageId);
  if (start < 0) {
    throw new SessionCompactionConflict(
      "Recovery compaction tail boundary is not an authorized member",
    );
  }
  return Object.freeze(
    members.slice(start).map((member) => member.kind === "message"
      ? Object.freeze({ ...member, selectionRole: "retained-tail" as const })
      : member),
  );
}

function summaryCheckpoint(input: {
  readonly control: CompactionControl;
  readonly summary: IssueSessionMessage;
}): IssueSessionRecoveryCheckpoint {
  if (
    input.control.kind !== "checkpoint" ||
    !input.control.compactionRequestMessageId ||
    !input.control.summaryAssistantMessageId ||
    input.summary.type !== "assistant" ||
    input.summary.id !== input.control.summaryAssistantMessageId
  ) {
    throw new SessionCompactionConflict(
      "Recovery checkpoint has no canonical request/assistant pair",
    );
  }
  return Object.freeze({
    id: input.control.id,
    requestMessageId: input.control.compactionRequestMessageId,
    assistantMessageId: input.control.summaryAssistantMessageId,
    summaryText: deriveCanonicalCompactionSummaryText(input.summary),
    tailStartMessageId: input.control.tailStartMessageId,
  });
}

/** Pure recovery-only planning seam covered without PostgreSQL/provider effects. */
export async function planIssueSessionRecoveryCompaction(input: {
  readonly messages: WithParts[];
  readonly settings: SessionCompactionSettings;
  readonly model: PersistedSessionCompactionModel;
}): Promise<RecoveryCompactionPlan> {
  const config = configFor(input.settings);
  const model = providerModel(input.model);
  const filtered = filterCompacted([...input.messages].reverse());
  const tokenCount = estimateTokens(
    serializeCompactionTranscript(filtered, { transformForPrompt: false }),
  );
  const usableTokens = usable({ cfg: config, model });
  const tokenUsage = {
    total: tokenCount,
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  };
  const overLimit = tokenCount >= usableTokens;
  // Invoke the copied overflow branch even though explicit auto=false is
  // handled by the recovery owner rather than hidden as "fits".
  void isOverflow({ cfg: config, model, tokens: tokenUsage });
  const pairs = completedCompactionPairs(filtered);
  const lowerable = filtered.filter((_, index) => !pairs.hidden.has(index));
  const selection = await createIssueSessionCompaction({
    async config() { return config; },
    async messages() { return lowerable; },
    async modelForCompaction() { return model; },
    async updateToolPruned() {
      throw new SessionCompactionConflict("Pure planning cannot persist prune effects");
    },
    async createCompactionRequest() {
      throw new SessionCompactionConflict("Pure planning cannot create a request");
    },
    async summarize() {
      throw new SessionCompactionConflict("Pure planning cannot call a provider");
    },
    async publishCompactionEnded() {
      throw new SessionCompactionConflict("Pure planning cannot publish a checkpoint");
    },
  }).select({ messages: lowerable, cfg: config, model });
  const instruction = buildPrompt({
    previousSummary: pairs.previousSummary,
    context: [],
  });
  return Object.freeze({
    config,
    model,
    tokenCount,
    usableTokens,
    overLimit,
    head: selection.head,
    tailStartMessageId: selection.tail_start_id ?? null,
    previousSummary: pairs.previousSummary,
    prompt: buildCompactionPrompt({
      messages: selection.head,
      instruction,
    }),
  });
}

export function createPostgresIssueSessionCompactionRuntime(
  db: Db,
  options: PostgresIssueSessionCompactionOptions,
) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const leaseDurationMs = positiveInteger(
    options.leaseDurationMs ?? DEFAULT_LEASE_MS,
    "compaction lease duration",
  );
  const leaseRenewalIntervalMs = Math.max(
    1,
    Math.floor(leaseDurationMs / 2),
  );
  const workerId = exactNonempty(options.workerId, "compaction worker id");
  const budgets = budgetService(db, options.budgetHooks);
  const activeAttempts = new Map<string, ActiveCompactionAttempt>();

  function sameCancellationIdentity(
    left: IssueSessionCompactionAttemptCancellationSignal,
    right: IssueSessionCompactionAttemptCancellationSignal,
  ): boolean {
    return left.companyId === right.companyId &&
      left.issueId === right.issueId &&
      left.sessionId === right.sessionId &&
      left.executionScopeId === right.executionScopeId &&
      left.runId === right.runId &&
      left.attemptId === right.attemptId &&
      left.leaseGeneration === right.leaseGeneration;
  }

  async function lockExactActiveAttemptInTransaction(
    transaction: Transaction,
    input: {
      readonly claim: ClaimedRecoveryCompaction;
      readonly attempt: CompactionAttempt;
    },
  ): Promise<LockedCompactionAttempt> {
    const run = await lockIssueExecutionRunInTransaction(transaction, {
      companyId: input.claim.companyId,
      issueId: input.claim.issueId,
      runId: input.claim.runId,
    });
    if (
      run.kind !== "compaction" ||
      run.status !== "running" ||
      run.sessionId !== input.claim.context.sessionId ||
      run.executionScopeId !== input.claim.context.executionLineageId ||
      run.compactionScopeKind !== input.claim.context.scope.kind ||
      run.triggeredByRunId !== input.claim.context.source.runId ||
      run.currentAttemptId !== input.attempt.attemptId ||
      run.currentLeaseId !== input.attempt.leaseId ||
      run.cancellationIntentId !== null ||
      run.terminalFinalizationId !== null ||
      run.finishedAt !== null
    ) {
      throw new SessionCompactionAttemptFenceLost(
        "Recovery compaction run no longer owns the exact active attempt",
      );
    }
    const controls = await transaction
      .select({ id: issueSessionCompactionControls.id })
      .from(issueSessionCompactionControls)
      .where(
        and(
          eq(issueSessionCompactionControls.id, input.claim.controlId),
          eq(issueSessionCompactionControls.companyId, input.claim.companyId),
          eq(issueSessionCompactionControls.issueId, input.claim.issueId),
          eq(
            issueSessionCompactionControls.sessionId,
            input.claim.context.sessionId,
          ),
          eq(issueSessionCompactionControls.kind, "recovery-prompt"),
          eq(issueSessionCompactionControls.compactionRunId, input.claim.runId),
        ),
      )
      .limit(2)
      .for("update");
    if (controls.length !== 1) {
      throw new SessionCompactionAttemptFenceLost(
        "Recovery compaction control no longer owns the active attempt",
      );
    }
    const attempts = await transaction
      .select()
      .from(issueExecutionAttempts)
      .where(
        and(
          eq(issueExecutionAttempts.id, input.attempt.attemptId),
          eq(issueExecutionAttempts.companyId, input.claim.companyId),
          eq(issueExecutionAttempts.issueId, input.claim.issueId),
          eq(issueExecutionAttempts.sessionId, input.claim.context.sessionId),
          eq(issueExecutionAttempts.runId, input.claim.runId),
          eq(issueExecutionAttempts.runKind, "compaction"),
          eq(issueExecutionAttempts.promptKind, "compaction"),
          eq(issueExecutionAttempts.compactionControlId, input.claim.controlId),
        ),
      )
      .limit(2)
      .for("update");
    const leases = await transaction
      .select()
      .from(issueExecutionLeases)
      .where(
        and(
          eq(issueExecutionLeases.id, input.attempt.leaseId),
          eq(issueExecutionLeases.companyId, input.claim.companyId),
          eq(issueExecutionLeases.issueId, input.claim.issueId),
          eq(issueExecutionLeases.runId, input.claim.runId),
          eq(issueExecutionLeases.attemptId, input.attempt.attemptId),
        ),
      )
      .limit(2)
      .for("update");
    const persistedAttempt = attempts[0];
    const persistedLease = leases[0];
    const checkedAt = now();
    if (
      attempts.length !== 1 ||
      leases.length !== 1 ||
      !persistedAttempt ||
      !persistedLease ||
      persistedAttempt.state !== "running" ||
      persistedAttempt.attemptGeneration !== input.attempt.leaseGeneration ||
      persistedLease.state !== "active" ||
      persistedLease.workerId !== workerId ||
      persistedLease.leaseGeneration !== input.attempt.leaseGeneration ||
      persistedLease.expiresAt <= checkedAt
    ) {
      throw new SessionCompactionAttemptFenceLost(
        "Recovery compaction attempt lease is stale or expired",
      );
    }
    return { attempt: persistedAttempt, lease: persistedLease };
  }

  async function renewAttemptLease(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly attempt: CompactionAttempt;
  }): Promise<void> {
    await db.transaction(async (transaction) => {
      const locked = await lockExactActiveAttemptInTransaction(transaction, {
        ...input,
      });
      const at = now();
      if (locked.lease.expiresAt <= at) {
        throw new SessionCompactionAttemptFenceLost(
          "Recovery compaction lease expired during renewal",
        );
      }
      const expiresAt = new Date(Math.max(
        at.getTime() + leaseDurationMs,
        locked.lease.expiresAt.getTime() + 1,
      ));
      const renewed = await transaction
        .update(issueExecutionLeases)
        .set({
          renewedAt: at,
          expiresAt,
        })
        .where(
          and(
            eq(issueExecutionLeases.id, input.attempt.leaseId),
            eq(issueExecutionLeases.companyId, input.claim.companyId),
            eq(issueExecutionLeases.issueId, input.claim.issueId),
            eq(issueExecutionLeases.runId, input.claim.runId),
            eq(issueExecutionLeases.attemptId, input.attempt.attemptId),
            eq(
              issueExecutionLeases.leaseGeneration,
              input.attempt.leaseGeneration,
            ),
            eq(issueExecutionLeases.workerId, workerId),
            eq(issueExecutionLeases.state, "active"),
            eq(issueExecutionLeases.expiresAt, locked.lease.expiresAt),
          ),
        )
        .returning({ id: issueExecutionLeases.id });
      if (renewed.length !== 1) {
        throw new SessionCompactionAttemptFenceLost(
          "Recovery compaction lease renewal lost its compare-and-set fence",
        );
      }
    });
  }

  async function runWithLeaseRenewal<T>(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly attempt: CompactionAttempt;
    readonly work: () => Promise<T>;
  }): Promise<T> {
    return runSessionCompactionWithLeaseRenewal({
      intervalMs: leaseRenewalIntervalMs,
      controller: input.attempt.controller,
      renew: () => renewAttemptLease(input),
      work: input.work,
    });
  }

  async function getSettings(
    companyId: string,
  ): Promise<SessionCompactionSettings | null> {
    const rows = await db
      .select({ settings: companies.sessionCompaction })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return rows[0]
      ? sparseSessionCompactionSettings(rows[0].settings)
      : null;
  }

  async function updateSettings(
    companyId: string,
    replacement: UpdateSessionCompactionSettings,
    activity: Pick<LogActivityInput, "actorType" | "actorId">,
  ): Promise<{
    previous: SessionCompactionSettings;
    current: SessionCompactionSettings;
  } | null> {
    return db.transaction(async (transaction) => {
      const row = await transaction
        .select({ settings: companies.sessionCompaction })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const previous = sparseSessionCompactionSettings(row.settings);
      const current = persistedSessionCompactionSettingsSchema.parse(
        replacement,
      );
      if (current.modelRef !== undefined) {
        await options.modelResolver.validateConfiguredModel({
          companyId,
          modelRef: current.modelRef,
        });
      }
      const at = now();
      await transaction
        .update(companies)
        .set({ sessionCompaction: settingsForDb(current), updatedAt: at })
        .where(eq(companies.id, companyId));
      await logActivity(transaction as unknown as Db, {
        companyId,
        actorType: activity.actorType,
        actorId: activity.actorId,
        action: "company.session_compaction_settings_updated",
        entityType: "company",
        entityId: companyId,
        details: { previous, current },
      });
      return { previous, current };
    });
  }

  async function loadMessages(
    candidate: IssueSessionRecoveryCandidate,
  ): Promise<LoadedCompactionMessages> {
    if (candidate.depth === "thread") {
      if (candidate.members.some((member) => member.kind !== "comment")) {
        throw new SessionCompactionConflict(
          "Comments recovery received a non-comment candidate",
        );
      }
      return {
        orderedMembers: candidate.members,
        messages: candidate.members.map((member) =>
          commentWithParts(member as Extract<IssueSessionRecoveryMember, { kind: "comment" }>)),
      };
    }
    if (candidate.members.some((member) => member.kind !== "message")) {
      throw new SessionCompactionConflict(
        "Turns recovery received a non-message candidate",
      );
    }
    const messageIds = candidate.members.map((member) => member.id);
    const [completedRows, errorRows, assistantRows, pruneRows] =
      messageIds.length === 0
        ? [[], [], [], []] as const
        : await Promise.all([
            db
              .select()
              .from(issueSessionCompletedToolSources)
              .where(
                and(
                  eq(issueSessionCompletedToolSources.companyId, candidate.identity.companyId),
                  eq(issueSessionCompletedToolSources.issueId, candidate.identity.issueId),
                  eq(issueSessionCompletedToolSources.sessionId, candidate.identity.sessionId),
                  inArray(issueSessionCompletedToolSources.assistantMessageId, messageIds),
                ),
              ),
            db
              .select()
              .from(issueSessionErrorToolSources)
              .where(
                and(
                  eq(issueSessionErrorToolSources.companyId, candidate.identity.companyId),
                  eq(issueSessionErrorToolSources.issueId, candidate.identity.issueId),
                  eq(issueSessionErrorToolSources.sessionId, candidate.identity.sessionId),
                  inArray(issueSessionErrorToolSources.assistantMessageId, messageIds),
                ),
              ),
            db
              .select()
              .from(issueSessionAssistantSources)
              .where(
                and(
                  eq(issueSessionAssistantSources.companyId, candidate.identity.companyId),
                  eq(issueSessionAssistantSources.issueId, candidate.identity.issueId),
                  eq(issueSessionAssistantSources.sessionId, candidate.identity.sessionId),
                  inArray(issueSessionAssistantSources.assistantMessageId, messageIds),
                ),
              ),
            db
              .select({
                assistantMessageId: issueSessionCompactionControls.assistantMessageId,
                toolId: issueSessionCompactionControls.toolId,
              })
              .from(issueSessionCompactionControls)
              .where(
                and(
                  eq(issueSessionCompactionControls.companyId, candidate.identity.companyId),
                  eq(issueSessionCompactionControls.issueId, candidate.identity.issueId),
                  eq(issueSessionCompactionControls.sessionId, candidate.identity.sessionId),
                  eq(issueSessionCompactionControls.kind, "tool-pruned"),
                  eq(issueSessionCompactionControls.disposition, "active"),
                  eq(issueSessionCompactionControls.historyScopeKind, candidate.identity.scopeKind),
                  eq(issueSessionCompactionControls.historyScopeId, candidate.identity.scopeId),
                  eq(issueSessionCompactionControls.audience, candidate.identity.audience),
                ),
              ),
          ]);
    const completedOutput = new Map(
      completedRows.map((row) => [
        sourceKey(row.assistantMessageId, row.toolId),
        row.sourceOutputText,
      ]),
    );
    const errorOutput = new Map(
      errorRows.map((row) => [
        sourceKey(row.assistantMessageId, row.toolId),
        { interrupted: row.interrupted, output: row.interruptedOutputText },
      ]),
    );
    const assistantErrorKind = new Map(
      assistantRows.map((row) => [
        row.assistantMessageId,
        row.sourceAssistantErrorKind,
      ]),
    );
    const pruned = new Set(
      pruneRows.flatMap((row) =>
        row.assistantMessageId && row.toolId
          ? [sourceKey(row.assistantMessageId, row.toolId)]
          : []),
    );
    return {
      orderedMembers: candidate.members,
      messages: candidate.members.map((member) => {
        if (member.kind !== "message") {
          throw new SessionCompactionConflict(
            "Turns recovery changed its candidate kind",
          );
        }
        return messageWithParts({
          message: member.message,
          completedOutput,
          errorOutput,
          pruned,
          assistantErrorKind,
        });
      }),
    };
  }

  async function collectRecoveryToolPrunes(input: {
    readonly candidate: IssueSessionRecoveryCandidate;
    readonly loaded: LoadedCompactionMessages;
    readonly settings: SessionCompactionSettings;
    readonly model: PersistedSessionCompactionModel;
  }): Promise<readonly RecoveryToolPrune[]> {
    if (input.candidate.depth !== "turns") return Object.freeze([]);
    const sourceByPart = new Map<
      ToolPart,
      { readonly assistantMessageId: string; readonly toolId: string }
    >();
    for (const message of input.loaded.messages) {
      if (message.info.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type !== "tool") continue;
        sourceByPart.set(part, {
          assistantMessageId: message.info.id,
          toolId: part.callID,
        });
      }
    }
    const effects: RecoveryToolPrune[] = [];
    await createIssueSessionCompaction({
      async config() { return configFor(input.settings); },
      async messages() { return input.loaded.messages; },
      async modelForCompaction() { return providerModel(input.model); },
      async updateToolPruned({ part, compactedAt }) {
        const source = sourceByPart.get(part);
        if (!source || part.state.status !== "completed") {
          throw new SessionCompactionConflict(
            "Copied pruning selected a tool outside the authorized completed source",
          );
        }
        effects.push({
          ...source,
          compactedAt: new Date(compactedAt),
        });
      },
      async createCompactionRequest() {
        throw new SessionCompactionConflict(
          "Recovery pruning cannot create a compaction request",
        );
      },
      async summarize() {
        throw new SessionCompactionConflict(
          "Recovery pruning cannot call the compaction provider",
        );
      },
      async publishCompactionEnded() {
        throw new SessionCompactionConflict(
          "Recovery pruning cannot publish a checkpoint",
        );
      },
    }).prune({ sessionID: input.candidate.identity.sessionId });
    return Object.freeze(effects);
  }

  async function resolveModelAndSettings(
    candidate: IssueSessionRecoveryCandidate,
  ): Promise<{
    readonly settings: SessionCompactionSettings;
    readonly model: PersistedSessionCompactionModel;
    readonly triggerModel: PersistedSessionCompactionModel;
  }> {
    const settings = await getSettings(candidate.identity.companyId);
    if (!settings) {
      throw new SessionCompactionConflict(
        "Recovery compaction company no longer exists",
      );
    }
    const triggerModel = triggerModelFromPromptRevision(candidate);
    const model = await options.modelResolver.resolve({
      companyId: candidate.identity.companyId,
      issueId: candidate.identity.issueId,
      agentId: candidate.identity.targetAgentId,
      ownershipEpoch: candidate.identity.ownershipEpoch,
      adapterConfigRevisionId:
        candidate.prompt.identity.adapterConfigRevisionId,
      executionWorkspaceBindingId:
        candidate.prompt.identity.executionWorkspaceBindingId,
      requestedModelRef: settings.modelRef ?? null,
      triggerModel,
    });
    return {
      settings,
      model: persistedSessionCompactionModelSchema.parse(model),
      triggerModel,
    };
  }

  async function reconcileTerminalCompactionRun(input: {
    readonly claim: ClaimedRecoveryCompaction;
  }): Promise<CompactionControl | null> {
    let recoveredAttemptId: string | null = null;
    const effect = await db.transaction(async (transaction) => {
      const run = await lockIssueExecutionRunInTransaction(transaction, {
        companyId: input.claim.companyId,
        issueId: input.claim.issueId,
        runId: input.claim.runId,
      });
      const promptControls = await transaction
        .select()
        .from(issueSessionCompactionControls)
        .where(
          and(
            eq(issueSessionCompactionControls.id, input.claim.controlId),
            eq(issueSessionCompactionControls.companyId, input.claim.companyId),
            eq(issueSessionCompactionControls.issueId, input.claim.issueId),
            eq(
              issueSessionCompactionControls.sessionId,
              input.claim.context.sessionId,
            ),
            eq(issueSessionCompactionControls.kind, "recovery-prompt"),
            eq(issueSessionCompactionControls.compactionRunId, input.claim.runId),
          ),
        )
        .limit(2)
        .for("update");
      const promptControl = promptControls[0];
      if (promptControls.length !== 1 || !promptControl) {
        throw new SessionCompactionConflict(
          "Recovery compaction lost its terminal prompt control",
        );
      }
      const effects = await transaction
        .select()
        .from(issueSessionCompactionControls)
        .where(
          and(
            eq(issueSessionCompactionControls.companyId, input.claim.companyId),
            eq(issueSessionCompactionControls.issueId, input.claim.issueId),
            eq(
              issueSessionCompactionControls.sessionId,
              input.claim.context.sessionId,
            ),
            eq(issueSessionCompactionControls.compactionRunId, input.claim.runId),
            inArray(issueSessionCompactionControls.kind, [
              "checkpoint",
              "failed-compaction",
            ]),
            eq(issueSessionCompactionControls.disposition, "active"),
          ),
        )
        .orderBy(asc(issueSessionCompactionControls.createdAt))
        .for("update");
      const checkpoint = effects.find((row) => row.kind === "checkpoint");
      const failed = effects.find((row) => row.kind === "failed-compaction");
      if (effects.length > 1) {
        throw new SessionCompactionConflict(
          "Recovery compaction has multiple terminal result effects",
        );
      }
      const terminalEffect = checkpoint ?? failed ?? null;
      const terminalEffectKind = checkpoint
        ? "checkpoint"
        : failed
          ? "failed-compaction"
          : null;
      if (promptControl.protocolSettlementState === null) {
        if (terminalEffect) {
          throw new SessionCompactionConflict(
            "Recovery compaction effect precedes prompt settlement",
          );
        }
        return null;
      }
      if (
        terminalEffect &&
        (
          terminalEffect.historyScopeKind !== promptControl.historyScopeKind ||
          terminalEffect.historyScopeId !== promptControl.historyScopeId ||
          terminalEffect.audience !== promptControl.audience ||
          terminalEffect.contextEpoch !== promptControl.contextEpoch ||
          terminalEffect.executionLineageId !==
            promptControl.executionLineageId ||
          terminalEffect.sourceHighWaterSeq !==
            promptControl.sourceHighWaterSeq ||
          terminalEffect.sourceRunId !== promptControl.sourceRunId ||
          terminalEffect.sourceRefId !== promptControl.sourceRefId ||
          terminalEffect.sourceRefOrdinal !== promptControl.sourceRefOrdinal ||
          terminalEffect.sourceSegmentOrdinal !==
            promptControl.sourceSegmentOrdinal
        )
      ) {
        throw new SessionCompactionConflict(
          "Recovery compaction terminal effect crossed its prompt scope",
        );
      }
      if (
        run.kind !== "compaction" ||
        run.sessionId !== input.claim.context.sessionId ||
        run.executionScopeId !== input.claim.context.executionLineageId ||
        run.compactionScopeKind !== input.claim.context.scope.kind ||
        run.triggeredByRunId !== input.claim.context.source.runId
      ) {
        throw new SessionCompactionConflict(
          "Recovery compaction terminal run changed identity",
        );
      }
      if ((run.currentAttemptId === null) !== (run.currentLeaseId === null)) {
        throw new SessionCompactionConflict(
          "Recovery compaction terminal run has a partial attempt attachment",
        );
      }
      let attachedAttempt: typeof issueExecutionAttempts.$inferSelect | null = null;
      let attachedLease: typeof issueExecutionLeases.$inferSelect | null = null;
      if (run.currentAttemptId && run.currentLeaseId) {
        const attempts = await transaction
          .select()
          .from(issueExecutionAttempts)
          .where(
            and(
              eq(issueExecutionAttempts.id, run.currentAttemptId),
              eq(issueExecutionAttempts.companyId, input.claim.companyId),
              eq(issueExecutionAttempts.issueId, input.claim.issueId),
              eq(issueExecutionAttempts.sessionId, input.claim.context.sessionId),
              eq(issueExecutionAttempts.runId, input.claim.runId),
              eq(issueExecutionAttempts.runKind, "compaction"),
              eq(issueExecutionAttempts.promptKind, "compaction"),
              eq(issueExecutionAttempts.compactionControlId, input.claim.controlId),
            ),
          )
          .limit(2)
          .for("update");
        const leases = await transaction
          .select()
          .from(issueExecutionLeases)
          .where(
            and(
              eq(issueExecutionLeases.id, run.currentLeaseId),
              eq(issueExecutionLeases.companyId, input.claim.companyId),
              eq(issueExecutionLeases.issueId, input.claim.issueId),
              eq(issueExecutionLeases.runId, input.claim.runId),
              eq(issueExecutionLeases.attemptId, run.currentAttemptId),
            ),
          )
          .limit(2)
          .for("update");
        if (attempts.length !== 1 || leases.length !== 1) {
          throw new SessionCompactionConflict(
            "Recovery compaction terminal attachment disappeared",
          );
        }
        attachedAttempt = attempts[0]!;
        attachedLease = leases[0]!;
        if (
          attachedAttempt.attemptGeneration !== attachedLease.leaseGeneration
        ) {
          throw new SessionCompactionConflict(
            "Recovery compaction terminal attachment crossed generations",
          );
        }
      }
      const checkedAt = now();
      const decision = decideSessionCompactionTerminalRecovery({
        protocolSettlementState: promptControl.protocolSettlementState,
        effectKind: terminalEffectKind,
        failureKind:
          terminalEffect?.failedAssistantErrorKind ??
          promptControl.compactionFailureKind,
        attachedAttempt: attachedAttempt && attachedLease
          ? {
              state: attachedAttempt.state,
              leaseState: attachedLease.state,
              expiresAt: attachedLease.expiresAt,
            }
          : null,
        at: checkedAt,
      });
      if (decision.kind === "live") {
        if (
          run.terminalFinalizationId !== null ||
          run.status !== "running"
        ) {
          throw new SessionCompactionConflict(
            "Recovery compaction live attempt is not owned by a running run",
          );
        }
        return terminalEffect;
      }
      if (run.terminalFinalizationId !== null) {
        if (
          run.status !== decision.runStatus ||
          run.terminalReasonCode !== decision.terminalReasonCode
        ) {
          throw new SessionCompactionConflict(
            "Recovery compaction terminal retry changed finalization",
          );
        }
        return terminalEffect;
      }
      if (run.status !== "queued" && run.status !== "running") {
        throw new SessionCompactionConflict(
          "Recovery compaction cannot reconcile a non-active run",
        );
      }

      let finishedAt = promptControl.settledAt;
      if (!finishedAt) {
        throw new SessionCompactionConflict(
          "Terminal recovery compaction has no settlement timestamp",
        );
      }
      if (decision.expireAttachedAttempt) {
        if (!attachedAttempt || !attachedLease || run.status !== "running") {
          throw new SessionCompactionConflict(
            "Recovery compaction lost its expiring terminal attachment",
          );
        }
        const processFacts = await transaction
          .select()
          .from(issueExecutionProcessFacts)
          .where(
            and(
              eq(issueExecutionProcessFacts.companyId, input.claim.companyId),
              eq(issueExecutionProcessFacts.issueId, input.claim.issueId),
              eq(issueExecutionProcessFacts.runId, input.claim.runId),
              eq(issueExecutionProcessFacts.attemptId, attachedAttempt.id),
              eq(issueExecutionProcessFacts.leaseId, attachedLease.id),
            ),
          )
          .limit(2)
          .for("update");
        if (processFacts.length > 1) {
          throw new SessionCompactionConflict(
            "Recovery compaction terminal attempt owns multiple process facts",
          );
        }
        if (
          processFacts[0]?.state === "starting" ||
          processFacts[0]?.state === "running"
        ) {
          const lost = await transaction
            .update(issueExecutionProcessFacts)
            .set({ state: "lost", settledAt: checkedAt })
            .where(
              and(
                eq(issueExecutionProcessFacts.id, processFacts[0].id),
                inArray(issueExecutionProcessFacts.state, [
                  "starting",
                  "running",
                ]),
              ),
            )
            .returning({ id: issueExecutionProcessFacts.id });
          if (lost.length !== 1) {
            throw new SessionCompactionConflict(
              "Recovery compaction terminal process-loss fence failed",
            );
          }
        }
        const terminalAttempt = await transaction
          .update(issueExecutionAttempts)
          .set({
            state: decision.attemptTerminalState,
            finishedAt: checkedAt,
          })
          .where(
            and(
              eq(issueExecutionAttempts.id, attachedAttempt.id),
              eq(issueExecutionAttempts.state, "running"),
              eq(
                issueExecutionAttempts.attemptGeneration,
                attachedLease.leaseGeneration,
              ),
            ),
          )
          .returning({ id: issueExecutionAttempts.id });
        const expiredLease = await transaction
          .update(issueExecutionLeases)
          .set({ state: "expired", releasedAt: checkedAt })
          .where(
            and(
              eq(issueExecutionLeases.id, attachedLease.id),
              eq(issueExecutionLeases.attemptId, attachedAttempt.id),
              eq(
                issueExecutionLeases.leaseGeneration,
                attachedLease.leaseGeneration,
              ),
              eq(issueExecutionLeases.state, "active"),
              eq(issueExecutionLeases.expiresAt, attachedLease.expiresAt),
            ),
          )
          .returning({ id: issueExecutionLeases.id });
        if (terminalAttempt.length !== 1 || expiredLease.length !== 1) {
          throw new SessionCompactionConflict(
            "Recovery compaction terminal expiry lost its exact generation",
          );
        }
        await detachIssueExecutionRunAttemptInTransaction(transaction, {
          companyId: input.claim.companyId,
          issueId: input.claim.issueId,
          runId: input.claim.runId,
          expectedAttemptId: attachedAttempt.id,
          expectedLeaseId: attachedLease.id,
          at: checkedAt,
        });
        recoveredAttemptId = attachedAttempt.id;
        finishedAt = checkedAt;
      } else {
        const attempts = await transaction
          .select()
          .from(issueExecutionAttempts)
          .where(
            and(
              eq(issueExecutionAttempts.companyId, input.claim.companyId),
              eq(issueExecutionAttempts.issueId, input.claim.issueId),
              eq(issueExecutionAttempts.sessionId, input.claim.context.sessionId),
              eq(issueExecutionAttempts.runId, input.claim.runId),
              eq(issueExecutionAttempts.runKind, "compaction"),
              eq(issueExecutionAttempts.promptKind, "compaction"),
              eq(issueExecutionAttempts.compactionControlId, input.claim.controlId),
            ),
          )
          .orderBy(desc(issueExecutionAttempts.attemptGeneration))
          .limit(1)
          .for("update");
        const latestAttempt = attempts[0] ?? null;
        if (!latestAttempt) {
          if (
            run.status !== "queued" ||
            promptControl.protocolSettlementState !== "not_sent"
          ) {
            throw new SessionCompactionConflict(
              "Recovery compaction terminal run lost its attempt history",
            );
          }
        } else {
          const leases = await transaction
            .select()
            .from(issueExecutionLeases)
            .where(
              and(
                eq(issueExecutionLeases.companyId, input.claim.companyId),
                eq(issueExecutionLeases.issueId, input.claim.issueId),
                eq(issueExecutionLeases.runId, input.claim.runId),
                eq(issueExecutionLeases.attemptId, latestAttempt.id),
              ),
            )
            .limit(2)
            .for("update");
          const latestLease = leases[0];
          if (
            leases.length !== 1 ||
            !latestLease ||
            latestAttempt.state !== decision.attemptTerminalState ||
            latestAttempt.finishedAt === null ||
            latestLease.leaseGeneration !== latestAttempt.attemptGeneration ||
            latestLease.state === "active" ||
            latestLease.releasedAt === null
          ) {
            throw new SessionCompactionConflict(
              "Recovery compaction detached terminal attempt is incomplete",
            );
          }
        }
      }
      await options.finalizationWriter.finalizeInTransaction(transaction, {
        companyId: input.claim.companyId,
        issueId: input.claim.issueId,
        runId: input.claim.runId,
        status: decision.runStatus,
        terminalReasonCode: decision.terminalReasonCode,
        finishedAt,
      });
      return terminalEffect;
    });
    if (recoveredAttemptId) {
      const recovered = activeAttempts.get(recoveredAttemptId);
      recovered?.controller.abort("issue_session_compaction_lease_expired");
      activeAttempts.delete(recoveredAttemptId);
    }
    return effect;
  }

  async function existingResult(
    candidate: IssueSessionRecoveryCandidate,
    claim: ClaimedRecoveryCompaction,
  ): Promise<PreparedIssueSessionRecoveryView | null> {
    const effect = await reconcileTerminalCompactionRun({ claim });
    const checkpoint = effect?.kind === "checkpoint" ? effect : null;
    const failed = effect?.kind === "failed-compaction" ? effect : null;
    if (failed) {
      throw new SessionCompactionRecoveryRejected(
        failed.failedAssistantErrorKind ?? "Recovery compaction failed",
        "compaction_failed",
      );
    }
    if (!checkpoint) return null;
    const hydrated = await loadCheckpoint({
      companyId: candidate.identity.companyId,
      issueId: candidate.identity.issueId,
      sessionId: candidate.identity.sessionId,
      checkpointControlId: checkpoint.id,
      scopeKind: candidate.identity.scopeKind,
      scopeId: candidate.identity.scopeId,
      audience: candidate.identity.audience,
      sourceHighWaterSeq: candidate.identity.sourceHighWaterSeq,
    });
    return {
      checkpoint: hydrated,
      members: retainedMembers(candidate.members, hydrated.tailStartMessageId),
    };
  }

  async function createOrLoadCompaction(
    candidate: IssueSessionRecoveryCandidate,
    settings: SessionCompactionSettings,
    model: PersistedSessionCompactionModel,
    triggerModel: PersistedSessionCompactionModel,
  ): Promise<ClaimedRecoveryCompaction> {
    const identityDigest = recoveryIdentityDigest(candidate);
    return db.transaction(async (transaction) => {
      const lockExistingPrompt = () => transaction
        .select()
        .from(issueSessionCompactionControls)
        .where(
          and(
            eq(issueSessionCompactionControls.companyId, candidate.identity.companyId),
            eq(issueSessionCompactionControls.recoveryIdentityDigest, identityDigest),
            eq(issueSessionCompactionControls.kind, "recovery-prompt"),
          ),
        )
        .limit(2)
        .for("update");
      let existing = await lockExistingPrompt();
      if (existing.length > 1) {
        throw new SessionCompactionConflict(
          "Recovery identity owns multiple compaction prompts",
        );
      }
      const sourceRun = await lockIssueExecutionRunIfPresentInTransaction(
        transaction,
        {
          companyId: candidate.identity.companyId,
          issueId: candidate.identity.issueId,
          runId: candidate.identity.sourceRunId,
        },
      );
      if (
        !sourceRun ||
        (sourceRun.kind !== "productive" && sourceRun.kind !== "consult") ||
        sourceRun.sessionId !== candidate.identity.sessionId ||
        sourceRun.ownershipEpoch !== candidate.identity.ownershipEpoch ||
        sourceRun.targetAgentId !== candidate.identity.targetAgentId ||
        sourceRun.adapterConfigRevisionId !== candidate.prompt.identity.adapterConfigRevisionId ||
        sourceRun.executionWorkspaceBindingId !== candidate.prompt.identity.executionWorkspaceBindingId
      ) {
        throw new SessionCompactionRecoveryRejected(
          "Recovery source run changed before compaction admission",
          "source_changed",
        );
      }
      // A concurrent first admission cannot be visible until its source-run
      // lock commits. Re-read after that lock so creation remains idempotent
      // without reversing the established control -> source lock order for an
      // already admitted compaction.
      if (existing.length === 0) existing = await lockExistingPrompt();
      if (existing.length > 1) {
        throw new SessionCompactionConflict(
          "Recovery identity owns multiple compaction prompts",
        );
      }
      if (existing[0]) {
        const row = existing[0];
        if (!row.compactionRunId) {
          throw new SessionCompactionConflict(
            "Recovery prompt lost its compaction run",
          );
        }
        const context = sessionCompactionRunContextSchema.parse({
          version: "paperclip-recovery-compaction-run/v1",
          issueId: row.issueId,
          sessionId: row.sessionId,
          ownershipEpoch: sourceRun.ownershipEpoch,
          contextEpoch: row.contextEpoch,
          executionLineageId: row.executionLineageId,
          targetAgentId: sourceRun.targetAgentId,
          adapterConfigRevisionId: sourceRun.adapterConfigRevisionId,
          executionWorkspaceBindingId: sourceRun.executionWorkspaceBindingId,
          scope: {
            kind: row.historyScopeKind,
            id: row.historyScopeId,
            audience: row.audience,
            sourceHighWaterSeq: row.sourceHighWaterSeq,
          },
          source: {
            runId: row.sourceRunId,
            runKind: row.sourceRunKind,
            refId: row.sourceRefId,
            refOrdinal: row.sourceRefOrdinal,
            segmentOrdinal: row.sourceSegmentOrdinal,
            latestFinishedAssistantMessageId:
              row.latestFinishedAssistantMessageId,
          },
          settings: row.settingsSnapshot,
          model: row.modelSnapshot,
        });
        return {
          companyId: candidate.identity.companyId,
          issueId: candidate.identity.issueId,
          runId: row.compactionRunId,
          controlId: row.id,
          context,
          existing: true,
        };
      }
      const at = now();
      const created = await createIssueExecutionRunInTransaction(transaction, {
        kind: "compaction",
        companyId: candidate.identity.companyId,
        issueId: candidate.identity.issueId,
        sessionId: candidate.identity.sessionId,
        executionScopeId: candidate.identity.executionLineageId,
        ownershipEpoch: candidate.identity.ownershipEpoch,
        adapterConfigRevisionId: candidate.prompt.identity.adapterConfigRevisionId,
        executionWorkspaceBindingId: candidate.prompt.identity.executionWorkspaceBindingId,
        compactionScopeKind: candidate.identity.scopeKind,
        triggeredByRunId: candidate.identity.sourceRunId,
        at,
      });
      const controlId = idFactory();
      const context = sessionCompactionRunContextSchema.parse({
        version: "paperclip-recovery-compaction-run/v1",
        issueId: candidate.identity.issueId,
        sessionId: candidate.identity.sessionId,
        ownershipEpoch: candidate.identity.ownershipEpoch,
        contextEpoch: candidate.identity.contextEpoch,
        executionLineageId: candidate.identity.executionLineageId,
        targetAgentId: candidate.identity.targetAgentId,
        adapterConfigRevisionId: candidate.prompt.identity.adapterConfigRevisionId,
        executionWorkspaceBindingId: candidate.prompt.identity.executionWorkspaceBindingId,
        scope: {
          kind: candidate.identity.scopeKind,
          id: candidate.identity.scopeId,
          audience: candidate.identity.audience,
          sourceHighWaterSeq: candidate.identity.sourceHighWaterSeq,
        },
        source: {
          runId: candidate.identity.sourceRunId,
          runKind: candidate.prompt.identity.runKind,
          refId: candidate.identity.sourceRefId,
          refOrdinal: candidate.identity.sourceRefOrdinal,
          segmentOrdinal: candidate.identity.sourceSegmentOrdinal,
          latestFinishedAssistantMessageId:
            candidate.latestFinishedAssistantMessageId,
        },
        settings,
        model,
      });
      await transaction.insert(issueSessionCompactionControls).values({
        id: controlId,
        companyId: candidate.identity.companyId,
        issueId: candidate.identity.issueId,
        sessionId: candidate.identity.sessionId,
        seq: null,
        kind: "recovery-prompt",
        disposition: "active",
        historyScopeKind: candidate.identity.scopeKind,
        historyScopeId: candidate.identity.scopeId,
        audience: candidate.identity.audience,
        contextEpoch: candidate.identity.contextEpoch,
        executionLineageId: candidate.identity.executionLineageId,
        sourceHighWaterSeq: candidate.identity.sourceHighWaterSeq,
        latestFinishedAssistantMessageId:
          candidate.latestFinishedAssistantMessageId,
        sourceRunId: candidate.identity.sourceRunId,
        sourceRunKind: candidate.prompt.identity.runKind,
        sourceRefId: candidate.identity.sourceRefId,
        sourceRefOrdinal: candidate.identity.sourceRefOrdinal,
        sourceSegmentOrdinal: candidate.identity.sourceSegmentOrdinal,
        recoveryIdentityDigest: identityDigest,
        compactionRunId: created.run.runId,
        compactionRunKind: "compaction",
        promptTransmissionPhase: "not_transmitted",
        settingsSnapshot: settingsForDb(settings),
        modelSnapshot: { ...model },
        triggerModelSnapshot: { ...triggerModel },
        structuralPositions: null,
        createdAt: at,
      });
      return {
        companyId: candidate.identity.companyId,
        issueId: candidate.identity.issueId,
        runId: created.run.runId,
        controlId,
        context,
        existing: false,
      };
    });
  }

  async function markUnsettledInTransaction(transaction: Transaction, input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly state: "not_sent" | "incomplete";
    readonly failureKind: string;
    readonly at: Date;
  }): Promise<void> {
    const rows = await transaction
      .select()
      .from(issueSessionCompactionControls)
      .where(eq(issueSessionCompactionControls.id, input.claim.controlId))
      .limit(1)
      .for("update");
    const control = rows[0];
    if (!control || control.kind !== "recovery-prompt") {
      throw new SessionCompactionConflict(
        "Recovery compaction prompt disappeared before settlement",
      );
    }
    if (control.protocolSettlementState !== null) return;
    const expectedPhase = input.state === "not_sent"
      ? "not_transmitted"
      : "transmitted";
    if (control.promptTransmissionPhase !== expectedPhase) {
      throw new SessionCompactionConflict(
        "Recovery compaction prompt has an incompatible transmission phase",
      );
    }
    await transaction
      .update(issueSessionCompactionControls)
      .set({
        protocolSettlementState: input.state,
        promptSettlementReferenceId: deterministicUuid(
          "paperclip-recovery-compaction-unsettled",
          `${input.claim.controlId}:${input.state}`,
        ),
        settlementVersion: 1,
        settledAt: input.at,
        compactionFailureKind: input.failureKind.slice(0, 200),
      })
      .where(eq(issueSessionCompactionControls.id, input.claim.controlId));
  }

  async function startAttempt(
    claim: ClaimedRecoveryCompaction,
    candidate: IssueSessionRecoveryCandidate,
  ): Promise<CompactionAttempt> {
    const claimed = await db.transaction(async (transaction) => {
      let run = await lockIssueExecutionRunInTransaction(transaction, {
        companyId: claim.companyId,
        issueId: claim.issueId,
        runId: claim.runId,
      });
      if (
        run.kind !== "compaction" ||
        run.sessionId !== claim.context.sessionId ||
        run.executionScopeId !== claim.context.executionLineageId ||
        run.compactionScopeKind !== claim.context.scope.kind ||
        run.triggeredByRunId !== claim.context.source.runId ||
        run.adapterConfigRevisionId !==
          claim.context.adapterConfigRevisionId ||
        run.executionWorkspaceBindingId !==
          claim.context.executionWorkspaceBindingId ||
        run.cancellationIntentId !== null ||
        run.terminalFinalizationId !== null ||
        run.finishedAt !== null
      ) {
        throw new SessionCompactionConflict(
          "Recovery compaction run changed before attempt admission",
        );
      }
      const controlRows = await transaction
        .select()
        .from(issueSessionCompactionControls)
        .where(
          and(
            eq(issueSessionCompactionControls.id, claim.controlId),
            eq(issueSessionCompactionControls.companyId, claim.companyId),
            eq(issueSessionCompactionControls.issueId, claim.issueId),
            eq(issueSessionCompactionControls.sessionId, claim.context.sessionId),
            eq(issueSessionCompactionControls.kind, "recovery-prompt"),
            eq(issueSessionCompactionControls.compactionRunId, claim.runId),
          ),
        )
        .limit(2)
        .for("update");
      const control = controlRows[0];
      if (
        controlRows.length !== 1 ||
        !control ||
        control.protocolSettlementState !== null
      ) {
        throw new SessionCompactionConflict(
          "Recovery compaction cannot start after prompt settlement",
        );
      }
      let at = now();
      let recoveredAttemptId: string | null = null;
      if (run.status === "queued") {
        if (run.currentAttemptId !== null || run.currentLeaseId !== null) {
          throw new SessionCompactionConflict(
            "Queued recovery compaction already owns an attempt",
          );
        }
        run = await transitionIssueExecutionRunStatusInTransaction(
          transaction,
          {
            companyId: claim.companyId,
            issueId: claim.issueId,
            runId: claim.runId,
            expectedStatus: "queued",
            status: "running",
            startedAt: at,
            at,
          },
        );
      } else if (run.status === "running") {
        if ((run.currentAttemptId === null) !== (run.currentLeaseId === null)) {
          throw new SessionCompactionConflict(
            "Recovery compaction has a partial attempt attachment",
          );
        }
        if (run.currentAttemptId && run.currentLeaseId) {
          const previousAttempts = await transaction
            .select()
            .from(issueExecutionAttempts)
            .where(
              and(
                eq(issueExecutionAttempts.id, run.currentAttemptId),
                eq(issueExecutionAttempts.companyId, claim.companyId),
                eq(issueExecutionAttempts.issueId, claim.issueId),
                eq(issueExecutionAttempts.sessionId, claim.context.sessionId),
                eq(issueExecutionAttempts.runId, claim.runId),
                eq(issueExecutionAttempts.runKind, "compaction"),
                eq(issueExecutionAttempts.promptKind, "compaction"),
                eq(issueExecutionAttempts.compactionControlId, claim.controlId),
              ),
            )
            .limit(2)
            .for("update");
          const previousLeases = await transaction
            .select()
            .from(issueExecutionLeases)
            .where(
              and(
                eq(issueExecutionLeases.id, run.currentLeaseId),
                eq(issueExecutionLeases.companyId, claim.companyId),
                eq(issueExecutionLeases.issueId, claim.issueId),
                eq(issueExecutionLeases.runId, claim.runId),
                eq(issueExecutionLeases.attemptId, run.currentAttemptId),
              ),
            )
            .limit(2)
            .for("update");
          const previousAttempt = previousAttempts[0];
          const previousLease = previousLeases[0];
          at = now();
          if (
            previousAttempts.length !== 1 ||
            previousLeases.length !== 1 ||
            !previousAttempt ||
            !previousLease ||
            previousAttempt.state !== "running" ||
            previousLease.state !== "active" ||
            previousLease.attemptId !== previousAttempt.id ||
            previousLease.leaseGeneration !==
              previousAttempt.attemptGeneration
          ) {
            throw new SessionCompactionConflict(
              "Recovery compaction current attempt is not an exact live pair",
            );
          }
          if (previousLease.expiresAt > at) {
            throw new SessionCompactionConflict(
              "Recovery compaction already has an unexpired active attempt",
            );
          }
          const processFacts = await transaction
            .select()
            .from(issueExecutionProcessFacts)
            .where(
              and(
                eq(issueExecutionProcessFacts.companyId, claim.companyId),
                eq(issueExecutionProcessFacts.issueId, claim.issueId),
                eq(issueExecutionProcessFacts.runId, claim.runId),
                eq(issueExecutionProcessFacts.attemptId, previousAttempt.id),
                eq(issueExecutionProcessFacts.leaseId, previousLease.id),
              ),
            )
            .limit(2)
            .for("update");
          if (processFacts.length > 1) {
            throw new SessionCompactionConflict(
              "Recovery compaction attempt owns multiple process facts",
            );
          }
          if (
            processFacts[0]?.state === "starting" ||
            processFacts[0]?.state === "running"
          ) {
            const lost = await transaction
              .update(issueExecutionProcessFacts)
              .set({ state: "lost", settledAt: at })
              .where(
                and(
                  eq(issueExecutionProcessFacts.id, processFacts[0].id),
                  inArray(issueExecutionProcessFacts.state, [
                    "starting",
                    "running",
                  ]),
                ),
              )
              .returning({ id: issueExecutionProcessFacts.id });
            if (lost.length !== 1) {
              throw new SessionCompactionConflict(
                "Recovery compaction process-loss transition lost its fence",
              );
            }
          }
          const failed = await transaction
            .update(issueExecutionAttempts)
            .set({ state: "failed", finishedAt: at })
            .where(
              and(
                eq(issueExecutionAttempts.id, previousAttempt.id),
                eq(issueExecutionAttempts.state, "running"),
                eq(
                  issueExecutionAttempts.attemptGeneration,
                  previousLease.leaseGeneration,
                ),
              ),
            )
            .returning({ id: issueExecutionAttempts.id });
          const expired = await transaction
            .update(issueExecutionLeases)
            .set({ state: "expired", releasedAt: at })
            .where(
              and(
                eq(issueExecutionLeases.id, previousLease.id),
                eq(issueExecutionLeases.attemptId, previousAttempt.id),
                eq(
                  issueExecutionLeases.leaseGeneration,
                  previousLease.leaseGeneration,
                ),
                eq(issueExecutionLeases.state, "active"),
              ),
            )
            .returning({ id: issueExecutionLeases.id });
          if (failed.length !== 1 || expired.length !== 1) {
            throw new SessionCompactionConflict(
              "Recovery compaction expired-attempt transition lost its fence",
            );
          }
          await detachIssueExecutionRunAttemptInTransaction(transaction, {
            companyId: claim.companyId,
            issueId: claim.issueId,
            runId: claim.runId,
            expectedAttemptId: previousAttempt.id,
            expectedLeaseId: previousLease.id,
            at,
          });
          recoveredAttemptId = previousAttempt.id;
          if (control.promptTransmissionPhase === "transmitted") {
            const requestMessageId = await reserveIssueSessionMessageId(
              transaction,
              {
                companyId: claim.companyId,
                issueId: claim.issueId,
                sessionId: claim.context.sessionId,
              },
              `recovery-compaction:${claim.controlId}:request`,
            );
            await publishUnsettledFailureInTransaction(transaction, {
              claim,
              candidate,
              requestMessageId,
              state: "incomplete",
              failureKind: "compaction_attempt_lease_expired",
              partialText: "",
              at,
            });
            await options.finalizationWriter.finalizeInTransaction(
              transaction,
              {
                companyId: claim.companyId,
                issueId: claim.issueId,
                runId: claim.runId,
                status: "failed",
                terminalReasonCode: "compaction_attempt_lease_expired",
                finishedAt: at,
              },
            );
            return {
              kind: "expired_transmitted" as const,
              recoveredAttemptId,
              at,
            };
          }
          if (control.promptTransmissionPhase !== "not_transmitted") {
            throw new SessionCompactionConflict(
              "Recovery compaction has an unknown prompt transmission phase",
            );
          }
        }
      } else {
        throw new SessionCompactionConflict(
          "Recovery compaction run is not attempt-admissible",
        );
      }

      const previousGenerations = await transaction
        .select({ generation: issueExecutionAttempts.attemptGeneration })
        .from(issueExecutionAttempts)
        .where(
          and(
            eq(issueExecutionAttempts.companyId, claim.companyId),
            eq(issueExecutionAttempts.issueId, claim.issueId),
            eq(issueExecutionAttempts.runId, claim.runId),
            eq(issueExecutionAttempts.runKind, "compaction"),
            eq(issueExecutionAttempts.promptKind, "compaction"),
            eq(issueExecutionAttempts.compactionControlId, claim.controlId),
          ),
        )
        .orderBy(desc(issueExecutionAttempts.attemptGeneration))
        .limit(1)
        .for("update");
      const leaseGeneration =
        (previousGenerations[0]?.generation ?? 0) + 1;
      const attemptId = idFactory();
      const leaseId = idFactory();
      const controller = new AbortController();
      const cancellation = Object.freeze({
        companyId: claim.companyId,
        issueId: claim.issueId,
        sessionId: claim.context.sessionId,
        executionScopeId: claim.context.executionLineageId,
        runId: claim.runId,
        attemptId,
        leaseGeneration,
      });
      const attempt = Object.freeze({
        attemptId,
        leaseId,
        leaseGeneration,
        cancellation,
        controller,
      });
      await transaction.insert(issueExecutionAttempts).values({
        id: attemptId,
        companyId: claim.companyId,
        issueId: claim.issueId,
        sessionId: claim.context.sessionId,
        runId: claim.runId,
        runKind: "compaction",
        promptKind: "compaction",
        compactionControlId: claim.controlId,
        sessionOperation: "new",
        attemptGeneration: leaseGeneration,
        state: "running",
        startedAt: at,
        createdAt: at,
      });
      await transaction.insert(issueExecutionLeases).values({
        id: leaseId,
        companyId: claim.companyId,
        issueId: claim.issueId,
        runId: claim.runId,
        attemptId,
        leaseGeneration,
        workerId,
        state: "active",
        acquiredAt: at,
        expiresAt: new Date(at.getTime() + leaseDurationMs),
        createdAt: at,
      });
      await attachIssueExecutionRunAttemptInTransaction(transaction, {
        companyId: claim.companyId,
        issueId: claim.issueId,
        runId: claim.runId,
        attemptId,
        leaseId,
        at,
      });
      return {
        kind: "attempt" as const,
        attempt,
        recoveredAttemptId,
      };
    });
    if (claimed.recoveredAttemptId) {
      const recovered = activeAttempts.get(claimed.recoveredAttemptId);
      recovered?.controller.abort("issue_session_compaction_lease_expired");
      activeAttempts.delete(claimed.recoveredAttemptId);
    }
    if (claimed.kind === "expired_transmitted") {
      throw new SessionCompactionRecoveryRejected(
        "Recovery compaction lost its worker after prompt transmission",
        "compaction_failed",
      );
    }
    activeAttempts.set(claimed.attempt.attemptId, {
      cancellation: claimed.attempt.cancellation,
      controller: claimed.attempt.controller,
    });
    return claimed.attempt;
  }

  async function markTransmissionBegan(
    claim: ClaimedRecoveryCompaction,
    attempt: CompactionAttempt,
  ): Promise<void> {
    await db.transaction(async (transaction) => {
      await lockExactActiveAttemptInTransaction(transaction, {
        claim,
        attempt,
      });
      const at = now();
      const updated = await transaction
        .update(issueSessionCompactionControls)
        .set({ promptTransmissionPhase: "transmitted" })
        .where(
          and(
            eq(issueSessionCompactionControls.id, claim.controlId),
            eq(issueSessionCompactionControls.companyId, claim.companyId),
            eq(issueSessionCompactionControls.issueId, claim.issueId),
            eq(issueSessionCompactionControls.kind, "recovery-prompt"),
            eq(issueSessionCompactionControls.compactionRunId, claim.runId),
            eq(issueSessionCompactionControls.promptTransmissionPhase, "not_transmitted"),
            isNull(issueSessionCompactionControls.protocolSettlementState),
          ),
        )
        .returning({ id: issueSessionCompactionControls.id });
      if (updated.length !== 1) {
        throw new SessionCompactionConflict(
          "Recovery compaction prompt lost its transmission fence",
        );
      }
    });
  }

  function publicationEnvelope(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly candidate: IssueSessionRecoveryCandidate;
    readonly sourceKind: string;
    readonly sourceId: string;
    readonly sourceRecordId: string;
    readonly at: Date;
  }) {
    const immutableSourceKey = [
      input.sourceKind,
      input.claim.runId,
      input.claim.controlId,
      input.sourceId,
    ].join(":");
    return {
      companyId: input.claim.companyId,
      issueId: input.claim.issueId,
      runId: input.claim.runId,
      ownershipEpoch: input.candidate.identity.ownershipEpoch,
      agentId: input.candidate.identity.targetAgentId,
      adapterConfigRevisionId:
        input.candidate.prompt.identity.adapterConfigRevisionId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      sourceIdentityDigest: sha256(immutableSourceKey),
      createdAt: input.at,
    };
  }

  function compactionEffectBase(
    claim: ClaimedRecoveryCompaction,
    at: Date,
  ) {
    return {
      disposition: "active" as const,
      invalidatedAt: null,
      invalidatedByRevertEventId: null,
      invalidatedBoundaryMessageId: null,
      invalidatedBoundarySeq: null,
      historyScopeKind: claim.context.scope.kind,
      historyScopeId: claim.context.scope.id,
      audience: claim.context.scope.audience,
      contextEpoch: claim.context.contextEpoch,
      executionLineageId: claim.context.executionLineageId,
      sourceHighWaterSeq: claim.context.scope.sourceHighWaterSeq,
      latestFinishedAssistantMessageId:
        claim.context.source.latestFinishedAssistantMessageId,
      sourceRunId: claim.context.source.runId,
      sourceRunKind: claim.context.source.runKind,
      sourceRefId: claim.context.source.refId,
      sourceRefOrdinal: claim.context.source.refOrdinal,
      sourceSegmentOrdinal: claim.context.source.segmentOrdinal,
      recoveryIdentityDigest: null,
      assistantMessageId: null,
      toolId: null,
      prunedAt: null,
      replayMessageId: null,
      continuationMessageId: null,
      postCheckpointAction: "none" as const,
      compactionRunId: claim.runId,
      compactionRunKind: "compaction" as const,
      promptTransmissionPhase: null,
      protocolSettlementState: null,
      promptSettlementReferenceId: null,
      accountingId: null,
      costEventId: null,
      settlementVersion: 0,
      settledAt: null,
      compactionFailureKind: null,
      structuralPositions: [],
      settingsSnapshot: null,
      modelSnapshot: null,
      triggerModelSnapshot: null,
      createdAt: at,
    };
  }

  async function publishCompactionStarted(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly candidate: IssueSessionRecoveryCandidate;
    readonly attempt: CompactionAttempt;
    readonly prunes: readonly RecoveryToolPrune[];
    readonly at: Date;
  }): Promise<string> {
    return db.transaction(async (transaction) => {
      await lockExactActiveAttemptInTransaction(transaction, {
        claim: input.claim,
        attempt: input.attempt,
      });
      const control = await transaction
        .select({
          phase: issueSessionCompactionControls.promptTransmissionPhase,
          settlement: issueSessionCompactionControls.protocolSettlementState,
        })
        .from(issueSessionCompactionControls)
        .where(
          and(
            eq(issueSessionCompactionControls.id, input.claim.controlId),
            eq(issueSessionCompactionControls.companyId, input.claim.companyId),
            eq(issueSessionCompactionControls.issueId, input.claim.issueId),
            eq(issueSessionCompactionControls.kind, "recovery-prompt"),
            eq(issueSessionCompactionControls.compactionRunId, input.claim.runId),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !control ||
        control.phase !== "not_transmitted" ||
        control.settlement !== null
      ) {
        throw new SessionCompactionConflict(
          "Recovery compaction request lost its unpublished prompt fence",
        );
      }
      const requestMessageId = await reserveIssueSessionMessageId(
        transaction,
        {
          companyId: input.claim.companyId,
          issueId: input.claim.issueId,
          sessionId: input.claim.context.sessionId,
        },
        `recovery-compaction:${input.claim.controlId}:request`,
      );
      const existingRequestRows = await transaction
        .select()
        .from(issueSessionMessages)
        .where(
          and(
            eq(issueSessionMessages.companyId, input.claim.companyId),
            eq(issueSessionMessages.issueId, input.claim.issueId),
            eq(issueSessionMessages.sessionId, input.claim.context.sessionId),
            eq(issueSessionMessages.id, requestMessageId),
          ),
        )
        .limit(2)
        .for("update");
      if (existingRequestRows.length > 1) {
        throw new SessionCompactionConflict(
          "Recovery compaction request marker is duplicated",
        );
      }
      if (existingRequestRows[0]) {
        const existingRequest = decodeStoredIssueSessionMessage(
          existingRequestRows[0],
        );
        const compaction = record(
          paperclipMetadata(existingRequest).compaction,
        );
        if (
          existingRequest.type !== "user" ||
          compaction.version !== "paperclip-session-compaction/v1" ||
          compaction.trigger !== "recovery" ||
          compaction.role !== "request-marker" ||
          compaction.runID !== input.claim.runId ||
          compaction.controlID !== input.claim.controlId
        ) {
          throw new SessionCompactionConflict(
            "Recovery compaction request marker changed across pre-send retry",
          );
        }
        return requestMessageId;
      }
      const { seq } = await reserveIssueSessionEventSequence(transaction, {
        companyId: input.claim.companyId,
        issueId: input.claim.issueId,
        sessionId: input.claim.context.sessionId,
      });
      const eventId = `evt_${sha256(`${input.claim.controlId}:started`).slice(0, 40)}`;
      await publishIssueSessionEventInTx(transaction, {
        event: {
          id: eventId,
          sessionId: input.claim.context.sessionId,
          seq,
          type: "session.next.compaction.started",
          data: {
            sessionID: input.claim.context.sessionId,
            messageID: requestMessageId,
            timestamp: input.at.getTime(),
            reason: "auto",
          },
        },
        envelope: publicationEnvelope({
          ...input,
          sourceKind: "recovery_compaction_started",
          sourceId: input.claim.controlId,
          sourceRecordId: input.claim.controlId,
        }),
      });
      for (const prune of input.prunes) {
        await publishIssueSessionToolPrunedEffectInTx(transaction, {
          ...compactionEffectBase(input.claim, input.at),
          id: deterministicUuid(
            "paperclip-recovery-tool-pruned",
            [
              input.claim.context.scope.kind,
              input.claim.context.scope.id,
              input.claim.context.scope.sourceHighWaterSeq,
              prune.assistantMessageId,
              prune.toolId,
            ].join(":"),
          ),
          companyId: input.claim.companyId,
          issueId: input.claim.issueId,
          sessionId: input.claim.context.sessionId,
          seq,
          kind: "tool-pruned",
          compactionRequestMessageId: null,
          summaryAssistantMessageId: null,
          failedAssistantMessageId: null,
          failedAssistantErrorKind: null,
          assistantMessageId: prune.assistantMessageId,
          toolId: prune.toolId,
          prunedAt: prune.compactedAt,
          tailStartMessageId: null,
          compactionRunId: null,
          structuralPositions: null,
        });
      }
      return requestMessageId;
    });
  }

  async function publishProtocolSettledResult(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly candidate: IssueSessionRecoveryCandidate;
    readonly attempt: CompactionAttempt;
    readonly requestMessageId: string;
    readonly result: SessionCompactionSummaryResult;
    readonly plan: RecoveryCompactionPlan;
    readonly at: Date;
  }): Promise<{
    readonly checkpointControlId: string | null;
    readonly failureKind: string | null;
    readonly budgetSuspensionScopes: Awaited<
      ReturnType<typeof settleAcpPromptInTransaction>
    >["budgetSuspensionScopes"];
  }> {
    const summaryText = input.result.text.trim();
    const failureKind =
      summaryText.length === 0
        ? "empty_summary"
        : input.result.settlement.stopReason === "end_turn"
          ? null
          : `terminal_${input.result.settlement.stopReason}`;
    const result = await db.transaction(async (transaction) => {
      await lockExactActiveAttemptInTransaction(transaction, {
        claim: input.claim,
        attempt: input.attempt,
      });
      const assistantMessageId = await reserveIssueSessionMessageId(
        transaction,
        {
          companyId: input.claim.companyId,
          issueId: input.claim.issueId,
          sessionId: input.claim.context.sessionId,
        },
        `recovery-compaction:${input.claim.controlId}:result`,
      );
      const endedSequence = await reserveIssueSessionEventSequence(
        transaction,
        {
          companyId: input.claim.companyId,
          issueId: input.claim.issueId,
          sessionId: input.claim.context.sessionId,
        },
      );
      const stepSequence = await reserveIssueSessionEventSequence(
        transaction,
        {
          companyId: input.claim.companyId,
          issueId: input.claim.issueId,
          sessionId: input.claim.context.sessionId,
        },
      );
      const effectId = deterministicUuid(
        failureKind === null
          ? "paperclip-recovery-compaction-checkpoint"
          : "paperclip-recovery-compaction-failed",
        input.claim.controlId,
      );
      const projection = failureKind === null
        ? {
            ...compactionEffectBase(input.claim, input.at),
            id: effectId,
            kind: "checkpoint" as const,
            compactionRequestMessageId: input.requestMessageId,
            summaryAssistantMessageId: assistantMessageId,
            failedAssistantMessageId: null,
            failedAssistantErrorKind: null,
            tailStartMessageId: input.plan.tailStartMessageId,
          }
        : {
            ...compactionEffectBase(input.claim, input.at),
            id: effectId,
            kind: "failed-compaction" as const,
            compactionRequestMessageId: input.requestMessageId,
            summaryAssistantMessageId: null,
            failedAssistantMessageId: assistantMessageId,
            failedAssistantErrorKind: failureKind.slice(0, 200),
            tailStartMessageId: null,
          };
      const endedEventId = `evt_${sha256(`${input.claim.controlId}:ended`).slice(0, 40)}`;
      await publishIssueSessionEventInTx(transaction, {
        event: {
          id: endedEventId,
          sessionId: input.claim.context.sessionId,
          seq: endedSequence.seq,
          type: "session.next.compaction.ended",
          data: {
            sessionID: input.claim.context.sessionId,
            messageID: assistantMessageId,
            timestamp: input.at.getTime(),
            reason: "auto",
            text: input.result.text,
            recent: "",
          },
        },
        envelope: publicationEnvelope({
          claim: input.claim,
          candidate: input.candidate,
          sourceKind: "recovery_compaction_ended",
          sourceId: effectId,
          sourceRecordId: effectId,
          at: input.at,
        }),
        projection: { compactionControl: projection },
      });
      const settled = await settleAcpPromptInTransaction(transaction, {
        identity: {
          companyId: input.claim.companyId,
          issueId: input.claim.issueId,
          sessionId: input.claim.context.sessionId,
          agentId: input.candidate.identity.targetAgentId,
          runId: input.claim.runId,
          runKind: "compaction",
          promptKind: "compaction",
          compactionControlId: input.claim.controlId,
          attemptId: input.attempt.attemptId,
          adapterConfigRevisionId:
            input.candidate.prompt.identity.adapterConfigRevisionId,
        },
        settlement: input.result.settlement,
        promptSettlementReferenceId: deterministicUuid(
          "paperclip-recovery-compaction-settlement",
          input.claim.controlId,
        ),
        terminalUsageReference:
          `recovery-compaction:${input.claim.controlId}:terminal-usage`,
        terminalStopReference:
          `recovery-compaction:${input.claim.controlId}:terminal-stop`,
        stepEnded: {
          eventId: `evt_${sha256(`${input.claim.controlId}:step-ended`).slice(0, 40)}`,
          eventSeq: stepSequence.seq,
          assistantMessageId,
          ...(failureKind === null
            ? {}
            : { sourceAssistantErrorKind: "other" as const }),
        },
        settledAt: input.at,
      });
      if (failureKind !== null) {
        await options.blockedPromptFailure.failBlockedPromptInTransaction(
          transaction,
          {
            candidate: input.candidate,
            compactionRunId: input.claim.runId,
            compactionControlId: input.claim.controlId,
            reason: "recovery_compaction_failed",
            at: input.at,
          },
        );
      }
      return {
        checkpointControlId: failureKind === null ? effectId : null,
        failureKind,
        budgetSuspensionScopes: settled.budgetSuspensionScopes,
      };
    });
    return result;
  }

  async function publishUnsettledFailureInTransaction(
    transaction: Transaction,
    input: {
      readonly claim: ClaimedRecoveryCompaction;
      readonly candidate: IssueSessionRecoveryCandidate;
      readonly requestMessageId: string;
      readonly state: "not_sent" | "incomplete";
      readonly failureKind: string;
      readonly partialText: string;
      readonly at: Date;
    },
  ): Promise<void> {
    const assistantMessageId = await reserveIssueSessionMessageId(
      transaction,
      {
        companyId: input.claim.companyId,
        issueId: input.claim.issueId,
        sessionId: input.claim.context.sessionId,
      },
      `recovery-compaction:${input.claim.controlId}:result`,
    );
    const { seq } = await reserveIssueSessionEventSequence(transaction, {
      companyId: input.claim.companyId,
      issueId: input.claim.issueId,
      sessionId: input.claim.context.sessionId,
    });
    const effectId = deterministicUuid(
      "paperclip-recovery-compaction-failed",
      input.claim.controlId,
    );
    const failureKind = input.failureKind.slice(0, 200);
    await publishIssueSessionEventInTx(transaction, {
      event: {
        id: `evt_${sha256(`${input.claim.controlId}:ended`).slice(0, 40)}`,
        sessionId: input.claim.context.sessionId,
        seq,
        type: "session.next.compaction.ended",
        data: {
          sessionID: input.claim.context.sessionId,
          messageID: assistantMessageId,
          timestamp: input.at.getTime(),
          reason: "auto",
          text: input.partialText,
          recent: "",
        },
      },
      envelope: publicationEnvelope({
        claim: input.claim,
        candidate: input.candidate,
        sourceKind: "recovery_compaction_failed",
        sourceId: effectId,
        sourceRecordId: effectId,
        at: input.at,
      }),
      projection: {
        compactionControl: {
          ...compactionEffectBase(input.claim, input.at),
          id: effectId,
          kind: "failed-compaction",
          compactionRequestMessageId: input.requestMessageId,
          summaryAssistantMessageId: null,
          failedAssistantMessageId: assistantMessageId,
          failedAssistantErrorKind: failureKind,
          tailStartMessageId: null,
        },
      },
      companions: {
        assistantSource: {
          assistantMessageId,
          sourceAssistantErrorKind: "other",
          createdAt: input.at,
        },
      },
    });
    await markUnsettledInTransaction(transaction, {
      claim: input.claim,
      state: input.state,
      failureKind,
      at: input.at,
    });
    await options.blockedPromptFailure.failBlockedPromptInTransaction(
      transaction,
      {
        candidate: input.candidate,
        compactionRunId: input.claim.runId,
        compactionControlId: input.claim.controlId,
        reason: "recovery_compaction_failed",
        at: input.at,
      },
    );
  }

  async function publishUnsettledFailure(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly candidate: IssueSessionRecoveryCandidate;
    readonly attempt: CompactionAttempt;
    readonly requestMessageId: string;
    readonly state: "not_sent" | "incomplete";
    readonly failureKind: string;
    readonly partialText: string;
    readonly at: Date;
  }): Promise<void> {
    await db.transaction(async (transaction) => {
      await lockExactActiveAttemptInTransaction(transaction, {
        claim: input.claim,
        attempt: input.attempt,
      });
      await publishUnsettledFailureInTransaction(transaction, input);
    });
  }

  async function finishAttempt(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly attempt: CompactionAttempt;
    readonly state: "settled" | "failed";
    readonly at: Date;
  }): Promise<boolean> {
    return db.transaction(async (transaction) => {
      const run = await lockIssueExecutionRunInTransaction(transaction, {
        companyId: input.claim.companyId,
        issueId: input.claim.issueId,
        runId: input.claim.runId,
      });
      if (run.cancellationIntentId !== null) return false;
      await lockExactActiveAttemptInTransaction(transaction, {
        claim: input.claim,
        attempt: input.attempt,
      });
      const finished = await transaction
        .update(issueExecutionAttempts)
        .set({ state: input.state, finishedAt: input.at })
        .where(
          and(
            eq(issueExecutionAttempts.id, input.attempt.attemptId),
            eq(issueExecutionAttempts.companyId, input.claim.companyId),
            eq(issueExecutionAttempts.issueId, input.claim.issueId),
            eq(issueExecutionAttempts.runId, input.claim.runId),
            eq(
              issueExecutionAttempts.attemptGeneration,
              input.attempt.leaseGeneration,
            ),
            eq(issueExecutionAttempts.state, "running"),
          ),
        )
        .returning({ id: issueExecutionAttempts.id });
      const released = await transaction
        .update(issueExecutionLeases)
        .set({ state: "released", releasedAt: input.at })
        .where(
          and(
            eq(issueExecutionLeases.id, input.attempt.leaseId),
            eq(issueExecutionLeases.companyId, input.claim.companyId),
            eq(issueExecutionLeases.issueId, input.claim.issueId),
            eq(issueExecutionLeases.runId, input.claim.runId),
            eq(issueExecutionLeases.attemptId, input.attempt.attemptId),
            eq(
              issueExecutionLeases.leaseGeneration,
              input.attempt.leaseGeneration,
            ),
            eq(issueExecutionLeases.workerId, workerId),
            eq(issueExecutionLeases.state, "active"),
          ),
        )
        .returning({ id: issueExecutionLeases.id });
      if (finished.length !== 1 || released.length !== 1) {
        throw new SessionCompactionAttemptFenceLost(
          "Recovery compaction attempt settlement lost its exact generation",
        );
      }
      await detachIssueExecutionRunAttemptInTransaction(transaction, {
        companyId: input.claim.companyId,
        issueId: input.claim.issueId,
        runId: input.claim.runId,
        expectedAttemptId: input.attempt.attemptId,
        expectedLeaseId: input.attempt.leaseId,
        at: input.at,
      });
      return true;
    });
  }

  async function finalizeRun(input: {
    readonly claim: ClaimedRecoveryCompaction;
    readonly status: "succeeded" | "failed";
    readonly reason: string;
    readonly at: Date;
  }): Promise<void> {
    await options.finalizationWriter.finalize({
      companyId: input.claim.companyId,
      issueId: input.claim.issueId,
      runId: input.claim.runId,
      status: input.status,
      terminalReasonCode: input.reason.slice(0, 200),
      finishedAt: input.at,
    });
  }

  async function loadCheckpoint(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sessionId: string;
    readonly checkpointControlId: string;
    readonly scopeKind: "comments-recovery" | "turns-recovery";
    readonly scopeId: string;
    readonly audience: "comments" | "turns";
    readonly sourceHighWaterSeq: number;
  }): Promise<IssueSessionRecoveryCheckpoint> {
    const control = await db
      .select()
      .from(issueSessionCompactionControls)
      .where(
        and(
          eq(issueSessionCompactionControls.id, input.checkpointControlId),
          eq(issueSessionCompactionControls.companyId, input.companyId),
          eq(issueSessionCompactionControls.issueId, input.issueId),
          eq(issueSessionCompactionControls.sessionId, input.sessionId),
          eq(issueSessionCompactionControls.kind, "checkpoint"),
          eq(issueSessionCompactionControls.disposition, "active"),
          eq(issueSessionCompactionControls.historyScopeKind, input.scopeKind),
          eq(issueSessionCompactionControls.historyScopeId, input.scopeId),
          eq(issueSessionCompactionControls.audience, input.audience),
          eq(issueSessionCompactionControls.sourceHighWaterSeq, input.sourceHighWaterSeq),
        ),
      )
      .limit(2);
    if (control.length !== 1 || !control[0]!.summaryAssistantMessageId) {
      throw new SessionCompactionConflict(
        "Recovery checkpoint is missing or outside the pinned scope",
      );
    }
    const summary = await db
      .select()
      .from(issueSessionMessages)
      .where(
        and(
          eq(issueSessionMessages.companyId, input.companyId),
          eq(issueSessionMessages.issueId, input.issueId),
          eq(issueSessionMessages.sessionId, input.sessionId),
          eq(issueSessionMessages.id, control[0]!.summaryAssistantMessageId),
        ),
      )
      .limit(2);
    if (summary.length !== 1) {
      throw new SessionCompactionConflict(
        "Recovery checkpoint assistant is missing",
      );
    }
    return summaryCheckpoint({
      control: control[0]!,
      summary: decodeStoredIssueSessionMessage(summary[0]!),
    });
  }

  async function prepare(
    candidate: IssueSessionRecoveryCandidate,
  ): Promise<PreparedIssueSessionRecoveryView> {
    if (!candidate.prompt.carryContext) {
      throw new SessionCompactionConflict(
        "False-carry prompt entered recovery compaction",
      );
    }
    if (
      (candidate.depth === "turns" &&
        (candidate.identity.scopeKind !== "turns-recovery" ||
          candidate.identity.audience !== "turns")) ||
      (candidate.depth === "thread" &&
        (candidate.identity.scopeKind !== "comments-recovery" ||
          candidate.identity.audience !== "comments"))
    ) {
      throw new SessionCompactionConflict(
        "Recovery depth crossed its scope or audience",
      );
    }
    const loaded = await loadMessages(candidate);
    const resolved = await resolveModelAndSettings(candidate);
    let plan = await planIssueSessionRecoveryCompaction({
      messages: loaded.messages,
      settings: resolved.settings,
      model: resolved.model,
    });
    if (!plan.overLimit) {
      return { checkpoint: null, members: candidate.members };
    }
    if (resolved.settings.auto === false) {
      throw new SessionCompactionRecoveryRejected(
        `Authorized recovery history uses ${plan.tokenCount} tokens but only ${plan.usableTokens} are usable and automatic recovery compaction is disabled`,
        "auto_disabled",
      );
    }
    const claim = await createOrLoadCompaction(
      candidate,
      resolved.settings,
      resolved.model,
      resolved.triggerModel,
    );
    const existingControl = await db
      .select()
      .from(issueSessionCompactionControls)
      .where(eq(issueSessionCompactionControls.id, claim.controlId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!existingControl) {
      throw new SessionCompactionConflict("Recovery compaction control disappeared");
    }
    const prior = await existingResult(candidate, claim);
    if (prior) return prior;
    if (existingControl.protocolSettlementState !== null) {
      throw new SessionCompactionRecoveryRejected(
        existingControl.compactionFailureKind ?? "Recovery compaction did not produce a checkpoint",
        "compaction_failed",
      );
    }
    const projectId = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, candidate.identity.companyId),
          eq(issues.id, candidate.identity.issueId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]?.projectId ?? null);
    const block = await budgets.getInvocationBlock(
      candidate.identity.companyId,
      candidate.identity.targetAgentId,
      { issueId: candidate.identity.issueId, projectId },
    );
    if (block) {
      const at = now();
      await db.transaction(async (transaction) => {
        await markUnsettledInTransaction(transaction, {
          claim,
          state: "not_sent",
          failureKind: "budget_hard_stop",
          at,
        });
        await options.blockedPromptFailure.failBlockedPromptInTransaction(
          transaction,
          {
            candidate,
            compactionRunId: claim.runId,
            compactionControlId: claim.controlId,
            reason: "recovery_compaction_budget_hard_stop",
            at,
          },
        );
      });
      await finalizeRun({
        claim,
        status: "failed",
        reason: "budget_hard_stop",
        at,
      });
      throw new SessionCompactionRecoveryRejected(
        block.reason,
        "budget_hard_stop",
      );
    }

    const prunes = await collectRecoveryToolPrunes({
      candidate,
      loaded,
      settings: resolved.settings,
      model: resolved.model,
    });
    if (prunes.length > 0) {
      plan = await planIssueSessionRecoveryCompaction({
        messages: loaded.messages,
        settings: resolved.settings,
        model: resolved.model,
      });
    }
    const attempt = await startAttempt(claim, candidate);
    try {
      let requestMessageId: string;
      try {
      requestMessageId = await publishCompactionStarted({
        claim,
        candidate,
        attempt,
        prunes,
        at: now(),
      });
      } catch (error) {
      if (error instanceof SessionCompactionAttemptFenceLost) {
        throw new SessionCompactionRecoveryRejected(
          error.message,
          "compaction_failed",
        );
      }
      try {
        await renewAttemptLease({ claim, attempt });
      } catch (renewalError) {
        throw new SessionCompactionRecoveryRejected(
          renewalError instanceof Error
            ? renewalError.message
            : "Recovery compaction lease renewal failed closed",
          "compaction_failed",
        );
      }
      const at = now();
      await db.transaction(async (transaction) => {
        await lockExactActiveAttemptInTransaction(transaction, {
          claim,
          attempt,
        });
        await markUnsettledInTransaction(transaction, {
          claim,
          state: "not_sent",
          failureKind: "request_publication_failed",
          at,
        });
        await options.blockedPromptFailure.failBlockedPromptInTransaction(
          transaction,
          {
            candidate,
            compactionRunId: claim.runId,
            compactionControlId: claim.controlId,
            reason: "recovery_compaction_failed",
            at,
          },
        );
      });
        const finished = await finishAttempt({
          claim,
          attempt,
          state: "failed",
          at,
        });
        if (finished) {
          await finalizeRun({
            claim,
            status: "failed",
            reason: "request_publication_failed",
            at,
          });
        }
      throw new SessionCompactionRecoveryRejected(
        error instanceof Error ? error.message : String(error),
        "compaction_failed",
      );
      }
      let transmitted = false;
      let result: SessionCompactionSummaryResult;
      try {
      result = await runWithLeaseRenewal({
        claim,
        attempt,
        work: () => options.summarizer.summarize({
          companyId: candidate.identity.companyId,
          issueId: candidate.identity.issueId,
          sessionId: candidate.identity.sessionId,
          runId: claim.runId,
          agentId: candidate.identity.targetAgentId,
          ownershipEpoch: candidate.identity.ownershipEpoch,
          adapterConfigRevisionId: candidate.prompt.identity.adapterConfigRevisionId,
          executionWorkspaceBindingId:
            candidate.prompt.identity.executionWorkspaceBindingId,
          prompt: plan.prompt,
          model: resolved.model,
          signal: attempt.controller.signal,
          lifecycle: {
            async onPromptTransmissionBegan() {
              await markTransmissionBegan(claim, attempt);
              transmitted = true;
            },
          },
        }),
      });
      } catch (error) {
      if (error instanceof SessionCompactionAttemptFenceLost) {
        throw new SessionCompactionRecoveryRejected(
          error.message,
          "compaction_failed",
        );
      }
      const failure = error instanceof SessionCompactionProviderFailure
        ? error
        : new SessionCompactionProviderFailure(
            error instanceof Error ? error.message : String(error),
            "recovery_compaction_failed",
            false,
            "",
            transmitted,
          );
      try {
        await renewAttemptLease({ claim, attempt });
      } catch (renewalError) {
        throw new SessionCompactionRecoveryRejected(
          renewalError instanceof Error
            ? renewalError.message
            : "Recovery compaction lease renewal failed closed",
          "compaction_failed",
        );
      }
      const at = now();
      await publishUnsettledFailure({
        claim,
        candidate,
        attempt,
        requestMessageId,
        state: failure.promptTransmitted || transmitted
          ? "incomplete"
          : "not_sent",
        failureKind: failure.errorKind,
        partialText: failure.partialText,
        at,
      });
        const finished = await finishAttempt({
          claim,
          attempt,
          state: "failed",
          at,
        });
        if (finished) {
          await finalizeRun({
            claim,
            status: "failed",
            reason: failure.errorKind,
            at,
          });
        }
      throw new SessionCompactionRecoveryRejected(
        failure.message,
        "compaction_failed",
      );
      }
      try {
        await renewAttemptLease({ claim, attempt });
      } catch (renewalError) {
        throw new SessionCompactionRecoveryRejected(
          renewalError instanceof Error
            ? renewalError.message
            : "Recovery compaction lease renewal failed closed",
          "compaction_failed",
        );
      }
      const settledAt = now();
      const settlement = await publishProtocolSettledResult({
      claim,
      candidate,
      attempt,
      requestMessageId,
      result,
      plan,
      at: settledAt,
      });
      const finished = await finishAttempt({
        claim,
        attempt,
        state: "settled",
        at: settledAt,
      });
      if (!finished) {
        await budgets.enforceSuspensionScopes(
          settlement.budgetSuspensionScopes,
        );
        throw new SessionCompactionRecoveryRejected(
          "Recovery compaction was cancelled",
          "compaction_failed",
        );
      }
      if (settlement.checkpointControlId === null) {
      const cancelled = result.settlement.stopReason === "cancelled";
      await options.finalizationWriter.finalize({
        companyId: claim.companyId,
        issueId: claim.issueId,
        runId: claim.runId,
        status: cancelled ? "cancelled" : "failed",
        terminalReasonCode:
          settlement.failureKind ?? "recovery_compaction_failed",
        finishedAt: settledAt,
      });
      await budgets.enforceSuspensionScopes(
        settlement.budgetSuspensionScopes,
      );
      throw new SessionCompactionRecoveryRejected(
        settlement.failureKind ?? "Recovery compaction failed",
        "compaction_failed",
      );
      }
      await finalizeRun({
      claim,
      status: "succeeded",
      reason: "recovery_compaction_completed",
      at: settledAt,
    });
      await budgets.enforceSuspensionScopes(
      settlement.budgetSuspensionScopes,
    );
      const checkpoint = await loadCheckpoint({
      companyId: candidate.identity.companyId,
      issueId: candidate.identity.issueId,
      sessionId: candidate.identity.sessionId,
      checkpointControlId: settlement.checkpointControlId,
      scopeKind: candidate.identity.scopeKind,
      scopeId: candidate.identity.scopeId,
      audience: candidate.identity.audience,
      sourceHighWaterSeq: candidate.identity.sourceHighWaterSeq,
    });
      return {
        checkpoint,
        members: retainedMembers(candidate.members, checkpoint.tailStartMessageId),
      };
    } finally {
      const active = activeAttempts.get(attempt.attemptId);
      if (active?.controller === attempt.controller) {
        activeAttempts.delete(attempt.attemptId);
      }
    }
  }

  const boundary: IssueSessionRecoveryCompactionBoundary = {
    prepare,
    loadCheckpoint,
  };

  return Object.freeze({
    ...boundary,
    getSettings,
    updateSettings,
    signalAttemptCancellation(
      input: IssueSessionCompactionAttemptCancellationSignal,
    ): boolean {
      const active = activeAttempts.get(input.attemptId);
      if (!active || !sameCancellationIdentity(input, active.cancellation)) {
        return false;
      }
      active.controller.abort("issue_session_compaction_attempt_cancelled");
      return true;
    },
    isAttemptActive(
      input: IssueSessionCompactionAttemptCancellationSignal,
    ): boolean {
      const active = activeAttempts.get(input.attemptId);
      return Boolean(
        active && sameCancellationIdentity(input, active.cancellation),
      );
    },
  });
}

export type PostgresIssueSessionCompactionRuntime = ReturnType<
  typeof createPostgresIssueSessionCompactionRuntime
>;
