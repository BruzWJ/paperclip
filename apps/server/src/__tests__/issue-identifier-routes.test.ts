import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const routeMocks = vi.hoisted(() => ({
  issues: {
    getByIdentifier: vi.fn(),
    getById: vi.fn(),
    getActiveInboxArchiveFields: vi.fn(async () => ({})),
    getAncestors: vi.fn(async () => []),
    findMentionedProjectIds: vi.fn(async () => []),
    getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
    listBlockerAttention: vi.fn(async () => new Map()),
    updateTitle: vi.fn(),
  },
  documents: {
    getIssueDocumentPayload: vi.fn(async () => ({
      planDocument: null,
      documentSummaries: [],
    })),
  },
  issueReferences: {
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  },
  workProducts: {
    listForIssue: vi.fn(async () => []),
  },
  goals: {
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  },
  executionWorkspaces: {
    getCurrentForIssue: vi.fn(async () => null),
  },
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>(
    "../services/index.js",
  );
  return {
    ...actual,
    issueService: () => routeMocks.issues,
    documentService: () => routeMocks.documents,
    issueReferenceService: () => routeMocks.issueReferences,
    workProductService: () => routeMocks.workProducts,
    goalService: () => routeMocks.goals,
    logActivity: routeMocks.logActivity,
  };
});

vi.mock("../services/execution-workspaces.js", async () => {
  const actual = await vi.importActual<typeof import("../services/execution-workspaces.js")>(
    "../services/execution-workspaces.js",
  );
  return {
    ...actual,
    executionWorkspaceService: () => routeMocks.executionWorkspaces,
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

describe("issue identifier routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.issues.getActiveInboxArchiveFields.mockResolvedValue({});
    routeMocks.issues.getAncestors.mockResolvedValue([]);
    routeMocks.issues.findMentionedProjectIds.mockResolvedValue([]);
    routeMocks.issues.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    routeMocks.issues.listBlockerAttention.mockResolvedValue(new Map());
    routeMocks.documents.getIssueDocumentPayload.mockResolvedValue({
      planDocument: null,
      documentSummaries: [],
    });
    routeMocks.issueReferences.listIssueReferenceSummary.mockResolvedValue({
      outbound: [],
      inbound: [],
    });
    routeMocks.workProducts.listForIssue.mockResolvedValue([]);
    routeMocks.executionWorkspaces.getCurrentForIssue.mockResolvedValue(null);
  });

  it("resolves alphanumeric session issue identifiers for detail reads and title updates", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issue = {
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
      title: "Tenant identifier route",
      projectId: null,
      goalId: null,
      boardPresentationStatus: "todo",
    };
    const updatedIssue = {
      ...issue,
      title: "Updated tenant identifier route",
    };
    routeMocks.issues.getByIdentifier.mockResolvedValue(issue);
    routeMocks.issues.getById.mockResolvedValue(issue);
    routeMocks.issues.updateTitle.mockResolvedValue(updatedIssue);

    const harness = createMockDb();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = testBoardSessionActor({
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
      });
      next();
    });
    app.use(
      "/api",
      issueRoutes(harness.db, {} as never, {
        ordinaryIssues: {} as never,
      }),
    );
    let routeError: unknown = null;
    app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
      routeError = error;
      next(error);
    });
    app.use(errorHandler);

    const read = await request(app).get("/api/issues/pc1a2-7");
    expect(read.status, routeError instanceof Error ? routeError.stack : JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
    });

    const updated = await request(app)
      .patch("/api/issues/PC1A2-7")
      .send({ title: "Updated tenant identifier route" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject(updatedIssue);

    expect(routeMocks.issues.getByIdentifier).toHaveBeenNthCalledWith(1, "PC1A2-7");
    expect(routeMocks.issues.getByIdentifier).toHaveBeenNthCalledWith(2, "PC1A2-7");
    expect(routeMocks.issues.getById).toHaveBeenNthCalledWith(1, issueId);
    expect(routeMocks.issues.getById).toHaveBeenNthCalledWith(2, issueId);
    expect(routeMocks.issues.updateTitle).toHaveBeenCalledWith(
      issueId,
      "Updated tenant identifier route",
    );
    expect(routeMocks.logActivity).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      companyId,
      actorId: "cloud-user-1",
      action: "issue.title_updated",
      entityId: issueId,
    }));
    expect(harness.remaining("select")).toBe(0);
  });
});
