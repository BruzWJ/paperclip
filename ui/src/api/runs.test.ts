import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({ api: mockApi }));

import { runsApi } from "./runs";

describe("runsApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.get.mockResolvedValue({ items: [], nextCursor: null });
    mockApi.post.mockResolvedValue({});
  });

  it("lists canonical company run envelopes with typed filters", async () => {
    await runsApi.listForCompany("company-1", {
      agentId: "agent-1",
      status: ["queued", "running"],
      cursor: "cursor-1",
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/runs?agentId=agent-1&status=queued%2Crunning&cursor=cursor-1&limit=25",
    );
  });

  it("lists issue run envelopes without a legacy endpoint fallback", async () => {
    await runsApi.listForIssue("issue-1", { status: ["scheduled_retry"] });

    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(mockApi.get).toHaveBeenCalledWith(
      "/issues/issue-1/runs?status=scheduled_retry",
    );
  });

  it("loads the joined canonical run detail", async () => {
    await runsApi.get("run-1", 50);

    expect(mockApi.get).toHaveBeenCalledWith("/runs/run-1?limit=50");
  });

  it("records a watchdog decision on the canonical run", async () => {
    await runsApi.recordWatchdogDecision({
      runId: "run-1",
      decision: "snooze",
      evaluationIssueId: "issue-2",
      reason: "Waiting for dependency",
      snoozedUntil: "2026-08-01T00:00:00.000Z",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      "/runs/run-1/watchdog-decisions",
      {
        decision: "snooze",
        evaluationIssueId: "issue-2",
        reason: "Waiting for dependency",
        snoozedUntil: "2026-08-01T00:00:00.000Z",
      },
    );
  });
});
