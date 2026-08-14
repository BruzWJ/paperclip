/**
 * Immutable creator attribution that is safe to expose through a compiled
 * provider interface. The canonical creator record contains authority,
 * adapter-revision, callback, and other control-plane identifiers; none of
 * those are retrieval content.
 */
import { type ProviderSafeRunTrace } from "@paperclipai/shared";
import { resolveContextRetrievalPolicy } from "./context-dial-resolver.js";
import {
  ContextRetrievalDenied,
  type ContextRetrievalCommentProjection,
  type ContextRetrievalRepository,
  type ContextRetrievalScope,
  type ContextRetrievalServiceOptions,
  type ContextRetrievalTaskProjection,
  type RetrievalPage,
  type RetrievalPageRequest,
  type RetrievalTaskFilters,
} from "./context-retrieval-contracts.js";
import {
  boundedLimit,
  commentPosition,
  decodeRetrievalCursor,
  pageCursor,
  scopeKey,
  taskPosition,
  tracePosition,
} from "./context-retrieval-cursors.js";
import {
  providerSafeComment,
  providerSafeRunTrace,
  providerSafeTask,
} from "./context-retrieval-projections.js";

export async function assertReach(
  repository: ContextRetrievalRepository,
  scope: ContextRetrievalScope,
  taskId: string,
  allowed: {
    active: boolean;
    descendant: boolean;
    company: boolean;
  },
): Promise<void> {
  const reach = await repository.taskReach({
    companyId: scope.companyId,
    activeTaskId: scope.activeTaskId,
    taskId,
  });
  if (
    !reach?.sameCompany ||
    !((allowed.active && reach.active) || (allowed.descendant && reach.descendant) || allowed.company)
  ) {
    throw new ContextRetrievalDenied();
  }
}

export function createContextRetrievalService(options: ContextRetrievalServiceOptions) {
  if (!options.cursorSecret) {
    throw new Error("Context retrieval cursor secret is required");
  }

  async function readCanonicalAgentRunTrace(input: {
    companyId: string;
    runId: string;
    cursor?: string | null;
  }): Promise<ProviderSafeRunTrace> {
    const run = await options.repository.runTask({
      companyId: input.companyId,
      runId: input.runId,
    });
    if (!run) throw new ContextRetrievalDenied();
    const key = scopeKey(["read_task_agent_run", input.companyId, input.runId]);
    const after = decodeRetrievalCursor(options.cursorSecret, input.cursor, key);
    const limit = boundedLimit(undefined);
    const trace = await options.repository.readCanonicalRunTrace({
      companyId: input.companyId,
      runId: input.runId,
      after,
      limit: limit + 1,
    });
    if (!trace || trace.taskId !== run.taskId) {
      throw new ContextRetrievalDenied();
    }
    const page = pageCursor(options.cursorSecret, key, trace.turns, limit, tracePosition);
    return providerSafeRunTrace({
      ...trace,
      turns: page.items,
      nextCursor: page.nextCursor,
    });
  }

  return {
    /**
     * Internal reuse point for a capability-scoped recovery. It intentionally
     * bypasses context-dial reach checks; its caller must prove a narrower
     * runtime authority before naming a run.
     */
    readCanonicalAgentRunTrace,

    async listCompanyTasks(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & {
        filters?: RetrievalTaskFilters;
      } = {},
    ): Promise<RetrievalPage<ContextRetrievalTaskProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.listCompanyTasks) throw new ContextRetrievalDenied();
      const filters = input.filters ?? {};
      const key = scopeKey([
        "list_company_tasks",
        scope.companyId,
        filters.status ?? "",
        filters.priority ?? "",
      ]);
      const after = decodeRetrievalCursor(options.cursorSecret, input.cursor, key);
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listTopLevelTasks({
        companyId: scope.companyId,
        filters,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeTask);
      if (projected.some((row) => row.parentId !== null)) {
        throw new Error("Context repository returned a non-top-level company task");
      }
      return pageCursor(options.cursorSecret, key, projected, limit, taskPosition);
    },

    async listSubTasks(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { taskId?: string } = {},
    ): Promise<RetrievalPage<ContextRetrievalTaskProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.listSubTasks.enabled) throw new ContextRetrievalDenied();
      const taskIdProvided = typeof input.taskId === "string" && input.taskId.length > 0;
      const taskId = taskIdProvided ? input.taskId! : scope.activeTaskId;
      await assertReach(options.repository, scope, taskId, {
        active: taskIdProvided ? policy.listSubTasks.explicit.active : policy.listSubTasks.omittedActive,
        descendant: taskIdProvided && policy.listSubTasks.explicit.descendant,
        company: taskIdProvided && policy.listSubTasks.explicit.company,
      });
      const key = scopeKey(["list_sub_tasks", scope.companyId, taskId]);
      const after = decodeRetrievalCursor(options.cursorSecret, input.cursor, key);
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listDirectChildren({
        companyId: scope.companyId,
        taskId,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeTask);
      if (projected.some((row) => row.parentId !== taskId)) {
        throw new Error("Context repository returned a non-direct child");
      }
      return pageCursor(options.cursorSecret, key, projected, limit, taskPosition);
    },

    async readTaskComments(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { taskId?: string } = {},
    ): Promise<RetrievalPage<ContextRetrievalCommentProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.comments.enabled) throw new ContextRetrievalDenied();
      const taskIdProvided = typeof input.taskId === "string" && input.taskId.length > 0;
      if (policy.comments.taskIdRequired && !taskIdProvided) {
        throw new ContextRetrievalDenied();
      }
      const taskId = taskIdProvided ? input.taskId! : scope.activeTaskId;
      await assertReach(options.repository, scope, taskId, {
        active: policy.comments.active,
        descendant: policy.comments.descendant,
        company: policy.comments.company,
      });
      const key = scopeKey(["read_task_comments", scope.companyId, taskId]);
      const after = decodeRetrievalCursor(options.cursorSecret, input.cursor, key);
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listTaskComments({
        companyId: scope.companyId,
        taskId,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeComment);
      if (projected.some((row) => row.taskId !== taskId)) {
        throw new Error("Context repository returned a cross-task comment");
      }
      for (let index = 1; index < projected.length; index += 1) {
        if (projected[index - 1].sequence >= projected[index].sequence) {
          throw new Error("Context repository returned non-chronological comments");
        }
      }
      return pageCursor(options.cursorSecret, key, projected, limit, commentPosition);
    },

    async readTaskAgentRun(
      scope: ContextRetrievalScope,
      input: { runId: string; cursor?: string | null },
    ): Promise<ProviderSafeRunTrace> {
      if (!input.runId) throw new ContextRetrievalDenied();
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.runs.enabled) throw new ContextRetrievalDenied();
      const run = await options.repository.runTask({
        companyId: scope.companyId,
        runId: input.runId,
      });
      if (!run) throw new ContextRetrievalDenied();
      await assertReach(options.repository, scope, run.taskId, {
        active: policy.runs.active,
        descendant: policy.runs.descendant,
        company: policy.runs.company,
      });
      return readCanonicalAgentRunTrace({
        companyId: scope.companyId,
        runId: input.runId,
        cursor: input.cursor,
      });
    },
  };
}

export type ContextRetrievalService = ReturnType<typeof createContextRetrievalService>;
export type { ProviderSafeTaskCreator, ProviderSafeTaskOwner } from "@paperclipai/shared";
export * from "./context-retrieval-contracts.js";
export * from "./context-retrieval-cursors.js";
export * from "./context-retrieval-projections.js";
