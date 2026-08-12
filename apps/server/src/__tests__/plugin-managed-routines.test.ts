import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginManagedRoutineService } from "../services/plugin-managed-routines.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testSecretsRuntimeConfig } from "./helpers/secrets-runtime.js";

const routineMocks = vi.hoisted(() => ({
  create: vi.fn(),
  createTrigger: vi.fn(),
  update: vi.fn(),
  runRoutine: vi.fn(),
}));
const logActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/routines.js", () => ({
  routineService: vi.fn(() => routineMocks),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity }));

const companyId = "11111111-1111-4111-8111-111111111111";
const pluginId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const routineId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-08-01T12:00:00.000Z");
const pluginKey = "paperclip.managed-routines-test";

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Routines Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["routines.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    routines: [
      {
        routineKey: "nightly-lint",
        title: "Nightly lint",
        description: "Lint plugin state",
        assigneeRef: { resourceKind: "agent", resourceKey: "wiki-maintainer" },
        projectRef: { resourceKind: "project", resourceKey: "operations" },
        status: "active",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        triggers: [
          {
            kind: "schedule",
            label: "Nightly",
            cronExpression: "0 3 * * *",
            timezone: "UTC",
          },
        ],
        taskTemplate: {
          surfaceVisibility: "plugin_operation",
          originId: "operation:nightly-lint",
          billingCode: "plugin-test:nightly-lint",
        },
      },
    ],
  };
}

function binding(resourceId = routineId) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    companyId,
    pluginId,
    pluginKey,
    resourceKind: "routine",
    resourceKey: "nightly-lint",
    resourceId,
    defaultsJson: {},
    manifestJson: { displayName: "Managed Routines Test" },
    createdAt: now,
    updatedAt: now,
  };
}

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: routineId,
    companyId,
    projectId,
    goalId: null,
    title: "Nightly lint",
    description: "Lint plugin state",
    assigneeAgentId: agentId,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function service(db: ReturnType<typeof createMockDb>["db"]) {
  return pluginManagedRoutineService(db, {
    pluginId,
    manifest: manifest(),
    ordinaryTasks: {} as never,
    secretsRuntime: testSecretsRuntimeConfig(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  routineMocks.create.mockResolvedValue(routine());
  routineMocks.createTrigger.mockResolvedValue({ id: "trigger-1" });
  routineMocks.update.mockResolvedValue(routine());
  routineMocks.runRoutine.mockResolvedValue({
    id: "run-1",
    status: "task_created",
    linkedTaskId: "77777777-7777-4777-8777-777777777777",
  });
});

describe("plugin-managed routines", () => {
  it("reports unresolved managed refs without creating a routine", async () => {
    const harness = createMockDb({ select: [[], [], []] });

    await expect(
      service(harness.db).reconcile("nightly-lint", companyId),
    ).resolves.toMatchObject({
      status: "missing_refs",
      routineId: null,
      missingRefs: [
        { resourceKind: "agent", resourceKey: "wiki-maintainer", pluginKey },
        { resourceKind: "project", resourceKey: "operations", pluginKey },
      ],
    });

    expect(routineMocks.create).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
    expect(harness.remaining("select")).toBe(0);
  });

  it("resolves stable managed refs, creates the routine, and installs its trigger", async () => {
    const managedBinding = binding();
    const harness = createMockDb({
      select: [
        [],
        [{ resourceId: agentId }],
        [{ resourceId: projectId }],
        [{ id: agentId }],
        [{ id: projectId }],
        [],
        [],
        [managedBinding],
        [routine()],
      ],
      insert: [[managedBinding]],
    });

    await expect(
      service(harness.db).reconcile("nightly-lint", companyId),
    ).resolves.toMatchObject({
      status: "created",
      routineId,
      routine: {
        id: routineId,
        assigneeAgentId: agentId,
        projectId,
        managedByPlugin: {
          pluginKey,
          resourceKind: "routine",
          resourceKey: "nightly-lint",
        },
      },
    });

    expect(routineMocks.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        assigneeAgentId: agentId,
        projectId,
        title: "Nightly lint",
        status: "active",
      }),
      { type: "system" },
    );
    expect(routineMocks.createTrigger).toHaveBeenCalledWith(
      routineId,
      {
        kind: "schedule",
        label: "Nightly",
        enabled: true,
        cronExpression: "0 3 * * *",
        timezone: "UTC",
      },
      { type: "system" },
    );
    expect(logActivity).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({ action: "plugin.managed_routine.created" }),
    );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("preserves operator edits and avoids recreating an existing routine", async () => {
    const edited = routine({ title: "Operator renamed lint" });
    const harness = createMockDb({
      select: [[binding()], [edited], [binding()], [{ id: "trigger-1" }]],
      update: [[binding()]],
    });

    await expect(
      service(harness.db).reconcile("nightly-lint", companyId),
    ).resolves.toMatchObject({
      status: "resolved",
      routine: { id: routineId, title: "Operator renamed lint" },
    });

    expect(routineMocks.create).not.toHaveBeenCalled();
    expect(routineMocks.update).not.toHaveBeenCalled();
    expect(routineMocks.createTrigger).not.toHaveBeenCalled();
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("runs the resolved managed routine through the canonical routine service", async () => {
    const harness = createMockDb({ select: [[binding()], [routine()]] });

    await expect(
      service(harness.db).run("nightly-lint", companyId),
    ).resolves.toMatchObject({ id: "run-1", status: "task_created" });

    expect(routineMocks.runRoutine).toHaveBeenCalledWith(
      routineId,
      {
        source: "manual",
        assigneeAgentId: undefined,
        projectId: undefined,
      },
      { type: "system" },
    );
    expect(logActivity).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        action: "plugin.managed_routine.run_triggered",
      }),
    );
  });
});
