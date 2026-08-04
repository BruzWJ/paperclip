import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PromptCapabilityBinding } from "../services/prompt-capability-gateway.js";
import {
  createRuntimeToolCallLedger,
  RuntimeToolCallIdentityConflict,
} from "../services/runtime-tool-call-ledger.js";
import type { CompiledRunToolDescriptor } from "../services/runtime-interface-compiler.js";
import { createMockDb } from "./helpers/mock-db.js";

const capability: PromptCapabilityBinding = {
  companyId: "00000000-0000-4000-8000-000000000301",
  issueId: "00000000-0000-4000-8000-000000000302",
  ownershipEpoch: 1,
  targetAgentId: "00000000-0000-4000-8000-000000000303",
  executionMode: "owner",
  issueExecutionAuthorityId: "00000000-0000-4000-8000-000000000304",
  consultExecutionId: null,
  capabilityConnectionId: "00000000-0000-4000-8000-000000000305",
  capabilityGeneration: 2,
  runId: "00000000-0000-4000-8000-000000000306",
  runBatchDigest: "run-batch-digest",
  refId: "00000000-0000-4000-8000-000000000307",
  refOrdinal: 0,
  segmentOrdinal: 0,
  attemptId: "00000000-0000-4000-8000-000000000308",
  leaseId: "00000000-0000-4000-8000-000000000309",
  leaseGeneration: 1,
  workerProcessIdentity: "worker-1",
  sessionId: "00000000-0000-4000-8000-00000000030a",
  laneKind: "owner",
  adapterConfigIdentity: "adapter-revision-1",
  workspaceIdentity: "workspace-1",
  targetSessionCorrelationId: "correlation-1",
  effectiveContextExposureDigest: "context-digest",
  effectiveToolsDigest: "tools-digest",
  expiresAt: new Date("2026-08-01T13:00:00.000Z"),
  activatedAt: new Date("2026-08-01T11:00:00.000Z"),
  createdAt: new Date("2026-08-01T11:00:00.000Z"),
};

const nonMentionDescriptor: CompiledRunToolDescriptor = {
  name: "read_issue_comments",
  title: "Read comments",
  description: "",
  inputSchema: { type: "object" },
  source: "paperclip",
};

const mentionDescriptor: CompiledRunToolDescriptor = {
  name: "mention_agent",
  title: "Mention agent",
  description: "",
  inputSchema: { type: "object" },
  source: "paperclip",
};

const now = new Date("2026-08-01T12:00:00.000Z");
const toolCallId = "00000000-0000-4000-8000-00000000030b";
const mentionTarget = "00000000-0000-4000-8000-00000000030c";

