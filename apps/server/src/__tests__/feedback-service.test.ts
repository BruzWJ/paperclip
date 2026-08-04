import { describe, expect, it } from "vitest";
import { feedbackService } from "../services/feedback.js";
import { createMockDb } from "./helpers/mock-db.js";

const now = new Date("2026-05-06T07:08:09.000Z");

function traceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "trace-1",
    companyId: "company-1",
    feedbackVoteId: "vote-1",
    issueId: "issue-1",
    projectId: "project-1",
    issueIdentifier: "PAP-1",
    issueTitle: "Improve feedback",
    authorUserId: "board-user",
    targetType: "issue_comment",
    targetId: "comment-1",
    vote: "down",
    status: "local_only",
    destination: null,
    exportId: "feedback-export-1",
    consentVersion: null,
    schemaVersion: "paperclip-feedback-envelope-v2",
    bundleVersion: "paperclip-feedback-bundle-v2",
    payloadVersion: "paperclip-feedback-v1",
    payloadDigest: "sha256:digest",
    payloadSnapshot: { target: { body: "Sanitized response" } },
    targetSummary: {
      label: "Agent response",
      excerpt: "Sanitized response",
      authorAgentId: "agent-1",
      authorUserId: null,
      createdAt: now,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
    },
    redactionSummary: { redactedFieldCount: 1 },
    attemptCount: 0,
    lastAttemptedAt: null,
    exportedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("feedbackService", () => {
  it("lists only the requesting user's issue votes through the scoped query", async () => {
    const rows = [{
      id: "vote-1",
      issueId: "issue-1",
      authorUserId: "board-user",
      targetType: "issue_comment",
      targetId: "comment-1",
      vote: "up",
    }];
    const mock = createMockDb({ select: [rows] });

    await expect(feedbackService(mock.db)
      .listIssueVotesForUser("issue-1", "board-user"))
      .resolves.toEqual(rows);
    expect(mock.remaining("select")).toBe(0);
  });

  it("maps trace metadata while withholding payload snapshots by default", async () => {
    const mock = createMockDb({ select: [[traceRow()]] });

    const [trace] = await feedbackService(mock.db).listFeedbackTraces({
      companyId: "company-1",
      issueId: "issue-1",
      vote: "down",
    });

    expect(trace).toMatchObject({
      id: "trace-1",
      companyId: "company-1",
      issueIdentifier: "PAP-1",
      issueTitle: "Improve feedback",
      vote: "down",
      status: "local_only",
      payloadSnapshot: null,
      targetSummary: expect.objectContaining({ label: "Agent response" }),
      redactionSummary: { redactedFieldCount: 1 },
    });
  });

  it("returns the sanitized payload only when explicitly requested", async () => {
    const mock = createMockDb({ select: [[traceRow()]] });

    const trace = await feedbackService(mock.db).getFeedbackTraceById("trace-1", true);

    expect(trace?.payloadSnapshot).toEqual({
      target: { body: "Sanitized response" },
    });
  });

  it("marks pending traces failed when no export backend is configured", async () => {
    const mock = createMockDb({
      select: [[
        { id: "trace-1", attemptCount: 0 },
        { id: "trace-2", attemptCount: 2 },
      ]],
      update: [[], []],
    });

    const result = await feedbackService(mock.db).flushPendingFeedbackTraces({
      companyId: "company-1",
      limit: 25,
      now,
    });

    expect(result).toEqual({ attempted: 2, sent: 0, failed: 2 });
    const setValues = mock.calls
      .filter((call) => call.operation === "update" && call.method === "set")
      .map((call) => call.args[0]);
    expect(setValues).toEqual([
      expect.objectContaining({
        status: "failed",
        attemptCount: 1,
        lastAttemptedAt: now,
        failureReason: "Feedback export backend is not configured",
      }),
      expect.objectContaining({
        status: "failed",
        attemptCount: 3,
        lastAttemptedAt: now,
        failureReason: "Feedback export backend is not configured",
      }),
    ]);
    expect(mock.remaining("update")).toBe(0);
  });

  it("does no writes when there are no pending traces", async () => {
    const mock = createMockDb({ select: [[]] });

    await expect(feedbackService(mock.db).flushPendingFeedbackTraces())
      .resolves.toEqual({ attempted: 0, sent: 0, failed: 0 });
    expect(mock.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("rejects votes for an unknown issue before resolving targets or writing traces", async () => {
    const mock = createMockDb({ select: [[]] });

    await expect(feedbackService(mock.db).saveIssueVote({
      issueId: "missing-issue",
      targetType: "issue_comment",
      targetId: "comment-1",
      vote: "down",
      authorUserId: "board-user",
      reason: "Incorrect result",
      allowSharing: false,
    })).rejects.toMatchObject({ status: 404 });

    expect(mock.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(mock.calls.some((call) => call.operation === "update")).toBe(false);
  });
});
