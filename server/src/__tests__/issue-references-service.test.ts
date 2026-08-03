import { describe, expect, it } from "vitest";
import { issueReferenceService } from "../services/issue-references.ts";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const sourceIssueId = "00000000-0000-4000-8000-000000000002";
const targetTwoId = "00000000-0000-4000-8000-000000000003";
const targetThreeId = "00000000-0000-4000-8000-000000000004";
const inboundIssueId = "00000000-0000-4000-8000-000000000005";

describe("issueReferenceService", () => {
  it("extracts and replaces issue, comment, and document source mentions", async () => {
    const issueHarness = createMockDb({
      select: [
        [{
          id: sourceIssueId,
          companyId,
          title: "Coordinate PAP-2",
          request: "Review /issues/pap-3 and ignore PAP-1 self references.",
        }],
        [{ id: targetTwoId, identifier: "PAP-2" }],
        [
          { id: targetThreeId, identifier: "PAP-3" },
          { id: sourceIssueId, identifier: "PAP-1" },
        ],
      ],
      delete: [[], []],
      insert: [[], []],
    });
    await issueReferenceService(issueHarness.db).syncIssue(
      sourceIssueId,
      issueHarness.db as never,
    );

    const issueValues = issueHarness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(issueValues).toEqual([
      [{
        companyId,
        sourceIssueId,
        targetIssueId: targetTwoId,
        sourceKind: "title",
        sourceRecordId: null,
        documentKey: null,
        matchedText: "PAP-2",
      }],
      [{
        companyId,
        sourceIssueId,
        targetIssueId: targetThreeId,
        sourceKind: "request",
        sourceRecordId: null,
        documentKey: null,
        matchedText: "/issues/pap-3",
      }],
    ]);

    const commentId = "00000000-0000-4000-8000-000000000006";
    const commentHarness = createMockDb({
      select: [
        [{
          id: commentId,
          companyId,
          issueId: sourceIssueId,
          body: "Follow up in https://paperclip.test/issues/pap-2.",
        }],
        [{ id: targetTwoId, identifier: "PAP-2" }],
      ],
      delete: [[]],
      insert: [[]],
    });
    await issueReferenceService(commentHarness.db).syncComment(
      commentId,
      commentHarness.db as never,
    );
    expect(
      commentHarness.calls.find(
        (call) => call.operation === "insert" && call.method === "values",
      )?.args[0],
    ).toEqual([expect.objectContaining({
      sourceKind: "comment",
      sourceRecordId: commentId,
      targetIssueId: targetTwoId,
    })]);

    const documentId = "00000000-0000-4000-8000-000000000007";
    const documentHarness = createMockDb({
      select: [
        [{
          documentId,
          companyId,
          issueId: sourceIssueId,
          key: "plan",
          body: "Spec note: /PAP/issues/PAP-3",
        }],
        [{ id: targetThreeId, identifier: "PAP-3" }],
      ],
      delete: [[]],
      insert: [[]],
    });
    await issueReferenceService(documentHarness.db).syncDocument(
      documentId,
      documentHarness.db as never,
    );
    expect(
      documentHarness.calls.find(
        (call) => call.operation === "insert" && call.method === "values",
      )?.args[0],
    ).toEqual([expect.objectContaining({
      sourceKind: "document",
      sourceRecordId: documentId,
      documentKey: "plan",
      targetIssueId: targetThreeId,
    })]);
  });

  it("groups, orders, and counts outbound and inbound references", async () => {
    const related = (
      id: string,
      identifier: string,
      title: string,
      sourceKind: "title" | "request" | "document" | "comment",
      sourceRecordId: string | null,
      documentKey: string | null = null,
    ) => ({
      relatedIssueId: id,
      relatedIssueIdentifier: identifier,
      relatedIssueTitle: title,
      relatedIssueBoardPresentationStatus: "todo",
      relatedIssuePriority: "medium",
      relatedIssueOwnerAgentId: null,
      relatedIssueOwnerUserId: null,
      sourceKind,
      sourceRecordId,
      documentKey,
      matchedText: identifier,
    });
    const { db } = createMockDb({
      select: [
        [{ id: sourceIssueId, companyId, title: "Source", request: null }],
        [
          related(targetTwoId, "PAP-2", "Target two", "title", null),
          related(targetTwoId, "PAP-2", "Target two", "comment", "comment-1"),
          related(targetThreeId, "PAP-3", "Target three", "request", null),
          related(targetThreeId, "PAP-3", "Target three", "document", "document-1", "plan"),
        ],
        [related(inboundIssueId, "PAP-4", "Inbound reference", "request", null)],
      ],
    });

    const summary = await issueReferenceService(db).listIssueReferenceSummary(sourceIssueId);

    expect(summary.outbound.map((item) => item.issue.identifier)).toEqual(["PAP-3", "PAP-2"]);
    expect(summary.outbound[0]?.mentionCount).toBe(2);
    expect(summary.outbound[0]?.sources.map((source) => source.label)).toEqual(["request", "plan"]);
    expect(summary.outbound[1]?.mentionCount).toBe(2);
    expect(summary.outbound[1]?.sources.map((source) => source.label)).toEqual(["title", "comment"]);
    expect(summary.inbound.map((item) => item.issue.identifier)).toEqual(["PAP-4"]);
  });

  it("projects an annotation comment and deletes its source projection", async () => {
    const annotationCommentId = "00000000-0000-4000-8000-000000000008";
    const { db, calls } = createMockDb({
      select: [
        [{
          id: annotationCommentId,
          companyId,
          issueId: sourceIssueId,
          body: "Review PAP-20.",
        }],
        [{ id: targetTwoId, identifier: "PAP-20" }],
      ],
      delete: [[], []],
      insert: [[]],
    });
    const refs = issueReferenceService(db);

    await refs.syncAnnotationComment(annotationCommentId, db as never);
    await refs.deleteCommentSource(annotationCommentId, db as never);

    expect(calls.find(
      (call) => call.operation === "insert" && call.method === "values",
    )?.args[0]).toEqual([expect.objectContaining({
      sourceIssueId,
      sourceKind: "comment",
      sourceRecordId: annotationCommentId,
      targetIssueId: targetTwoId,
    })]);
    expect(calls.filter(
      (call) => call.operation === "delete" && call.method === "where",
    )).toHaveLength(2);
  });
});
