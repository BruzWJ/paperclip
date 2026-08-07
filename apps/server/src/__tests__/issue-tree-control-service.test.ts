import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";

const serviceMocks = vi.hoisted(() => ({
  recordNamedBoardLifecycleCommandInTransaction: vi.fn(async () => undefined),
  resolveCurrentIssueOwnerRunLinkages: vi.fn(async () => new Map()),
  requestRunningIssueInterruptionsInTransaction: vi.fn(),
  reconcileRequestedRunningIssueInterruptions: vi.fn(),
  requestScopeCancellationsInTransaction: vi.fn(),
  reconcileRequestedScopeCancellations: vi.fn(),
}));

vi.mock("../services/issue-board-lifecycle-command.js", () => ({
  recordNamedBoardLifecycleCommandInTransaction:
    serviceMocks.recordNamedBoardLifecycleCommandInTransaction,
}));

vi.mock("../services/productive-run-linkage.js", () => ({
  resolveCurrentIssueOwnerRunLinkages:
    serviceMocks.resolveCurrentIssueOwnerRunLinkages,
}));

import { issueTreeControlService } from "../services/issue-tree-control.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const boardUserId = "board-user";
const baseTime = new Date("2026-04-21T10:00:00.000Z");

function issue(input: {
  id?: string;
  parentId?: string | null;
  title?: string;
  status?: string;
  lifecycleStatus?: "open" | "blocked" | "done" | "cancelled";
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  createdAt?: Date;
}) {
  const id = input.id ?? randomUUID();
  return {
    id,
    companyId,
    identifier: `TST-${id.slice(0, 4)}`,
    title: input.title ?? "Issue",
    parentId: input.parentId ?? null,
    boardPresentationStatus: input.status ?? "todo",
    lifecycleStatus:
      input.lifecycleStatus ??
      (input.status === "done" || input.status === "cancelled"
        ? input.status
        : input.status === "blocked"
          ? "blocked"
          : "open"),
    ownerAgentId: input.ownerAgentId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    ownershipEpoch: 1,
    createdAt: input.createdAt ?? baseTime,
    updatedAt: input.createdAt ?? baseTime,
  };
}

function hold(input: {
  id?: string;
  rootIssueId: string;
  mode?: "pause" | "resume" | "cancel" | "restore";
  status?: "active" | "released";
  actorType?: "user" | "agent" | "system";
}) {
  return {
    id: input.id ?? randomUUID(),
    companyId,
    rootIssueId: input.rootIssueId,
    mode: input.mode ?? "pause",
    status: input.status ?? "active",
    reason: "operator requested control",
    releasePolicy: { strategy: "manual" },
    createdByActorType: input.actorType ?? "user",
    createdByAgentId: null,
    createdByUserId:
      (input.actorType ?? "user") === "user" ? boardUserId : null,
    createdByRunId: null,
    releasedAt: null,
    releasedByActorType: null,
    releasedByAgentId: null,
    releasedByUserId: null,
    releasedByRunId: null,
    releaseReason: null,
    releaseMetadata: null,
    createdAt: baseTime,
    updatedAt: baseTime,
  };
}

function member(input: {
  holdId: string;
  issueId: string;
  status?: string;
  skipped?: boolean;
  skipReason?: string | null;
  parentIssueId?: string | null;
}) {
  return {
    id: randomUUID(),
    companyId,
    holdId: input.holdId,
    issueId: input.issueId,
    parentIssueId: input.parentIssueId ?? null,
    depth: input.parentIssueId ? 1 : 0,
    issueIdentifier: `TST-${input.issueId.slice(0, 4)}`,
    issueTitle: "Issue",
    issueStatus: input.status ?? "todo",
    ownerAgentId: null,
    ownerUserId: boardUserId,
    activeRunId: null,
    activeRunStatus: null,
    skipped: input.skipped ?? false,
    skipReason: input.skipReason ?? null,
    createdAt: baseTime,
  };
}

