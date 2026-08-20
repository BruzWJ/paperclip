import { createHash as createHashImport } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb as createMockDbImport, type MockDbHarness } from "./helpers/mock-db.js";
import {
  createOrdinaryTaskRuntime as createOrdinaryTaskRuntimeImport,
  OrdinaryTaskRuntimeRejected as OrdinaryTaskRuntimeRejectedImport,
} from "../services/ordinary-task-runtime.js";
import { RuntimeTaskActionDenied as RuntimeTaskActionDeniedImport } from "../services/runtime-task-action-port.js";
import { canonicalJson as canonicalJsonImport } from "../services/canonical-json.js";

export const createHash = createHashImport;
export const createMockDb = createMockDbImport;
export const createOrdinaryTaskRuntime = createOrdinaryTaskRuntimeImport;
export const OrdinaryTaskRuntimeRejected = OrdinaryTaskRuntimeRejectedImport;
export const RuntimeTaskActionDenied = RuntimeTaskActionDeniedImport;
export const canonicalJson = canonicalJsonImport;
const hoistedMocks = vi.hoisted(() => ({
  sessions: {
    admitExecutionSource: vi.fn(),
    admitExecutionSourceBatch: vi.fn(),
    appendNonDispatchUserComment: vi.fn(),
  },
  taskForms: {
    commitOwnerFormUpdate: vi.fn(),
    commitCreatorFormUpdate: vi.fn(),
  },
  resolveInvokableOwner: vi.fn(),
  reserveWorkspace: vi.fn(),
  persistActivity: vi.fn(),
  publishActivity: vi.fn(),
  revokeOwnership: vi.fn(),
  dispatchRef: vi.fn(),
  requestCancellations: vi.fn(),
  reconcileCancellations: vi.fn(),
}));
export const mocks = hoistedMocks;

vi.mock("../services/task-session/admission.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/task-session/admission.js")>();
  return {
    ...actual,
    createTaskSessionAdmissionService: vi.fn(() => hoistedMocks.sessions),
  };
});

vi.mock("../services/runtime-task-action-port.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/runtime-task-action-port.js")>();
  return {
    ...actual,
    createTaskFormCommitRuntime: vi.fn(() => hoistedMocks.taskForms),
    revokeOutgoingOwnershipEpoch: hoistedMocks.revokeOwnership,
  };
});

vi.mock("../services/agent-invokability.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/agent-invokability.js")>();
  return {
    ...actual,
    resolveInvokableTaskOwnerInTransaction: hoistedMocks.resolveInvokableOwner,
  };
});

vi.mock("../services/execution-workspaces.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/execution-workspaces.js")>()),
  reserveTaskExecutionWorkspaceBinding: hoistedMocks.reserveWorkspace,
}));

vi.mock("../services/activity-log.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/activity-log.js")>()),
  persistActivityLog: hoistedMocks.persistActivity,
  publishCommittedActivity: hoistedMocks.publishActivity,
}));

export const COMPANY_ID = "company-1";
export const TASK_ID = "task-1";
export const NOW = new Date("2026-07-25T20:00:00.000Z");

export function identityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createRuntime(harness: MockDbHarness) {
  return createOrdinaryTaskRuntime(harness.db, {
    clock: () => NOW,
    taskExecutionCancellation: {
      requestScopeCancellationsInTransaction: mocks.requestCancellations,
      reconcileRequestedCancellations: mocks.reconcileCancellations,
    },
    dispatchRef: mocks.dispatchRef,
  });
}

export function sessionState() {
  return {
    session: {
      id: "ses_task_1",
      companyId: COMPANY_ID,
      taskId: TASK_ID,
      integrityState: "ready",
      timeArchived: null,
      purgeFencedAt: null,
    },
    contextGeneration: 3,
  };
}

beforeEach(() => {
  for (const candidate of Object.values(mocks)) {
    if (typeof candidate === "function" && "mockReset" in candidate) {
      candidate.mockReset();
    }
  }
  for (const candidate of Object.values(mocks.sessions)) candidate.mockReset();
  for (const candidate of Object.values(mocks.taskForms)) candidate.mockReset();
  mocks.resolveInvokableOwner.mockResolvedValue({
    revisionId: "revision-owner",
  });
  mocks.reserveWorkspace.mockResolvedValue({ contextEpochGeneration: 4 });
  mocks.persistActivity.mockResolvedValue({ row: { id: "reassignment-audit" }, taskId: TASK_ID });
  mocks.revokeOwnership.mockResolvedValue({ escalationDispatchRefIds: [], cancellations: null });
  mocks.dispatchRef.mockResolvedValue(undefined);
  mocks.requestCancellations.mockResolvedValue(null);
  mocks.reconcileCancellations.mockResolvedValue(undefined);
});

export { beforeEach, describe, expect, it, vi };
export type { MockDbHarness };
