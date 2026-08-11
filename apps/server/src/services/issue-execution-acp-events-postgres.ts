import { createHash } from "node:crypto";
import {
  normalizeAcpToolOutput,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acpx-runtime";
import {
  agentAdapterConfigRevisions,
  issueExecutionAttempts,
  issueExecutionLeases,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRunControls,
  issueExecutionRunRefs,
  issueSessionEvents,
  issueSessionMessages,
  type Db,
} from "@paperclipai/db";
import {
  agentAdapterAcpConfigurationSchema,
  IssueSession,
} from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { redactSensitiveText } from "../redaction.js";
import type {
  IssueExecutionAcpEventSink,
  IssueExecutionPromptCapabilityIdentity,
  IssueExecutionPromptIdentity,
} from "./issue-execution-attempt-executor.js";
import type { IssueExecutionRunService } from "./issue-execution-run-service.js";
import {
  lockIssueSessionProjectionRoot,
  reserveIssueSessionEventSequence,
  reserveIssueSessionMessageId,
  type IssueSessionDbTransaction,
} from "./issue-session/event-store.js";
import { issueSessionMessageFromRow } from "./issue-session/projector.js";
import {
  publishIssueSessionEventInTx,
  type IssueSessionPublicationCompanions,
  type IssueSessionPublicationRedactor,
} from "./issue-session/publication.js";

export class PostgresIssueExecutionAcpEventRejected extends Error {
  readonly code = "postgres_issue_execution_acp_event_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresIssueExecutionAcpEventRejected";
  }
}

function reject(message: string): never {
  throw new PostgresIssueExecutionAcpEventRejected(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const PAPERCLIP_MCP_SERVER_NAME = "paperclip";
const PAPERCLIP_MCP_TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Extracts the exact Paperclip MCP identity retained in normalized ACP raw
 * input. A Paperclip-marked envelope must be exact; display titles are never
 * parsed as aliases for canonical tool names.
 */
export function canonicalPaperclipMcpToolName(value: unknown): string | null {
  if (!isPlainRecord(value) || value.server !== PAPERCLIP_MCP_SERVER_NAME) {
    return null;
  }
  if (
    Object.keys(value).sort().join("\n") !==
      ["arguments", "server", "tool"].sort().join("\n") ||
    typeof value.tool !== "string" ||
    !PAPERCLIP_MCP_TOOL_NAME.test(value.tool)
  ) {
    reject("Paperclip MCP tool input has no exact canonical identity");
  }
  return value.tool;
}

/**
 * Projects one ACP tool label into a collision-free Session name. Paperclip
 * MCP tools retain their exact compiler-owned name; every other tool is kept
 * in the separate provider display namespace and can never masquerade as a
 * Paperclip capability.
 */
export function projectedAcpToolName(
  rawInput: unknown,
  providerTitle: string,
): string {
  const paperclipToolName = canonicalPaperclipMcpToolName(rawInput);
  if (paperclipToolName !== null) return paperclipToolName;
  if (providerTitle.length === 0) {
    reject("ACP provider tool has no display title");
  }
  return `provider-tool:${providerTitle}`;
}

function redactValue<T>(
  value: T,
  redactText: (text: string) => string,
  ancestors: ReadonlySet<object> = new Set(),
): T {
  if (typeof value === "string") {
    return redactSensitiveText(redactText(value)) as T;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      reject("ACP event contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    reject("ACP event contains a non-JSON value");
  }
  if (ancestors.has(value)) reject("ACP event contains a cycle");
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactValue(entry, redactText, nextAncestors),
    ) as T;
  }
  if (!isPlainRecord(value)) reject("ACP event contains a non-JSON object");
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => key !== "_meta" && entry !== undefined)
      .map(([key, entry]) => [
        key,
        redactValue(entry, redactText, nextAncestors),
      ]),
  ) as T;
}

function publicationRedactor(
  redactText: (text: string) => string,
): IssueSessionPublicationRedactor {
  return {
    redactText: (value) => redactSensitiveText(redactText(value)),
    redactValue: (value) => redactValue(value, redactText),
  };
}