describe("issueTreeControlService without a database process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveCurrentIssueOwnerRunLinkages.mockResolvedValue(new Map());
    serviceMocks.requestRunningIssueInterruptionsInTransaction.mockResolvedValue({
      companyId,
      issueId: "issue",
      ownershipEpoch: 1,
      reason: "active_subtree_pause_hold",
      requests: [],
    });
    serviceMocks.requestScopeCancellationsInTransaction.mockResolvedValue({
      companyId,
      issueId: "issue",
      selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
      reason: "issue_tree_cancelled",
      fence: { refIds: [], correlationIds: [] },
      requests: [],
    });
    serviceMocks.reconcileRequestedRunningIssueInterruptions.mockResolvedValue([]);
    serviceMocks.reconcileRequestedScopeCancellations.mockResolvedValue([]);
  });

  it("previews a subtree, terminal skips, and active execution without mutations", async () => {
    const root = issue({ title: "Root" });
    const agentId = randomUUID();
    const runningChild = issue({
      parentId: root.id,
      title: "Running child",
      status: "in_progress",
      ownerAgentId: agentId,
    });
    const doneChild = issue({
      parentId: root.id,
      title: "Done child",
      status: "done",
    });
    const runId = randomUUID();
    serviceMocks.resolveCurrentIssueOwnerRunLinkages.mockResolvedValue(new Map([
      [runningChild.id, {
        runId,
        issueId: runningChild.id,
        agentId,
        startedAt: baseTime,
        createdAt: baseTime,
      }],
    ]));
    const harness = createMockDb({
      select: [[root], [runningChild, doneChild], [], []],
    });

    const preview = await issueTreeControlService(harness.db).preview(
      companyId,
      root.id,
      { mode: "pause" },
    );

    expect(preview.issues.map((row) => [row.id, row.depth, row.skipReason]))
      .toEqual([
        [root.id, 0, null],
        [runningChild.id, 1, null],
        [doneChild.id, 1, "terminal_status"],
      ]);
    expect(preview.totals).toMatchObject({
      totalIssues: 3,
      affectedIssues: 2,
      skippedIssues: 1,
      activeRuns: 1,
      affectedAgents: 1,
    });
    expect(preview.warnings.map((warning) => warning.code))
      .toContain("running_runs_present");
    expect(harness.calls.some((call) => call.operation !== "select")).toBe(false);
  });

  it("keeps human-owned work static with no affected agent execution", async () => {
    const root = issue({
      title: "Human validation",
      status: "in_progress",
      ownerUserId: boardUserId,
    });
    const harness = createMockDb({ select: [[root], [], []] });

    const preview = await issueTreeControlService(harness.db).preview(
      companyId,
      root.id,
      { mode: "pause" },
    );

    expect(preview.issues).toEqual([
      expect.objectContaining({
        id: root.id,
        ownerAgentId: null,
        ownerUserId: boardUserId,
        activeRun: null,
        skipped: false,
      }),
    ]);
    expect(preview.activeRuns).toEqual([]);
    expect(preview.affectedAgents).toEqual([]);
  });

  it("uses lifecycle rather than stale terminal presentation for tree control", async () => {
    const reopened = issue({
      status: "done",
      lifecycleStatus: "open",
      ownerAgentId: randomUUID(),
    });
    const harness = createMockDb({
      select: [[reopened], [], []],
    });

    const preview = await issueTreeControlService(harness.db).preview(
      companyId,
      reopened.id,
      { mode: "cancel" },
    );

    expect(preview.issues).toEqual([
      expect.objectContaining({ id: reopened.id, skipReason: null }),
    ]);
    expect(preview.totals).toMatchObject({
      affectedIssues: 1,
      skippedIssues: 0,
    });
  });

  it("fails closed when the root is outside the requested company", async () => {
    const harness = createMockDb({ select: [[]] });

    await expect(
      issueTreeControlService(harness.db).preview(
        companyId,
        randomUUID(),
        { mode: "pause" },
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(harness.remaining("select")).toBe(0);
  });

  it("creates a normalized pause snapshot and records the named-board command", async () => {
    const root = issue({ ownerUserId: boardUserId });
    const createdHold = hold({ rootIssueId: root.id });
    const createdMember = member({ holdId: createdHold.id, issueId: root.id });
    const harness = createMockDb({
      select: [[root], [], [], [{ id: root.id, ownershipEpoch: 1 }]],
      insert: [[createdHold], [createdMember]],
      execute: [[]],
    });

    const result = await issueTreeControlService(harness.db, {
      issueExecutionCancellation: {
        requestRunningIssueInterruptionsInTransaction:
          serviceMocks.requestRunningIssueInterruptionsInTransaction,
        reconcileRequestedRunningIssueInterruptions:
          serviceMocks.reconcileRequestedRunningIssueInterruptions,
        requestScopeCancellationsInTransaction:
          serviceMocks.requestScopeCancellationsInTransaction,
        reconcileRequestedScopeCancellations:
          serviceMocks.reconcileRequestedScopeCancellations,
      },
    }).createHold(
      companyId,
      root.id,
      {
        mode: "pause",
        reason: "operator requested pause",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      },
    );

    expect(result.hold).toMatchObject({
      id: createdHold.id,
      mode: "pause",
      status: "active",
      members: [expect.objectContaining({ issueId: root.id, skipped: false })],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          actorUserId: boardUserId,
          subtype: "tree_control_pause",
          sourceCommandId: createdHold.id,
        }),
      );
    expect(serviceMocks.requestRunningIssueInterruptionsInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          issueId: root.id,
          ownershipEpoch: 1,
          reason: "active_subtree_pause_hold",
        }),
      );
    expect(serviceMocks.reconcileRequestedRunningIssueInterruptions)
      .toHaveBeenCalledOnce();
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.calls.findIndex((call) => call.operation === "execute"))
      .toBeLessThan(harness.calls.findIndex((call) => call.operation === "select"));
  });

  it("releases a hold and records a separate named-board lifecycle command", async () => {
    const rootIssueId = randomUUID();
    const existing = hold({ rootIssueId });
    const released = {
      ...existing,
      status: "released",
      releaseReason: "operator resumed",
      releasedAt: new Date("2026-04-21T11:00:00.000Z"),
    };
    const snapshot = member({ holdId: existing.id, issueId: rootIssueId });
    const harness = createMockDb({
      select: [
        [existing],
        [snapshot],
        [{ id: rootIssueId, ownershipEpoch: 1 }],
      ],
      update: [[released]],
    });

    const result = await issueTreeControlService(harness.db).releaseHold(
      companyId,
      rootIssueId,
      existing.id,
      {
        reason: "operator resumed",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      },
    );

    expect(result).toMatchObject({
      id: existing.id,
      status: "released",
      releaseReason: "operator resumed",
      members: [expect.objectContaining({ issueId: rootIssueId })],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subtype: "tree_control_release" }),
      );
  });

  it.each(["cancel", "resume", "restore"] as const)(
    "rejects direct release of a %s hold",
    async (mode) => {
      const rootIssueId = randomUUID();
      const existing = hold({ rootIssueId, mode });
      const harness = createMockDb({ select: [[existing]] });

      await expect(
        issueTreeControlService(harness.db).releaseHold(
          companyId,
          rootIssueId,
          existing.id,
          {
            reason: "invalid direct release",
            actor: {
              actorType: "user",
              actorId: boardUserId,
              userId: boardUserId,
            },
          },
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(harness.calls.some((call) => call.operation === "update"))
        .toBe(false);
    },
  );

  it("allows internal cleanup to release a failed restore command", async () => {
    const rootIssueId = randomUUID();
    const existing = hold({ rootIssueId, mode: "restore" });
    const released = { ...existing, status: "released" };
    const harness = createMockDb({
      select: [[existing], []],
      update: [[released]],
    });

    await expect(issueTreeControlService(harness.db).releaseHold(
      companyId,
      rootIssueId,
      existing.id,
      {
        actor: { actorType: "system", actorId: "restore-cleanup" },
        internal: true,
      },
    )).resolves.toMatchObject({ status: "released", mode: "restore" });
  });

  it("commits a cancel hold, lifecycle update, and execution fence together", async () => {
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const root = issue({ id: rootIssueId, title: "Root" });
    const child = issue({
      id: childIssueId,
      parentId: rootIssueId,
      title: "Running child",
    });
    const cancelHold = hold({ rootIssueId, mode: "cancel" });
    const cancelMember = member({
      holdId: cancelHold.id,
      issueId: childIssueId,
      parentIssueId: rootIssueId,
      status: "in_progress",
    });
    const updatedIssue = {
      id: childIssueId,
      companyId,
      ownershipEpoch: 1,
      identifier: "TST-2",
      title: "Running child",
      boardPresentationStatus: "cancelled",
      ownerAgentId: null,
    };
    const harness = createMockDb({
      select: [[root], [child], [], []],
      insert: [[cancelHold], [cancelMember]],
      update: [[updatedIssue]],
      execute: [[]],
    });

    const result = await issueTreeControlService(harness.db, {
      issueExecutionCancellation: {
        requestRunningIssueInterruptionsInTransaction:
          serviceMocks.requestRunningIssueInterruptionsInTransaction,
        reconcileRequestedRunningIssueInterruptions:
          serviceMocks.reconcileRequestedRunningIssueInterruptions,
        requestScopeCancellationsInTransaction:
          serviceMocks.requestScopeCancellationsInTransaction,
        reconcileRequestedScopeCancellations:
          serviceMocks.reconcileRequestedScopeCancellations,
      },
    })
      .createHold(companyId, rootIssueId, {
        mode: "cancel",
        reason: "cancel subtree",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      });

    expect(result.cancelledIssueIds).toEqual([childIssueId]);
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subtype: "tree_control_cancel" }),
      );
    expect(serviceMocks.requestScopeCancellationsInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId,
          issueId: childIssueId,
          selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
          reason: "issue_tree_cancelled",
        }),
      );
    expect(serviceMocks.reconcileRequestedScopeCancellations)
      .toHaveBeenCalledOnce();
    expect(harness.calls.findIndex((call) => call.operation === "execute"))
      .toBeLessThan(harness.calls.findIndex((call) => call.operation === "select"));
  });

  it("walks pause-hold ancestry beyond fifteen levels", async () => {
    const issuePath = Array.from({ length: 17 }, () => randomUUID());
    const rootIssueId = issuePath[0]!;
    const descendantIssueId = issuePath.at(-1)!;
    const pauseHold = hold({ rootIssueId });
    const parentRows = issuePath
      .slice(1)
      .reverse()
      .map((currentId) => {
        const currentIndex = issuePath.indexOf(currentId);
        return [{ parentId: issuePath[currentIndex - 1] ?? null }];
      });
    const harness = createMockDb({
      select: [[{
        id: pauseHold.id,
        rootIssueId,
        reason: pauseHold.reason,
        releasePolicy: pauseHold.releasePolicy,
      }], ...parentRows],
    });

    const gate = await issueTreeControlService(harness.db)
      .getActivePauseHoldGate(companyId, descendantIssueId);

    expect(gate).toMatchObject({
      holdId: pauseHold.id,
      rootIssueId,
      issueId: descendantIssueId,
      isRoot: false,
      mode: "pause",
    });
    expect(harness.remaining("select")).toBe(0);
  });

  it("resumes only active pause holds rooted in the selected subtree", async () => {
    const root = issue({ title: "Root" });
    const child = issue({ parentId: root.id, title: "Child" });
    const paused = hold({ rootIssueId: child.id });
    const resume = hold({ rootIssueId: root.id, mode: "resume", status: "active" });
    const releasedResume = {
      ...resume,
      status: "released",
      releaseReason: "resume subtree",
      releaseMetadata: {
        resumedPauseHoldIds: [paused.id],
        resumeMode: "subtree",
      },
    };
    const rootMember = member({ holdId: resume.id, issueId: root.id });
    const childMember = member({
      holdId: resume.id,
      issueId: child.id,
      parentIssueId: root.id,
    });
    const harness = createMockDb({
      select: [
        [root],
        [child],
        [],
        [],
        [paused],
        [{ issueId: child.id }],
        [{ id: child.id, ownershipEpoch: 1 }],
      ],
      insert: [[resume], [rootMember, childMember]],
      update: [[], [releasedResume]],
    });

    const result = await issueTreeControlService(harness.db).createHold(
      companyId,
      root.id,
      {
        mode: "resume",
        reason: "resume subtree",
        actor: {
          actorType: "user",
          actorId: boardUserId,
          userId: boardUserId,
        },
      },
    );

    expect(result.resumedPauseHoldIds).toEqual([paused.id]);
    expect(result.hold).toMatchObject({
      id: resume.id,
      mode: "resume",
      status: "released",
      members: [
        expect.objectContaining({ issueId: root.id }),
        expect.objectContaining({ issueId: child.id }),
      ],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          subtype: "tree_control_resume",
          sourceCommandId: resume.id,
        }),
      );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("marks restore conflicts from the active cancel snapshot", async () => {
    const root = issue({ status: "cancelled" });
    const child = issue({
      parentId: root.id,
      status: "cancelled",
      lifecycleStatus: "open",
    });
    const cancelHold = hold({ rootIssueId: root.id, mode: "cancel" });
    const rootSnapshot = member({
      holdId: cancelHold.id,
      issueId: root.id,
      status: "todo",
    });
    const childSnapshot = member({
      holdId: cancelHold.id,
      issueId: child.id,
      parentIssueId: root.id,
      status: "in_progress",
    });
    const harness = createMockDb({
      select: [
        [root],
        [child],
        [],
        [],
        [cancelHold],
        [rootSnapshot, childSnapshot],
      ],
    });

    const preview = await issueTreeControlService(harness.db).preview(
      companyId,
      root.id,
      { mode: "restore" },
    );

    expect(preview.issues.map((row) => [row.id, row.skipReason]))
      .toEqual([
        [root.id, null],
        [child.id, "changed_after_cancel"],
      ]);
    expect(preview.warnings.map((warning) => warning.code))
      .toContain("restore_conflicts_present");
  });
});
