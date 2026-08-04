import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { buildCasePatchUpdateValues, caseRoutes } from "../routes/cases.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import type { StorageService } from "../storage/types.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mocks = vi.hoisted(() => ({
  getExperimental: vi.fn(),
  logActivity: vi.fn(),
  annotations: {
    listThreadsForCaseDocument: vi.fn(),
    getThreadForCaseDocument: vi.fn(),
    createCaseThread: vi.fn(),
    addCommentToCaseThread: vi.fn(),
    updateCaseThread: vi.fn(),
    remapOpenThreadsForCaseDocument: vi.fn(),
  },
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: mocks.getExperimental,
  })),
}));

vi.mock("../services/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/index.js")>()),
  documentAnnotationService: vi.fn(() => mocks.annotations),
  logActivity: mocks.logActivity,
}));

const companyId = "00000000-0000-4000-8000-000000000501";
const caseId = "00000000-0000-4000-8000-000000000502";

const storage: StorageService = {
  provider: "local_disk",
  async putFile(input) {
    return {
      provider: "local_disk",
      objectKey: `${input.namespace}/${randomUUID()}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      originalFilename: input.originalFilename,
    };
  },
  async getObject() {
    throw new Error("not used");
  },
  async headObject() {
    return { exists: false };
  },
  async deleteObject() {},
};

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: caseId,
    companyId,
    projectId: null,
    caseNumber: 1,
    identifier: "CAS-C1",
    caseType: "bug",
    key: "bug-1",
    title: "Canonical case",
    summary: null,
    status: "draft",
    fields: {},
    parentCaseId: null,
    createdByUserId: "board-user",
    completedAt: null,
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T00:00:00.000Z"),
    ...overrides,
  };
}

function mount(
  db: ReturnType<typeof createMockDb>["db"],
  actor: Express.Request["actor"] = testBoardSessionActor({
    userId: "board-user",
    companyIds: [companyId],
  }),
  options: { denyAgentRest?: boolean; fallback?: boolean } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  if (options.denyAgentRest) app.use("/api", denyGenericAgentRest("REST"));
  app.use("/api", caseRoutes(db, storage));
  if (options.fallback) {
    app.use("/api", (_req, res) => res.status(202).json({ fallback: true }));
  }
  app.use(errorHandler);
  return app;
}

describe("cases routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExperimental.mockResolvedValue({ enableCases: true });
    mocks.logActivity.mockResolvedValue(undefined);
    mocks.annotations.remapOpenThreadsForCaseDocument.mockResolvedValue([]);
  });

  it("omits completedAt from non-status patches and changes it only with status", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");
    const completedAt = new Date("2026-07-09T00:00:00.000Z");

    expect(buildCasePatchUpdateValues(
      { title: "Rename" },
      { status: "todo", completedAt: null },
      now,
    )).not.toHaveProperty("completedAt");
    expect(buildCasePatchUpdateValues(
      { title: "Rename" },
      { status: "done", completedAt },
      now,
    )).not.toHaveProperty("completedAt");
    expect(buildCasePatchUpdateValues(
      { status: "done" },
      { status: "todo", completedAt: null },
      now,
    )).toMatchObject({ status: "done", completedAt: expect.any(Date), updatedAt: now });
    expect(buildCasePatchUpdateValues(
      { status: "in_progress" },
      { status: "done", completedAt },
      now,
    )).toMatchObject({ status: "in_progress", completedAt: null, updatedAt: now });
  });

  it("gates company case reads and writes when the feature is disabled", async () => {
    mocks.getExperimental.mockResolvedValue({ enableCases: false });
    const harness = createMockDb();
    const app = mount(harness.db);

    await request(app)
      .get(`/api/companies/${companyId}/cases`)
      .expect(403);
    await request(app)
      .post(`/api/companies/${companyId}/cases`)
      .send({ caseType: "bug", key: "disabled", title: "Disabled" })
      .expect(403);
    expect(harness.calls).toEqual([]);
  });

  it("falls through shared case paths when the id is not a canonical Cases row", async () => {
    const harness = createMockDb({ select: [[]] });
    const app = mount(harness.db, undefined, { fallback: true });

    await request(app)
      .get("/api/cases/PIPE-123")
      .expect(202, { fallback: true });
    expect(mocks.getExperimental).not.toHaveBeenCalled();
  });

  it("denies productive agents at the compiled-interface boundary", async () => {
    const harness = createMockDb();
    const actor = {
      type: "agent" as const,
      agentId: randomUUID(),
      companyId,
      source: "internal" as const,
    };
    const app = mount(harness.db, actor, { denyAgentRest: true });

    await request(app)
      .get(`/api/companies/${companyId}/cases`)
      .expect(403);
    expect(mocks.getExperimental).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it("creates a canonical case identity and records board-user attribution", async () => {
    const created = caseRow();
    const harness = createMockDb({
      execute: [[], []],
      select: [
        [],
        [{ issuePrefix: "CAS" }],
        [{ maxNum: 0 }],
        [],
        [],
        [],
        [],
      ],
      insert: [[created], [{ id: randomUUID(), kind: "created" }]],
    });
    const app = mount(harness.db);

    const response = await request(app)
      .post(`/api/companies/${companyId}/cases`)
      .send({
        caseType: "bug",
        key: "bug-1",
        title: "Canonical case",
      })
      .expect(201);

    expect(response.body).toMatchObject({
      id: caseId,
      identifier: "CAS-C1",
      title: "Canonical case",
      labels: [],
      issueLinks: [],
      documents: [],
      attachments: [],
    });
    const insertedValues = harness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(insertedValues[0]).toMatchObject({
      companyId,
      caseNumber: 1,
      identifier: "CAS-C1",
      caseType: "bug",
      key: "bug-1",
      title: "Canonical case",
      status: "draft",
      createdByUserId: "board-user",
    });
    expect(insertedValues[1]).toMatchObject({
      companyId,
      caseId,
      kind: "created",
      actorType: "user",
      actorUserId: "board-user",
      payload: { caseType: "bug", key: "bug-1" },
    });
  });

  it("upserts a keyed case without allocating a second identity", async () => {
    const existing = caseRow();
    const updated = caseRow({
      title: "Updated case",
      status: "done",
      completedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    const harness = createMockDb({
      execute: [[]],
      select: [[existing], [], [], [], []],
      update: [[updated]],
      insert: [[{ id: randomUUID(), kind: "updated" }]],
    });
    const app = mount(harness.db);

    const response = await request(app)
      .post(`/api/companies/${companyId}/cases`)
      .send({
        caseType: "bug",
        key: "bug-1",
        title: "Updated case",
        status: "done",
      })
      .expect(200);

    expect(response.body).toMatchObject({
      id: caseId,
      title: "Updated case",
      status: "done",
    });
    expect(harness.calls.filter((call) => call.operation === "execute")).toHaveLength(1);
    expect(harness.calls.some(
      (call) => call.operation === "insert" && call.args.length > 0,
    )).toBe(true);
    const updateSet = harness.calls.find(
      (call) => call.operation === "update" && call.method === "set",
    );
    expect(updateSet?.args[0]).toMatchObject({
      title: "Updated case",
      status: "done",
      completedAt: expect.any(Date),
    });
  });

  it("resolves identifiers case-insensitively and returns canonical detail projections", async () => {
    const row = caseRow({ identifier: "CAS-C9" });
    const harness = createMockDb({
      select: [[row], [], [], [], []],
    });
    const app = mount(harness.db);

    await request(app)
      .get("/api/cases/cas-c9")
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: caseId,
          identifier: "CAS-C9",
          parent: null,
          labels: [],
          issueLinks: [],
          documents: [],
          attachments: [],
        });
      });
    expect(mocks.getExperimental).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid list filters before querying case rows", async () => {
    const harness = createMockDb();
    const app = mount(harness.db);

    await request(app)
      .get(`/api/companies/${companyId}/cases?status=not-a-status`)
      .expect(400);
    await request(app)
      .get(`/api/companies/${companyId}/cases?projectId=not-a-uuid`)
      .expect(400);
    expect(harness.calls).toEqual([]);
  });
});
