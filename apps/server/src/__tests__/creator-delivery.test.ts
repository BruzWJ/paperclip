import { describe, expect, it } from "vitest";
import {
  creatorDeliveryCounterpartExecutionKey,
  enqueueCreatorDelivery,
} from "../services/creator-delivery-enqueue.js";
import { createMockDb } from "./helpers/mock-db.js";

const now = new Date("2026-07-25T20:00:00.000Z");
const update = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  issueId: "00000000-0000-4000-8000-000000000003",
  sessionId: "ses_creator_delivery",
  ownershipEpoch: 3,
  gatewayInvocationId: "invocation-1",
  commentId: "00000000-0000-4000-8000-000000000004",
  form: "owner",
  message: "The work is complete",
  status: "completed",
  disposition: "complete",
} as never;
const edge = {
  id: "00000000-0000-4000-8000-000000000005",
  state: "receivable",
  terminalReason: null,
} as never;
const policy = {
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 30_000,
  maxAttempts: 3,
} as never;

function insertValues(calls: ReturnType<typeof createMockDb>["calls"]) {
  return calls
    .filter((call) => call.operation === "insert" && call.method === "values")
    .map((call) => call.args[0] as Record<string, unknown>);
}

describe("creator delivery enqueue contract", () => {
  it.each([
    ["agent-execution", { authorityId: "auth-1" }, "agent-execution:auth-1"],
    [
      "plugin",
      {
        pluginInstallationId: "install-1",
        pluginKey: "reviewer",
        callbackKey: "complete",
        callbackVersion: "1",
      },
      "plugin:install-1:reviewer:complete:1",
    ],
    [
      "routine",
      { routineId: "routine-1", routineDispatchId: "dispatch-1" },
      "routine:routine-1:dispatch-1",
    ],
    ["user/board", { userId: "user-1" }, "user/board:user-1"],
    ["user/board", {}, "user/board:company-board"],
    ["system", { sourceId: "recovery-1" }, "system:recovery-1"],
  ] as const)("maps %s recipients to a stable execution key", (kind, ref, expected) => {
    expect(creatorDeliveryCounterpartExecutionKey(kind, ref)).toBe(expected);
  });

  it("rejects incomplete recipient identities before persistence", () => {
    expect(() => creatorDeliveryCounterpartExecutionKey("plugin", {
      pluginInstallationId: "install-1",
      pluginKey: "reviewer",
      callbackKey: "complete",
    })).toThrow("callbackVersion");
  });

  it("persists a sequenced plugin parent and callback outbox entry", async () => {
    const delivery = { id: "delivery-row", state: "pending" };
    const harness = createMockDb({
      select: [[], [{ value: 4 }]],
      execute: [[]],
      insert: [[delivery], []],
    });
    const recipientRef = {
      pluginInstallationId: "install-1",
      pluginKey: "reviewer",
      callbackKey: "complete",
      callbackVersion: "1",
    };

    await expect(enqueueCreatorDelivery(harness.db as never, {
      update,
      edge,
      recipientKind: "plugin",
      recipientRef,
      counterpartRefId: "callback-ref",
      policy,
      now,
    })).resolves.toBe(delivery);

    const [parent, callback] = insertValues(harness.calls);
    expect(parent).toMatchObject({
      recipientKind: "plugin",
      recipientRef,
      direction: "to_creator",
      counterpartExecutionKey: "plugin:install-1:reviewer:complete:1",
      committedSequence: 5,
      deliveryId: `creator_delivery:${update.id}`,
      idempotencyKey: `issue_update:${update.gatewayInvocationId}`,
      state: "pending",
      counterpartRefId: "callback-ref",
    });
    expect(callback).toMatchObject({
      creatorDeliveryId: "delivery-row",
      pluginInstallationId: "install-1",
      pluginKey: "reviewer",
      callbackKey: "complete",
      callbackVersion: "1",
      committedSequence: 5,
      state: "pending",
      payload: {
        updateId: update.id,
        issueId: update.issueId,
        message: update.message,
        committedSequence: 5,
      },
    });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("returns the existing delivery without taking a lock or inserting", async () => {
    const existing = { id: "existing-delivery", state: "pending" };
    const harness = createMockDb({ select: [[existing]] });

    await expect(enqueueCreatorDelivery(harness.db as never, {
      update,
      edge,
      recipientKind: "system",
      recipientRef: { sourceId: "system-1" },
      counterpartRefId: null,
      policy,
      now,
    })).resolves.toBe(existing);

    expect(harness.calls.filter((call) => call.operation === "execute")).toHaveLength(0);
    expect(harness.calls.filter((call) => call.operation === "insert")).toHaveLength(0);
  });

  it("persists terminal edges as permanently unreceivable", async () => {
    const delivery = { id: "terminal-delivery", state: "permanently_unreceivable" };
    const harness = createMockDb({
      select: [[], []],
      execute: [[]],
      insert: [[delivery]],
    });

    await enqueueCreatorDelivery(harness.db as never, {
      update: { ...update, form: "creator" } as never,
      edge: { ...edge, state: "terminal", terminalReason: "agent_terminated" } as never,
      recipientKind: "agent-execution",
      recipientRef: { authorityId: "auth-1" },
      counterpartRefId: "ref-1",
      policy,
      now,
    });

    expect(insertValues(harness.calls)[0]).toMatchObject({
      direction: "to_owner",
      state: "permanently_unreceivable",
      terminalAt: now,
      terminalReason: "agent_terminated",
      committedSequence: 0,
    });
  });

  it("refuses a terminal edge without its immutable reason", async () => {
    const harness = createMockDb({
      select: [[], []],
      execute: [[]],
    });

    await expect(enqueueCreatorDelivery(harness.db as never, {
      update,
      edge: { ...edge, state: "terminal", terminalReason: null } as never,
      recipientKind: "system",
      recipientRef: { sourceId: "system-1" },
      counterpartRefId: null,
      policy,
      now,
    })).rejects.toThrow("immutable terminal reason");
    expect(harness.calls.filter((call) => call.operation === "insert")).toHaveLength(0);
  });
});
