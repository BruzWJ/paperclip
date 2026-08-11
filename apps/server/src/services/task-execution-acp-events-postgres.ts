import { createHash } from "node:crypto";
import {
  normalizeAcpToolOutput,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acpx-runtime";
import {
  agentAdapterConfigRevisions,
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskSessionEvents,
  taskSessionMessages,
  type Db,
} from "@paperclipai/db";
import {
  agentAdapterAcpConfigurationSchema,
  TaskSession,
} from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { redactSensitiveText } from "../redaction.js";
import type {
  TaskExecutionAcpEventSink,
  TaskExecutionPromptCapabilityIdentity,
  TaskExecutionPromptIdentity,
} from "./task-execution-attempt-executor.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import {
  lockTaskSessionProjectionRoot,
  reserveTaskSessionEventSequence,
  reserveTaskSessionMessageId,
  type TaskSessionDbTransaction,
} from "./task-session/event-store.js";
import { taskSessionMessageFromRow } from "./task-session/projector.js";
import {
  publishTaskSessionEventInTx,
  type TaskSessionPublicationCompanions,
  type TaskSessionPublicationRedactor,
} from "./task-session/publication.js";

export class PostgresTaskExecutionAcpEventRejected extends Error {
  readonly code = "postgres_task_execution_acp_event_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresTaskExecutionAcpEventRejected";
  }
}

function reject(message: string): never {
  throw new PostgresTaskExecutionAcpEventRejected(message);
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
): TaskSessionPublicationRedactor {
  return {
    redactText: (value) => redactSensitiveText(redactText(value)),
    redactValue: (value) => redactValue(value, redactText),
  };
}

function exactCapability(
  row: typeof taskExecutionPromptCapabilities.$inferSelect,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
): void {
  if (
    row.capabilityConnectionId !== capability.capabilityConnectionId ||
    row.capabilityGeneration !== capability.capabilityGeneration ||
    row.companyId !== prompt.companyId ||
    row.taskId !== prompt.taskId ||
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
    row.taskExecutionAuthorityId !== prompt.taskExecutionAuthorityId ||
    row.consultExecutionId !== prompt.consultExecutionId ||
    row.adapterConfigIdentity !== prompt.adapterConfigRevisionId ||
    row.workspaceIdentity !== prompt.executionWorkspaceBindingId
  ) {
    reject("ACP update crossed its exact prompt capability identity");
  }
}

