import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const logActivityMock = vi.hoisted(() => vi.fn(async () => undefined));
const listIssueExecutionRunsMock = vi.hoisted(() => vi.fn(async () => ({
  items: [],
  nextCursor: null,
})));

vi.mock("../services/activity-log.js", () => ({
  logActivity: logActivityMock,
}));

vi.mock("../services/issue-execution-run-service.js", () => ({
  listIssueExecutionRunsForIssue: listIssueExecutionRunsMock,
}));

import { issueWatchdogService } from "../services/issue-watchdogs.js";

describe("task safeguard persisted system nudge", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("nudges the watched issue through the ordinary runtime once per stopped fingerprint", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const issueId = randomUUID();
    const watchdogId = randomUUID();
    const refId = randomUUID();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const issue = {
      id: issueId,
      companyId,
      identifier: "SG-1",
      title: "Watched issue",
      boardPresentationStatus: "in_progress",
      parentId: null,
      ownerAgentId,
      ownerUserId: null,
      originKind: "user",
      createdAt,
      updatedAt: createdAt,
    };
    const watchdogRow: any = {
      id: watchdogId,
      companyId,
      issueId,
      status: "active",
      lastObservedFingerprint: null,
      lastTriggeredAt: null,
      triggerCount: 0,
      createdAt,
      updatedAt: createdAt,
    };
    const harness = createMockDb({
      select: [
        [{ id: issueId, companyId }],
        [],
        [watchdogRow],
        [issue],
        [], [], [], [], [], [],
        () => [watchdogRow],
        [issue],
        [], [], [], [], [], [],
      ],
      insert: [[watchdogRow]],
      update: [[{ id: watchdogId }], []],
      execute: [[issue], [issue]],
    });
    const dispatchDirectEvent = vi.fn(async () => ({ ref: { id: refId } }));
    const service = issueWatchdogService(harness.db, {
      dispatchDirectEvent: dispatchDirectEvent as never,
    });

    const { watchdog } = await service.upsertForIssue(companyId, issueId);
    expect(watchdog).toMatchObject({ id: watchdogId, companyId, issueId, status: "active" });

    const first = await service.reconcileIssueWatchdogs({ companyId });
    expect(first).toMatchObject({
      checked: 1,
      triggered: 1,
      alreadyNudged: 0,
      nudgedIssueIds: [issueId],
    });
    expect(dispatchDirectEvent).toHaveBeenCalledTimes(1);
    expect(dispatchDirectEvent).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      issueId,
      sourceKind: "system_nudge",
      sourceRecordId: watchdogId,
      idempotencyKey: expect.stringContaining(watchdogId),
      message: expect.stringContaining("System safeguard detected a stopped subtree."),
    }));
    expect(dispatchDirectEvent.mock.calls[0]?.[0]).not.toHaveProperty("agentId");

    const persistedPatches = harness.calls
      .filter((call) => call.operation === "update" && call.method === "set")
      .map((call) => call.args[0] as Record<string, unknown>);
    expect(persistedPatches[0]).toMatchObject({
      lastObservedFingerprint: expect.stringMatching(/^issue_watchdog_stop:/),
      updatedAt: expect.any(Date),
    });
    expect(persistedPatches[1]).toMatchObject({
      lastTriggeredAt: expect.any(Date),
      triggerCount: expect.anything(),
      updatedAt: expect.any(Date),
    });
    watchdogRow.lastObservedFingerprint = persistedPatches[0]?.lastObservedFingerprint;
    watchdogRow.lastTriggeredAt = persistedPatches[1]?.lastTriggeredAt;
    watchdogRow.triggerCount = 1;

    expect(logActivityMock).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      companyId,
      actorType: "system",
      action: "issue.watchdog_triggered",
      entityType: "issue",
      entityId: issueId,
      details: expect.objectContaining({
        watchdogId,
        refId,
        stopFingerprint: persistedPatches[0]?.lastObservedFingerprint,
      }),
    }));

    const second = await service.reconcileIssueWatchdogs({ companyId });
    expect(second).toMatchObject({
      checked: 1,
      triggered: 0,
      alreadyNudged: 1,
    });
    expect(dispatchDirectEvent).toHaveBeenCalledTimes(1);
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    expect(listIssueExecutionRunsMock).toHaveBeenCalledTimes(2);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
  });
});
