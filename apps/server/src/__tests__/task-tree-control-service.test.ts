import "./task-tree-control-service.test-suite-01-previews-a-subtree-terminal-skips.js";
import * as t from "./task-tree-control-service.test-support.js";
const { describe, registerSuiteSetup, it, task, hold, member, createMockDb } = t;
const { taskTreeControlService, companyId, boardUserId, expect, serviceMocks } = t;

describe("taskTreeControlService without a database process", () => {
  registerSuiteSetup();

  it("resumes only active pause holds rooted in the selected subtree", async () => {
    const root = task({ title: "Root" });
    const child = task({ parentId: root.id, title: "Child" });
    const paused = hold({ rootTaskId: child.id });
    const resume = hold({
      rootTaskId: root.id,
      mode: "resume",
      status: "active",
    });
    const releasedResume = {
      ...resume,
      status: "released",
      releaseReason: "resume subtree",
      releaseMetadata: {
        resumedPauseHoldIds: [paused.id],
        resumeMode: "subtree",
      },
    };
    const rootMember = member({
      holdId: resume.id,
      taskId: root.id,
    });
    const childMember = member({
      holdId: resume.id,
      taskId: child.id,
      parentTaskId: root.id,
    });
    const harness = createMockDb({
      select: [
        [root],
        [child],
        [],
        [],
        [paused],
        [{ taskId: child.id }],
        [{ id: child.id, ownershipEpoch: 1 }],
      ],
      insert: [[resume], [rootMember, childMember]],
      update: [[], [releasedResume]],
    });

    const result = await taskTreeControlService(harness.db).createHold(companyId, root.id, {
      mode: "resume",
      reason: "resume subtree",
      actor: {
        actorType: "user",
        actorId: boardUserId,
        userId: boardUserId,
      },
    });

    expect(result.resumedPauseHoldIds).toEqual([paused.id]);
    expect(result.hold).toMatchObject({
      id: resume.id,
      mode: "resume",
      status: "released",
      members: [expect.objectContaining({ taskId: root.id }), expect.objectContaining({ taskId: child.id })],
    });
    expect(serviceMocks.recordNamedBoardLifecycleCommandInTransaction).toHaveBeenCalledWith(
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
    const root = task({ status: "cancelled" });
    const child = task({
      parentId: root.id,
      status: "cancelled",
      lifecycleStatus: "open",
    });
    const cancelHold = hold({
      rootTaskId: root.id,
      mode: "cancel",
    });
    const rootSnapshot = member({
      holdId: cancelHold.id,
      taskId: root.id,
      status: "todo",
    });
    const childSnapshot = member({
      holdId: cancelHold.id,
      taskId: child.id,
      parentTaskId: root.id,
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
        [
          { id: root.id, taskNumber: root.taskNumber },
          { id: child.id, taskNumber: child.taskNumber },
        ],
      ],
    });

    const preview = await taskTreeControlService(harness.db).preview(companyId, root.id, { mode: "restore" });

    expect(preview.tasks.map((row) => [row.id, row.skipReason])).toEqual([
      [root.id, null],
      [child.id, "changed_after_cancel"],
    ]);
    expect(preview.warnings.map((warning) => warning.code)).toContain("restore_conflicts_present");
  });
});
