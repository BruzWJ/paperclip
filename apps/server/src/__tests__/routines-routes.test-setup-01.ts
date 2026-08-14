import * as t from "./routines-routes.test-support.js";
const { beforeEach, vi, registerModuleMocks, mockGetTelemetryClient } = t;
const { mockRoutineService, routine, trigger, otherAgentId, revision } = t;
const { mockAccessService, mockLogActivity, companyId, routineId, revisionId, mockAnnotationService } = t;

export function registerSuiteSetup() {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({
      track: vi.fn(),
    });
    mockRoutineService.list.mockResolvedValue([routine]);
    mockRoutineService.create.mockResolvedValue(routine);
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.getTrigger.mockResolvedValue(trigger);
    mockRoutineService.update.mockResolvedValue({
      ...routine,
      assigneeAgentId: otherAgentId,
    });
    mockRoutineService.listRevisions.mockResolvedValue([revision]);
    mockRoutineService.restoreRevision.mockResolvedValue({
      routine,
      revision: {
        ...revision,
        revisionNumber: 2,
        restoredFromRevisionId: revision.id,
      },
      restoredFromRevisionId: revision.id,
      restoredFromRevisionNumber: revision.revisionNumber,
      secretMaterials: [],
    });
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-1",
      source: "manual",
      status: "task_created",
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      explanation: "Board membership is viewer-only",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockRoutineService.getDescriptionDocument.mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      companyId,
      routineId,
      key: "description",
      title: "Routine description",
      format: "markdown",
      body: "Alpha selected text omega",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });
    mockAnnotationService.listThreadsForRoutineDocument.mockResolvedValue([]);
    mockAnnotationService.getThreadForRoutineDocument.mockResolvedValue(null);
    const annotationThread = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId,
      taskId: null,
      routineId,
      documentId: "99999999-9999-4999-8999-999999999999",
      documentKey: "description",
      status: "open",
      anchorState: "active",
      anchorConfidence: "exact",
      originalRevisionId: revisionId,
      originalRevisionNumber: 1,
      currentRevisionId: revisionId,
      currentRevisionNumber: 1,
      selectedText: "selected text",
      prefixText: "Alpha ",
      suffixText: " omega",
      normalizedStart: 6,
      normalizedEnd: 19,
      markdownStart: 6,
      markdownEnd: 19,
      anchorSelector: {
        quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
        position: {
          normalizedStart: 6,
          normalizedEnd: 19,
          markdownStart: 6,
          markdownEnd: 19,
        },
      },
      createdByAgentId: null,
      createdByUserId: "board-user",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
      comments: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          companyId,
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          taskId: null,
          routineId,
          documentId: "99999999-9999-4999-8999-999999999999",
          body: "Please review",
          authorType: "user",
          authorAgentId: null,
          authorUserId: "board-user",
          createdByRunId: null,
          taskCommentId: null,
          createdAt: new Date("2026-03-20T00:00:00.000Z"),
          updatedAt: new Date("2026-03-20T00:00:00.000Z"),
        },
      ],
    };
    mockAnnotationService.createRoutineThread.mockResolvedValue(annotationThread);
    mockAnnotationService.addRoutineComment.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      companyId,
      threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      taskId: null,
      routineId,
      documentId: "99999999-9999-4999-8999-999999999999",
      body: "Reply",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "board-user",
      createdByRunId: null,
      taskCommentId: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });
    mockAnnotationService.updateRoutineThread.mockResolvedValue({
      ...annotationThread,
      status: "resolved",
    });
    mockAnnotationService.remapOpenThreadsForRoutineDocument.mockResolvedValue([]);
  });
}
