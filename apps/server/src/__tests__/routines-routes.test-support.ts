import express from "express";
import requestModule from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import { testSecretsRuntimeConfig } from "./helpers/secrets-runtime.js";
export const request = requestModule;
export const companyId = "22222222-2222-4222-8222-222222222222";
export const agentId = "11111111-1111-4111-8111-111111111111";
export const routineId = "33333333-3333-4333-8333-333333333333";
export const projectId = "44444444-4444-4444-8444-444444444444";
export const otherAgentId = "55555555-5555-4555-8555-555555555555";
export const revisionId = "77777777-7777-4777-8777-777777777777";

export const routine = {
  id: routineId,
  companyId,
  projectId,
  goalId: null,
  parentTaskId: null,
  title: "Daily routine",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  variables: [],
  latestRevisionId: revisionId,
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

export const revision = {
  id: revisionId,
  companyId,
  routineId,
  revisionNumber: 1,
  title: "Daily routine",
  description: null,
  snapshot: {
    version: 1,
    routine: {
      id: routineId,
      companyId,
      projectId,
      goalId: null,
      parentTaskId: null,
      title: "Daily routine",
      description: null,
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    },
    triggers: [],
  },
  changeSummary: "Created routine",
  restoredFromRevisionId: null,
  createdByAgentId: null,
  createdByUserId: "board-user",
  createdByRunId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
};
export const pausedRoutine = {
  ...routine,
  status: "paused",
};
export const trigger = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  routineId,
  kind: "schedule",
  label: "weekday",
  enabled: false,
  cronExpression: "0 10 * * 1-5",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

export const mockRoutineService = {
  list: vi.fn(),
  get: vi.fn(),
  getDetail: vi.fn(),
  getDescriptionDocument: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
  listRuns: vi.fn(),
  createTrigger: vi.fn(),
  getTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  rotateTriggerSecret: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
};

export const mockAnnotationService = {
  listThreadsForRoutineDocument: vi.fn(),
  getThreadForRoutineDocument: vi.fn(),
  createRoutineThread: vi.fn(),
  addRoutineComment: vi.fn(),
  updateRoutineThread: vi.fn(),
  remapOpenThreadsForRoutineDocument: vi.fn(),
};

export const mockAccessService = {
  decide: vi.fn(),
};

export const mockLogActivity = vi.fn();
export const mockTrackRoutineCreated = vi.fn();
export const mockGetTelemetryClient = vi.fn();

export function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackRoutineCreated: mockTrackRoutineCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    documentAnnotationService: () => mockAnnotationService,
    logActivity: mockLogActivity,
    routineService: () => mockRoutineService,
  }));
}

export async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { routineRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/routines.js")>("../routes/routines.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    routineRoutes({} as any, {
      ordinaryTasks: {} as never,
      secretsRuntime: testSecretsRuntimeConfig(),
    }),
  );
  app.use(errorHandler);
  return app;
}

export async function createBoardApp(
  membershipRole: "admin" | "viewer" | "operator",
  memberCompanyId = companyId,
  isInstanceAdmin = membershipRole === "admin",
) {
  return createApp(
    testBoardSessionActor({
      userId: "board-user",
      sessionId: "session-board-user",
      isInstanceAdmin,
      companyIds: [memberCompanyId],
      memberships: [
        {
          companyId: memberCompanyId,
          status: "active",
          membershipRole,
        },
      ],
    }),
  );
}

export { beforeEach, describe, expect, it, vi };
