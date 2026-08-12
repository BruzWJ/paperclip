import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeState, agents } from "@paperclipai/db";
import { parseMoneyAmount } from "@paperclipai/shared";
import { createMockDb } from "./helpers/mock-db.js";

const budgetMocks = vi.hoisted(() => ({
  getAgentMonthlyKnownSpend: vi.fn(),
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: vi.fn(() => budgetMocks),
}));

import { agentService } from "../services/agents.js";

type AgentRow = typeof agents.$inferSelect;

function agentRow(status: string, id = randomUUID()): AgentRow {
  const now = new Date("2026-06-07T00:00:00.000Z");
  return {
    id,
    companyId: randomUUID(),
    name: "CodexCoder",
    title: null,
    icon: null,
    status,
    reportsTo: null,
    capabilities: null,
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: parseMoneyAmount("0"),
    pauseReason: status === "error" ? "system" : null,
    pausedAt: status === "error" ? now : null,
    errorReason:
      status === "error"
        ? "Secret is not bound to agent at env.ANTHROPIC_API_KEY"
        : null,
    instruction: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("agent service clearError", () => {
  beforeEach(() => {
    budgetMocks.getAgentMonthlyKnownSpend.mockReset();
    budgetMocks.getAgentMonthlyKnownSpend.mockImplementation(
      async (_companyId: string, agentIds: readonly string[]) =>
        new Map(agentIds.map((agentId) => [agentId, parseMoneyAmount("0")])),
    );
  });

  it("moves an error agent to idle without deleting runtime diagnostics", async () => {
    const existing = agentRow("error");
    const updated: AgentRow = {
      ...existing,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
      updatedAt: new Date("2026-06-07T00:01:00.000Z"),
    };
    const { db, calls, remaining } = createMockDb({
      // getById before and after the guarded update: row + company graph.
      select: [[existing], [existing], [updated], [updated]],
      update: [[updated]],
    });

    const cleared = await agentService(db).clearError(existing.id);

    expect(cleared).toMatchObject({
      id: existing.id,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
    });
    expect(
      calls.find(
        (call) => call.operation === "update" && call.method === "set",
      )?.args[0],
    ).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
    });

    const updateTargets = calls
      .filter(
        (call) => call.operation === "update" && call.method === "update",
      )
      .map((call) => call.args[0]);
    expect(updateTargets).toEqual([agents]);
    expect(updateTargets).not.toContain(agentRuntimeState);
    expect(calls.some((call) => call.operation === "delete")).toBe(false);
    expect(remaining("select")).toBe(0);
    expect(remaining("update")).toBe(0);
  });

  it("rejects non-error agents with a 409 conflict", async () => {
    const existing = agentRow("idle");
    const { db, calls, remaining } = createMockDb({
      select: [[existing], [existing]],
    });

    await expect(agentService(db).clearError(existing.id)).rejects.toMatchObject({
      status: 409,
      message: "Only agents in error status can have their error cleared",
    });

    expect(calls.some((call) => call.operation === "update")).toBe(false);
    expect(remaining("select")).toBe(0);
  });

  it("keeps resume-style terminal and pending-approval protections", async () => {
    const protectedCases = [
      {
        row: agentRow("terminated"),
        message: "Cannot clear error on terminated agent",
      },
      {
        row: agentRow("pending_approval"),
        message: "Pending approval agents cannot have errors cleared",
      },
    ];

    for (const { row, message } of protectedCases) {
      const { db, calls, remaining } = createMockDb({
        select: [[row], [row]],
      });

      await expect(agentService(db).clearError(row.id)).rejects.toMatchObject({
        status: 409,
        message,
      });
      expect(calls.some((call) => call.operation === "update")).toBe(false);
      expect(remaining("select")).toBe(0);
    }
  });
});
