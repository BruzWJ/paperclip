import { describe, expect, it, vi } from "vitest";
import { costService } from "../services/costs.js";

function sequenceDb(results: readonly unknown[][]) {
  const pending = [...results];
  const select = vi.fn(() => {
    const rows = pending.shift() ?? [];
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(async () => rows),
      then: vi.fn((resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(resolve(rows))),
    };
    return chain;
  });
  return { select };
}

const EVENT = {
  id: "00000000-0000-4000-8000-000000000001",
  accountingId: "00000000-0000-4000-8000-000000000002",
  companyId: "00000000-0000-4000-8000-000000000003",
  taskId: "00000000-0000-4000-8000-000000000004",
  agentId: "00000000-0000-4000-8000-000000000005",
  runId: "00000000-0000-4000-8000-000000000006",
  runKind: "productive",
  promptKind: "base",
  refId: "00000000-0000-4000-8000-000000000007",
  runOrdinal: 0,
  segmentOrdinal: 0,
  budgetCurrency: "EUR",
  kind: "known",
  unavailableReason: null,
  observedCumulativeAmount: "10.125",
  observedCurrency: "EUR",
  knownDeltaAmount: "2.125",
  cursorBeforeState: "known",
  cursorBeforeAmount: "8",
  cursorBeforeCurrency: "EUR",
  cursorAfterState: "known",
  cursorAfterAmount: "10.125",
  cursorAfterCurrency: "EUR",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
} as const;

describe("canonical AI cost readers", () => {
  it("returns immutable settled-prompt facts with exact decimal strings", async () => {
    const db = sequenceDb([
      [{ budgetCurrency: "EUR", budgetMonthlyAmount: "100" }],
      [EVENT],
    ]);

    await expect(
      costService(db as never).listEvents(EVENT.companyId),
    ).resolves.toEqual([EVENT]);
  });

  it("keeps unavailable prompt facts unpriced without inventing zero cost", async () => {
    const unavailable = {
      ...EVENT,
      id: "00000000-0000-4000-8000-000000000008",
      kind: "unavailable",
      unavailableReason: "absent",
      observedCumulativeAmount: null,
      observedCurrency: null,
      knownDeltaAmount: null,
      cursorAfterState: "unavailable",
      cursorAfterAmount: null,
      cursorAfterCurrency: null,
    } as const;
    const db = sequenceDb([
      [{ budgetCurrency: "EUR", budgetMonthlyAmount: "100" }],
      [unavailable],
    ]);

    const [event] = await costService(db as never).listEvents(EVENT.companyId);
    expect(event).toMatchObject({
      kind: "unavailable",
      unavailableReason: "absent",
      observedCumulativeAmount: null,
      knownDeltaAmount: null,
      cursorAfterState: "unavailable",
    });
  });

  it("groups agent cost only from known deltas in the company currency", async () => {
    const db = sequenceDb([
      [{ budgetCurrency: "JPY", budgetMonthlyAmount: "5000" }],
      [
        {
          agentId: EVENT.agentId,
          agentName: "Canonical Agent",
          agentStatus: "idle",
          knownAmount: "125.5",
          pricedPromptCount: 2,
          unpricedPromptCount: 1,
        },
      ],
    ]);

    await expect(costService(db as never).byAgent(EVENT.companyId)).resolves.toEqual([
      {
        agentId: EVENT.agentId,
        agentName: "Canonical Agent",
        agentStatus: "idle",
        budgetCurrency: "JPY",
        knownCostAmount: "125.5",
        pricedPromptCount: 2,
        unpricedPromptCount: 1,
      },
    ]);
  });
});
