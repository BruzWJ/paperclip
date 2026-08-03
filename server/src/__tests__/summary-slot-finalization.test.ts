import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeSummarySlotsForTerminalIssue } from "../services/summary-slot-finalization.js";
import { createMockDb } from "./helpers/mock-db.js";

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  identifier: "SUM-1",
  title: "Refresh project summary",
  boardPresentationStatus: "done" as const,
  ownerAgentId: "33333333-3333-4333-8333-333333333333",
  creatorRoutineId: "44444444-4444-4444-8444-444444444444",
  creatorRoutineDispatchId: "55555555-5555-4555-8555-555555555555",
};

const source = {
  updateId: "66666666-6666-4666-8666-666666666666",
  commentId: "77777777-7777-4777-8777-777777777777",
  runId: "run_summary_projection",
};

const slot = {
  id: "88888888-8888-4888-8888-888888888888",
  documentId: null,
};

const body = "**Nothing to decide right now.**\n\n**Recent work:**\n- SUM-2 is ready.";
const comment = {
  id: source.commentId,
  body,
  authorAgentId: issue.ownerAgentId,
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
};
const update = { id: source.updateId, message: body };

function methodArgs(
  calls: ReturnType<typeof createMockDb>["calls"],
  operation: "insert" | "update",
  method: "values" | "set",
) {
  return calls
    .filter((call) => call.operation === operation && call.method === method)
    .map((call) => call.args[0] as Record<string, unknown>);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("summary routine terminal projection", () => {
  it("projects one canonical terminal comment and completes the routine run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const document = {
      id: "99999999-9999-4999-8999-999999999999",
      latestRevisionNumber: 1,
    };
    const revision = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const harness = createMockDb({
      select: [[slot], [update], [comment], []],
      insert: [[document], [revision]],
      update: [[document], [{ id: slot.id }], []],
    });

    await expect(
      finalizeSummarySlotsForTerminalIssue(harness.db, issue, source),
    ).resolves.toEqual([{ id: slot.id }]);

    const inserts = methodArgs(harness.calls, "insert", "values");
    expect(inserts[0]).toMatchObject({
      companyId: issue.companyId,
      title: issue.title,
      format: "markdown",
      latestBody: body,
      createdByAgentId: issue.ownerAgentId,
    });
    expect(inserts[1]).toMatchObject({
      documentId: document.id,
      revisionNumber: 1,
      body,
      createdByRunId: source.runId,
      sourceIssueCommentId: source.commentId,
    });

    const updates = methodArgs(harness.calls, "update", "set");
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: document.id,
        status: "idle",
        generatingIssueId: null,
        lastGeneratedByAgentId: issue.ownerAgentId,
      }),
      expect.objectContaining({
        status: "completed",
        failureReason: null,
      }),
    ]));
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("acknowledges an existing source-comment projection without inserting again", async () => {
    const harness = createMockDb({
      select: [
        [slot],
        [update],
        [comment],
        [{ id: "existing-revision" }],
      ],
      update: [[], []],
    });

    await expect(
      finalizeSummarySlotsForTerminalIssue(harness.db, issue, source),
    ).resolves.toEqual([{ id: slot.id }]);

    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    const updates = methodArgs(harness.calls, "update", "set");
    expect(updates[0]).toMatchObject({
      status: "idle",
      generatingIssueId: null,
      lastGeneratedAt: comment.createdAt,
      lastGeneratedByAgentId: issue.ownerAgentId,
    });
    expect(updates[1]).toMatchObject({ status: "completed" });
  });

  it("fails both the slot and routine run when the terminal comment is invalid", async () => {
    const harness = createMockDb({
      select: [[slot], [update], [{ ...comment, body: "   " }]],
      update: [[{ id: slot.id }], []],
    });

    await expect(
      finalizeSummarySlotsForTerminalIssue(harness.db, issue, source),
    ).resolves.toEqual([{ id: slot.id }]);

    const updates = methodArgs(harness.calls, "update", "set");
    expect(updates[0]).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("no valid canonical terminal comment"),
    });
    expect(updates[1]).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("no valid canonical terminal comment"),
    });
  });

  it("does no database work for a non-terminal issue", async () => {
    const harness = createMockDb();

    await expect(
      finalizeSummarySlotsForTerminalIssue(harness.db, {
        ...issue,
        boardPresentationStatus: "in_progress",
      }),
    ).resolves.toEqual([]);

    expect(harness.calls).toEqual([]);
  });
});
