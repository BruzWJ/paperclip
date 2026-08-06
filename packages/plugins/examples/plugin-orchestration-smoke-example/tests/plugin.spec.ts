import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeMoneyAmount,
  pluginManifestV1Schema,
  type Agent,
  type Issue,
} from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function issue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  const { id, companyId, title, ...rest } = input;
  return {
    id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    request: "Run the plugin issue control-plane smoke flow.",
    boardPresentationStatus: "todo",
    lifecycleStatus: "open",
    workMode: "standard",
    priority: "medium",
    ownerKind: "agent",
    ownerAgentId: rest.ownerAgentId ?? "00000000-0000-4000-8000-000000000001",
    ownerUserId: null,
    ownerAssignmentSource: null,
    ownershipEpoch: 1,
    contextAccessMask: null,
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
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  } as Issue;
}

function agent(id: string, companyId: string): Agent {
  const now = new Date();
  return {
    id,
    companyId,
    name: "Smoke owner",
    urlKey: "smoke-owner",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: "Owns ordinary plugin smoke issues.",
    adapterType: "codex",
    adapterConfig: { model: "gpt-5.6" },
    runtimeConfig: {},
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    pauseReason: null,
    pausedAt: null,
    governance: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("issue runtime smoke plugin", () => {
  it("declares the canonical issue control-plane surfaces", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclipai.plugin-orchestration-smoke-example",
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["issues"],
      },
      apiRoutes: [
        expect.objectContaining({ routeKey: "initialize" }),
        expect.objectContaining({ routeKey: "summary" }),
      ],
    });
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "issues.read",
      "issues.create",
    ]));
    expect(manifest.capabilities).not.toEqual(expect.arrayContaining([
      "issues.update",
      "issues.withdraw",
      "issue.relations.read",
      "issue.documents.read",
      "issues.orchestration.read",
    ]));
  });

  it("creates a plugin-owned ordinary issue and records its durable binding", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      agents: [agent(agentId, companyId)],
      issues: [
        issue({
          id: rootIssueId,
          companyId,
          title: "Root orchestration issue",
          ownerAgentId: agentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      rootIssueId: string;
      childIssueId: string;
      ownerAgentId: string;
      request: string;
      childStatus: string;
    }>("initialize-smoke", {
      issueId: rootIssueId,
      ownerAgentId: agentId,
    }, {
      actor: { type: "system", companyId },
    });

    expect(result.rootIssueId).toBe(rootIssueId);
    expect(result.childIssueId).toEqual(expect.any(String));
    expect(result.ownerAgentId).toBe(agentId);
    expect(result.childStatus).toBe("open");
    expect(result.request).toContain("canonical plugin issue creation");
    expect(harness.dbExecutes[0]?.sql).toContain(".smoke_runs");
    expect(harness.dbQueries.some((entry) => entry.sql.includes("JOIN public.issues"))).toBe(true);
    await expect(harness.ctx.issues.get(result.childIssueId, companyId)).resolves.toMatchObject({
      id: result.childIssueId,
      parentId: rootIssueId,
      ownerAgentId: agentId,
      creatorKind: "plugin",
      creatorPluginKey: manifest.id,
    });
  });

  it("dispatches the scoped API route through the same smoke path", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      agents: [agent(agentId, companyId)],
      issues: [
        issue({
          id: rootIssueId,
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
      path: `/issues/${rootIssueId}/smoke`,
      params: { issueId: rootIssueId },
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
        rootIssueId,
        ownerAgentId: agentId,
        childStatus: "open",
      }),
    });
  });
});
