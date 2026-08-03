import { createHash } from "node:crypto";
import type { IssueSessionMessage } from "@paperclipai/shared/issue-session";
import type { ContextDial } from "./context-dial-resolver.js";
import type {
  IssueExecutionTargetNotFoundRecovery,
  ResolvedIssueExecutionPrompt,
} from "./issue-execution-attempt-executor.js";

export const ISSUE_SESSION_RECOVERY_CONTEXT_TAG =
  "paperclip-issue-session-context" as const;
export const ISSUE_SESSION_RECOVERY_PROMPT_SEPARATOR = "\n\n" as const;

export type IssueSessionRecoveryDepth = "thread" | "turns";
export type IssueSessionRecoveryScopeKind =
  | "comments-recovery"
  | "turns-recovery";
export type IssueSessionRecoveryAudience = "comments" | "turns";

export interface IssueSessionRecoveryCheckpoint {
  readonly id: string;
  readonly requestMessageId: string;
  readonly assistantMessageId: string;
  readonly summaryText: string;
  readonly tailStartMessageId: string | null;
}

export interface IssueSessionRecoveryComment {
  readonly kind: "comment";
  readonly id: string;
  readonly canonicalMessageId: string;
  readonly sourceSequence: number;
  readonly authorKind: "agent" | "user" | "board" | "system" | "plugin";
  readonly body: string;
}

export interface IssueSessionRecoveryTurn {
  readonly kind: "message";
  readonly id: string;
  readonly sourceSequence: number;
  readonly selectionRole: "history" | "retained-tail";
  readonly message: IssueSessionMessage;
}

export type IssueSessionRecoveryMember =
  | IssueSessionRecoveryComment
  | IssueSessionRecoveryTurn;

export interface IssueSessionRecoverySelectionIdentity {
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly visibility: "active" | "archived";
  readonly scopeKind: IssueSessionRecoveryScopeKind;
  readonly scopeId: string;
  readonly audience: IssueSessionRecoveryAudience;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly laneKind: "owner" | "consult";
  readonly contextEpoch: number;
  readonly executionLineageId: string;
  readonly sourceHighWaterSeq: number;
  readonly effectiveContextDigest: string;
  readonly selectedCheckpointControlId: string | null;
  readonly latestFinishedAssistantMessageId: string | null;
  readonly sourceRunId: string;
  readonly sourceRefId: string;
  readonly sourceRefOrdinal: number;
  readonly sourceSegmentOrdinal: number;
}

export interface PinnedIssueSessionRecoverySelection
  extends IssueSessionRecoverySelectionIdentity {
  readonly id: string;
  readonly selectionIdentityDigest: string;
  readonly expectedAssembledContentDigest: string;
  readonly depth: IssueSessionRecoveryDepth;
  readonly checkpoint: IssueSessionRecoveryCheckpoint | null;
  readonly members: readonly IssueSessionRecoveryMember[];
}

export type PreparedIssueSessionRecovery =
  | {
      readonly kind: "no_context";
      readonly sourceText: string;
    }
  | {
      readonly kind: "selected";
      readonly sourceText: string;
      readonly selection: PinnedIssueSessionRecoverySelection;
    };

/**
 * The PostgreSQL owner resolves current authorization, pins or reloads the
 * immutable identity-only selection, runs recovery-only compaction when the
 * selected view is over limit, and hydrates only those pinned members.
 */
export interface IssueSessionRecoveryRepository {
  prepare(
    prompt: ResolvedIssueExecutionPrompt,
  ): Promise<PreparedIssueSessionRecovery>;
}

export class IssueSessionRecoveryRejected extends Error {
  readonly code = "issue_session_recovery_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueSessionRecoveryRejected";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new IssueSessionRecoveryRejected(
      `${label} must be exact and non-empty`,
    );
  }
}

