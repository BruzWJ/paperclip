import type {
  AcpPromptAccountingRecord,
  BoundedRunRecords,
  TaskExecutionCostEventRecord,
  TaskExecutionRunJoinedDetail,
  TaskExecutionSessionMessageRecord,
} from "@/api/runs";
import {
  TaskSession,
  canonicalizeMoneyAmount,
  type Agent,
  type TaskExecutionRunEnvelopeRecord,
} from "@paperclipai/shared";

export const RUN_DETAIL_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
export const RUN_DETAIL_AGENT_ID = "22222222-2222-4222-8222-222222222222";
export const RUN_DETAIL_TASK_ID = "33333333-3333-4333-8333-333333333333";
export const RUN_DETAIL_RUN_ID = "44444444-4444-4444-8444-444444444444";

const BASE_TIME = new Date("2026-08-14T17:00:00.000Z");
const at = (seconds: number) => new Date(BASE_TIME.getTime() + seconds * 1_000);

export function bounded<T>(items: T[] = [], truncated = false): BoundedRunRecords<T> {
  return { items, truncated, nextCursor: truncated ? "bounded-next" : null };
}

export function createRunEnvelope(
  overrides: Partial<TaskExecutionRunEnvelopeRecord> = {},
): TaskExecutionRunEnvelopeRecord {
  return {
    id: RUN_DETAIL_RUN_ID,
    companyId: RUN_DETAIL_COMPANY_ID,
    taskId: RUN_DETAIL_TASK_ID,
    sessionId: "ses_run_detail_fixture",
    executionScopeId: "scope-run-detail-fixture",
    kind: "productive",
    status: "succeeded",
    ownershipEpoch: 3,
    targetAgentId: RUN_DETAIL_AGENT_ID,
    adapterConfigRevisionId: "55555555-5555-4555-8555-555555555555",
    executionMode: "owner",
    taskExecutionAuthorityId: "66666666-6666-4666-8666-666666666666",
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: "77777777-7777-4777-8777-777777777777",
    startedAt: at(0).toISOString(),
    finishedAt: at(95).toISOString(),
    terminalClassification: "succeeded",
    terminalReasonCode: null,
    createdAt: at(-5).toISOString(),
    updatedAt: at(95).toISOString(),
    ...overrides,
  };
}

export const runDetailAgent: Agent = {
  id: RUN_DETAIL_AGENT_ID,
  companyId: RUN_DETAIL_COMPANY_ID,
  name: "Codex Run Agent",
  title: "Senior Product Engineer",
  icon: "code",
  status: "idle",
  reportsTo: null,
  capabilities: "Inspects source, runs focused checks, and reports verified workspace outputs.",
  currentAdapterConfigRevisionId: "55555555-5555-4555-8555-555555555555",
  budgetMonthlyAmount: canonicalizeMoneyAmount("250"),
  knownSpendAmount: canonicalizeMoneyAmount("12.50"),
  pauseReason: null,
  pausedAt: null,
  instruction: "Keep changes scoped and verify the smallest relevant surface.",
  createdAt: at(-86_400),
  updatedAt: at(-60),
};

export function createCanonicalSessionRecord(input: {
  wire: Record<string, unknown> & { id: string; type: TaskExecutionSessionMessageRecord["type"] };
  seq: number;
  modelStateSeq?: number;
}): TaskExecutionSessionMessageRecord {
  const decoded = TaskSession.decodeTaskSessionMessage(input.wire);
  const encoded = TaskSession.encodeTaskSessionMessage(decoded) as Record<string, unknown> & {
    id: string;
    type: TaskExecutionSessionMessageRecord["type"];
    time: { created: number };
  };
  const { id, type, ...data } = encoded;
  const timeCreated = new Date(encoded.time.created).toISOString();
  return {
    id,
    seq: input.seq,
    modelStateSeq: input.modelStateSeq ?? input.seq,
    type,
    data,
    timeCreated,
    timeUpdated: timeCreated,
  };
}

