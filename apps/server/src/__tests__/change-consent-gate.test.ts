import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentProfileChangeTargetKey,
  changeConsentGateService,
  consumeAcceptedChangeConsentInTransaction,
} from "../services/change-consent-gate.js";
import { createMockDb } from "./helpers/mock-db.js";

const runMocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  readRun: vi.fn(),
}));

vi.mock("../services/task-execution-run-service.js", () => ({
  resolveTaskExecutionRunIdentityById: runMocks.resolveIdentity,
  readTaskExecutionRun: runMocks.readRun,
}));

const DISPLAYED_DIFF = "```diff\n+Tighten the workflow.\n```";
const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const sourceRunId = "00000000-0000-4000-8000-000000000003";
const actorRunId = "00000000-0000-4000-8000-000000000004";
const consentId = "00000000-0000-4000-8000-000000000006";
const targetKey = agentProfileChangeTargetKey("00000000-0000-4000-8000-000000000005");

describe("changeConsentGateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMocks.resolveIdentity.mockResolvedValue({ companyId, runId: sourceRunId });
    runMocks.readRun.mockResolvedValue({ targetAgentId: agentId });
  });

  it("requires durable consent for the exact target", async () => {
    const { db } = createMockDb({ select: [[]] });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: agentId,
      actorRunId,
      targetKeys: [targetKey],
      displayedDiff: DISPLAYED_DIFF,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "change_consent_required" },
    });
  });

  it("rejects consent from the same run as the applying mutation", async () => {
    const { db } = createMockDb({ select: [[]] });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: agentId,
      actorRunId: sourceRunId,
      targetKeys: [targetKey],
      displayedDiff: DISPLAYED_DIFF,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "change_consent_required" },
    });
  });

  it("consumes one previous-run accepted consent atomically", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const { db, calls } = createMockDb({
      select: [[{ id: "consent-1" }]],
      update: [[{ id: "consent-1" }]],
    });

    await expect(consumeAcceptedChangeConsentInTransaction(db as never, {
      companyId,
      actorAgentId: agentId,
      actorRunId,
      targetKeys: [targetKey],
      displayedDiff: DISPLAYED_DIFF,
      now,
    })).resolves.toBe(true);

    expect(calls.find(
      (call) => call.operation === "update" && call.method === "set",
    )?.args[0]).toEqual({
      consumedAt: now,
      consumedByRunId: actorRunId,
      updatedAt: now,
    });
  });

  it("does not consume consent for a different displayed diff", async () => {
    const { db } = createMockDb({
      select: [[], [{ id: "consent-1" }]],
      update: [[{ id: "consent-1" }]],
    });
    const service = changeConsentGateService(db);

    await expect(service.assertConsented({
      companyId,
      actorAgentId: agentId,
      actorRunId,
      targetKeys: [targetKey],
      displayedDiff: "```diff\n+Different change.\n```",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "change_consent_required" },
    });
    await expect(service.assertConsented({
      companyId,
      actorAgentId: agentId,
      actorRunId,
      targetKeys: [targetKey],
      displayedDiff: DISPLAYED_DIFF,
    })).resolves.toBe(true);
  });

  it("cannot consume an accepted consent twice", async () => {
    const { db } = createMockDb({
      select: [[{ id: "consent-1" }], []],
      update: [[{ id: "consent-1" }]],
    });
    const service = changeConsentGateService(db);

    await service.assertConsented({
      companyId,
      actorAgentId: agentId,
      actorRunId,
      targetKeys: [targetKey],
      displayedDiff: DISPLAYED_DIFF,
    });
    await expect(service.assertConsented({
      companyId,
      actorAgentId: agentId,
      actorRunId: "00000000-0000-4000-8000-000000000099",
      targetKeys: [targetKey],
      displayedDiff: DISPLAYED_DIFF,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "change_consent_required" },
    });
  });

  it("requires the exact displayed diff before resolving or writing a request", async () => {
    const { db, calls } = createMockDb();

    await expect(changeConsentGateService(db).request({
      companyId,
      requestedByAgentId: agentId,
      sourceRunId,
      targetKey,
      displayedDiff: "Please approve the change.",
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toMatchObject({ status: 400 });
    expect(runMocks.resolveIdentity).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("persists a validated request against its canonical source run", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const created = {
      id: consentId,
      companyId,
      requestedByAgentId: agentId,
      sourceRunId,
      targetKey,
      displayedDiff: DISPLAYED_DIFF,
      expiresAt,
    };
    const { db, calls } = createMockDb({ insert: [[created]] });

    await expect(changeConsentGateService(db).request({
      companyId,
      requestedByAgentId: agentId,
      sourceRunId,
      targetKey,
      displayedDiff: DISPLAYED_DIFF,
      expiresAt,
    })).resolves.toEqual(created);
    expect(runMocks.resolveIdentity).toHaveBeenCalledWith(db, sourceRunId);
    expect(calls.find((call) => call.method === "values")?.args[0]).toEqual({
      companyId,
      requestedByAgentId: agentId,
      sourceRunId,
      targetKey,
      displayedDiff: DISPLAYED_DIFF,
      expiresAt,
    });
  });

  it("does not treat a rejected decision as consent", async () => {
    const { db } = createMockDb({
      update: [[], [{ id: "consent-1", status: "rejected" }]],
      select: [[]],
    });
    const service = changeConsentGateService(db);

    await expect(service.decide({
      companyId,
      consentId,
      decision: "rejected",
      decidedByBoardId: "board-user",
      reason: "Needs revision",
    })).resolves.toMatchObject({ status: "rejected" });
    await expect(service.assertConsented({
      companyId,
      actorAgentId: agentId,
      actorRunId,
      targetKeys: [targetKey],
      displayedDiff: DISPLAYED_DIFF,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "change_consent_required" },
    });
  });
});
