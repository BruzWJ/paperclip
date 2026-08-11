import { issues, type Db } from "@paperclipai/db";
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
  PluginRunIssueContextReader,
  PluginRuntimeRecordsReader,
} from "./plugin-host-services.js";
import type { IssueExecutionRunService } from "./issue-execution-run-service.js";
import type { IssueSessionStore } from "./issue-session/store.js";
import { createPluginCanonicalSessionReader } from "./plugin-canonical-session-reader.js";

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
  /** Canonical redacted Session read authority shared with runtime plugins. */
  issueSessionStore: IssueSessionStore;
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

  const pluginRunIssueContextReader: PluginRunIssueContextReader = {
    async resolveContext(input) {
      const { capability, scope } = await resolvePluginScope(input);
      const [issue] = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, capability.companyId),
            eq(issues.id, capability.issueId),
          ),
        )
        .limit(1);
      if (!issue) {
        throw new PromptCapabilityAuthenticationError(
          "Plugin run-context issue no longer exists",
        );
      }
      return {
        companyId: capability.companyId,
        issueId: capability.issueId,
        agentId: capability.targetAgentId,
        runId: capability.runId,
        projectId: issue.projectId,
        contextAccess: { ...scope.dial },
      };
    },
    async issueReach(input) {
      const { scope } = await resolvePluginScope(input);
      const reach = await retrievalRepository.issueReach({
        companyId: scope.companyId,
        activeIssueId: scope.activeIssueId,
        issueId: input.issueId,
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
            scope.dial.list_sub_issues || scope.dial.list_company_issues,
          relation: "descendant",
        };
      }
      return {
        visible: scope.dial.list_company_issues,
        relation: "company",
      };
    },
    async listCompanyIssues(input) {
      const { scope } = await resolvePluginScope(input);
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
      const { scope } = await resolvePluginScope(input);
      return retrieval.listSubIssues(scope, {
        issueId: input.issueId,
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async readIssueComments(input) {
      const { scope } = await resolvePluginScope(input);
      return retrieval.readIssueComments(scope, {
        issueId: input.issueId,
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async readIssueAgentRun(input) {
      const { scope } = await resolvePluginScope(input);
      return retrieval.readIssueAgentRun(scope, {
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
    options.issueSessionStore,
  );
  const pluginRuntimeRecordsReader: PluginRuntimeRecordsReader = {
    readSession(input) {
      return canonicalSessions.readSession(input);
    },
    async readRun(input) {
      const run = await retrievalRepository.runIssue({
        companyId: input.companyId,
        runId: input.runId,
      });
      if (!run) {
        throw new PromptCapabilityAuthenticationError(
          "Runtime record is unavailable in the requested company",
        );
      }
      return retrieval.readIssueAgentRun(
        {
          companyId: input.companyId,
          activeIssueId: run.issueId,
          dial: privilegedRuntimeDial,
        },
        { runId: input.runId, cursor: input.cursor },
      );
    },
    async readIssueComments(input) {
      return retrieval.readIssueComments(
        {
          companyId: input.companyId,
          activeIssueId: input.issueId,
          dial: privilegedRuntimeDial,
        },
        {
          issueId: input.issueId,
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
    pluginRunIssueContextReader,
    pluginRuntimeRecordsReader,
  };
}

export type PostgresPromptCapabilityRuntime = ReturnType<
  typeof createPostgresPromptCapabilityRuntime
>;