export function createTranscriptRecords(): TaskExecutionSessionMessageRecord[] {
  const user = createCanonicalSessionRecord({
    seq: 1,
    wire: {
      id: "msg_run_user",
      type: "user",
      text: "Inspect the run-detail surface and verify its canonical output.",
      files: [],
      agents: [{ name: "Codex Run Agent" }],
      time: { created: at(1).getTime() },
    },
  });
  const assistant = createCanonicalSessionRecord({
    seq: 2,
    wire: {
      id: "msg_run_assistant",
      type: "assistant",
      agent: "codex",
      model: { providerID: "openai", id: "gpt-run-fixture", variant: "default" },
      content: [
        {
          type: "reasoning",
          id: "reasoning-run-fixture",
          text: "I should inspect the contract before presenting the execution trace.",
          time: { created: at(2).getTime(), completed: at(4).getTime() },
        },
        {
          type: "tool",
          id: "tool-run-fixture",
          name: "read_file",
          state: {
            status: "completed",
            input: { path: "apps/ui/src/components/agents/AgentRunsPanel.tsx" },
            structured: { lines: 182 },
            content: [
              { type: "text", text: "Read the run-detail panel." },
              { type: "file", uri: "logs/read-file.log", mime: "text/plain", name: "read-file.log" },
            ],
            attachments: [
              { uri: "reports/verification.json", mime: "application/json", name: "verification.json" },
            ],
            outputPaths: ["reports/run-detail-summary.md"],
            result: { status: "verified" },
          },
          time: {
            created: at(5).getTime(),
            ran: at(6).getTime(),
            completed: at(8).getTime(),
          },
        },
        {
          type: "text",
          id: "text-run-fixture",
          text: "The run detail is verified and the reported outputs are ready for review.",
        },
      ],
      snapshot: {
        start: "snapshot-start",
        end: "snapshot-end",
        files: ["src/run-detail.tsx"],
      },
      finish: "stop",
      cost: 0.42,
      tokens: {
        input: 8_000,
        output: 900,
        reasoning: 240,
        cache: { read: 1_200, write: 100 },
      },
      time: { created: at(2).getTime(), completed: at(12).getTime() },
    },
  });
  const shell = createCanonicalSessionRecord({
    seq: 3,
    wire: {
      id: "msg_run_shell",
      type: "shell",
      callID: "shell-run-fixture",
      command: "pnpm --filter @paperclipai/ui typecheck",
      output: "Typecheck passed for the UI package.",
      time: { created: at(13).getTime(), completed: at(18).getTime() },
    },
  });
  return [user, assistant, shell];
}

function accountingRecord(run: TaskExecutionRunEnvelopeRecord): AcpPromptAccountingRecord {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    companyId: run.companyId,
    taskId: run.taskId,
    sessionId: run.sessionId,
    agentId: run.targetAgentId,
    runId: run.id,
    runKind: run.kind,
    promptKind: "base",
    refId: "99999999-9999-4999-8999-999999999999",
    runOrdinal: 0,
    segmentOrdinal: 0,
    attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    selectedModelId: "openai/gpt-run-fixture",
    contextTokenLimit: 128_000,
    contextUsedTokens: 18_432,
    contextWindowTokens: 128_000,
    promptSettlementReferenceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    terminalUsageReference: "usage-run-fixture",
    terminalStopReference: "stop-run-fixture",
    settledAt: at(90).toISOString(),
    createdAt: at(91).toISOString(),
  };
}

function costEvent(run: TaskExecutionRunEnvelopeRecord, accountingId: string): TaskExecutionCostEventRecord {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    accountingId,
    companyId: run.companyId,
    taskId: run.taskId,
    agentId: run.targetAgentId,
    runId: run.id,
    runKind: run.kind,
    promptKind: "base",
    refId: "99999999-9999-4999-8999-999999999999",
    runOrdinal: 0,
    segmentOrdinal: 0,
    budgetCurrency: "USD",
    kind: "known",
    unavailableReason: null,
    observedCumulativeAmount: canonicalizeMoneyAmount("4.25"),
    observedCurrency: "USD",
    knownDeltaAmount: canonicalizeMoneyAmount("0.42"),
    cursorBeforeState: "known",
    cursorBeforeAmount: canonicalizeMoneyAmount("3.83"),
    cursorBeforeCurrency: "USD",
    cursorAfterState: "known",
    cursorAfterAmount: canonicalizeMoneyAmount("4.25"),
    cursorAfterCurrency: "USD",
    occurredAt: at(90).toISOString(),
    createdAt: at(91).toISOString(),
  };
}

