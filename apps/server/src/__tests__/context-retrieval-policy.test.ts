import { describe, expect, it } from "vitest";
import { resolveContextDial } from "../services/context-dial-resolver.ts";
import {
  ContextRetrievalDenied,
  createContextRetrievalService,
  type CanonicalRunTrace,
  type ContextRetrievalTaskProjection,
  type ContextRetrievalRepository,
} from "../services/context-retrieval.ts";

function task(
  id: string,
  parentId: string | null,
): ContextRetrievalTaskProjection {
  return {
    id,
    identifier: `PAP-${id}`,
    title: id,
    request: id,
    status: "open",
    disposition: null,
    priority: "medium",
    creator: { kind: "system", sourceKind: "recovery" },
    owner: { kind: "agent", agentId: "owner" },
    parentId,
    directChildCount: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function canonicalTrace(
  runId: string,
  taskId: string,
): CanonicalRunTrace {
  return {
    runId,
    runKind: "productive",
    taskId,
    status: "succeeded",
    startedAt: "2026-07-28T00:00:00.000Z",
    finishedAt: "2026-07-28T00:00:01.000Z",
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      knownDeltaAmount: "0",
    },
    checkpoint: null,
    turns: [],
    outcome: null,
    comments: [],
  };
}

function repository(): ContextRetrievalRepository {
  const reach = new Map([
    ["active", { sameCompany: true, active: true, descendant: false }],
    ["child", { sameCompany: true, active: false, descendant: true }],
    ["other", { sameCompany: true, active: false, descendant: false }],
    ["cross", { sameCompany: false, active: false, descendant: false }],
  ]);
  const runTasks = new Map([
    ["run-active", "active"],
    ["run-child", "child"],
    ["run-other", "other"],
    ["run-cross", "cross"],
  ]);
  return {
    async taskReach({ taskId }) {
      return reach.get(taskId) ?? null;
    },
    async listTopLevelTasks() {
      return [];
    },
    async listDirectChildren({ taskId }) {
      return [task(`${taskId}-child`, taskId)];
    },
    async listTaskComments() {
      return [];
    },
    async runTask({ runId }) {
      const taskId = runTasks.get(runId);
      return taskId ? { taskId } : null;
    },
    async readCanonicalRunTrace({ runId }) {
      const taskId = runTasks.get(runId);
      return taskId ? canonicalTrace(runId, taskId) : null;
    },
  };
}

function scope(
  agent: Parameters<typeof resolveContextDial>[0]["agent"],
) {
  return {
    companyId: "company",
    activeTaskId: "active",
    dial: resolveContextDial({ agent }).effective,
  };
}

function service() {
  return createContextRetrievalService({
    cursorSecret: "policy-test-secret",
    repository: repository(),
  });
}

const REACH_CASES = [false, true].flatMap((current) =>
  [false, true].flatMap((descendant) =>
    [false, true].map((company) => ({
      name: `current=${current} descendant=${descendant} company=${company}`,
      current,
      descendant,
      company,
    })),
  ),
);

describe("context retrieval policy", () => {
  it("keeps sub-only omission, explicit-active rejection, and proper-descendant reach exact", async () => {
    const api = service();
    const subOnly = scope({ list_sub_tasks: true });

    await expect(api.listSubTasks(subOnly)).resolves.toMatchObject({
      items: [{ parentId: "active" }],
    });
    await expect(
      api.listSubTasks(subOnly, { taskId: undefined }),
    ).resolves.toMatchObject({
      items: [{ parentId: "active" }],
    });
    await expect(
      api.listSubTasks(subOnly, { taskId: "active" }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);
    await expect(
      api.listSubTasks(subOnly, { taskId: "child" }),
    ).resolves.toMatchObject({
      items: [{ parentId: "child" }],
    });
    await expect(
      api.listSubTasks(subOnly, { taskId: "other" }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);
  });

  it("lets company listing target any same-company task but never cross company", async () => {
    const api = service();
    const company = scope({ list_company_tasks: true });

    await expect(api.listSubTasks(company)).resolves.toBeDefined();
    for (const taskId of ["active", "child", "other"]) {
      await expect(
        api.listSubTasks(company, { taskId }),
      ).resolves.toBeDefined();
    }
    await expect(
      api.listSubTasks(company, { taskId: "cross" }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);
  });

  it.each(REACH_CASES)(
    "enforces the exact comment reach for $name",
    async ({ current, descendant, company }) => {
      const api = service();
      const activeScope = scope({
        read_task_comments: current,
        read_sub_task_comments: descendant,
        read_company_task_comments: company,
      });
      const assertResult = async (
        accepted: boolean,
        input: { taskId?: string },
      ) => {
        const result = api.readTaskComments(activeScope, input);
        if (accepted) {
          await expect(result).resolves.toBeDefined();
        } else {
          await expect(result).rejects.toBeInstanceOf(
            ContextRetrievalDenied,
          );
        }
      };

      await assertResult(current, {});
      await assertResult(current, { taskId: undefined });
      await assertResult(current || company, { taskId: "active" });
      await assertResult(descendant || company, { taskId: "child" });
      await assertResult(company, { taskId: "other" });
      await assertResult(false, { taskId: "cross" });
    },
  );

  it.each(REACH_CASES)(
    "enforces the exact run reach for $name",
    async ({ current, descendant, company }) => {
      const api = service();
      const activeScope = scope({
        read_task_agent_run: current,
        read_sub_task_agent_run: descendant,
        read_company_task_agent_run: company,
      });
      const expected = new Map([
        ["run-active", current || company],
        ["run-child", descendant || company],
        ["run-other", company],
        ["run-cross", false],
      ]);
      for (const [runId, accepted] of expected) {
        const result = api.readTaskAgentRun(activeScope, { runId });
        if (accepted) {
          await expect(result).resolves.toBeDefined();
        } else {
          await expect(result).rejects.toBeInstanceOf(
            ContextRetrievalDenied,
          );
        }
      }
    },
  );
});
