import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(
  status: string,
  type = "request_board_approval",
): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type,
    status,
    payload: {},
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(
  selectResults: ApprovalRecord[][],
  updateResults: ApprovalRecord[],
) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(
    async () => pendingSelectResults.shift() ?? [],
  );
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats repeated generic approve retries as no-ops", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const result = await approvalService(
      dbStub.db as never,
      {
        dispatchRef: async () => undefined,
      },
    ).approve("approval-1", "board", "ship it");

    expect(result).toMatchObject({
      applied: false,
      approval: { status: "approved" },
    });
  });

  it("treats repeated generic reject retries as no-ops", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const result = await approvalService(
      dbStub.db as never,
      {
        dispatchRef: async () => undefined,
      },
    ).reject("approval-1", "board", "not now");

    expect(result).toMatchObject({
      applied: false,
      approval: { status: "rejected" },
    });
  });

  it("rejects delayed-create hire approvals at the generic service boundary", () => {
    const dbStub = createDbStub([], []);
    expect(() =>
      approvalService(dbStub.db as never, {
        dispatchRef: async () => undefined,
      }).create(
        "company-1",
        {
          type: "hire_agent",
          payload: { name: "Delayed create" },
        },
      ),
    ).toThrow(
      "Hire approvals are created only by the canonical runtime-agent transaction",
    );
  });
});
