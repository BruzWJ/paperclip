import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import type { StorageService } from "../storage/types.js";

const multilingualMocks = vi.hoisted(() => ({
  issues: {
    getByIdentifier: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    getActiveInboxArchiveFields: vi.fn(),
    getAncestors: vi.fn(),
    findMentionedProjectIds: vi.fn(),
    getRelationSummaries: vi.fn(),
    listBlockerAttention: vi.fn(),
    getBoardComment: vi.fn(),
    listBoardCommentGroups: vi.fn(),
  },
  access: { decide: vi.fn() },
  documents: { getIssueDocumentPayload: vi.fn(), upsertIssueDocument: vi.fn() },
  documentAnnotations: { remapOpenThreadsForDocument: vi.fn() },
  issueReferences: {
    listIssueReferenceSummary: vi.fn(),
    diffIssueReferenceSummary: vi.fn(),
  },
  workProducts: { listForIssue: vi.fn() },
  goals: { getById: vi.fn(), getDefaultCompanyGoal: vi.fn() },
  executionWorkspaces: { getCurrentForIssue: vi.fn() },
  externalObjects: {
    syncCommentSafely: vi.fn(),
    syncDocumentSafely: vi.fn(),
  },
  ordinaryIssues: {
    create: vi.fn(),
    userComment: vi.fn(),
  },
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>(
    "../services/index.js",
  );
  return {
    ...actual,
    issueService: () => multilingualMocks.issues,
    accessService: () => multilingualMocks.access,
    documentService: () => multilingualMocks.documents,
    documentAnnotationService: () => multilingualMocks.documentAnnotations,
    issueReferenceService: () => multilingualMocks.issueReferences,
    workProductService: () => multilingualMocks.workProducts,
    goalService: () => multilingualMocks.goals,
    logActivity: multilingualMocks.logActivity,
  };
});

vi.mock("../services/execution-workspaces.js", async () => {
  const actual = await vi.importActual<typeof import("../services/execution-workspaces.js")>(
    "../services/execution-workspaces.js",
  );
  return {
    ...actual,
    executionWorkspaceService: () => multilingualMocks.executionWorkspaces,
  };
});

vi.mock("../services/external-objects.js", async () => {
  const actual = await vi.importActual<typeof import("../services/external-objects.js")>(
    "../services/external-objects.js",
  );
  return {
    ...actual,
    externalObjectService: () => multilingualMocks.externalObjects,
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const title = "验证中文任务";
const issueRequest = [
  "请用中文回复并保留上下文。",
  "日本語: 次の手順を書いてください。",
  "हिन्दी: कृपया स्थिति बताएं।",
].join("\n");
const firstReply = [
  "结果: 中文响应保留。",
  "日本語の返信も保持。",
  "हिन्दी उत्तर भी सुरक्षित है।",
].join("\n");
const completionNote = [
  "完成: 已验证中文。",
  "日本語: 完了しました。",
  "हिन्दी: सत्यापन पूरा हुआ।",
].join("\n");
const documentBody = [
  "# QA notes",
  "",
  "- 中文: 可以创建、读取、搜索、评论。",
  "- 日本語: ドキュメント本文を保持します。",
  "- हिन्दी: दस्तावेज़ पाठ सुरक्षित रहता है।",
].join("\n");

const companyId = "11111111-1111-4111-8111-111111111111";
const ownerAgentId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const firstCommentId = "44444444-4444-4444-8444-444444444444";
const completionCommentId = "55555555-5555-4555-8555-555555555555";
const documentId = "66666666-6666-4666-8666-666666666666";

const issue = {
  id: issueId,
  companyId,
  identifier: "LNG-1",
  title,
  request: issueRequest,
  boardPresentationStatus: "todo",
  lifecycleStatus: "open",
  ownerAgentId,
  priority: "medium",
  projectId: null,
  goalId: null,
};
const firstComment = { id: firstCommentId, issueId, body: firstReply };
const completionComment = { id: completionCommentId, issueId, body: completionNote };
const requestComment = { id: randomUUID(), issueId, body: issueRequest };

function createStorage(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(async () => { throw new Error("Unexpected storage.putFile call"); }),
    getObject: vi.fn(async () => { throw new Error("Unexpected storage.getObject call"); }),
    headObject: vi.fn(async () => ({ exists: false })),
    deleteObject: vi.fn(async () => undefined),
  };
}

function createApp(harness: ReturnType<typeof createMockDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = testBoardSessionActor({
      userId: "cloud-user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", issueRoutes(harness.db, createStorage(), {
    ordinaryIssues: multilingualMocks.ordinaryIssues as never,
  }));
  app.use(errorHandler);
  return app;
}

describe("multilingual issue routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    multilingualMocks.issues.getByIdentifier.mockResolvedValue(issue);
    multilingualMocks.issues.getById.mockResolvedValue(issue);
    multilingualMocks.issues.list.mockResolvedValue([issue]);
    multilingualMocks.issues.getActiveInboxArchiveFields.mockResolvedValue({});
    multilingualMocks.issues.getAncestors.mockResolvedValue([]);
    multilingualMocks.issues.findMentionedProjectIds.mockResolvedValue([]);
    multilingualMocks.issues.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    multilingualMocks.issues.listBlockerAttention.mockResolvedValue(new Map());
    multilingualMocks.issues.getBoardComment.mockImplementation(async (_companyId, _issueId, id) =>
      id === completionCommentId ? completionComment : firstComment);
    multilingualMocks.issues.listBoardCommentGroups.mockResolvedValue({
      groups: [completionComment, firstComment, requestComment].map((root) => ({ root, replies: [] })),
      nextCursor: null,
    });
    multilingualMocks.access.decide.mockResolvedValue({ allowed: true });
    multilingualMocks.documents.getIssueDocumentPayload.mockResolvedValue({
      planDocument: null,
      documentSummaries: [],
    });
    multilingualMocks.documents.upsertIssueDocument.mockResolvedValue({
      created: true,
      document: {
        id: documentId,
        companyId,
        issueId,
        key: "qa-notes",
        title: "Multilingual QA",
        format: "markdown",
        body: documentBody,
        latestRevisionId: randomUUID(),
        latestRevisionNumber: 1,
      },
    });
    multilingualMocks.documentAnnotations.remapOpenThreadsForDocument.mockResolvedValue([]);
    multilingualMocks.issueReferences.listIssueReferenceSummary.mockResolvedValue({
      outbound: [],
      inbound: [],
    });
    multilingualMocks.issueReferences.diffIssueReferenceSummary.mockReturnValue({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    });
    multilingualMocks.workProducts.listForIssue.mockResolvedValue([]);
    multilingualMocks.goals.getById.mockResolvedValue(null);
    multilingualMocks.goals.getDefaultCompanyGoal.mockResolvedValue(null);
    multilingualMocks.executionWorkspaces.getCurrentForIssue.mockResolvedValue(null);
    multilingualMocks.externalObjects.syncCommentSafely.mockResolvedValue(undefined);
    multilingualMocks.externalObjects.syncDocumentSafely.mockResolvedValue(undefined);
    multilingualMocks.ordinaryIssues.create.mockResolvedValue({
      issue,
      ref: { id: randomUUID() },
      retried: false,
    });
    multilingualMocks.ordinaryIssues.userComment.mockImplementation(async (input: { message: string }) => ({
      comment: { id: input.message === completionNote ? completionCommentId : firstCommentId },
      retried: false,
    }));
    multilingualMocks.logActivity.mockResolvedValue(undefined);
  });

  it("creates an issue with a multilingual title and immutable request", async () => {
    const harness = createMockDb();
    const response = await request(createApp(harness))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title,
        request: issueRequest,
        ownerAgentId,
        idempotencyKey: "multilingual-create-1",
        priority: "medium",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject(issue);
    expect(multilingualMocks.ordinaryIssues.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      title,
      request: issueRequest,
      ownerAgentId,
    }));
    expect(harness.calls).toEqual([]);
  });

  it("reads the multilingual title and immutable request unchanged", async () => {
    const harness = createMockDb({ select: [[]] });
    const response = await request(createApp(harness)).get("/api/issues/LNG-1");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.title).toBe(title);
    expect(response.body.request).toBe(issueRequest);
    expect(harness.remaining("select")).toBe(0);
  });

  it("finds the issue by Chinese search text", async () => {
    const harness = createMockDb();
    const response = await request(createApp(harness))
      .get(`/api/companies/${companyId}/issues`)
      .query({ q: "中文" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.map((entry: { identifier: string }) => entry.identifier)).toContain("LNG-1");
    expect(multilingualMocks.issues.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ q: "中文" }),
    );
    expect(harness.calls).toEqual([]);
  });

  it.each([
    [firstReply, firstCommentId],
    [completionNote, completionCommentId],
  ])("preserves a multilingual comment body", async (message, expectedCommentId) => {
    const harness = createMockDb();
    const response = await request(createApp(harness))
      .post("/api/issues/LNG-1/comments")
      .send({ message, idempotencyKey: `comment-${expectedCommentId}` });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.comment).toMatchObject({ id: expectedCommentId, body: message });
    expect(multilingualMocks.ordinaryIssues.userComment).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      issueId,
      message,
    }));
    expect(harness.calls).toEqual([]);
  });

  it("preserves multilingual document bodies", async () => {
    const harness = createMockDb();
    const response = await request(createApp(harness))
      .put("/api/issues/LNG-1/documents/qa-notes")
      .send({ title: "Multilingual QA", format: "markdown", body: documentBody });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.body).toBe(documentBody);
    expect(multilingualMocks.documents.upsertIssueDocument).toHaveBeenCalledWith(expect.objectContaining({
      issueId,
      key: "qa-notes",
      body: documentBody,
    }));
    expect(harness.calls).toEqual([]);
  });

  it("lists multilingual comments as newest-first board groups", async () => {
    const harness = createMockDb();
    const response = await request(createApp(harness)).get("/api/issues/LNG-1/comments");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.groups.map((group: { root: { body: string } }) => group.root.body))
      .toEqual([completionNote, firstReply, issueRequest]);
    expect(response.body.nextCursor).toBeNull();
    expect(harness.calls).toEqual([]);
  });
});