function exactCapability(
  row: typeof issueExecutionPromptCapabilities.$inferSelect,
  prompt: IssueExecutionPromptIdentity,
  capability: IssueExecutionPromptCapabilityIdentity,
): void {
  if (
    row.capabilityConnectionId !== capability.capabilityConnectionId ||
    row.capabilityGeneration !== capability.capabilityGeneration ||
    row.companyId !== prompt.companyId ||
    row.issueId !== prompt.issueId ||
    row.runId !== prompt.runId ||
    row.runBatchDigest !== prompt.runBatchDigest ||
    row.refId !== prompt.refId ||
    row.refOrdinal !== prompt.refOrdinal ||
    row.segmentOrdinal !== prompt.segmentOrdinal ||
    row.attemptId !== prompt.attemptId ||
    row.leaseId !== prompt.leaseId ||
    row.leaseGeneration !== prompt.leaseGeneration ||
    row.ownershipEpoch !== prompt.ownershipEpoch ||
    row.targetAgentId !== prompt.targetAgentId ||
    row.laneKind !== prompt.laneKind ||
    row.executionMode !== prompt.laneKind ||
    row.issueExecutionAuthorityId !== prompt.issueExecutionAuthorityId ||
    row.consultExecutionId !== prompt.consultExecutionId ||
    row.adapterConfigIdentity !== prompt.adapterConfigRevisionId ||
    row.workspaceIdentity !== prompt.executionWorkspaceBindingId
  ) {
    reject("ACP update crossed its exact prompt capability identity");
  }
}

