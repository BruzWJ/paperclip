import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const taskReferenceMocks = vi.hoisted(() => ({
  syncDocument: vi.fn(async () => undefined),
  deleteCommentSource: vi.fn(async () => undefined),
  deleteDocumentSource: vi.fn(async () => undefined),
}));

vi.mock("../services/task-references.js", () => ({
  taskReferenceService: () => taskReferenceMocks,
}));

import { documentService } from "../services/documents.js";

type DocumentRow = Parameters<typeof import("../services/documents.js").mapTaskDocumentRow>[0];

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    taskId: randomUUID(),
    key: "plan",
    title: "Plan",
    format: "markdown",
    latestBody: "# Plan",
    latestRevisionId: randomUUID(),
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    sourceTrust: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("documentService task documents", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["Plan", " plan", "plan ", "PLAN"])(
    "rejects the noncanonical document key %j without querying",
    async (key) => {
      const harness = createMockDb();

      await expect(
        documentService(harness.db).getTaskDocumentByKey(randomUUID(), key),
      ).rejects.toMatchObject({
        status: 422,
        message: "Invalid document key",
      });
      expect(harness.calls).toEqual([]);
    },
  );

  it("locks, rejects writes to, unlocks, and then updates a task document", async () => {
    const taskId = randomUUID();
    const companyId = randomUUID();
    const userId = "board-user";
    const initial = documentRow({ companyId, taskId });

    const lockDb = createMockDb({
      select: [[initial]],
      update: [[], []],
    });
    const locked = await documentService(lockDb.db).lockTaskDocument({
      taskId,
      key: "plan",
      lockedByUserId: userId,
    });

    expect(locked.changed).toBe(true);
    expect(locked.document.lockedAt).toBeInstanceOf(Date);
    expect(locked.document.lockedByUserId).toBe(userId);
    expect(lockDb.remaining("select")).toBe(0);
    expect(lockDb.remaining("update")).toBe(0);

    const lockedRow = documentRow({
      ...initial,
      lockedAt: locked.document.lockedAt,
      lockedByUserId: userId,
    });
    const conflictDb = createMockDb({
      select: [[{ id: taskId, companyId }], [lockedRow]],
    });
    await expect(documentService(conflictDb.db).upsertTaskDocument({
      taskId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: locked.document.latestRevisionId,
      createdByUserId: userId,
    })).rejects.toMatchObject({
      status: 409,
      message: "Document is locked",
    });
    expect(conflictDb.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(conflictDb.calls.some((call) => call.operation === "update")).toBe(false);

    const unlockDb = createMockDb({
      select: [[lockedRow]],
      update: [[], []],
    });
    const unlocked = await documentService(unlockDb.db).unlockTaskDocument(taskId, "plan");
    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.lockedAt).toBeNull();

    const unlockedRow = documentRow({
      ...lockedRow,
      lockedAt: null,
      lockedByUserId: null,
    });
    const revisionId = randomUUID();
    const updateDb = createMockDb({
      select: [[{ id: taskId, companyId }], [unlockedRow]],
      insert: [[{ id: revisionId }]],
      update: [[], []],
    });
    const updated = await documentService(updateDb.db).upsertTaskDocument({
      taskId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: unlocked.document.latestRevisionId,
      createdByUserId: userId,
    });

    expect(updated.created).toBe(false);
    expect(updated.document).toMatchObject({
      body: "# Updated plan",
      latestRevisionId: revisionId,
      latestRevisionNumber: 2,
      updatedByUserId: userId,
    });
    expect(taskReferenceMocks.syncDocument).toHaveBeenCalledWith(initial.id, updateDb.db);
    expect(updateDb.remaining("select")).toBe(0);
    expect(updateDb.remaining("insert")).toBe(0);
    expect(updateDb.remaining("update")).toBe(0);
  });

  it("creates a new document instead of updating a locked document when requested", async () => {
    const taskId = randomUUID();
    const companyId = randomUUID();
    const locked = documentRow({
      companyId,
      taskId,
      lockedAt: new Date("2026-01-01T00:05:00.000Z"),
      lockedByUserId: "board-user",
    });
    const replacementDocument = documentRow({
      id: randomUUID(),
      companyId,
      taskId,
      key: "plan-2",
      latestBody: "# Agent replacement plan",
      latestRevisionId: null,
      lockedAt: null,
      lockedByUserId: null,
    });
    const replacementRevisionId = randomUUID();
    const writeDb = createMockDb({
      select: [
        [{ id: taskId, companyId }],
        [locked],
        [{ key: "plan" }],
      ],
      insert: [
        [replacementDocument],
        [{ id: replacementRevisionId }],
        [],
      ],
      update: [[]],
    });

    const fallback = await documentService(writeDb.db).upsertTaskDocument({
      taskId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Agent replacement plan",
      baseRevisionId: locked.latestRevisionId,
      lockedDocumentStrategy: "create_new_document",
    });

    expect(fallback).toMatchObject({
      created: true,
      redirectedFromLockedDocument: { id: locked.id, key: "plan" },
      document: {
        id: replacementDocument.id,
        key: "plan-2",
        body: "# Agent replacement plan",
        latestRevisionId: replacementRevisionId,
        lockedAt: null,
      },
    });
    expect(taskReferenceMocks.syncDocument).toHaveBeenCalledWith(replacementDocument.id, writeDb.db);
    expect(writeDb.remaining("select")).toBe(0);
    expect(writeDb.remaining("insert")).toBe(0);
    expect(writeDb.remaining("update")).toBe(0);

    const readDb = createMockDb({
      select: [
        [locked],
        [{ ...replacementDocument, latestRevisionId: replacementRevisionId }],
      ],
    });
    const readService = documentService(readDb.db);
    await expect(readService.getTaskDocumentByKey(taskId, "plan")).resolves.toMatchObject({
      body: "# Plan",
      lockedAt: locked.lockedAt,
    });
    await expect(readService.getTaskDocumentByKey(taskId, "plan-2")).resolves.toMatchObject({
      body: "# Agent replacement plan",
      lockedAt: null,
    });
    expect(readDb.remaining("select")).toBe(0);
  });
});