async function lockCurrentPrompt(
  transaction: TaskSessionDbTransaction,
  runService: Pick<TaskExecutionRunService, "lockRun">,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
  now: Date,
): Promise<typeof taskExecutionPromptCapabilities.$inferSelect> {
  const run = await runService.lockRun(transaction, {
    companyId: prompt.companyId,
    taskId: prompt.taskId,
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
    run.taskExecutionAuthorityId !== prompt.taskExecutionAuthorityId ||
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
    .from(taskExecutionRunControls)
    .where(eq(taskExecutionRunControls.runId, prompt.runId))
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
    .from(taskExecutionAttempts)
    .where(eq(taskExecutionAttempts.id, prompt.attemptId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !attempt ||
    attempt.companyId !== prompt.companyId ||
    attempt.taskId !== prompt.taskId ||
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
    .from(taskExecutionLeases)
    .where(eq(taskExecutionLeases.id, prompt.leaseId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !lease ||
    lease.companyId !== prompt.companyId ||
    lease.taskId !== prompt.taskId ||
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
    .from(taskExecutionPromptCapabilities)
    .where(
      and(
        eq(
          taskExecutionPromptCapabilities.capabilityConnectionId,
          capability.capabilityConnectionId,
        ),
        eq(
          taskExecutionPromptCapabilities.capabilityGeneration,
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
          attemptId: taskExecutionRunRefs.attemptId,
          capabilityConnectionId:
            taskExecutionRunRefs.capabilityConnectionId,
          capabilityGeneration: taskExecutionRunRefs.capabilityGeneration,
          protocolSettlementState:
            taskExecutionRunRefs.protocolSettlementState,
        })
        .from(taskExecutionRunRefs)
        .where(
          and(
            eq(taskExecutionRunRefs.runId, prompt.runId),
            eq(taskExecutionRunRefs.refId, prompt.refId),
            eq(taskExecutionRunRefs.refOrdinal, prompt.refOrdinal),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null)
    : await transaction
        .select({
          attemptId: taskExecutionPromptSegments.attemptId,
          capabilityConnectionId:
            taskExecutionPromptSegments.capabilityConnectionId,
          capabilityGeneration:
            taskExecutionPromptSegments.capabilityGeneration,
          protocolSettlementState:
            taskExecutionPromptSegments.protocolSettlementState,
        })
        .from(taskExecutionPromptSegments)
        .where(
          and(
            eq(taskExecutionPromptSegments.runId, prompt.runId),
            eq(taskExecutionPromptSegments.refId, prompt.refId),
            eq(
              taskExecutionPromptSegments.refOrdinal,
              prompt.refOrdinal,
            ),
            eq(
              taskExecutionPromptSegments.segmentOrdinal,
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
    type: Parameters<typeof publishTaskSessionEventInTx>[1]["event"]["type"],
    data: Record<string, unknown>,
    companions?: TaskSessionPublicationCompanions,
  ): Promise<string>;
}

async function beginPromptPublication(
  transaction: TaskSessionDbTransaction,
  input: {
    prompt: TaskExecutionPromptIdentity;
    capability: TaskExecutionPromptCapabilityIdentity;
    redactor: TaskSessionPublicationRedactor;
    timestamp: Date;
  },
): Promise<PromptPublication> {
  const scope = {
    companyId: input.prompt.companyId,
    taskId: input.prompt.taskId,
    sessionId: input.prompt.sessionId,
  };
  const assistantMessageId = await reserveTaskSessionMessageId(
    transaction,
    scope,
    `acp-prompt:${input.prompt.attemptId}:assistant`,
  );
  const count = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.companyId, input.prompt.companyId),
        eq(taskSessionEvents.taskId, input.prompt.taskId),
        eq(taskSessionEvents.sessionId, input.prompt.sessionId),
        eq(taskSessionEvents.runId, input.prompt.runId),
        eq(taskSessionEvents.sourceKind, "acp_prompt_update"),
        eq(taskSessionEvents.sourceId, input.prompt.attemptId),
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
      const { seq } = await reserveTaskSessionEventSequence(
        transaction,
        scope,
      );
      await publishTaskSessionEventInTx(transaction, {
        event: {
          id: eventId,
          sessionId: input.prompt.sessionId,
          seq,
          type,
          data,
        },
        envelope: {
          companyId: input.prompt.companyId,
          taskId: input.prompt.taskId,
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
            input.prompt.taskId,
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
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, input.prompt.companyId),
        eq(taskSessionMessages.taskId, input.prompt.taskId),
        eq(taskSessionMessages.sessionId, input.prompt.sessionId),
        eq(taskSessionMessages.id, assistantMessageId),
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
  await publication.publish(TaskSession.Event.Step.Started.type, {
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
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  assistantMessageId: string,
) {
  const row = await transaction
    .select()
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, prompt.companyId),
        eq(taskSessionMessages.taskId, prompt.taskId),
        eq(taskSessionMessages.sessionId, prompt.sessionId),
        eq(taskSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!row) reject("ACP prompt assistant projection is missing");
  const message = taskSessionMessageFromRow(row);
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
  part: TaskSession.Message.AssistantContent,
): part is TaskSession.Message.AssistantTool {
  return part.type === "tool";
}

async function publishToolEvent(
  transaction: TaskSessionDbTransaction,
  publication: PromptPublication,
  prompt: TaskExecutionPromptIdentity,
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
    (part): part is TaskSession.Message.AssistantTool =>
      isAssistantTool(part) && part.id === event.toolCallId,
  );
  if (!tool) {
    if (event.kind !== "tool_call") {
      reject("ACP tool update arrived before its tool-call creation");
    }
    const name = redactSensitiveText(redactText(
      projectedAcpToolName(event.rawInput, event.title),
    ));
    await publication.publish(TaskSession.Event.Tool.Input.Started.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      name,
    });
    const inputText = redactedRawInput === undefined
      ? "{}"
      : normalizeAcpToolOutput({ rawOutput: redactedRawInput });
    await publication.publish(TaskSession.Event.Tool.Input.Ended.type, {
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
      (part): part is TaskSession.Message.AssistantTool =>
        isAssistantTool(part) && part.id === event.toolCallId,
    );
  } else if (
    tool.state.status === "pending" &&
    redactedRawInput !== undefined
  ) {
    await publication.publish(TaskSession.Event.Tool.Input.Ended.type, {
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
    await publication.publish(TaskSession.Event.Tool.Called.type, {
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
      (part): part is TaskSession.Message.AssistantTool =>
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
      TaskSession.Event.Tool.Success.type,
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
      TaskSession.Event.Tool.Failed.type,
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
    await publication.publish(TaskSession.Event.Tool.Progress.type, {
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
export function createPostgresTaskExecutionAcpEventSink(options: {
  readonly database: Db;
  readonly runService: Pick<TaskExecutionRunService, "lockRun">;
  readonly now?: () => Date;
}): TaskExecutionAcpEventSink {
  const now = options.now ?? (() => new Date());
  return {
    async publish(input) {
      await options.database.transaction(async (transaction) => {
        const timestamp = now();
        if (!Number.isFinite(timestamp.getTime())) {
          reject("ACP event timestamp is invalid");
        }
        await lockTaskSessionProjectionRoot(transaction, {
          companyId: input.prompt.companyId,
          taskId: input.prompt.taskId,
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
            await publication.publish(TaskSession.Event.Text.Started.type, {
              timestamp: timestamp.getTime(),
              sessionID: input.prompt.sessionId,
              assistantMessageID: publication.assistantMessageId,
              textID: textId,
            });
            await publication.publish(TaskSession.Event.Text.Ended.type, {
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
              TaskSession.Event.Reasoning.Started.type,
              {
                timestamp: timestamp.getTime(),
                sessionID: input.prompt.sessionId,
                assistantMessageID: publication.assistantMessageId,
                reasoningID: reasoningId,
              },
            );
            await publication.publish(
              TaskSession.Event.Reasoning.Ended.type,
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
