import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockDb as createQueuedMockDb,
  type MockDbHarness,
  type MockDbPlan,
} from "./helpers/mock-db.js";
import { testSecretsRuntimeConfig } from "./helpers/secrets-runtime.js";
import { nextCronTickInTimeZone, routineService } from "../services/routines.js";
const hoistedMocks = vi.hoisted(() => ({
  resolveOwner: vi.fn(),
  terminalizeRoutineEdges: vi.fn(),
  logActivity: vi.fn(),
  secrets: {
    normalizeEnvBindingsForPersistence: vi.fn(),
    syncEnvBindingsForTarget: vi.fn(),
    createBound: vi.fn(),
    remove: vi.fn(),
    rotate: vi.fn(),
    resolveSecretValue: vi.fn(),
  },
}));
export const mocks = hoistedMocks;

vi.mock("../services/agent-invokability.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/agent-invokability.js")>();
  return {
    ...actual,
    resolveInvokableTaskOwnerInTransaction: hoistedMocks.resolveOwner,
  };
});

vi.mock("../services/system-escalation-postgres.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/system-escalation-postgres.js")>();
  return {
    ...actual,
    terminalizeRoutineCreatorEdgesInTransaction: hoistedMocks.terminalizeRoutineEdges,
  };
});

vi.mock("../services/task-session/admission.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/task-session/admission.js")>();
  return {
    ...actual,
    createTaskSessionAdmissionService: vi.fn(() => ({})),
  };
});

vi.mock("../services/secrets.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/secrets.js")>();
  return {
    ...actual,
    secretService: vi.fn(() => hoistedMocks.secrets),
  };
});

vi.mock("../services/activity-log.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/activity-log.js")>();
  return { ...actual, logActivity: hoistedMocks.logActivity };
});

vi.mock("../telemetry.js", async (importActual) => {
  const actual = await importActual<typeof import("../telemetry.js")>();
  return { ...actual, getTelemetryClient: vi.fn(() => null) };
});

export const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
export const ROUTINE_ID = "22222222-2222-4222-8222-222222222222";
export const CALLING_AGENT_ID = "33333333-3333-4333-8333-333333333333";
export const ROUTINE_REVISION_ID = "44444444-4444-4444-8444-000000000001";
export const HISTORICAL_REVISION_ID = "55555555-5555-4555-8555-555555555555";
export const USER_ACTOR = { type: "user", userId: "board-user" } as const;
export const NOW = new Date("2026-07-25T12:08:00.000Z");

/**
 * Routines deliberately distinguish a root Db from its transaction executor
 * when deciding whether to open a nested transaction. Keep those identities
 * distinct while delegating every operation to the same deterministic queues.
 */
export function createMockDb(plan: MockDbPlan = {}): MockDbHarness {
  const harness = createQueuedMockDb(plan);
  let transactionDb: typeof harness.db;
  transactionDb = new Proxy(harness.db, {
    get(target, property) {
      if (property === "transaction") {
        return vi.fn(async (callback: (tx: typeof harness.db) => unknown) => callback(transactionDb));
      }
      return Reflect.get(target, property);
    },
  });
  const rootDb = new Proxy(harness.db, {
    get(target, property) {
      if (property === "transaction") {
        return vi.fn(async (callback: (tx: typeof harness.db) => unknown) => callback(transactionDb));
      }
      return Reflect.get(target, property);
    },
  });
  return { ...harness, db: rootDb };
}

export function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUTINE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    folderId: null,
    goalId: null,
    parentTaskId: null,
    title: "Repository triage",
    description: "Review the repository",
    assigneeAgentId: "agent-owner",
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    env: null,
    responsibleUserId: "board-user",
    originKind: "manual",
    originId: null,
    latestRevisionId: ROUTINE_REVISION_ID,
    latestRevisionNumber: 1,
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: new Date("2026-07-25T10:00:00.000Z"),
    updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    ...overrides,
  };
}

