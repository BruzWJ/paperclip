import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const issueReferenceMocks = vi.hoisted(() => ({
  syncDocument: vi.fn(async () => undefined),
  deleteCommentSource: vi.fn(async () => undefined),
  deleteDocumentSource: vi.fn(async () => undefined),
}));

vi.mock("../services/issue-references.js", () => ({
  issueReferenceService: () => issueReferenceMocks,
}));

import { documentService } from "../services/documents.js";

type DocumentRow = Parameters<typeof import("../services/documents.js").mapIssueDocumentRow>[0];

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    issueId: randomUUID(),
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

describe("documentService issue documents", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("locks, rejects writes to, unlocks, and then updates an issue document", async () => {
    const issueId = randomUUID();
    const companyId = randomUUID();
    const userId = "board-user";
    const initial = documentRow({ companyId, issueId });

    const lockDb = createMockDb({
      select: [[initial]],
      update: [[], []],
    });
    const locked = await documentService(lockDb.db).lockIssueDocument({
      issueId,
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
      select: [[{ id: issueId, companyId }], [lockedRow]],
    });
    await expect(documentService(conflictDb.db).upsertIssueDocument({
      issueId,
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
    const unlocked = await documentService(unlockDb.db).unlockIssueDocument(issueId, "plan");
    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.lockedAt).toBeNull();

    const unlockedRow = documentRow({
      ...lockedRow,
      lockedAt: null,
      lockedByUserId: null,
    });
    const revisionId = randomUUID();
    const updateDb = createMockDb({
      select: [[{ id: issueId, companyId }], [unlockedRow]],
      insert: [[{ id: revisionId }]],
      update: [[], []],
    });
    const updated = await documentService(updateDb.db).upsertIssueDocument({
      issueId,
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
    expect(issueReferenceMocks.syncDocument).toHaveBeenCalledWith(initial.id, updateDb.db);
    expect(updateDb.remaining("select")).toBe(0);
    expect(updateDb.remaining("insert")).toBe(0);
    expect(updateDb.remaining("update")).toBe(0);
  });

  it("creates a new document instead of updating a locked document when requested", async () => {
    const issueId = randomUUID();
    const companyId = randomUUID();
    const locked = documentRow({
      companyId,
      issueId,
      lockedAt: new Date("2026-01-01T00:05:00.000Z"),
      lockedByUserId: "board-user",
    });
    const replacementDocument = documentRow({
      id: randomUUID(),
      companyId,
      issueId,
      key: "plan-2",
      latestBody: "# Agent replacement plan",
      latestRevisionId: null,
      lockedAt: null,
      lockedByUserId: null,
    });
    const replacementRevisionId = randomUUID();
    const writeDb = createMockDb({
      select: [
        [{ id: issueId, companyId }],
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

    const fallback = await documentService(writeDb.db).upsertIssueDocument({
      issueId,
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
    expect(issueReferenceMocks.syncDocument).toHaveBeenCalledWith(replacementDocument.id, writeDb.db);
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
    await expect(readService.getIssueDocumentByKey(issueId, "plan")).resolves.toMatchObject({
      body: "# Plan",
      lockedAt: locked.lockedAt,
    });
    await expect(readService.getIssueDocumentByKey(issueId, "plan-2")).resolves.toMatchObject({
      body: "# Agent replacement plan",
      lockedAt: null,
    });
    expect(readDb.remaining("select")).toBe(0);
  });
});
