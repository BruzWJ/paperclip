import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyService } from "../services/companies.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  getCompanyMonthlyKnownSpend: vi.fn(),
  createCompany: vi.fn(),
  logActivity: vi.fn(),
  archiveCompanySessionGraphInTx: vi.fn(),
  reactivateCompanySessionGraphInTx: vi.fn(),
  beginCompanyHardDeleteInTx: vi.fn(),
  purgeCompanySessionGraphInTx: vi.fn(),
}));

vi.mock("../services/budgets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/budgets.js")>();
  return {
    ...actual,
    budgetService: vi.fn(() => ({
      getCompanyMonthlyKnownSpend: mocks.getCompanyMonthlyKnownSpend,
      createCompany: mocks.createCompany,
    })),
  };
});

vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.logActivity }));

vi.mock("../services/issue-session-lifecycle.js", () => ({
  archiveCompanySessionGraphInTx: mocks.archiveCompanySessionGraphInTx,
  reactivateCompanySessionGraphInTx: mocks.reactivateCompanySessionGraphInTx,
  beginCompanyHardDeleteInTx: mocks.beginCompanyHardDeleteInTx,
  purgeCompanySessionGraphInTx: mocks.purgeCompanySessionGraphInTx,
}));

const now = new Date("2026-01-02T03:04:05.000Z");

function companyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 12,
    budgetCurrency: "USD",
    budgetMonthlyAmount: "1000",
    attachmentMaxBytes: 10_000_000,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    brandColor: null,
    logoAssetId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("companyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCompanyMonthlyKnownSpend.mockImplementation(async (ids: string[]) =>
      new Map(ids.map((id) => [id, "0"])),
    );
    mocks.logActivity.mockResolvedValue(undefined);
  });

  it("hydrates company lists with canonical spend and logo URLs", async () => {
    const mock = createMockDb({
      select: [[
        companyRow({ id: "company-1", logoAssetId: "asset-1" }),
        companyRow({ id: "company-2", name: "Second", logoAssetId: null }),
      ]],
    });
    mocks.getCompanyMonthlyKnownSpend.mockResolvedValue(new Map([
      ["company-1", "12.50"],
      ["company-2", "0"],
    ]));

    const result = await companyService(mock.db).list();

    expect(result).toEqual([
      expect.objectContaining({
        id: "company-1",
        knownSpendAmount: "12.50",
        logoUrl: "/api/assets/asset-1/content",
      }),
      expect.objectContaining({
        id: "company-2",
        knownSpendAmount: "0",
        logoUrl: null,
      }),
    ]);
    expect(mocks.getCompanyMonthlyKnownSpend).toHaveBeenCalledWith(["company-1", "company-2"]);
  });

  it("creates through the budget owner", async () => {
    const created = companyRow();
    const mock = createMockDb({ select: [[created]] });
    mocks.createCompany.mockResolvedValue({ id: "company-1" });

    const result = await companyService(mock.db).create({
      name: "Paperclip",
      budgetCurrency: "USD",
      budgetMonthlyAmount: "1000",
    }, "board-user");

    expect(mocks.createCompany).toHaveBeenCalledWith(expect.objectContaining({
      name: "Paperclip",
    }), "board-user");
    expect(result).toMatchObject({ id: "company-1", knownSpendAmount: "0", logoUrl: null });
  });

  it("archives through the canonical session lifecycle before pausing runnable agents", async () => {
    const existing = companyRow();
    const archived = companyRow({ status: "archived", pauseReason: "company_archived", pausedAt: now });
    const mock = createMockDb({
      select: [[existing]],
      update: [[{ id: "agent-1" }, { id: "agent-2" }], [archived]],
    });
    mocks.archiveCompanySessionGraphInTx.mockResolvedValue({
      operation: { id: "lifecycle-1" },
      runs: [{ id: "run-1" }],
      intents: [{ id: "intent-1" }],
    });

    const result = await companyService(mock.db).update(
      "company-1",
      { status: "archived" },
      { actorType: "user", actorId: "board-user" },
    );

    expect(mocks.archiveCompanySessionGraphInTx).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      expect.any(String),
      { actor: { requestedByAgentId: null, requestedByUserId: "board-user" } },
    );
    expect(result).toMatchObject({ id: "company-1", status: "archived" });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.archived",
      actorType: "user",
      actorId: "board-user",
      details: {
        agentsPaused: 2,
        lifecycleOperationId: "lifecycle-1",
        affectedRunCount: 1,
        cancellationIntentCount: 1,
      },
    }));
  });

  it("reactivates only agents carrying the company-archived pause reason", async () => {
    const existing = companyRow({ status: "archived", pauseReason: "company_archived", pausedAt: now });
    const active = companyRow({ status: "active" });
    const mock = createMockDb({
      select: [[existing]],
      update: [[active], [{ id: "agent-1" }]],
    });
    mocks.reactivateCompanySessionGraphInTx.mockResolvedValue(undefined);

    const result = await companyService(mock.db).update(
      "company-1",
      { status: "active" },
      { actorType: "system", actorId: "operator" },
    );

    expect(mocks.reactivateCompanySessionGraphInTx).toHaveBeenCalledWith(
      expect.anything(),
      { companyId: "company-1" },
    );
    expect(result).toMatchObject({ status: "active" });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.reactivated",
      details: { agentsRestored: 1 },
    }));
  });

  it("aggregates per-company agent and issue counts", async () => {
    const mock = createMockDb({
      select: [
        [{ companyId: "company-1", count: 3 }, { companyId: "company-2", count: 1 }],
        [{ companyId: "company-1", count: 8 }, { companyId: "company-3", count: 2 }],
      ],
    });

    await expect(companyService(mock.db).stats()).resolves.toEqual({
      "company-1": { agentCount: 3, issueCount: 8 },
      "company-2": { agentCount: 1, issueCount: 0 },
      "company-3": { agentCount: 0, issueCount: 2 },
    });
  });
});