export function createJoinedRunDetail(
  overrides: Partial<TaskExecutionRunJoinedDetail> = {},
): TaskExecutionRunJoinedDetail {
  const run = overrides.run ?? createRunEnvelope();
  const accounting = accountingRecord(run);
  const attemptOne = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const attemptTwo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const refId = "99999999-9999-4999-8999-999999999999";
  return {
    run,
    control: { runId: run.id, currentRefId: refId, currentOrdinal: 0, currentSegmentOrdinal: 1 },
    refs: bounded([
      {
        companyId: run.companyId,
        taskId: run.taskId,
        sessionId: run.sessionId,
        runId: run.id,
        refId,
        refOrdinal: 0,
        inputId: "msg_run_user",
        attemptId: attemptTwo,
        capabilityConnectionId: "connection-run-fixture",
        capabilityGeneration: 2,
        promptTransmissionPhase: "transmitted",
        outcome: "succeeded",
        outcomeReferenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        protocolSettlementState: "settled",
        accountingId: accounting.id,
        costEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        settlementVersion: 1,
        settledAt: at(90).toISOString(),
        createdAt: at(0).toISOString(),
        admissionOrder: 0,
        batchDigest: "a".repeat(64),
      },
    ]),
    segments: bounded([]),
    sessionEvents: bounded([
      {
        id: "event-run-fixture",
        seq: 2,
        type: "session.next.step.ended.3",
        data: { outcome: "succeeded" },
        createdAt: at(88).toISOString(),
      },
    ]),
    sessionMessages: bounded(createTranscriptRecords()),
    attempts: bounded([
      {
        id: attemptOne,
        companyId: run.companyId,
        taskId: run.taskId,
        sessionId: run.sessionId,
        runId: run.id,
        runKind: run.kind,
        promptKind: "base",
        sessionOperation: "new",
        refId,
        refOrdinal: 0,
        segmentOrdinal: 0,
        steeringSegmentOrdinal: null,
        attemptGeneration: 1,
        state: "failed",
        startedAt: at(0).toISOString(),
        finishedAt: at(20).toISOString(),
        createdAt: at(0).toISOString(),
      },
      {
        id: attemptTwo,
        companyId: run.companyId,
        taskId: run.taskId,
        sessionId: run.sessionId,
        runId: run.id,
        runKind: run.kind,
        promptKind: "base",
        sessionOperation: "resume",
        refId,
        refOrdinal: 0,
        segmentOrdinal: 0,
        steeringSegmentOrdinal: null,
        attemptGeneration: 2,
        state: "settled",
        startedAt: at(35).toISOString(),
        finishedAt: at(90).toISOString(),
        createdAt: at(35).toISOString(),
      },
    ]),
    retrySchedules: bounded([
      {
        id: "retry-run-fixture",
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.id,
        predecessorAttemptId: attemptOne,
        reasonCode: "transient_provider_error",
        retryAt: at(30).toISOString(),
        state: "claimed",
        successorAttemptId: attemptTwo,
        claimedAt: at(35).toISOString(),
        cancelledAt: null,
        createdAt: at(20).toISOString(),
      },
    ]),
    leases: bounded([
      {
        id: "lease-run-fixture",
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.id,
        attemptId: attemptTwo,
        leaseGeneration: 2,
        workerId: "worker-run-fixture",
        state: "released",
        acquiredAt: at(35).toISOString(),
        renewedAt: at(60).toISOString(),
        expiresAt: at(120).toISOString(),
        releasedAt: at(90).toISOString(),
        createdAt: at(35).toISOString(),
      },
    ]),
    cancellations: bounded([
      {
        id: "cancellation-run-fixture",
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.id,
        attemptId: attemptOne,
        leaseId: null,
        reasonKind: "timeout",
        actorKind: "system",
        actorUserId: null,
        actorAgentId: null,
        state: "completed",
        requestedAt: at(18).toISOString(),
        acknowledgedAt: at(19).toISOString(),
        nativeCancellationSettledAt: at(20).toISOString(),
        completedAt: at(20).toISOString(),
        failedAt: null,
        failureCode: null,
        createdAt: at(18).toISOString(),
      },
    ]),
    accounting: bounded([accounting]),
    costs: bounded([costEvent(run, accounting.id)]),
    activity: bounded([
      {
        id: "activity-run-fixture",
        actorType: "agent",
        actorId: run.targetAgentId,
        action: "execution.completed",
        entityType: "task_execution_run",
        entityId: run.id,
        agentId: run.targetAgentId,
        responsibleUserId: null,
        details: { status: "succeeded" },
        createdAt: at(95).toISOString(),
      },
    ]),
    outputComments: bounded([
      {
        commentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        messageId: "msg_run_assistant",
        sourceKind: "run_output",
        projectedEventSeq: 4,
      },
    ]),
    finalization: {
      record: {
        id: "77777777-7777-4777-8777-777777777777",
        companyId: run.companyId,
        runId: run.id,
        finalizationIdentityDigest: "f".repeat(64),
        action: "comment_only",
        terminalSessionEventId: "event-run-fixture",
        terminalSessionMessageId: "msg_run_assistant",
        progressCommentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        gatewayCapabilityConnectionId: null,
        gatewayCapabilityGeneration: null,
        runLivenessFactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        finalizedAt: at(95).toISOString(),
        createdAt: at(94).toISOString(),
      },
      promptDependencies: bounded([
        {
          companyId: run.companyId,
          taskId: run.taskId,
          runId: run.id,
          finalizationId: "77777777-7777-4777-8777-777777777777",
          dependencyOrdinal: 0,
          promptKind: "base",
          refId,
          refOrdinal: 0,
          segmentOrdinal: 0,
          protocolSettlementState: "settled",
          settlementVersion: 1,
          accountingId: accounting.id,
          costEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      ]),
      updateDependencies: bounded([]),
      liveness: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        runId: run.id,
        livenessState: "completed",
        livenessReason: "The requested run-detail verification completed.",
        continuationAttempt: 0,
        lastUsefulActionAt: at(90).toISOString(),
        nextAction: null,
      },
    },
    ...overrides,
  };
}
