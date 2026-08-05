import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePipelineCaseBodyDocumentFromSummary,
  PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE,
  pipelineService,
  type PipelineActor,
} from "../services/pipelines.js";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000401";
const pipelineId = "00000000-0000-4000-8000-000000000402";
const actor: PipelineActor = { type: "user", userId: "board-user" };

const ordinaryIssues = {
  create: vi.fn(),
  dispatchRef: vi.fn(),
  notifyCreatorDelivery: vi.fn(),
} as never;

function serviceFor(db: ReturnType<typeof createMockDb>["db"]) {
  return pipelineService(db, {
    ordinaryIssues,
    issueExecutionCancellation: {
      requestScopeCancellationsInTransaction: vi.fn(async (_tx, input) => ({
        ...input,
        fence: { refIds: [], deliveryIds: [], correlationIds: [] },
        requests: [],
      })),
      reconcileRequestedScopeCancellations: vi.fn(async () => []),
    },
  });
}

function pipelineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: pipelineId,
    companyId,
    key: "content",
    name: "Content",
    description: null,
    projectId: null,
    enforceTransitions: false,
    createdByUserId: "board-user",
    createdByAgentId: null,
    archivedAt: null,
    ...overrides,
  };
}

function stageRows() {
  return [
    { id: `${pipelineId.slice(0, -1)}1`, pipelineId, key: "intake", name: "Intake", kind: "working", position: 100, config: {} },
    { id: `${pipelineId.slice(0, -1)}2`, pipelineId, key: "in_progress", name: "In progress", kind: "working", position: 200, config: {} },
    { id: `${pipelineId.slice(0, -1)}3`, pipelineId, key: "review", name: "Review", kind: "review", position: 300, config: {} },
    { id: `${pipelineId.slice(0, -1)}4`, pipelineId, key: "done", name: "Done", kind: "done", position: 900, config: {} },
    { id: `${pipelineId.slice(0, -1)}5`, pipelineId, key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000, config: {} },
  ];
}

