import { describe, expect, it } from "vitest";
import { taskReferenceService } from "../services/task-references.ts";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const sourceTaskId = "00000000-0000-4000-8000-000000000002";
const targetTwoId = "00000000-0000-4000-8000-000000000003";
const targetThreeId = "00000000-0000-4000-8000-000000000004";
const inboundTaskId = "00000000-0000-4000-8000-000000000005";

describe("taskReferenceService", () => {
  it("extracts and replaces task, comment, and document source mentions", async () => {
    const taskHarness = createMockDb({
      select: [
        [{
          id: sourceTaskId,
          companyId,
          title: "Coordinate PAP-2",
          request: "Review /tasks/pap-3 and ignore PAP-1 self references.",
        }],
        [{ id: targetTwoId, identifier: "PAP-2" }],
        [
          { id: targetThreeId, identifier: "PAP-3" },
          { id: sourceTaskId, identifier: "PAP-1" },
        ],
      ],
      delete: [[], []],
      insert: [[], []],
    });
    await taskReferenceService(taskHarness.db).syncTask(
      sourceTaskId,
      taskHarness.db as never,
    );

    const taskValues = taskHarness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(taskValues).toEqual([
      [{
        companyId,
        sourceTaskId,
        targetTaskId: targetTwoId,
        sourceKind: "title",
        sourceRecordId: null,
        documentKey: null,
        matchedText: "PAP-2",
      }],
      [{
        companyId,
        sourceTaskId,
        targetTaskId: targetThreeId,
        sourceKind: "request",
        sourceRecordId: null,
        documentKey: null,
        matchedText: "/tasks/pap-3",
      }],
    ]);

    const commentId = "00000000-0000-4000-8000-000000000006";
    const commentHarness = createMockDb({
      select: [
        [{
          id: commentId,
          companyId,
          taskId: sourceTaskId,
          body: "Follow up in https://paperclip.test/tasks/pap-2.",
        }],
        [{ id: targetTwoId, identifier: "PAP-2" }],
      ],
      delete: [[]],
      insert: [[]],
    });
    await taskReferenceService(commentHarness.db).syncComment(
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
      targetTaskId: targetTwoId,
    })]);

    const documentId = "00000000-0000-4000-8000-000000000007";
    const documentHarness = createMockDb({
      select: [
        [{
          documentId,
          companyId,
          taskId: sourceTaskId,
          key: "plan",
          body: "Spec note: /PAP/tasks/PAP-3",
        }],
        [{ id: targetThreeId, identifier: "PAP-3" }],
      ],
      delete: [[]],
      insert: [[]],
    });
    await taskReferenceService(documentHarness.db).syncDocument(
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
      targetTaskId: targetThreeId,
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
      relatedTaskId: id,
      relatedTaskIdentifier: identifier,
      relatedTaskTitle: title,
      relatedTaskBoardPresentationStatus: "todo",
      relatedTaskPriority: "medium",
      relatedTaskOwnerAgentId: null,
      relatedTaskOwnerUserId: null,
      sourceKind,
      sourceRecordId,
      documentKey,
      matchedText: identifier,
    });
    const { db } = createMockDb({
      select: [
        [{ id: sourceTaskId, companyId, title: "Source", request: null }],
        [
          related(targetTwoId, "PAP-2", "Target two", "title", null),
          related(targetTwoId, "PAP-2", "Target two", "comment", "comment-1"),
          related(targetThreeId, "PAP-3", "Target three", "request", null),
          related(targetThreeId, "PAP-3", "Target three", "document", "document-1", "plan"),
        ],
        [related(inboundTaskId, "PAP-4", "Inbound reference", "request", null)],
      ],
    });

    const summary = await taskReferenceService(db).listTaskReferenceSummary(sourceTaskId);

    expect(summary.outbound.map((item) => item.task.identifier)).toEqual(["PAP-3", "PAP-2"]);
    expect(summary.outbound[0]?.mentionCount).toBe(2);
    expect(summary.outbound[0]?.sources.map((source) => source.label)).toEqual(["request", "plan"]);
    expect(summary.outbound[1]?.mentionCount).toBe(2);
    expect(summary.outbound[1]?.sources.map((source) => source.label)).toEqual(["title", "comment"]);
    expect(summary.inbound.map((item) => item.task.identifier)).toEqual(["PAP-4"]);
  });

  it("projects an annotation comment and deletes its source projection", async () => {
    const annotationCommentId = "00000000-0000-4000-8000-000000000008";
    const { db, calls } = createMockDb({
      select: [
        [{
          id: annotationCommentId,
          companyId,
          taskId: sourceTaskId,
          body: "Review PAP-20.",
        }],
        [{ id: targetTwoId, identifier: "PAP-20" }],
      ],
      delete: [[], []],
      insert: [[]],
    });
    const refs = taskReferenceService(db);

    await refs.syncAnnotationComment(annotationCommentId, db as never);
    await refs.deleteCommentSource(annotationCommentId, db as never);

    expect(calls.find(
      (call) => call.operation === "insert" && call.method === "values",
    )?.args[0]).toEqual([expect.objectContaining({
      sourceTaskId,
      sourceKind: "comment",
      sourceRecordId: annotationCommentId,
      targetTaskId: targetTwoId,
    })]);
    expect(calls.filter(
      (call) => call.operation === "delete" && call.method === "where",
    )).toHaveLength(2);
  });
});