function capabilityRow(overrides: Record<string, unknown> = {}) {
  return {
    companyId: capability.companyId,
    capabilityConnectionId: capability.capabilityConnectionId,
    capabilityGeneration: capability.capabilityGeneration,
    state: "active",
    expiresAt: capability.expiresAt,
    ingressHighWater: -1,
    classificationHighWater: -1,
    ...overrides,
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toolCallRow(overrides: Record<string, unknown> = {}) {
  return {
    id: toolCallId,
    companyId: capability.companyId,
    capabilityConnectionId: capability.capabilityConnectionId,
    capabilityGeneration: capability.capabilityGeneration,
    ingressOrdinal: 0,
    callIdentitySource: "jsonrpc",
    callIdentityType: "string",
    callIdentityValue: "call-0",
    toolName: nonMentionDescriptor.name,
    companyToolSelectionId: null,
    pluginInstallationId: null,
    argumentsDigest: digest('{"a":1,"b":2}'),
    status: "executing",
    classification: "unclassified",
    mentionTargetAgentId: null,
    mentionAdmissionState: null,
    classifiedAt: null,
    result: null,
    error: null,
    ...overrides,
  };
}

describe("runtime tool-call ledger", () => {
  it("claims a canonical identity and advances only the contiguous ingress high-water", async () => {
    const locked = capabilityRow();
    const unclassified = {
      ingressOrdinal: 0,
      classification: "unclassified",
    };
    const harness = createMockDb({
      select: [[locked], [], [], [unclassified], [unclassified]],
      insert: [[{ id: toolCallId }]],
      update: [[]],
    });
    const ledger = createRuntimeToolCallLedger(harness.db, {
      now: () => now,
      admissionPollIntervalMs: 0,
    });

    await expect(ledger.claim({
      capability,
      descriptor: nonMentionDescriptor,
      callIdentity: { source: "jsonrpc", id: "call-0" },
      ingressOrdinal: 0,
      arguments: { b: 2, a: 1 },
    })).resolves.toEqual({ state: "claimed", id: toolCallId });

    const valuesCall = harness.calls.find(
      (call) => call.operation === "insert" && call.method === "values",
    );
    expect(valuesCall?.args[0]).toMatchObject({
      companyId: capability.companyId,
      capabilityConnectionId: capability.capabilityConnectionId,
      capabilityGeneration: capability.capabilityGeneration,
      ingressOrdinal: 0,
      callIdentitySource: "jsonrpc",
      callIdentityType: "string",
      callIdentityValue: "call-0",
      toolName: "read_issue_comments",
      argumentsDigest: digest('{"a":1,"b":2}'),
      status: "executing",
    });
    const capabilityUpdate = harness.calls.find(
      (call) => call.operation === "update" && call.method === "set",
    );
    expect(capabilityUpdate?.args[0]).toEqual({
      ingressHighWater: 0,
      classificationHighWater: -1,
    });
  });

  it("replays completed identities and rejects identity or ordinal drift", async () => {
    const completed = toolCallRow({
      status: "completed",
      classification: "non_mention",
      result: { ok: true },
    });
    const replayDb = createMockDb({
      select: [[capabilityRow()], [completed], [completed]],
    });
    const replayLedger = createRuntimeToolCallLedger(replayDb.db, {
      now: () => now,
    });
    await expect(replayLedger.claim({
      capability,
      descriptor: nonMentionDescriptor,
      callIdentity: { source: "jsonrpc", id: "call-0" },
      ingressOrdinal: 0,
      arguments: { a: 1, b: 2 },
    })).resolves.toEqual({ state: "completed", result: { ok: true } });

    const driftDb = createMockDb({
      select: [[capabilityRow()], [completed], []],
    });
    const driftLedger = createRuntimeToolCallLedger(driftDb.db, {
      now: () => now,
    });
    await expect(driftLedger.claim({
      capability,
      descriptor: nonMentionDescriptor,
      callIdentity: { source: "jsonrpc", id: "call-0" },
      ingressOrdinal: 1,
      arguments: { a: 1, b: 2 },
    })).rejects.toBeInstanceOf(RuntimeToolCallIdentityConflict);
    expect(driftDb.calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("terminal-registers an invalid pending-setup call with a durable serialized error", async () => {
    const locked = capabilityRow({ state: "pending_setup" });
    const unclassified = {
      ingressOrdinal: 0,
      classification: "unclassified",
    };
    const terminal = {
      ingressOrdinal: 0,
      classification: "terminal_invalid",
    };
    const row = toolCallRow();
    const harness = createMockDb({
      select: [
        [locked],
        [],
        [],
        [unclassified],
        [unclassified],
        [row],
        [terminal],
        [terminal],
      ],
      insert: [[{ id: toolCallId }]],
      update: [[], [], []],
    });
    const ledger = createRuntimeToolCallLedger(harness.db, {
      now: () => now,
    });

    await ledger.registerTerminalInvalid({
      capability,
      descriptor: nonMentionDescriptor,
      callIdentity: null,
      ingressOrdinal: 0,
      arguments: { bad: true },
      error: Object.assign(new Error("Malformed tool payload"), {
        code: "invalid_arguments",
        status: 400,
        details: { field: "issueId" },
      }),
    });

    const insertValues = harness.calls.find(
      (call) => call.operation === "insert" && call.method === "values",
    );
    expect(insertValues?.args[0]).toMatchObject({
      callIdentitySource: "ingress",
      callIdentityType: "ordinal",
      callIdentityValue: "0",
      ingressOrdinal: 0,
    });
    const terminalSet = harness.calls
      .filter((call) => call.operation === "update" && call.method === "set")
      .map((call) => call.args[0])
      .find((value) =>
        typeof value === "object"
        && value !== null
        && "status" in value
      );
    expect(terminalSet).toMatchObject({
      classification: "terminal_invalid",
      status: "failed",
      error: {
        name: "Error",
        message: "Malformed tool payload",
        code: "invalid_arguments",
        status: 400,
        details: { field: "issueId" },
      },
      completedAt: now,
    });
  });

  it("waits for lower classification and same-target admission before preparing a mention", async () => {
    const row = toolCallRow({
      toolName: mentionDescriptor.name,
      ingressOrdinal: 1,
      callIdentityValue: "mention-1",
      argumentsDigest: digest("{}"),
      classification: "validated_mention",
      mentionTargetAgentId: mentionTarget,
      mentionAdmissionState: "pending",
    });
    const lowCapability = capabilityRow({
      ingressHighWater: 1,
      classificationHighWater: 0,
    });
    const readyCapability = capabilityRow({
      ingressHighWater: 1,
      classificationHighWater: 1,
    });
    const harness = createMockDb({
      select: [
        [lowCapability],
        [row],
        [readyCapability],
        [row],
        [],
        [readyCapability],
      ],
      update: [[], [{ id: toolCallId }]],
    });
    const ledger = createRuntimeToolCallLedger(harness.db, {
      now: () => now,
      admissionPollIntervalMs: 0,
    });
    const prepare = vi.fn(async () => ({ admitted: true }));

    await expect(ledger.withMentionAdmission({
      capability,
      id: toolCallId,
      ingressOrdinal: 1,
      targetAgentId: mentionTarget,
      prepare,
    })).resolves.toEqual({ admitted: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    const states = harness.calls
      .filter((call) => call.operation === "update" && call.method === "set")
      .map((call) => call.args[0]);
    expect(states).toEqual([
      {
        mentionAdmissionState: "preparing",
        mentionAdmissionStartedAt: now,
        updatedAt: now,
      },
      {
        mentionAdmissionState: "admitted",
        mentionAdmittedAt: now,
        updatedAt: now,
      },
    ]);
  });

  it("requires durable classification and admission before completion", async () => {
    const row = toolCallRow({
      toolName: mentionDescriptor.name,
      classification: "validated_mention",
      mentionTargetAgentId: mentionTarget,
      mentionAdmissionState: "pending",
    });
    const harness = createMockDb({
      select: [[capabilityRow()], [row]],
    });
    const ledger = createRuntimeToolCallLedger(harness.db, {
      now: () => now,
    });

    await expect(ledger.complete({
      capability,
      id: toolCallId,
      result: { shouldNotPersist: true },
    })).rejects.toBeInstanceOf(RuntimeToolCallIdentityConflict);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("rejects invalid ordinals, mention targets, and poll configuration without touching persistence", async () => {
    const harness = createMockDb();
    expect(() => createRuntimeToolCallLedger(harness.db, {
      admissionPollIntervalMs: -1,
    })).toThrow("Admission poll interval must be a nonnegative integer");
    const ledger = createRuntimeToolCallLedger(harness.db);
    await expect(ledger.claim({
      capability,
      descriptor: nonMentionDescriptor,
      callIdentity: { source: "jsonrpc", id: "bad" },
      ingressOrdinal: -1,
      arguments: {},
    })).rejects.toBeInstanceOf(RuntimeToolCallIdentityConflict);
    await expect(ledger.classify({
      capability,
      id: toolCallId,
      ingressOrdinal: 0,
      classification: "validated_mention",
      targetAgentId: "",
    })).rejects.toBeInstanceOf(RuntimeToolCallIdentityConflict);
    expect(harness.calls).toEqual([]);
  });
});
