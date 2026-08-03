import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { decisionTrainingRoutes } from "../routes/decision-training.js";
import {
  captureDecisionSnapshot,
  decisionTrainingService,
} from "../services/decision-training.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  logActivity: vi.fn(),
  routeService: {
    preview: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    getById: vi.fn(),
    updateNotes: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../services/issue-execution-run-service.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/issue-execution-run-service.js")>()),
  listIssueExecutionRunsForIssue: mocks.listRuns,
}));

vi.mock("../services/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/index.js")>()),
  decisionTrainingService: vi.fn(() => mocks.routeService),
  logActivity: mocks.logActivity,
}));

const companyId = "00000000-0000-4000-8000-000000000101";
const issueId = "00000000-0000-4000-8000-000000000102";
const approvalId = "00000000-0000-4000-8000-000000000103";
const exampleId = "00000000-0000-4000-8000-000000000104";
const cutoffAt = new Date("2026-07-16T12:00:00.000Z");

function snapshotPlan(options: {
  comments?: Array<Record<string, unknown>>;
  projectId?: string | null;
  projectWorkspace?: Record<string, unknown> | null;
  executionWorkspace?: Record<string, unknown> | null;
} = {}) {
  const issue = {
    id: issueId,
    companyId,
    projectId: options.projectId ?? null,
    title: "Choose a rollout strategy",
  };
  const approval = {
    id: approvalId,
    companyId,
    type: "project_plan",
    status: "approved",
    payload: { question: "Ship it?" },
    decisionNote: "Approved",
    decidedByUserId: "board-user",
    requestedByUserId: null,
    requestedByAgentId: null,
    decidedAt: cutoffAt,
  };
  const before = {
    id: "00000000-0000-4000-8000-000000000105",
    companyId,
    issueId,
    body: "Before",
    createdAt: new Date("2026-07-16T11:59:59.000Z"),
  };
  const boundary = {
    id: "00000000-0000-4000-8000-000000000106",
    companyId,
    issueId,
    body: "At cutoff",
    createdAt: cutoffAt,
  };
  const select: unknown[] = [
    issue,
    [{ approval }],
    options.comments ?? [before, boundary],
  ];
  if (issue.projectId) {
    select.push(options.projectWorkspace ? [options.projectWorkspace] : []);
  }
  select.push(
    options.executionWorkspace
      ? [{ workspace: options.executionWorkspace }]
      : [],
  );
  return { issue, approval, before, boundary, select };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: randomUUID(),
    companyId,
    issueId,
    targetAgentId: randomUUID(),
    kind: "agent",
    status: "succeeded",
    ownershipEpoch: 1,
    adapterConfigRevisionId: randomUUID(),
    executionWorkspaceBindingId: null,
    executionMode: "owner",
    parentRunId: null,
    retryOfRunId: null,
    startedAt: new Date("2026-07-16T11:00:00.000Z"),
    finishedAt: new Date("2026-07-16T11:30:00.000Z"),
    terminalClassification: "success",
    terminalReasonCode: null,
    processExitCode: 0,
    processSignal: null,
    createdAt: new Date("2026-07-16T11:00:00.000Z"),
    updatedAt: new Date("2026-07-16T11:30:00.000Z"),
    ...overrides,
  };
}

function mount(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", decisionTrainingRoutes(createMockDb().db));
  app.use(errorHandler);
  return app;
}