describe("pipelineService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the canonical default stages, terminal stages, and transition edges", async () => {
    const stages = stageRows();
    const harness = createMockDb({
      insert: [[pipelineRow()], stages, []],
    });

    await expect(serviceFor(harness.db).createPipeline({
      companyId,
      key: "content",
      name: "Content",
      actor,
    })).resolves.toEqual({ ...pipelineRow(), stages });

    const values = harness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(values[0]).toMatchObject({
      companyId,
      key: "content",
      name: "Content",
      enforceTransitions: false,
      createdByUserId: "board-user",
      createdByAgentId: null,
    });
    expect(values[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "intake", kind: "working", position: 100 }),
      expect.objectContaining({ key: "review", kind: "review", position: 300 }),
      expect.objectContaining({ key: "done", kind: "done", position: 900 }),
      expect.objectContaining({ key: "cancelled", kind: "cancelled", position: 1000 }),
    ]));
    expect(values[2]).toEqual([
      { pipelineId, fromStageId: stages[0]!.id, toStageId: stages[1]!.id },
      { pipelineId, fromStageId: stages[1]!.id, toStageId: stages[2]!.id },
      { pipelineId, fromStageId: stages[2]!.id, toStageId: stages[3]!.id },
    ]);
  });

  it("normalizes legacy open stages and rejects pipelines without both terminal outcomes", async () => {
    const pipeline = pipelineRow({ key: "custom" });
    const insertedStages = [
      { id: randomUUID(), pipelineId, key: "work", name: "Work", kind: "working", position: 100, config: {} },
      { id: randomUUID(), pipelineId, key: "done", name: "Done", kind: "done", position: 200, config: {} },
    ];
    const harness = createMockDb({
      insert: [[pipeline], insertedStages],
    });

    await expect(serviceFor(harness.db).createPipeline({
      companyId,
      key: "custom",
      name: "Custom",
      actor,
      stages: [
        { key: "work", name: "Work", kind: "open", position: 100 },
        { key: "done", name: "Done", kind: "done", position: 200 },
      ],
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "validation" },
    });

    const stageValues = harness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")[1]
      ?.args[0];
    expect(stageValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "work", kind: "working" }),
    ]));
  });

  it("rejects review targets outside the pipeline stage set before persistence", async () => {
    const harness = createMockDb();

    await expect(serviceFor(harness.db).createPipeline({
      companyId,
      key: "invalid-review",
      name: "Invalid review",
      actor,
      stages: [
        {
          key: "review",
          name: "Review",
          kind: "review",
          config: { approveToStageKey: "missing" },
        },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "validation" },
    });
    expect(harness.calls).toEqual([]);
  });

  it("rejects a cross-company stage automation routine before writing the pipeline", async () => {
    const routineId = randomUUID();
    const harness = createMockDb({
      select: [[{
        id: routineId,
        companyId: randomUUID(),
        assigneeAgentId: randomUUID(),
      }]],
    });

    await expect(serviceFor(harness.db).createPipeline({
      companyId,
      key: "automated",
      name: "Automated",
      actor,
      stages: [
        {
          key: "work",
          name: "Work",
          kind: "working",
          config: { onEnter: { type: "run_routine", routineId } },
        },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "validation" },
    });
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("creates the canonical case body document with board-user provenance", async () => {
    const caseId = randomUUID();
    const document = {
      id: randomUUID(),
      companyId,
      title: "Item body document",
      latestRevisionId: null,
      latestRevisionNumber: 1,
    };
    const revision = {
      id: randomUUID(),
      companyId,
      documentId: document.id,
      revisionNumber: 1,
    };
    const updatedDocument = {
      ...document,
      latestRevisionId: revision.id,
    };
    const harness = createMockDb({
      select: [[]],
      insert: [[document], [revision], []],
      update: [[updatedDocument]],
    });

    await expect(ensurePipelineCaseBodyDocumentFromSummary(harness.db, {
      companyId,
      caseId,
      summary: "Canonical body",
      actor,
    })).resolves.toEqual({
      created: true,
      document: updatedDocument,
      revision,
    });

    const values = harness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(values[0]).toMatchObject({
      companyId,
      title: "Item body document",
      format: "markdown",
      latestBody: "Canonical body",
      createdByUserId: "board-user",
      createdByAgentId: null,
    });
    expect(values[1]).toMatchObject({
      companyId,
      documentId: document.id,
      body: "Canonical body",
      changeSummary: "Created from pipeline item body",
      createdByUserId: "board-user",
      createdByAgentId: null,
      createdByRunId: null,
    });
    expect(values[2]).toMatchObject({
      companyId,
      caseId,
      documentId: document.id,
      key: "body",
    });
  });

  it("does not persist a case body document for blank summary content", async () => {
    const harness = createMockDb();
    await expect(ensurePipelineCaseBodyDocumentFromSummary(harness.db, {
      companyId,
      caseId: randomUUID(),
      summary: "  \n",
      actor,
    })).resolves.toEqual({ created: false, document: null, revision: null });
    expect(harness.calls).toEqual([]);
  });

  it("validates ingest size, provenance, and batch limits before database access", async () => {
    const harness = createMockDb();
    const svc = serviceFor(harness.db);

    await expect(svc.ingestCase({
      companyId,
      pipelineId,
      title: "Oversized",
      fields: { payload: "x".repeat(70 * 1024) },
      actor,
    })).rejects.toMatchObject({ status: 422 });
    await expect(svc.ingestCase({
      companyId,
      pipelineId,
      title: "Missing provenance",
      actor: { type: "agent", agentId: randomUUID(), runId: "" },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "run_id_required" },
    });
    await expect(svc.ingestCase({
      companyId,
      pipelineId,
      caseKey: "x".repeat(1025),
      title: "Long key",
      actor,
    })).rejects.toMatchObject({ status: 422 });
    await expect(svc.ingestCases({
      companyId,
      pipelineId,
      actor,
      items: Array.from({ length: 201 }, (_, index) => ({
        caseKey: `case-${index}`,
        title: `Case ${index}`,
      })),
    })).rejects.toMatchObject({ status: 422 });
    expect(harness.calls).toEqual([]);
  });

  it("uses the canonical automation title template", () => {
    expect(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE).toBe(
      "{{pipeline_name}} / {{stage_name}}: {{case_title}}",
    );
  });
});
