import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentAnnotationService } from "../services/document-annotations.js";
import { createMockDb } from "./helpers/mock-db.js";

const referenceMocks = vi.hoisted(() => ({
  syncAnnotationComment: vi.fn(async () => undefined),
}));

vi.mock("../services/issue-references.js", () => ({
  issueReferenceService: () => referenceMocks,
}));

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const ISSUE_ID = "00000000-0000-4000-8000-000000000002";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000003";
const REVISION_ID = "00000000-0000-4000-8000-000000000004";
const ISSUE_COMMENT_ID = "00000000-0000-4000-8000-000000000005";

const actor = {
  actorType: "user",
  actorId: "board-user",
  userId: "board-user",
} as const;

const selector = {
  quote: {
    exact: "selected text",
    prefix: "Alpha ",
    suffix: " omega",
  },
  position: {
    normalizedStart: 6,
    normalizedEnd: 19,
    markdownStart: 6,
    markdownEnd: 19,
  },
};

function issueDocument(overrides: Record<string, unknown> = {}) {
  return {
    issueId: ISSUE_ID,
    companyId: COMPANY_ID,
    documentId: DOCUMENT_ID,
    documentKey: "plan",
    latestBody: "Alpha selected text omega",
    latestRevisionId: REVISION_ID,
    latestRevisionNumber: 1,
    ...overrides,
  };
}

describe("documentAnnotationService database boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a linked comment that is absent from the same issue", async () => {
    const harness = createMockDb({
      execute: [[]],
      select: [[issueDocument()], []],
    });
    const service = documentAnnotationService(harness.db);

    await expect(service.createThread(
      ISSUE_ID,
      "plan",
      {
        baseRevisionId: REVISION_ID,
        baseRevisionNumber: 1,
        selector,
        body: "Do not link a missing comment",
        issueCommentId: ISSUE_COMMENT_ID,
      },
      actor,
    )).rejects.toMatchObject({
      status: 422,
      message: "Linked issue comment must belong to this issue",
    });

    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(referenceMocks.syncAnnotationComment).not.toHaveBeenCalled();
  });

  it("creates the annotation and its reference projection in one transaction", async () => {
    const threadId = "00000000-0000-4000-8000-000000000020";
    const annotationCommentId = "00000000-0000-4000-8000-000000000010";
    const thread = {
      id: threadId,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      documentId: DOCUMENT_ID,
      documentKey: "plan",
      status: "open",
    };
    const comment = {
      id: annotationCommentId,
      companyId: COMPANY_ID,
      threadId,
      issueId: ISSUE_ID,
      documentId: DOCUMENT_ID,
      body: "Linked annotation",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "board-user",
      createdByRunId: null,
      issueCommentId: ISSUE_COMMENT_ID,
    };
    const harness = createMockDb({
      execute: [[]],
      select: [
        [issueDocument()],
        [{ id: ISSUE_COMMENT_ID, companyId: COMPANY_ID, issueId: ISSUE_ID }],
      ],
      insert: [[thread], [comment]],
    });
    const service = documentAnnotationService(harness.db);

    await expect(service.createThread(
      ISSUE_ID,
      "plan",
      {
        baseRevisionId: REVISION_ID,
        baseRevisionNumber: 1,
        selector,
        body: "Linked annotation",
        issueCommentId: ISSUE_COMMENT_ID,
      },
      actor,
    )).resolves.toEqual({ ...thread, comments: [comment] });

    expect(referenceMocks.syncAnnotationComment).toHaveBeenCalledWith(
      annotationCommentId,
      harness.db,
    );
    expect(harness.calls.filter((call) => call.operation === "insert" && call.method === "insert"))
      .toHaveLength(2);
  });

  it("checks the locked current revision before writing an annotation thread", async () => {
    const harness = createMockDb({
      execute: [[]],
      select: [[issueDocument({
        latestRevisionId: "00000000-0000-4000-8000-000000000099",
        latestRevisionNumber: 2,
        latestBody: "Alpha changed text omega",
      })]],
    });
    const service = documentAnnotationService(harness.db);

    await expect(service.createThread(
      ISSUE_ID,
      "plan",
      {
        baseRevisionId: REVISION_ID,
        baseRevisionNumber: 1,
        selector,
        body: "This revision already lost the race",
      },
      actor,
    )).rejects.toMatchObject({
      status: 409,
      message: "Annotation anchor requires the current document revision",
      details: {
        currentRevisionId: "00000000-0000-4000-8000-000000000099",
        currentRevisionNumber: 2,
      },
    });

    expect(harness.calls[0]).toMatchObject({ operation: "execute", method: "execute" });
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(referenceMocks.syncAnnotationComment).not.toHaveBeenCalled();
  });
});