describe("decision training", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRuns.mockResolvedValue({ items: [], nextCursor: null });
    mocks.logActivity.mockResolvedValue(undefined);
  });

  it("freezes the authorized cutoff view and excludes runs updated after it", async () => {
    const executionWorkspace = {
      repoUrl: "https://example.test/repo.git",
      branchName: "feature/decision",
      baseRef: "main",
      metadata: { headSha: "abcdef1234567" },
    };
    const plan = snapshotPlan({ executionWorkspace });
    const included = runRow();
    const excluded = runRow({
      updatedAt: new Date("2026-07-16T12:00:01.000Z"),
    });
    mocks.listRuns.mockResolvedValue({
      items: [excluded, included],
      nextCursor: null,
    });
    const { db } = createMockDb({ select: plan.select });

    const captured = await captureDecisionSnapshot(db, {
      companyId,
      sourceKind: "approval",
      sourceId: approvalId,
      issueId,
    }, new Date("2026-07-16T13:00:00.000Z"));

    expect(captured.cutoffAt).toEqual(cutoffAt);
    expect(captured.snapshot.cutoff).toEqual({
      at: cutoffAt.toISOString(),
      lastCommentId: plan.boundary.id,
      commentCount: 2,
    });
    expect(captured.snapshot.comments.map((comment) => comment.id)).toEqual([
      plan.before.id,
      plan.boundary.id,
    ]);
    expect(captured.snapshot.runs.map((run) => run.id)).toEqual([
      included.runId,
    ]);
    expect(captured.snapshot.code).toEqual({
      repoUrl: executionWorkspace.repoUrl,
      ref: executionWorkspace.branchName,
      commitSha: "abcdef1234567",
      resolution: "workspace",
    });
    expect(captured.snapshot.retention).toEqual({
      policy: "scrub_deleted_comments_v1",
      commentDeletion: "redact",
      issueDeletion: "cascade",
    });
  });

  it("enforces one training example per decision and author", async () => {
    const plan = snapshotPlan();
    const { db } = createMockDb({
      select: plan.select,
      insert: [[]],
    });

    await expect(decisionTrainingService(db).create({
      companyId,
      sourceKind: "approval",
      sourceId: approvalId,
      issueId,
      notes: "Already captured",
      createdByUserId: "board-user",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("redacts deleted source comments without mutating unrelated snapshots", async () => {
    const deletedAt = new Date("2026-07-16T14:00:00.000Z");
    const snapshot = {
      version: 1,
      retention: {
        policy: "scrub_deleted_comments_v1",
        commentDeletion: "redact",
        issueDeletion: "cascade",
      },
      comments: [
        { id: "comment-a", body: "Sensitive", metadata: { source: true } },
        { id: "comment-b", body: "Keep me" },
      ],
    };
    const harness = createMockDb({
      select: [[{ id: exampleId, snapshot }]],
      update: [[]],
    });

    await expect(decisionTrainingService(harness.db).scrubDeletedComments({
      companyId,
      issueId,
      commentIds: ["comment-a"],
      deletedAt,
    })).resolves.toEqual({ updatedCount: 1 });

    const setCall = harness.calls.find(
      (call) => call.operation === "update" && call.method === "set",
    );
    expect(setCall?.args[0]).toMatchObject({
      retentionPolicy: "scrub_deleted_comments_v1",
      snapshot: {
        comments: [
          {
            id: "comment-a",
            body: "",
            presentation: null,
            metadata: null,
            deletedAt: deletedAt.toISOString(),
            retentionRedaction: {
              reason: "source_comment_deleted",
              policy: "scrub_deleted_comments_v1",
            },
          },
          { id: "comment-b", body: "Keep me" },
        ],
      },
      updatedAt: deletedAt,
    });
  });

  it("does not write notes history when the submitted notes are unchanged", async () => {
    const row = {
      id: exampleId,
      notes: "Keep this",
      notesHistory: [],
    };
    const harness = createMockDb({ select: [row] });

    await expect(
      decisionTrainingService(harness.db).updateNotes(
        exampleId,
        "board-user",
        "Keep this",
      ),
    ).resolves.toBe(row);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("rejects agent writes, reads, and exports before invoking the service", async () => {
    const actor = {
      type: "agent" as const,
      agentId: randomUUID(),
      companyId,
      source: "internal" as const,
    };
    const app = mount(actor);

    await request(app)
      .post(`/api/companies/${companyId}/decision-training`)
      .send({ sourceKind: "approval", sourceId: approvalId, issueId, notes: "No" })
      .expect(403);
    await request(app)
      .get(`/api/companies/${companyId}/decision-training`)
      .expect(403);
    await request(app)
      .get(`/api/companies/${companyId}/decision-training/export.jsonl`)
      .expect(403);
    expect(mocks.routeService.create).not.toHaveBeenCalled();
    expect(mocks.routeService.list).not.toHaveBeenCalled();
  });

  it("requires the author for mutations and keeps snapshot fields immutable", async () => {
    mocks.routeService.getById.mockResolvedValue({
      id: exampleId,
      companyId,
      createdByUserId: "author",
      notes: "Original",
    });
    const app = mount(testBoardSessionActor({
      userId: "other-user",
      companyIds: [companyId],
    }));

    await request(app)
      .patch(`/api/decision-training/${exampleId}`)
      .send({ notes: "Changed" })
      .expect(403);
    await request(app)
      .delete(`/api/decision-training/${exampleId}`)
      .expect(403);
    await request(app)
      .patch(`/api/decision-training/${exampleId}`)
      .send({ notes: "Changed", snapshot: { version: 2 } })
      .expect(400);
    expect(mocks.routeService.updateNotes).not.toHaveBeenCalled();
    expect(mocks.routeService.delete).not.toHaveBeenCalled();
  });

  it("exports immutable state and labels as JSONL and audits the export", async () => {
    const snapshot = { version: 1, decision: { outcome: "approved" } };
    mocks.routeService.list.mockResolvedValue([{
      example: {
        id: exampleId,
        retentionPolicy: "scrub_deleted_comments_v1",
        snapshot,
        decisionOutcome: "approved",
        notes: "Use a feature flag.",
      },
    }]);
    const app = mount(testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
    }));

    const response = await request(app)
      .get(`/api/companies/${companyId}/decision-training/export.jsonl`)
      .expect(200);

    expect(JSON.parse(response.text.trim())).toEqual({
      retentionPolicy: "scrub_deleted_comments_v1",
      state: snapshot,
      label: { outcome: "approved", notes: "Use a feature flag." },
    });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), {
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "decision_training.exported",
      entityType: "decision_training_export",
      entityId: companyId,
      details: { exampleCount: 1, exampleIds: [exampleId] },
    });
  });
});
