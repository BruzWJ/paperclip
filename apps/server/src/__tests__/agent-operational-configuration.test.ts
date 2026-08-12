import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@paperclipai/db";
import { parseMoneyAmount } from "@paperclipai/shared";
import { createMockDb } from "./helpers/mock-db.js";

const budgetMocks = vi.hoisted(() => ({
  setAgentMonthlyLimitInTransaction: vi.fn(),
  applyCommittedPolicyUpsert: vi.fn(),
}));

const committedBudgetPolicy = { kind: "committed-budget-policy" };

vi.mock("../services/budgets.js", () => ({
  budgetService: vi.fn(() => budgetMocks),
}));

import { createAgentOperationalConfigurationService } from "../services/agent-operational-configuration.js";

type AgentRow = typeof agents.$inferSelect;

function agentRow(status = "idle"): AgentRow {
  const now = new Date("2026-07-01T12:00:00.000Z");
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    name: "Operational agent",
    title: null,
    icon: null,
    status,
    reportsTo: null,
    capabilities: null,
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: parseMoneyAmount("0"),
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    instruction: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("agent operational configuration", () => {
  beforeEach(() => {
    budgetMocks.setAgentMonthlyLimitInTransaction.mockReset();
    budgetMocks.setAgentMonthlyLimitInTransaction.mockResolvedValue(
      committedBudgetPolicy,
    );
    budgetMocks.applyCommittedPolicyUpsert.mockReset();
    budgetMocks.applyCommittedPolicyUpsert.mockResolvedValue(undefined);
  });

  it("atomically synchronizes the agent projection and monthly policy", async () => {
    const agent = agentRow();
    const updatedAgent: AgentRow = {
      ...agent,
      icon: "bot",
      budgetMonthlyAmount: parseMoneyAmount("25"),
    };
    const { db, calls, remaining } = createMockDb({
      select: [[agent], [updatedAgent]],
      update: [[]],
    });
    const service = createAgentOperationalConfigurationService(db);

    const result = await service.update({
      companyId: agent.companyId,
      agentId: agent.id,
      configuration: {
        icon: "bot",
        budgetMonthlyAmount: parseMoneyAmount("25"),
      },
      actorUserId: "board-user",
    });

    expect(result.agent).toMatchObject({
      id: agent.id,
      icon: "bot",
      budgetMonthlyAmount: "25",
    });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(
      calls.find((call) => call.operation === "update" && call.method === "set")
        ?.args[0],
    ).toMatchObject({ icon: "bot" });
    expect(budgetMocks.setAgentMonthlyLimitInTransaction).toHaveBeenCalledWith(
      agent.companyId,
      agent.id,
      parseMoneyAmount("25"),
      "board-user",
    );
    expect(
      budgetMocks.applyCommittedPolicyUpsert,
    ).toHaveBeenCalledExactlyOnceWith(committedBudgetPolicy);
    expect(
      budgetMocks.setAgentMonthlyLimitInTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(
      budgetMocks.applyCommittedPolicyUpsert.mock.invocationCallOrder[0]!,
    );
    expect(remaining("select")).toBe(0);
    expect(remaining("update")).toBe(0);
  });

  it("rejects fields owned by other configuration contracts", async () => {
    const agent = agentRow();
    const { db, calls } = createMockDb();
    const service = createAgentOperationalConfigurationService(db);

    await expect(
      service.update({
        companyId: agent.companyId,
        agentId: agent.id,
        configuration: {
          name: "Mixed writer",
          adapterType: "codex",
        },
        actorUserId: "board-user",
      }),
    ).rejects.toMatchObject({
      status: 422,
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(
      budgetMocks.setAgentMonthlyLimitInTransaction,
    ).not.toHaveBeenCalled();
    expect(budgetMocks.applyCommittedPolicyUpsert).not.toHaveBeenCalled();
  });

  it("updates a role instruction without changing the monthly budget policy", async () => {
    const agent = agentRow();
    const updatedAgent: AgentRow = {
      ...agent,
      instruction: "Review changes carefully before reporting completion.",
    };
    const { db, calls, remaining } = createMockDb({
      select: [[agent], [updatedAgent]],
      update: [[]],
    });
    const service = createAgentOperationalConfigurationService(db);

    const result = await service.update({
      companyId: agent.companyId,
      agentId: agent.id,
      configuration: { instruction: updatedAgent.instruction },
      actorUserId: "board-user",
    });

    expect(result.agent.instruction).toBe(updatedAgent.instruction);
    expect(
      calls.find((call) => call.operation === "update" && call.method === "set")
        ?.args[0],
    ).toMatchObject({ instruction: updatedAgent.instruction });
    expect(
      budgetMocks.setAgentMonthlyLimitInTransaction,
    ).not.toHaveBeenCalled();
    expect(budgetMocks.applyCommittedPolicyUpsert).not.toHaveBeenCalled();
    expect(remaining("select")).toBe(0);
    expect(remaining("update")).toBe(0);
  });

  it("does not mutate terminated agents", async () => {
    const agent = agentRow("terminated");
    const { db, calls, remaining } = createMockDb({ select: [[agent]] });
    const service = createAgentOperationalConfigurationService(db);

    await expect(
      service.update({
        companyId: agent.companyId,
        agentId: agent.id,
        configuration: { budgetMonthlyAmount: parseMoneyAmount("25") },
        actorUserId: "board-user",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "terminated_agent_operational_configuration",
      },
    });

    expect(
      calls.filter(
        (call) => call.operation === "update" || call.operation === "insert",
      ),
    ).toHaveLength(0);
    expect(
      budgetMocks.setAgentMonthlyLimitInTransaction,
    ).not.toHaveBeenCalled();
    expect(budgetMocks.applyCommittedPolicyUpsert).not.toHaveBeenCalled();
    expect(remaining("select")).toBe(0);
  });
});