async function lockCurrentPrompt(
  transaction: IssueSessionDbTransaction,
  runService: Pick<IssueExecutionRunService, "lockRun">,
  prompt: IssueExecutionPromptIdentity,
  capability: IssueExecutionPromptCapabilityIdentity,
  now: Date,
): Promise<typeof issueExecutionPromptCapabilities.$inferSelect> {
  const run = await runService.lockRun(transaction, {
    companyId: prompt.companyId,
    issueId: prompt.issueId,
    runId: prompt.runId,
  });
  if (
    run.kind !== prompt.runKind ||
    run.status !== "running" ||
    run.sessionId !== prompt.sessionId ||
    run.ownershipEpoch !== prompt.ownershipEpoch ||
    run.targetAgentId !== prompt.targetAgentId ||
    run.adapterConfigRevisionId !== prompt.adapterConfigRevisionId ||
    run.executionWorkspaceBindingId !==
      prompt.executionWorkspaceBindingId ||
    run.executionMode !== prompt.laneKind ||
    run.issueExecutionAuthorityId !== prompt.issueExecutionAuthorityId ||
    run.consultExecutionId !== prompt.consultExecutionId ||
    run.currentAttemptId !== prompt.attemptId ||
    run.currentLeaseId !== prompt.leaseId ||
    run.cancellationIntentId !== null ||
    run.terminalFinalizationId !== null
  ) {
    reject("ACP update does not belong to the current running envelope");
  }
  const control = await transaction
    .select()
    .from(issueExecutionRunControls)
    .where(eq(issueExecutionRunControls.runId, prompt.runId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !control ||
    control.currentRefId !== prompt.refId ||
    control.currentOrdinal !== prompt.refOrdinal ||
    control.currentSegmentOrdinal !== prompt.segmentOrdinal
  ) {
    reject("ACP update crossed the run's current prompt pointer");
  }
  const attempt = await transaction
    .select()
    .from(issueExecutionAttempts)
    .where(eq(issueExecutionAttempts.id, prompt.attemptId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !attempt ||
    attempt.companyId !== prompt.companyId ||
    attempt.issueId !== prompt.issueId ||
    attempt.sessionId !== prompt.sessionId ||
    attempt.runId !== prompt.runId ||
    attempt.runKind !== prompt.runKind ||
    attempt.promptKind !== prompt.promptKind ||
    attempt.refId !== prompt.refId ||
    attempt.refOrdinal !== prompt.refOrdinal ||
    attempt.segmentOrdinal !== prompt.segmentOrdinal ||
    attempt.attemptGeneration !== prompt.attemptGeneration ||
    attempt.state !== "running"
  ) {
    reject("ACP update does not belong to the current running attempt");
  }
  const lease = await transaction
    .select()
    .from(issueExecutionLeases)
    .where(eq(issueExecutionLeases.id, prompt.leaseId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !lease ||
    lease.companyId !== prompt.companyId ||
    lease.issueId !== prompt.issueId ||
    lease.runId !== prompt.runId ||
    lease.attemptId !== prompt.attemptId ||
    lease.leaseGeneration !== prompt.leaseGeneration ||
    lease.state !== "active" ||
    lease.expiresAt <= now
  ) {
    reject("ACP update does not belong to a live exact lease");
  }
  const capabilityRow = await transaction
    .select()
    .from(issueExecutionPromptCapabilities)
    .where(
      and(
        eq(
          issueExecutionPromptCapabilities.capabilityConnectionId,
          capability.capabilityConnectionId,
        ),
        eq(
          issueExecutionPromptCapabilities.capabilityGeneration,
          capability.capabilityGeneration,
        ),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !capabilityRow ||
    capabilityRow.state !== "active" ||
    capabilityRow.targetSessionCorrelationId === null ||
    capabilityRow.expiresAt <= now
  ) {
    reject("ACP update arrived outside an active prompt capability");
  }
  exactCapability(capabilityRow, prompt, capability);

  const owner = prompt.promptKind === "base"
    ? await transaction
        .select({
          attemptId: issueExecutionRunRefs.attemptId,
          capabilityConnectionId:
            issueExecutionRunRefs.capabilityConnectionId,
          capabilityGeneration: issueExecutionRunRefs.capabilityGeneration,
          protocolSettlementState:
            issueExecutionRunRefs.protocolSettlementState,
        })
        .from(issueExecutionRunRefs)
        .where(
          and(
            eq(issueExecutionRunRefs.runId, prompt.runId),
            eq(issueExecutionRunRefs.refId, prompt.refId),
            eq(issueExecutionRunRefs.refOrdinal, prompt.refOrdinal),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null)
    : await transaction
        .select({
          attemptId: issueExecutionPromptSegments.attemptId,
          capabilityConnectionId:
            issueExecutionPromptSegments.capabilityConnectionId,
          capabilityGeneration:
            issueExecutionPromptSegments.capabilityGeneration,
          protocolSettlementState:
            issueExecutionPromptSegments.protocolSettlementState,
        })
        .from(issueExecutionPromptSegments)
        .where(
          and(
            eq(issueExecutionPromptSegments.runId, prompt.runId),
            eq(issueExecutionPromptSegments.refId, prompt.refId),
            eq(
              issueExecutionPromptSegments.refOrdinal,
              prompt.refOrdinal,
            ),
            eq(
              issueExecutionPromptSegments.segmentOrdinal,
              prompt.segmentOrdinal,
            ),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
  if (
    !owner ||
    owner.attemptId !== prompt.attemptId ||
    owner.capabilityConnectionId !== capability.capabilityConnectionId ||
    owner.capabilityGeneration !== capability.capabilityGeneration ||
    owner.protocolSettlementState !== null
  ) {
    reject("ACP update crossed its current ref or steering-segment owner");
  }
  return capabilityRow;
}

interface PromptPublication {
  readonly assistantMessageId: string;
  readonly timestamp: Date;
  nextSourceOrdinal: number;
  publish(
    type: Parameters<typeof publishIssueSessionEventInTx>[1]["event"]["type"],
    data: Record<string, unknown>,
    companions?: IssueSessionPublicationCompanions,
  ): Promise<string>;
}

async function beginPromptPublication(
  transaction: IssueSessionDbTransaction,
  input: {
    prompt: IssueExecutionPromptIdentity;
    capability: IssueExecutionPromptCapabilityIdentity;
    redactor: IssueSessionPublicationRedactor;
    timestamp: Date;
  },
): Promise<PromptPublication> {
  const scope = {
    companyId: input.prompt.companyId,
    issueId: input.prompt.issueId,
    sessionId: input.prompt.sessionId,
  };
  const assistantMessageId = await reserveIssueSessionMessageId(
    transaction,
    scope,
    `acp-prompt:${input.prompt.attemptId}:assistant`,
  );
  const count = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(issueSessionEvents)
    .where(
      and(
        eq(issueSessionEvents.companyId, input.prompt.companyId),
        eq(issueSessionEvents.issueId, input.prompt.issueId),
        eq(issueSessionEvents.sessionId, input.prompt.sessionId),
        eq(issueSessionEvents.runId, input.prompt.runId),
        eq(issueSessionEvents.sourceKind, "acp_prompt_update"),
        eq(issueSessionEvents.sourceId, input.prompt.attemptId),
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));
  if (!Number.isSafeInteger(count) || count < 0) {
    reject("ACP prompt update event frontier is invalid");
  }
  const publication: PromptPublication = {
    assistantMessageId,
    timestamp: input.timestamp,
    nextSourceOrdinal: count,
    async publish(type, data, companions) {
      const sourceOrdinal = publication.nextSourceOrdinal;
      publication.nextSourceOrdinal += 1;
      const immutableSourceKey = [
        "acp_prompt_update",
        input.prompt.attemptId,
        sourceOrdinal,
        type,
      ].join(":");
      const eventId = `evt_${sha256(immutableSourceKey).slice(0, 40)}`;
      const { seq } = await reserveIssueSessionEventSequence(
        transaction,
        scope,
      );
      await publishIssueSessionEventInTx(transaction, {
        event: {
          id: eventId,
          sessionId: input.prompt.sessionId,
          seq,
          type,
          data,
        },
        envelope: {
          companyId: input.prompt.companyId,
          issueId: input.prompt.issueId,
          runId: input.prompt.runId,
          ownershipEpoch: input.prompt.ownershipEpoch,
          agentId: input.prompt.targetAgentId,
          adapterConfigRevisionId: input.prompt.adapterConfigRevisionId,
          sourceKind: "acp_prompt_update",
          sourceId: input.prompt.attemptId,
          immutableSourceKey,
          sourceRecordId: input.capability.capabilityConnectionId,
          sourceIdentityDigest: sha256([
            input.prompt.companyId,
            input.prompt.issueId,
            input.prompt.sessionId,
            input.prompt.runId,
            input.prompt.refId,
            input.prompt.refOrdinal,
            input.prompt.segmentOrdinal,
            input.prompt.attemptId,
            input.capability.capabilityConnectionId,
            input.capability.capabilityGeneration,
            sourceOrdinal,
            type,
          ].join(":")),
          createdAt: input.timestamp,
        },
        ...(companions ? { companions } : {}),
        redactor: input.redactor,
      });
      return eventId;
    },
  };
  const existing = await transaction
    .select()
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, input.prompt.companyId),
        eq(issueSessionMessages.issueId, input.prompt.issueId),
        eq(issueSessionMessages.sessionId, input.prompt.sessionId),
        eq(issueSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (existing) {
    if (
      existing.type !== "assistant" ||
      existing.runId !== input.prompt.runId ||
      existing.agentId !== input.prompt.targetAgentId ||
      existing.adapterConfigRevisionId !==
        input.prompt.adapterConfigRevisionId
    ) {
      reject("ACP prompt assistant identity is already owned elsewhere");
    }
    return publication;
  }
  const revision = await transaction
    .select({
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
    })
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(
          agentAdapterConfigRevisions.id,
          input.prompt.adapterConfigRevisionId,
        ),
        eq(
          agentAdapterConfigRevisions.companyId,
          input.prompt.companyId,
        ),
        eq(
          agentAdapterConfigRevisions.agentId,
          input.prompt.targetAgentId,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!revision) reject("ACP prompt immutable adapter revision is missing");
  const configuration = agentAdapterAcpConfigurationSchema.parse(
    revision.acpConfiguration,
  );
  await publication.publish(IssueSession.Event.Step.Started.type, {
    timestamp: input.timestamp.getTime(),
    sessionID: input.prompt.sessionId,
    assistantMessageID: assistantMessageId,
    agent: input.prompt.targetAgentId,
    ...(configuration.model === null
      ? {}
      : {
          model: {
            id: configuration.model.id,
            providerID: configuration.launchProfile.registryName,
          },
        }),
  });
  return publication;
}

async function currentAssistant(
  transaction: IssueSessionDbTransaction,
  prompt: IssueExecutionPromptIdentity,
  assistantMessageId: string,
) {
  const row = await transaction
    .select()
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, prompt.companyId),
        eq(issueSessionMessages.issueId, prompt.issueId),
        eq(issueSessionMessages.sessionId, prompt.sessionId),
        eq(issueSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!row) reject("ACP prompt assistant projection is missing");
  const message = issueSessionMessageFromRow(row);
  if (message.type !== "assistant" || message.time.completed) {
    reject("ACP update arrived outside an unfinished assistant step");
  }
  return message;
}

function toolContent(sourceOutputText: string) {
  return sourceOutputText.length === 0
    ? []
    : [{ type: "text" as const, text: sourceOutputText }];
}

function outputPaths(
  event: Extract<
    NormalizedAcpSessionEvent,
    { kind: "tool_call" | "tool_call_update" }
  >,
): string[] | undefined {
  const values = event.locations?.map((location) => location.path) ?? [];
  return values.length === 0 ? undefined : values;
}

function toolInput(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function isAssistantTool(
  part: IssueSession.Message.AssistantContent,
): part is IssueSession.Message.AssistantTool {
  return part.type === "tool";
}

async function publishToolEvent(
  transaction: IssueSessionDbTransaction,
  publication: PromptPublication,
  prompt: IssueExecutionPromptIdentity,
  event: Extract<
    NormalizedAcpSessionEvent,
    { kind: "tool_call" | "tool_call_update" }
  >,
  redactText: (value: string) => string,
): Promise<void> {
  const redactedRawInput = event.rawInput === undefined
    ? undefined
    : redactValue(event.rawInput, redactText);
  const redactedRawOutput = event.rawOutput === undefined
    ? undefined
    : redactValue(event.rawOutput, redactText);
  const redactedContent = event.content === undefined || event.content === null
    ? event.content
    : redactValue(event.content, redactText);
  let assistant = await currentAssistant(
    transaction,
    prompt,
    publication.assistantMessageId,
  );
  let tool = assistant.content.findLast(
    (part): part is IssueSession.Message.AssistantTool =>
      isAssistantTool(part) && part.id === event.toolCallId,
  );
  if (!tool) {
    if (event.kind !== "tool_call") {
      reject("ACP tool update arrived before its tool-call creation");
    }
    const name = redactSensitiveText(redactText(
      projectedAcpToolName(event.rawInput, event.title),
    ));
    await publication.publish(IssueSession.Event.Tool.Input.Started.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      name,
    });
    const inputText = redactedRawInput === undefined
      ? "{}"
      : normalizeAcpToolOutput({ rawOutput: redactedRawInput });
    await publication.publish(IssueSession.Event.Tool.Input.Ended.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      text: inputText,
    });
    assistant = await currentAssistant(
      transaction,
      prompt,
      publication.assistantMessageId,
    );
    tool = assistant.content.findLast(
      (part): part is IssueSession.Message.AssistantTool =>
        isAssistantTool(part) && part.id === event.toolCallId,
    );
  } else if (
    tool.state.status === "pending" &&
    redactedRawInput !== undefined
  ) {
    await publication.publish(IssueSession.Event.Tool.Input.Ended.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      text: normalizeAcpToolOutput({ rawOutput: redactedRawInput }),
    });
  }
  if (!tool) reject("ACP tool-call creation did not project its tool");

  const status = event.status ?? null;
  if (
    tool.state.status === "pending" &&
    (status === "in_progress" ||
      status === "completed" ||
      status === "failed")
  ) {
    await publication.publish(IssueSession.Event.Tool.Called.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      tool: tool.name,
      input: toolInput(redactedRawInput),
      provider: { executed: true },
    });
    assistant = await currentAssistant(
      transaction,
      prompt,
      publication.assistantMessageId,
    );
    tool = assistant.content.findLast(
      (part): part is IssueSession.Message.AssistantTool =>
        isAssistantTool(part) && part.id === event.toolCallId,
    );
  }
  if (!tool) reject("ACP tool-call transition lost its tool projection");
  const sourceOutputText = normalizeAcpToolOutput({
    ...(redactedRawOutput === undefined
      ? {}
      : { rawOutput: redactedRawOutput }),
    ...(redactedContent === undefined ? {} : { content: redactedContent }),
  });
  const structured = isPlainRecord(redactedRawOutput)
    ? redactedRawOutput
    : {};
  if (status === "completed") {
    if (tool.state.status !== "running") {
      reject("ACP completed tool is not in the running donor state");
    }
    await publication.publish(
      IssueSession.Event.Tool.Success.type,
      {
        timestamp: publication.timestamp.getTime(),
        sessionID: prompt.sessionId,
        assistantMessageID: publication.assistantMessageId,
        callID: event.toolCallId,
        structured,
        content: toolContent(sourceOutputText),
        ...(outputPaths(event) === undefined
          ? {}
          : { outputPaths: outputPaths(event) }),
        ...(redactedRawOutput === undefined
          ? {}
          : { result: redactedRawOutput }),
        provider: { executed: true },
      },
    );
    return;
  }
  if (status === "failed") {
    if (tool.state.status !== "pending" && tool.state.status !== "running") {
      reject("ACP failed tool is already terminal");
    }
    await publication.publish(
      IssueSession.Event.Tool.Failed.type,
      {
        timestamp: publication.timestamp.getTime(),
        sessionID: prompt.sessionId,
        assistantMessageID: publication.assistantMessageId,
        callID: event.toolCallId,
        error: {
          type: "unknown",
          message: redactSensitiveText(
            redactText(event.title ?? "ACP tool call failed"),
          ),
        },
        ...(redactedRawOutput === undefined
          ? {}
          : { result: redactedRawOutput }),
        provider: { executed: true },
      },
    );
    return;
  }
  if (
    tool.state.status === "running" &&
    (event.content !== undefined || event.rawOutput !== undefined)
  ) {
    await publication.publish(IssueSession.Event.Tool.Progress.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      structured,
      content: toolContent(sourceOutputText),
    });
  }
}

/**
 * Sole provider-neutral productive/consult ACP update projector. Every durable
 * write re-locks the exact run/ref/segment, attempt, lease, and capability.
 */
export function createPostgresIssueExecutionAcpEventSink(options: {
  readonly database: Db;
  readonly runService: Pick<IssueExecutionRunService, "lockRun">;
  readonly now?: () => Date;
}): IssueExecutionAcpEventSink {
  const now = options.now ?? (() => new Date());
  return {
    async publish(input) {
      await options.database.transaction(async (transaction) => {
        const timestamp = now();
        if (!Number.isFinite(timestamp.getTime())) {
          reject("ACP event timestamp is invalid");
        }
        await lockIssueSessionProjectionRoot(transaction, {
          companyId: input.prompt.companyId,
          issueId: input.prompt.issueId,
          sessionId: input.prompt.sessionId,
        });
        await lockCurrentPrompt(
          transaction,
          options.runService,
          input.prompt,
          input.capability,
          timestamp,
        );
        const redactor = publicationRedactor(input.redactor.redactText);
        const publication = await beginPromptPublication(transaction, {
          prompt: input.prompt,
          capability: input.capability,
          redactor,
          timestamp,
        });
        if (input.event.kind === "message_chunk") {
          if (input.event.content.type !== "text") {
            reject("ACP assistant/thought output must be a text content block");
          }
          const text = redactSensitiveText(
            input.redactor.redactText(input.event.content.text),
          );
          const partOrdinal = publication.nextSourceOrdinal;
          if (input.event.channel === "assistant") {
            const textId = `text_${input.prompt.attemptId}_${partOrdinal}`;
            await publication.publish(IssueSession.Event.Text.Started.type, {
              timestamp: timestamp.getTime(),
              sessionID: input.prompt.sessionId,
              assistantMessageID: publication.assistantMessageId,
              textID: textId,
            });
            await publication.publish(IssueSession.Event.Text.Ended.type, {
              timestamp: timestamp.getTime(),
              sessionID: input.prompt.sessionId,
              assistantMessageID: publication.assistantMessageId,
              textID: textId,
              text,
            });
          } else {
            const reasoningId =
              `reasoning_${input.prompt.attemptId}_${partOrdinal}`;
            await publication.publish(
              IssueSession.Event.Reasoning.Started.type,
              {
                timestamp: timestamp.getTime(),
                sessionID: input.prompt.sessionId,
                assistantMessageID: publication.assistantMessageId,
                reasoningID: reasoningId,
              },
            );
            await publication.publish(
              IssueSession.Event.Reasoning.Ended.type,
              {
                timestamp: timestamp.getTime(),
                sessionID: input.prompt.sessionId,
                assistantMessageID: publication.assistantMessageId,
                reasoningID: reasoningId,
                text,
              },
            );
          }
          return;
        }
        if (
          input.event.kind !== "tool_call" &&
          input.event.kind !== "tool_call_update"
        ) {
          reject("unsupported ACP productive session update");
        }
        await publishToolEvent(
          transaction,
          publication,
          input.prompt,
          input.event,
          input.redactor.redactText,
        );
      });
    },
  };
}