export function snapshot(row: ReturnType<typeof routine>, triggers: unknown[] = []) {
  return {
    version: 1 as const,
    routine: {
      id: row.id,
      companyId: row.companyId,
      projectId: row.projectId,
      goalId: row.goalId,
      parentTaskId: row.parentTaskId,
      title: row.title,
      description: row.description,
      assigneeAgentId: row.assigneeAgentId,
      priority: row.priority,
      status: row.status,
      concurrencyPolicy: row.concurrencyPolicy,
      catchUpPolicy: row.catchUpPolicy,
      variables: row.variables,
      env: row.env,
      responsibleUserId: row.responsibleUserId,
    },
    triggers,
  };
}

export function revision(row: ReturnType<typeof routine>, overrides: Record<string, unknown> = {}) {
  const revisionNumber = Number(overrides.revisionNumber ?? row.latestRevisionNumber);
  return {
    id: `44444444-4444-4444-8444-${String(revisionNumber).padStart(12, "0")}`,
    companyId: row.companyId,
    routineId: row.id,
    revisionNumber,
    title: row.title,
    description: row.description,
    snapshot: snapshot(row),
    changeSummary: null,
    restoredFromRevisionId: null,
    createdByAgentId: null,
    createdByUserId: "board-user",
    createdByRunId: null,
    responsibleUserId: row.responsibleUserId,
    createdAt: NOW,
    ...overrides,
  };
}

export function descriptionDocument(row: ReturnType<typeof routine>) {
  return {
    id: "document-1",
    companyId: row.companyId,
    routineId: row.id,
    key: "description",
    title: "Routine description",
    format: "markdown",
    latestBody: row.description ?? "",
    latestRevisionId: "document-revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function ordinaryTasks() {
  return {
    create: vi.fn(),
    dispatchRef: vi.fn().mockResolvedValue(undefined),
  };
}

export function service(
  harness: MockDbHarness,
  ordinary = ordinaryTasks(),
  runtimeEnv: Record<string, string | undefined> = {
    PAPERCLIP_PUBLIC_URL: "https://paperclip.example/",
  },
) {
  return {
    ordinary,
    service: routineService(harness.db, {
      runtimeEnv,
      ordinaryTasks: ordinary as never,
      secretsRuntime: testSecretsRuntimeConfig(),
    }),
  };
}

export function queryValues(harness: MockDbHarness, operation: "insert" | "update") {
  const valueMethod = operation === "insert" ? "values" : "set";
  return harness.calls
    .filter((call) => call.operation === operation && call.method === valueMethod)
    .map((call) => call.args[0]);
}

export function creationHarness(created: ReturnType<typeof routine>) {
  const createdRevision = revision(created, {
    id: ROUTINE_REVISION_ID,
    revisionNumber: 1,
    snapshot: snapshot(created),
    changeSummary: "Created routine",
  });
  const committed = {
    ...created,
    latestRevisionId: createdRevision.id,
    latestRevisionNumber: 1,
  };
  const document = {
    id: "document-1",
    companyId: created.companyId,
    title: "Routine description",
    format: "markdown",
    latestBody: created.description ?? "",
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const documentRevision = {
    id: "document-revision-1",
    documentId: document.id,
  };
  return {
    committed,
    harness: createMockDb({
      select: [[], []],
      insert: [[created], [createdRevision], [document], [documentRevision], []],
      update: [[committed], []],
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.resolveOwner.mockReset();
  mocks.terminalizeRoutineEdges.mockReset();
  mocks.logActivity.mockReset();
  for (const candidate of Object.values(mocks.secrets)) candidate.mockReset();
  mocks.resolveOwner.mockResolvedValue({ revisionId: "agent-revision-1" });
  mocks.terminalizeRoutineEdges.mockResolvedValue([]);
  mocks.logActivity.mockResolvedValue(undefined);
  mocks.secrets.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
  mocks.secrets.syncEnvBindingsForTarget.mockResolvedValue(undefined);
  mocks.secrets.remove.mockResolvedValue(undefined);
  mocks.secrets.rotate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

export { createHmac, afterEach, beforeEach, describe, expect, it, vi };
export { testSecretsRuntimeConfig };
export { routineService };
export type { MockDbHarness, MockDbPlan };
