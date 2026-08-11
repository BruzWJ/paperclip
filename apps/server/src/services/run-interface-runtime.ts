import { tasks, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
import {
  createContextRetrievalDbRepository,
} from "./context-retrieval-db.js";
import {
  createContextRetrievalService,
} from "./context-retrieval.js";
import {
  createPostgresPromptCapabilityGatewayRepository,
} from "./prompt-capability-gateway-postgres.js";
import {
  createPromptCapabilityGateway,
  PromptCapabilityAuthenticationError,
} from "./prompt-capability-gateway.js";
import {
  createPostgresRuntimeInterfaceCompiler,
  createRuntimeRetrievalScopeResolver,
} from "./runtime-interface-compiler-db.js";
import {
  createRuntimeToolGateway,
  type RuntimePluginToolPort,
} from "./runtime-tool-gateway.js";
import type { PaperclipManagedToolRouter } from "./paperclip-managed-tool-router.js";
import {
  createRuntimeToolCallLedger,
} from "./runtime-tool-call-ledger.js";
import type {
  PluginRunTaskContextReader,
  PluginRuntimeRecordsReader,
} from "./plugin-host-services.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import type { TaskSessionStore } from "./task-session/store.js";
import { createPluginCanonicalSessionReader } from "./plugin-canonical-session-reader.js";

export interface PostgresPromptCapabilityRuntimeOptions {
  /**
   * Canonical run reader. The capability repository may inspect every other
   * separately owned authority row directly, but never bypasses this owner for
   * the task-execution run envelope.
   */
  runService: Pick<
    TaskExecutionRunService,
    "readRun" | "readJoinedRunDetail"
  >;
  /**
   * Instance-private cursor signing secret. Retrieval cursors are scoped and
   * authenticated independently from the prompt-capability bearer.
   */
  cursorSecret: string;
  /** Canonical redacted Session read authority shared with runtime plugins. */
  taskSessionStore: TaskSessionStore;
  managedTools: PaperclipManagedToolRouter;
  pluginTools: RuntimePluginToolPort;
  now?: () => Date;
}

/**
 * Canonical production composition for the sole provider-visible Paperclip
 * capability interface. Capability minting and the raw endpoint descriptor
 * remain owned by the ACP prompt-cycle repository; this runtime authenticates
 * and serves only already-active exact generations.
 */
export function createPostgresPromptCapabilityRuntime(
  db: Db,
  options: PostgresPromptCapabilityRuntimeOptions,
) {
  if (!options.cursorSecret) {
    throw new Error("Prompt-capability retrieval cursor secret is required");
  }
  const compiler = createPostgresRuntimeInterfaceCompiler(db);
  const retrievalRepository = createContextRetrievalDbRepository(db, {
    runService: options.runService,
  });
  const retrieval = createContextRetrievalService({
    cursorSecret: options.cursorSecret,
    repository: retrievalRepository,
  });
  const runtimeToolGateway = createRuntimeToolGateway({
    managedTools: options.managedTools,
    pluginTools: options.pluginTools,
    callLedger: createRuntimeToolCallLedger(db),
  });
  const repository = createPostgresPromptCapabilityGatewayRepository(
    db,
    compiler,
    options.runService,
  );
  const gateway = createPromptCapabilityGateway({
    repository,
    executor: runtimeToolGateway,
    now: options.now,
  });
  const retrievalScope = createRuntimeRetrievalScopeResolver(compiler);

  async function resolvePluginScope(input: {
    runContextHandle: string;
    pluginInstallationId: string;
  }) {
    const resolved = await gateway.resolvePluginRunContext(
      input.runContextHandle,
      input.pluginInstallationId,
    );
    if (
      resolved.pluginInstallationId !== input.pluginInstallationId
    ) {
      throw new PromptCapabilityAuthenticationError(
        "Invalid plugin run-context handle",
      );
    }
    return {
      capability: resolved.capability,
      scope: await retrievalScope.resolve(resolved.capability),
    };
  }

  const pluginRunTaskContextReader: PluginRunTaskContextReader = {
    async resolveContext(input) {
      const { capability, scope } = await resolvePluginScope(input);
      const [task] = await db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, capability.companyId),
            eq(tasks.id, capability.taskId),
          ),
        )
        .limit(1);
      if (!task) {
        throw new PromptCapabilityAuthenticationError(
          "Plugin run-context task no longer exists",
        );
      }
      return {
        companyId: capability.companyId,
        taskId: capability.taskId,
        agentId: capability.targetAgentId,
        runId: capability.runId,
        projectId: task.projectId,
        contextAccess: { ...scope.dial },
      };
    },
    async taskReach(input) {
      const { scope } = await resolvePluginScope(input);
      const reach = await retrievalRepository.taskReach({
        companyId: scope.companyId,
        activeTaskId: scope.activeTaskId,
        taskId: input.taskId,
      });
      if (!reach?.sameCompany) {
        return { visible: false, relation: "outside" };
      }
      if (reach.active) {
        return { visible: true, relation: "active" };
      }
      if (reach.descendant) {
        return {
          visible:
            scope.dial.list_sub_tasks || scope.dial.list_company_tasks,
          relation: "descendant",
        };
      }
      return {
        visible: scope.dial.list_company_tasks,
        relation: "company",
      };
    },
    async listCompanyTasks(input) {
      const { scope } = await resolvePluginScope(input);
      return retrieval.listCompanyTasks(scope, {
        filters: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
        },
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async listSubTasks(input) {
      const { scope } = await resolvePluginScope(input);
      return retrieval.listSubTasks(scope, {
        taskId: input.taskId,
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async readTaskComments(input) {
      const { scope } = await resolvePluginScope(input);
      return retrieval.readTaskComments(scope, {
        taskId: input.taskId,
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async readTaskAgentRun(input) {
      const { scope } = await resolvePluginScope(input);
      return retrieval.readTaskAgentRun(scope, {
        runId: input.runId,
        cursor: input.cursor,
      });
    },
  };

  const privilegedRuntimeDial = Object.freeze(
    Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, true])),
  ) as Record<(typeof AGENT_CONTEXT_GRANT_KEYS)[number], boolean>;
  const canonicalSessions = createPluginCanonicalSessionReader(
    db,
    options.taskSessionStore,
  );
  const pluginRuntimeRecordsReader: PluginRuntimeRecordsReader = {
    readSession(input) {
      return canonicalSessions.readSession(input);
    },
    async readRun(input) {
      const run = await retrievalRepository.runTask({
        companyId: input.companyId,
        runId: input.runId,
      });
      if (!run) {
        throw new PromptCapabilityAuthenticationError(
          "Runtime record is unavailable in the requested company",
        );
      }
      return retrieval.readTaskAgentRun(
        {
          companyId: input.companyId,
          activeTaskId: run.taskId,
          dial: privilegedRuntimeDial,
        },
        { runId: input.runId, cursor: input.cursor },
      );
    },
    async readTaskComments(input) {
      return retrieval.readTaskComments(
        {
          companyId: input.companyId,
          activeTaskId: input.taskId,
          dial: privilegedRuntimeDial,
        },
        {
          taskId: input.taskId,
          cursor: input.cursor,
          limit: input.limit,
        },
      );
    },
  };

  return {
    compiler,
    retrieval,
    /** ACPX's prompt gateway still calls this an executor; it is ingress only. */
    executor: runtimeToolGateway,
    repository,
    gateway,
    pluginRunTaskContextReader,
    pluginRuntimeRecordsReader,
  };
}

export type PostgresPromptCapabilityRuntime = ReturnType<
  typeof createPostgresPromptCapabilityRuntime
>;
