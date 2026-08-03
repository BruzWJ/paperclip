import type { Db } from "@paperclipai/db";
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
  createRuntimeToolExecutor,
  type RuntimeActionPort,
  type RuntimeCompanyToolPort,
} from "./runtime-tool-executor.js";
import {
  createRuntimeToolCallLedger,
} from "./runtime-tool-call-ledger.js";
import type {
  PluginRunIssueContextReader,
} from "./plugin-host-services.js";
import type { IssueExecutionRunService } from "./issue-execution-run-service.js";

export interface PostgresPromptCapabilityRuntimeOptions {
  /**
   * Canonical run reader. The capability repository may inspect every other
   * separately owned authority row directly, but never bypasses this owner for
   * the issue-execution run envelope.
   */
  runService: Pick<
    IssueExecutionRunService,
    "readRun" | "readJoinedRunDetail"
  >;
  /**
   * Instance-private cursor signing secret. Retrieval cursors are scoped and
   * authenticated independently from the prompt-capability bearer.
   */
  cursorSecret: string;
  actions: RuntimeActionPort;
  companyTools: RuntimeCompanyToolPort;
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
  const retrieval = createContextRetrievalService({
    cursorSecret: options.cursorSecret,
    repository: createContextRetrievalDbRepository(db, {
      runService: options.runService,
    }),
  });
  const executor = createRuntimeToolExecutor({
    retrieval,
    retrievalScope: createRuntimeRetrievalScopeResolver(compiler),
    actions: options.actions,
    companyTools: options.companyTools,
    callLedger: createRuntimeToolCallLedger(db),
  });
  const repository = createPostgresPromptCapabilityGatewayRepository(
    db,
    compiler,
    options.runService,
  );
  const gateway = createPromptCapabilityGateway({
    repository,
    executor,
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
    return retrievalScope.resolve(resolved.capability);
  }

  const pluginRunIssueContextReader: PluginRunIssueContextReader = {
    async listCompanyIssues(input) {
      const scope = await resolvePluginScope(input);
      return retrieval.listCompanyIssues(scope, {
        filters: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
        },
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async listSubIssues(input) {
      const scope = await resolvePluginScope(input);
      return retrieval.listSubIssues(scope, {
        issueId: input.issueId,
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async readIssueComments(input) {
      const scope = await resolvePluginScope(input);
      return retrieval.readIssueComments(scope, {
        issueId: input.issueId,
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async readIssueAgentRun(input) {
      const scope = await resolvePluginScope(input);
      return retrieval.readIssueAgentRun(scope, {
        runId: input.runId,
        cursor: input.cursor,
      });
    },
  };

  return {
    compiler,
    retrieval,
    executor,
    repository,
    gateway,
    pluginRunIssueContextReader,
  };
}

export type PostgresPromptCapabilityRuntime = ReturnType<
  typeof createPostgresPromptCapabilityRuntime
>;
