import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeMoneyAmount,
  pluginManifestV1Schema,
  type Agent,
  type Company,
  type Task,
} from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function task(input: Partial<Task> & Pick<Task, "id" | "companyId" | "title">): Task {
  const now = new Date();
  const {
    id,
    companyId,
    title,
    taskNumber: requestedTaskNumber,
    identifier: requestedIdentifier,
    ...rest
  } = input;
  const taskNumber = requestedTaskNumber ?? 1;
  return {
    id,
    companyId,
    projectId: null,
    goalId: null,
    parentId: null,
    title,
    request: "Run the plugin task control-plane smoke flow.",
    boardPresentationStatus: "todo",
    lifecycleStatus: "open",
    workMode: "standard",
    priority: "medium",
    ownerKind: "agent",
    ownerAgentId: rest.ownerAgentId ?? "00000000-0000-4000-8000-000000000001",
    ownerUserId: null,
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorAuthorityId: null,
    creatorAdapterConfigRevisionId: null,
    creatorUserId: null,
    creatorPluginInstallationId: null,
    creatorPluginKey: null,
    creatorCallbackKey: null,
    creatorCallbackVersion: null,
    creatorRoutineId: null,
    creatorRoutineDispatchId: null,
    creatorSystemSourceKind: null,
    creatorSystemSourceId: null,
    responsibleUserId: null,
    taskNumber,
    identifier: requestedIdentifier ?? `PSM-${taskNumber}`,
    requestDepth: 0,
    billingCode: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  } as Task;
}

function company(id: string): Company {
  const now = new Date();
  return {
    id,
    name: "Plugin smoke company",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    taskPrefix: "PSM",
    taskCounter: 1,
    budgetCurrency: "USD",
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

function agent(id: string, companyId: string): Agent {
  const now = new Date();
  return {
    id,
    companyId,
    name: "Smoke owner",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: "Owns ordinary plugin smoke tasks.",
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    pauseReason: null,
    pausedAt: null,
    instruction: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("task runtime smoke plugin", () => {
  it("declares the canonical task control-plane surfaces", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclipai.plugin-orchestration-smoke-example",
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["tasks"],
      },
      apiRoutes: [
        expect.objectContaining({ routeKey: "initialize" }),
        expect.objectContaining({ routeKey: "summary" }),
      ],
    });
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "tasks.read",
      "tasks.create",
    ]));
    expect(manifest.capabilities).not.toEqual(expect.arrayContaining([
      "tasks.update",
      "tasks.withdraw",
      "task.relations.read",
      "task.documents.read",
      "tasks.orchestration.read",
    ]));
  });

  it("creates a plugin-owned ordinary task and records its durable binding", async () => {
    const companyId = randomUUID();
    const rootTaskId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      companies: [company(companyId)],
      agents: [agent(agentId, companyId)],
      tasks: [
        task({
          id: rootTaskId,
          companyId,
          title: "Root orchestration task",
          ownerAgentId: agentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      rootTaskId: string;
      childTaskId: string;
      ownerAgentId: string;
      request: string;
      childStatus: string;
    }>("initialize-smoke", {
      taskId: rootTaskId,
      ownerAgentId: agentId,
    }, {
      actor: { type: "system", companyId },
    });

    expect(result.rootTaskId).toBe(rootTaskId);
    expect(result.childTaskId).toEqual(expect.any(String));
    expect(result.ownerAgentId).toBe(agentId);
    expect(result.childStatus).toBe("open");
    expect(result.request).toContain("canonical plugin task creation");
    expect(harness.dbExecutes[0]?.sql).toContain(".smoke_runs");
    expect(harness.dbQueries.some((entry) => entry.sql.includes("JOIN public.tasks"))).toBe(true);
    await expect(harness.ctx.tasks.get(result.childTaskId, companyId)).resolves.toMatchObject({
      id: result.childTaskId,
      parentId: rootTaskId,
      ownerAgentId: agentId,
      creatorKind: "plugin",
      creatorPluginKey: manifest.id,
    });
  });

  it("dispatches the scoped API route through the same smoke path", async () => {
    const companyId = randomUUID();
    const rootTaskId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      companies: [company(companyId)],
      agents: [agent(agentId, companyId)],
      tasks: [
        task({
          id: rootTaskId,
          companyId,
          title: "Scoped API root",
          ownerAgentId: agentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(plugin.definition.onApiRequest?.({
      routeKey: "initialize",
      method: "POST",
      path: `/tasks/${rootTaskId}/smoke`,
      params: { taskId: rootTaskId },
      query: {},
      body: { ownerAgentId: agentId },
      actor: {
        type: "user",
        userId: "board",
      },
      companyId,
      headers: {},
    })).resolves.toMatchObject({
      status: 201,
      body: expect.objectContaining({
        rootTaskId,
        ownerAgentId: agentId,
        childStatus: "open",
      }),
    });
  });
});
