import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMoneyAmount } from "@paperclipai/shared";
import { agentService } from "../services/agents.js";
import { budgetService } from "../services/budgets.js";
import { createMockDb } from "./helpers/mock-db.js";

const activityMocks = vi.hoisted(() => ({
  logActivity: vi.fn(),
  persistActivityLog: vi.fn(),
  publishCommittedActivity: vi.fn(),
}));

const persistedBudgetActivity = {
  row: { id: "persisted-budget-activity" },
  taskId: null,
};

vi.mock("../services/activity-log.js", () => ({
  logActivity: activityMocks.logActivity,
  persistActivityLog: activityMocks.persistActivityLog,
  publishCommittedActivity: activityMocks.publishCommittedActivity,
}));

function companyRow(input: {
  id: string;
  name: string;
  currency: "USD" | "EUR";
  monthlyAmount: string;
}) {
  const now = new Date("2026-03-11T00:00:00.000Z");
  return {
    id: input.id,
    name: input.name,
    taskPrefix: "BUD",
    status: "active",
    pauseReason: null,
    pausedAt: null,
    budgetCurrency: input.currency,
    budgetMonthlyAmount: input.monthlyAmount,
    sessionIntegrityState: "ready",
    sessionIntegrityReadyAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function agentRow(input: {
  id: string;
  companyId: string;
  name?: string;
  status?: string;
  pauseReason?: string | null;
  budgetMonthlyAmount?: string;
}) {
  const now = new Date("2026-03-11T00:00:00.000Z");
  return {
    id: input.id,
    companyId: input.companyId,
    name: input.name ?? "Budgeted Agent",
    status: input.status ?? "idle",
    pauseReason: input.pauseReason ?? null,
    pausedAt: input.pauseReason ? now : null,
    reportsTo: null,
    currentAdapterConfigRevisionId: null,
    instruction: null,
    budgetMonthlyAmount: input.budgetMonthlyAmount ?? "10",
    createdAt: now,
    updatedAt: now,
  };
}

function policyRow(input: {
  id?: string;
  companyId: string;
  scopeType: "company" | "agent";
  scopeId: string;
  limitAmount: string;
}) {
  const now = new Date("2026-03-11T00:00:00.000Z");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    windowKind: "calendar_month_utc",
    limitAmount: input.limitAmount,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: true,
    isActive: input.limitAmount !== "0",
    createdByUserId: "board-user",
    updatedByUserId: "board-user",
    createdAt: now,
    updatedAt: now,
  };
}

describe("canonical budget service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityMocks.logActivity.mockResolvedValue(undefined);
    activityMocks.persistActivityLog.mockResolvedValue(persistedBudgetActivity);
  });

  it("creates one immutable company currency and exact decimal-string policy", async () => {
    const companyId = randomUUID();
    const amount = "12345678901234567890.125";
    const company = companyRow({
      id: companyId,
      name: "Canonical Budget Company",
      currency: "EUR",
      monthlyAmount: amount,
    });
    const policy = policyRow({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      limitAmount: amount,
    });
    const { db, calls } = createMockDb({
      insert: [[company], [policy]],
      select: [
        [{ budgetCurrency: "EUR" }],
        [
          {
            companyId,
            name: company.name,
            status: "active",
            pauseReason: null,
            pausedAt: null,
          },
        ],
        [],
        [{ total: "0" }],
      ],
      update: [[], []],
    });

    await expect(
      budgetService(db).createCompany(
        {
          name: company.name,
          budgetCurrency: "EUR",
          budgetMonthlyAmount: amount,
        },
        "board-user",
      ),
    ).resolves.toMatchObject({
      budgetCurrency: "EUR",
      budgetMonthlyAmount: amount,
    });

    const policyValues = calls
      .filter((call) => call.method === "values")
      .map((call) => call.args[0])
      .find(
        (value) => (value as { scopeType?: string }).scopeType === "company",
      );
    expect(policyValues).toMatchObject({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      windowKind: "calendar_month_utc",
      limitAmount: amount,
    });
  });

  it("defaults currency only at company creation and rejects noncanonical money", async () => {
    const companyId = randomUUID();
    const company = companyRow({
      id: companyId,
      name: "Default Currency Company",
      currency: "USD",
      monthlyAmount: "0",
    });
    const policy = policyRow({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      limitAmount: "0",
    });
    const { db } = createMockDb({
      insert: [[company], [policy]],
      select: [
        [{ budgetCurrency: "USD" }],
        [
          {
            companyId,
            name: company.name,
            status: "active",
            pauseReason: null,
            pausedAt: null,
          },
        ],
        [],
        [],
      ],
      update: [[], [], []],
    });
    const service = budgetService(db);

    await expect(
      service.createCompany({ name: company.name }, "board-user"),
    ).resolves.toMatchObject({
      budgetCurrency: "USD",
      budgetMonthlyAmount: "0",
    });
    await expect(
      service.createCompany(
        {
          name: "Exponent Budget Company",
          budgetMonthlyAmount: "1e3",
        },
        "board-user",
      ),
    ).rejects.toThrow("non-exponent decimal string");
    await expect(
      service.createCompany(
        {
          name: "Numeric Budget Company",
          budgetMonthlyAmount: 100 as never,
        },
        "board-user",
      ),
    ).rejects.toThrow("canonical decimal string");
  });

  it("rejects noncanonical budget incident UUID aliases before database access", async () => {
    const companyId = randomUUID();
    const canonicalIncidentId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const uppercaseIncidentId = canonicalIncidentId.toUpperCase();
    const { db, calls } = createMockDb();
    const service = budgetService(db);

    await expect(
      service.getIncidentScope(companyId, uppercaseIncidentId),
    ).rejects.toMatchObject({
      status: 404,
      message: "Budget incident not found",
    });
    await expect(
      service.resolveIncident(
        companyId,
        uppercaseIncidentId,
        { action: "keep_paused" },
        "board-user",
      ),
    ).rejects.toMatchObject({
      status: 404,
      message: "Budget incident not found",
    });

    expect(calls).toEqual([]);
    expect(activityMocks.logActivity).not.toHaveBeenCalled();
    expect(activityMocks.persistActivityLog).not.toHaveBeenCalled();
    expect(activityMocks.publishCommittedActivity).not.toHaveBeenCalled();
  });

  it("writes agent limits only through the operational budget owner", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const agent = agentRow({ id: agentId, companyId });
    const existing = policyRow({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      limitAmount: "10.5",
    });
    const updated = {
      ...existing,
      limitAmount: "20.125",
      updatedAt: new Date(),
    };
    const { db, calls } = createMockDb({
      select: [
        [{ budgetCurrency: "USD" }],
        [{ companyId, name: agent.name, status: "idle", pauseReason: null }],
        [existing],
        [{ total: "0" }],
        [{ companyId, name: agent.name, status: "idle", pauseReason: null }],
        [{ total: "0" }],
      ],
      update: [[updated], [], []],
    });

    await expect(
      budgetService(db).setAgentMonthlyLimit(
        companyId,
        agentId,
        parseMoneyAmount("20.125"),
        "board-user",
      ),
    ).resolves.toMatchObject({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      limitAmount: "20.125",
    });

    const sets = calls
      .filter((call) => call.method === "set")
      .map((call) => call.args[0]);
    expect(sets).toContainEqual(
      expect.objectContaining({
        limitAmount: "20.125",
        isActive: true,
      }),
    );
    expect(sets).toContainEqual(
      expect.objectContaining({
        budgetMonthlyAmount: "20.125",
      }),
    );
    expect(activityMocks.persistActivityLog).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId,
        actorId: "board-user",
        action: "budget.policy_upserted",
        entityType: "budget_policy",
        entityId: existing.id,
      }),
    );
    expect(
      activityMocks.publishCommittedActivity,
    ).toHaveBeenCalledExactlyOnceWith(persistedBudgetActivity);
    expect(activityMocks.logActivity).not.toHaveBeenCalled();
    expect(
      activityMocks.persistActivityLog.mock.invocationCallOrder[0],
    ).toBeLessThan(
      activityMocks.publishCommittedActivity.mock.invocationCallOrder[0]!,
    );
  });

  it("separates ledger evaluation from post-commit scope suspension", async () => {
    const suspendWorkForScope = vi.fn().mockResolvedValue(undefined);
    const { db } = createMockDb();
    const service = budgetService(db, { suspendWorkForScope });

    expect(
      await service.evaluateCostEventInTransaction({
        kind: "unavailable",
        knownDeltaAmount: null,
      } as never),
    ).toEqual([]);
    expect(suspendWorkForScope).not.toHaveBeenCalled();

    const scope = {
      companyId: "00000000-0000-4000-8000-000000000001",
      scopeType: "agent" as const,
      scopeId: "00000000-0000-4000-8000-000000000002",
    };
    await service.enforceSuspensionScopes([scope]);
    expect(suspendWorkForScope).toHaveBeenCalledExactlyOnceWith(scope);
  });

  it("rejects manual budget resume and releases only through canonical budget resolution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const company = companyRow({
      id: companyId,
      name: "Budget Resume Owner",
      currency: "USD",
      monthlyAmount: "0",
    });
    const pausedAgent = agentRow({
      id: agentId,
      companyId,
      status: "paused",
      pauseReason: "budget",
    });
    const manualHarness = createMockDb({
      execute: [[]],
      select: [[{ companyId }], [company], [pausedAgent]],
    });
    await expect(
      agentService(manualHarness.db).resume(agentId),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        code: "budget_resume_requires_budget_resolution",
        agentId,
      },
    });
    const policy = policyRow({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      limitAmount: "10",
    });
    const incidentId = randomUUID();
    const now = new Date("2026-07-31T12:00:00.000Z");
    const incident = {
      id: incidentId,
      companyId,
      policyId: policy.id,
      scopeType: "agent",
      scopeId: agentId,
      windowKind: "calendar_month_utc",
      windowStart: new Date("2026-07-01T00:00:00.000Z"),
      windowEnd: new Date("2026-08-01T00:00:00.000Z"),
      thresholdType: "hard",
      limitAmount: "10",
      observedAmount: "10",
      status: "open",
      approvalId: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const resolved = {
      ...incident,
      status: "resolved",
      resolvedAt: now,
      updatedAt: now,
    };
    const resolutionHarness = createMockDb({
      select: [
        [{ budgetCurrency: "USD" }],
        [incident],
        [policy],
        [
          {
            companyId,
            name: pausedAgent.name,
            status: "paused",
            pauseReason: "budget",
          },
        ],
        [{ total: "10" }],
        [resolved],
        [
          {
            companyId,
            name: pausedAgent.name,
            status: "idle",
            pauseReason: null,
          },
        ],
      ],
      update: [[], [], [], []],
    });
    const resumeWorkForScope = vi.fn().mockResolvedValue(undefined);

    await expect(
      budgetService(resolutionHarness.db, {
        resumeWorkForScope,
      }).resolveIncident(
        companyId,
        incidentId,
        {
          action: "raise_budget_and_resume",
          limitAmount: parseMoneyAmount("20"),
        },
        "board-user",
        "agent_operational_configuration",
      ),
    ).resolves.toMatchObject({
      id: incidentId,
      status: "resolved",
      scopeType: "agent",
      scopeId: agentId,
    });
    expect(resumeWorkForScope).toHaveBeenCalledExactlyOnceWith({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
    });
  });
});