function canonicalJsonForModel(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function issueSessionRecoveryDepthForDial(
  dial: Pick<
    ContextDial,
    "carry_context" | "read_issue_comments" | "read_issue_agent_run"
  >,
): IssueSessionRecoveryDepth | null {
  if (!dial.carry_context) return null;
  if (dial.read_issue_agent_run) return "turns";
  if (dial.read_issue_comments) return "thread";
  return null;
}

export function issueSessionRecoveryScopeForDepth(
  depth: IssueSessionRecoveryDepth,
): {
  readonly scopeKind: IssueSessionRecoveryScopeKind;
  readonly audience: IssueSessionRecoveryAudience;
} {
  return depth === "turns"
    ? { scopeKind: "turns-recovery", audience: "turns" }
    : { scopeKind: "comments-recovery", audience: "comments" };
}

function validateCheckpoint(
  checkpoint: IssueSessionRecoveryCheckpoint | null,
): void {
  if (!checkpoint) return;
  exactIdentity(checkpoint.id, "recovery checkpoint id");
  exactIdentity(
    checkpoint.requestMessageId,
    "recovery checkpoint request message id",
  );
  exactIdentity(
    checkpoint.assistantMessageId,
    "recovery checkpoint assistant message id",
  );
  if (checkpoint.tailStartMessageId !== null) {
    exactIdentity(
      checkpoint.tailStartMessageId,
      "recovery checkpoint tail message id",
    );
  }
}

function validateMembers(input: {
  readonly depth: IssueSessionRecoveryDepth;
  readonly members: readonly IssueSessionRecoveryMember[];
  readonly allowEmpty: boolean;
}): void {
  if (input.members.length === 0 && !input.allowEmpty) {
    throw new IssueSessionRecoveryRejected(
      "A recovery selection without a checkpoint cannot be empty",
    );
  }
  const ids = new Set<string>();
  let previousSequence = -1;
  for (const member of input.members) {
    exactIdentity(member.id, "recovery member id");
    if (
      !Number.isSafeInteger(member.sourceSequence) ||
      member.sourceSequence < 0 ||
      member.sourceSequence <= previousSequence ||
      ids.has(member.id)
    ) {
      throw new IssueSessionRecoveryRejected(
        "Recovery members must have unique ids in strict source order",
      );
    }
    previousSequence = member.sourceSequence;
    ids.add(member.id);
    if (input.depth === "thread") {
      if (member.kind !== "comment") {
        throw new IssueSessionRecoveryRejected(
          "Thread recovery can contain only projected comments",
        );
      }
      exactIdentity(
        member.canonicalMessageId,
        "recovery comment message id",
      );
      continue;
    }
    if (member.kind !== "message") {
      throw new IssueSessionRecoveryRejected(
        "Turns recovery can contain only canonical Session messages",
      );
    }
  }
}

export function serializeIssueSessionRecoveryHistory(input: {
  readonly depth: IssueSessionRecoveryDepth;
  readonly checkpoint: IssueSessionRecoveryCheckpoint | null;
  readonly members: readonly IssueSessionRecoveryMember[];
}): string {
  validateCheckpoint(input.checkpoint);
  validateMembers({
    ...input,
    allowEmpty: input.checkpoint !== null,
  });
  const payload =
    input.depth === "thread"
      ? {
          version: "paperclip-issue-session-recovery/v1",
          depth: "thread" as const,
          ...(input.checkpoint
            ? {
                checkpoint: {
                  id: input.checkpoint.id,
                  summary: input.checkpoint.summaryText,
                },
              }
            : {}),
          comments: input.members.map((member) => {
            if (member.kind !== "comment") {
              throw new IssueSessionRecoveryRejected(
                "Thread recovery received a non-comment member",
              );
            }
            return {
              id: member.id,
              seq: member.sourceSequence,
              authorKind: member.authorKind,
              body: member.body,
            };
          }),
        }
      : {
          version: "paperclip-issue-session-recovery/v1",
          depth: "turns" as const,
          ...(input.checkpoint
            ? {
                checkpoint: {
                  id: input.checkpoint.id,
                  summary: input.checkpoint.summaryText,
                },
              }
            : {}),
          turns: input.members.map((member) => {
            if (member.kind !== "message") {
              throw new IssueSessionRecoveryRejected(
                "Turns recovery received a non-message member",
              );
            }
            return {
              seq: member.sourceSequence,
              message: member.message,
            };
          }),
        };
  return canonicalJsonForModel(payload);
}

export function assembleIssueSessionRecoveryPrompt(input: {
  readonly depth: IssueSessionRecoveryDepth;
  readonly checkpoint: IssueSessionRecoveryCheckpoint | null;
  readonly members: readonly IssueSessionRecoveryMember[];
  readonly sourceText: string;
}): string {
  const serialized = serializeIssueSessionRecoveryHistory(input);
  const prefix =
    `<${ISSUE_SESSION_RECOVERY_CONTEXT_TAG} depth="${input.depth}">\n` +
    `${serialized}\n` +
    `</${ISSUE_SESSION_RECOVERY_CONTEXT_TAG}>`;
  return `${prefix}${ISSUE_SESSION_RECOVERY_PROMPT_SEPARATOR}${input.sourceText}`;
}

export function issueSessionRecoveryAssembledContentDigest(
  assembledPrompt: string,
): string {
  return sha256(assembledPrompt);
}

export function issueSessionRecoverySelectionIdentityDigest(input: {
  readonly identity: IssueSessionRecoverySelectionIdentity;
  readonly members: readonly IssueSessionRecoveryMember[];
}): string {
  validateMembers({
    depth:
      input.identity.audience === "turns" ? "turns" : "thread",
    members: input.members,
    allowEmpty: input.identity.selectedCheckpointControlId !== null,
  });
  const identity = input.identity;
  const scope = issueSessionRecoveryScopeForDepth(
    identity.audience === "turns" ? "turns" : "thread",
  );
  if (
    scope.scopeKind !== identity.scopeKind ||
    scope.audience !== identity.audience
  ) {
    throw new IssueSessionRecoveryRejected(
      "Recovery scope kind and audience do not match",
    );
  }
  const canonical = {
    version: "paperclip-issue-session-recovery-selection/v1",
    companyId: identity.companyId,
    issueId: identity.issueId,
    sessionId: identity.sessionId,
    visibility: identity.visibility,
    scopeKind: identity.scopeKind,
    scopeId: identity.scopeId,
    audience: identity.audience,
    ownershipEpoch: identity.ownershipEpoch,
    targetAgentId: identity.targetAgentId,
    laneKind: identity.laneKind,
    contextEpoch: identity.contextEpoch,
    executionLineageId: identity.executionLineageId,
    sourceHighWaterSeq: identity.sourceHighWaterSeq,
    effectiveContextDigest: identity.effectiveContextDigest,
    selectedCheckpointControlId:
      identity.selectedCheckpointControlId,
    latestFinishedAssistantMessageId:
      identity.latestFinishedAssistantMessageId,
    sourceRunId: identity.sourceRunId,
    sourceRefId: identity.sourceRefId,
    sourceRefOrdinal: identity.sourceRefOrdinal,
    sourceSegmentOrdinal: identity.sourceSegmentOrdinal,
    members: input.members.map((member, memberOrdinal) => ({
      memberOrdinal,
      memberKind: member.kind,
      selectionRole:
        member.kind === "message" ? member.selectionRole : "history",
      sourceSequence: member.sourceSequence,
      messageId: member.kind === "message" ? member.id : null,
      commentId: member.kind === "comment" ? member.id : null,
      commentProjectedEventSeq:
        member.kind === "comment" ? member.sourceSequence : null,
    })),
  };
  return sha256(JSON.stringify(canonical));
}

export function verifyPinnedIssueSessionRecovery(input: {
  readonly selection: PinnedIssueSessionRecoverySelection;
  readonly sourceText: string;
}): string {
  const selection = input.selection;
  const identity: IssueSessionRecoverySelectionIdentity = {
    companyId: selection.companyId,
    issueId: selection.issueId,
    sessionId: selection.sessionId,
    visibility: selection.visibility,
    scopeKind: selection.scopeKind,
    scopeId: selection.scopeId,
    audience: selection.audience,
    ownershipEpoch: selection.ownershipEpoch,
    targetAgentId: selection.targetAgentId,
    laneKind: selection.laneKind,
    contextEpoch: selection.contextEpoch,
    executionLineageId: selection.executionLineageId,
    sourceHighWaterSeq: selection.sourceHighWaterSeq,
    effectiveContextDigest: selection.effectiveContextDigest,
    selectedCheckpointControlId:
      selection.selectedCheckpointControlId,
    latestFinishedAssistantMessageId:
      selection.latestFinishedAssistantMessageId,
    sourceRunId: selection.sourceRunId,
    sourceRefId: selection.sourceRefId,
    sourceRefOrdinal: selection.sourceRefOrdinal,
    sourceSegmentOrdinal: selection.sourceSegmentOrdinal,
  };
  const selectionDigest = issueSessionRecoverySelectionIdentityDigest({
    identity,
    members: selection.members,
  });
  if (selectionDigest !== selection.selectionIdentityDigest) {
    throw new IssueSessionRecoveryRejected(
      "Pinned recovery selection identity digest changed",
    );
  }
  const assembled = assembleIssueSessionRecoveryPrompt({
    depth: selection.depth,
    checkpoint: selection.checkpoint,
    members: selection.members,
    sourceText: input.sourceText,
  });
  if (
    issueSessionRecoveryAssembledContentDigest(assembled) !==
    selection.expectedAssembledContentDigest
  ) {
    throw new IssueSessionRecoveryRejected(
      "Pinned recovery assembled-content digest changed",
    );
  }
  return assembled;
}

/**
 * True-carry target-loss orchestration. False carry cannot call this owner;
 * successful resume never calls it; and no compiled prefix is persisted.
 */
export function createIssueSessionTargetNotFoundRecovery(options: {
  readonly repository: IssueSessionRecoveryRepository;
}): IssueExecutionTargetNotFoundRecovery {
  const recovery: IssueExecutionTargetNotFoundRecovery = {
    async prepareReplacementPrompt(prompt) {
      if (!prompt.carryContext) {
        throw new IssueSessionRecoveryRejected(
          "False-carry work cannot enter missing-target recovery",
        );
      }
      const prepared = await options.repository.prepare(prompt);
      if (prepared.sourceText !== prompt.sourceText) {
        throw new IssueSessionRecoveryRejected(
          "Recovery source text changed after prompt resolution",
        );
      }
      if (prepared.kind === "no_context") return prepared.sourceText;
      const assembled = verifyPinnedIssueSessionRecovery({
        selection: prepared.selection,
        sourceText: prepared.sourceText,
      });
      return assembled;
    },
  };
  return Object.freeze(recovery);
}
