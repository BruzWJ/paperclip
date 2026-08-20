import { describe, expect, it } from "vitest";
import { taskService } from "../services/tasks.js";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000601";
const rootId = "00000000-0000-4000-8000-000000000602";
const blockerId = "00000000-0000-4000-8000-000000000603";
const secondBlockerId = "00000000-0000-4000-8000-000000000604";
const middleId = "00000000-0000-4000-8000-000000000605";
const ownerAgentId = "00000000-0000-4000-8000-000000000606";
const now = new Date("2026-07-20T12:00:00.000Z");

function taskListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: rootId,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    parentOwnershipEpoch: null,
    title: "Blocked root",
    request: Buffer.from("Blocked root request", "utf8").toString("base64"),
    lifecycleStatus: "blocked",
    boardPresentationStatus: "blocked",
    disposition: null,
    workMode: "standard",
    priority: "medium",
    ownerKind: "board",
    ownerAgentId: null,
    ownerUserId: null,
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorUserId: "board-user",
    responsibleUserId: null,
    taskNumber: 1,
    identifier: "BLK-1",
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: "blocked-root",
    billingCode: null,
    requestDepth: 0,
    sourceTrust: "trusted",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function blockerNode(input: {
  id?: string;
  taskId?: string;
  parentId?: string | null;
  identifier?: string;
  status?: string;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
}) {
  const id = input.id ?? blockerId;
  return {
    taskId: input.taskId ?? rootId,
    blockerTaskId: id,
    id,
    companyId,
    parentId: input.parentId ?? null,
    identifier: input.identifier ?? "BLK-2",
    title: `Blocker ${input.identifier ?? "BLK-2"}`,
    boardPresentationStatus: input.status ?? "backlog",
    ownerAgentId: input.ownerAgentId ?? null,
    ownerUserId: input.ownerUserId ?? null,
  };
}

function currentRunLinkage(taskId: string) {
  return {
    runId: "00000000-0000-4000-8000-000000000607",
    runStatus: "running",
    companyId,
    agentId: ownerAgentId,
    refId: "00000000-0000-4000-8000-000000000608",
    taskId,
    projectId: null,
    routineId: null,
    sessionId: "00000000-0000-4000-8000-000000000609",
    ownershipEpoch: 1,
    mode: "owner",
    sourceKind: "task_request",
    sourceRecordId: taskId,
    adapterConfigRevisionId: "00000000-0000-4000-8000-00000000060a",
    taskExecutionAuthorityId: "00000000-0000-4000-8000-00000000060b",
    consultExecutionId: null,
    taskExecutionPolicy: null,
    startedAt: new Date("2026-07-20T11:00:00.000Z"),
    finishedAt: null,
    createdAt: new Date("2026-07-20T11:00:00.000Z"),
  };
}

async function classify(input: {
  root?: Record<string, unknown>;
  levels: Array<{
    explicit?: Array<Record<string, unknown>>;
    children?: Array<Record<string, unknown>>;
  }>;
  activeLinkages?: Array<Record<string, unknown>>;
  approvals?: Array<{ taskId: string }>;
  agents?: Array<{ id: string; companyId: string; status: string }>;
}) {
  const select: unknown[] = [
    [taskListRow(input.root)],
    [],
    [],
    [],
    [],
    [],
  ];
  for (const level of input.levels) {
    select.push(level.explicit ?? [], level.children ?? []);
  }
  select.push(input.activeLinkages ?? []);
  select.push(input.approvals ?? []);
  if (input.agents) select.push(input.agents);
  const harness = createMockDb({ select });
  const rows = await taskService(harness.db).list(companyId, {
    status: ["blocked"],
  });
  expect(harness.remaining("select")).toBe(0);
  return rows[0]!;
}

describe("task blocker attention", () => {
  it("classifies a human-owned blocker as a covered waiting path", async () => {
    const blocker = blockerNode({ ownerUserId: "board-user" });
    const root = await classify({
      levels: [
        { explicit: [blocker] },
        {},
      ],
    });

    expect(root.blockerAttention).toEqual({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "BLK-2",
      sampleStalledBlockerIdentifier: null,
    });
  });

  it("requires attention for an assigned backlog blocker without a live execution path", async () => {
    const blocker = blockerNode({ ownerAgentId });
    const root = await classify({
      levels: [
        { explicit: [blocker] },
        {},
      ],
      agents: [{ id: ownerAgentId, companyId, status: "idle" }],
    });

    expect(root.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "BLK-2",
    });
  });

  it("classifies an ownerless review leaf as stalled", async () => {
    const blocker = blockerNode({ status: "in_review" });
    const root = await classify({
      levels: [
        { explicit: [blocker] },
        {},
      ],
    });

    expect(root.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "BLK-2",
      sampleStalledBlockerIdentifier: "BLK-2",
    });
  });

  it("covers an in-review blocker while its canonical owner run is active", async () => {
    const blocker = blockerNode({
      status: "in_review",
      ownerAgentId,
    });
    const root = await classify({
      levels: [
        { explicit: [blocker] },
        {},
      ],
      activeLinkages: [currentRunLinkage(blockerId)],
      agents: [{ id: ownerAgentId, companyId, status: "running" }],
    });

    expect(root.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
    });
  });

  it("prefers hard attention over stalled when blocker paths are mixed", async () => {
    const hard = blockerNode({
      id: blockerId,
      identifier: "BLK-HARD",
      ownerAgentId,
    });
    const stalled = blockerNode({
      id: secondBlockerId,
      identifier: "BLK-STALL",
      status: "in_review",
    });
    const root = await classify({
      levels: [
        { explicit: [hard, stalled] },
        {},
      ],
      agents: [{ id: ownerAgentId, companyId, status: "idle" }],
    });

    expect(root.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "BLK-HARD",
      sampleStalledBlockerIdentifier: "BLK-STALL",
    });
  });

  it("classifies recursive dependency chains from their terminal leaf", async () => {
    const middle = blockerNode({
      id: middleId,
      identifier: "BLK-MID",
      status: "todo",
    });
    const leaf = blockerNode({
      id: blockerId,
      taskId: middleId,
      identifier: "BLK-LEAF",
      ownerUserId: "board-user",
    });
    const root = await classify({
      levels: [
        { explicit: [middle] },
        { explicit: [leaf] },
        {},
      ],
    });

    expect(root.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "BLK-LEAF",
    });
  });

  it("treats pending human approval as an explicit waiting path", async () => {
    const blocker = blockerNode({ status: "todo" });
    const root = await classify({
      levels: [
        { explicit: [blocker] },
        {},
      ],
      approvals: [{ taskId: blockerId }],
    });

    expect(root.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
    });
  });

  it("rejects malformed blocked-inbox owner filters before database access", async () => {
    const harness = createMockDb();
    const svc = taskService(harness.db);

    await expect(svc.list(companyId, {
      attention: "blocked",
      ownerAgentId: "not-a-uuid",
    })).rejects.toMatchObject({ status: 422 });
    await expect(svc.count(companyId, {
      attention: "blocked",
      ownerAgentId: "not-a-uuid",
    })).rejects.toMatchObject({ status: 422 });
    expect(harness.calls).toEqual([]);
  });
});
