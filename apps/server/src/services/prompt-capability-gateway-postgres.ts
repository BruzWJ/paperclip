import {
  type Db,
  taskExecutionPromptCapabilities,
  pluginRunContexts,
  plugins,
  runInterfaceToolCalls,
} from "@paperclipai/db";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import type {
  PromptCapabilityGatewayRepository,
  PromptCapabilityBinding,
} from "./prompt-capability-gateway.js";

import {
  type PromptCapabilityCompiler,
  createPromptCapabilityGatewayPostgresContext,
  inactive,
  invalid,
  projectIngressBinding,
  runMatchesCapability,
  sameBinding,
  transactionClockTimestamp,
  type PromptCapabilityGatewayPostgresContext,
} from "./prompt-capability-postgres-foundation.js";

import { buildPromptCapabilityGatewayPostgresPromptCapabilityPostgresValidation } from "./prompt-capability-postgres-validation.js";

import { and, eq, or } from "drizzle-orm";
import { lockPluginInstallationCompanyScopeInTransaction } from "./plugin-authorization-locks.js";
import { pluginManifestDeclaresAgentTool } from "./plugin-agent-tool-authority.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";

export function createPromptCapabilityGatewayPostgresMethods1(
  scope: PromptCapabilityGatewayPostgresContext &
    ReturnType<typeof buildPromptCapabilityGatewayPostgresPromptCapabilityPostgresValidation>,
) {
  const { db, compiler, runService, validateRow, activeRowByIdentity } = scope;

  return {
    async authenticateBearerHash(bearerHash, _at) {
      const locked = await db.transaction(async (transaction) => {
        const row = await transaction
          .select()
          .from(taskExecutionPromptCapabilities)
          .where(
            and(
              eq(taskExecutionPromptCapabilities.bearerHash, bearerHash),
              or(
                eq(taskExecutionPromptCapabilities.state, "pending_setup"),
                eq(taskExecutionPromptCapabilities.state, "active"),
              ),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        const at = await transactionClockTimestamp(transaction);
        return row && row.expiresAt > at ? { row, at } : null;
      });
      if (!locked) return inactive();
      if (locked.row.state === "active") {
        return validateRow(locked.row, locked.at);
      }
      const run = await runService.readRun({
        companyId: locked.row.companyId,
        taskId: locked.row.taskId,
        runId: locked.row.runId,
      });
      if (!run) return invalid("run_not_found");
      return runMatchesCapability(run, locked.row)
        ? {
            kind: "authenticated" as const,
            capability: projectIngressBinding(locked.row, run.sessionId),
          }
        : invalid("run_scope_changed");
    },

    async revalidate(capability, _at) {
      const locked = await activeRowByIdentity({
        capabilityConnectionId: capability.capabilityConnectionId,
        capabilityGeneration: capability.capabilityGeneration,
      });
      if (!locked) return inactive();
      const result = await validateRow(locked.row, locked.at);
      if (result.kind !== "authenticated") return result;
      if (result.capability.activatedAt === null || result.capability.targetSessionCorrelationId === null) {
        return inactive();
      }
      const current = result.capability as PromptCapabilityBinding;
      return sameBinding(capability, current) ? result : invalid("capability_generation_changed");
    },

    resolveCompileInput(capability) {
      return compiler.resolve(capability);
    },

    async createPluginRunContext(input) {
      await db.transaction(async (tx) => {
        const parent = await tx
          .select({
            state: taskExecutionPromptCapabilities.state,
            expiresAt: taskExecutionPromptCapabilities.expiresAt,
          })
          .from(taskExecutionPromptCapabilities)
          .where(
            and(
              eq(
                taskExecutionPromptCapabilities.capabilityConnectionId,
                input.capability.capabilityConnectionId,
              ),
              eq(taskExecutionPromptCapabilities.capabilityGeneration, input.capability.capabilityGeneration),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        const authorizationTime = await transactionClockTimestamp(tx);
        if (!parent || parent.state !== "active" || parent.expiresAt <= authorizationTime) {
          throw new Error("Prompt capability changed before plugin context binding");
        }
        const call = await tx
          .select({
            id: runInterfaceToolCalls.id,
            toolName: runInterfaceToolCalls.toolName,
          })
          .from(runInterfaceToolCalls)
          .where(
            and(
              eq(runInterfaceToolCalls.id, input.runInterfaceToolCallId),
              eq(runInterfaceToolCalls.companyId, input.capability.companyId),
              eq(runInterfaceToolCalls.capabilityConnectionId, input.capability.capabilityConnectionId),
              eq(runInterfaceToolCalls.capabilityGeneration, input.capability.capabilityGeneration),
              eq(runInterfaceToolCalls.pluginInstallationId, input.pluginInstallationId),
              eq(runInterfaceToolCalls.status, "executing"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!call) {
          throw new Error("Plugin context is not bound to the exact active tool call");
        }
        const pluginScope = await lockPluginInstallationCompanyScopeInTransaction(tx, {
          pluginInstallationId: input.pluginInstallationId,
          companyId: input.capability.companyId,
        });
        const installation = pluginScope.installation;
        if (
          installation?.status !== "ready" ||
          !pluginScope.company ||
          pluginManifestIdentity(installation.manifestJson) !== input.pluginManifestIdentity ||
          !pluginManifestDeclaresAgentTool(
            {
              pluginKey: installation.pluginKey,
              manifest: installation.manifestJson,
            },
            call.toolName,
          )
        ) {
          throw new Error("Plugin context is not bound to a ready tool");
        }
        await tx.insert(pluginRunContexts).values({
          capabilityConnectionId: input.capability.capabilityConnectionId,
          capabilityGeneration: input.capability.capabilityGeneration,
          runInterfaceToolCallId: input.runInterfaceToolCallId,
          pluginInstallationId: input.pluginInstallationId,
          handleHash: input.handleHash,
          firstUsedAt: null,
          createdAt: input.createdAt,
        });
      });
    },

    async resolvePluginRunContextHash(handleHash, at) {
      const child = await db
        .select()
        .from(pluginRunContexts)
        .where(eq(pluginRunContexts.handleHash, handleHash))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!child) return null;
      const locked = await activeRowByIdentity({
        capabilityConnectionId: child.capabilityConnectionId,
        capabilityGeneration: child.capabilityGeneration,
      });
      if (!locked) return null;
      const result = await validateRow(locked.row, locked.at);
      if (
        result.kind !== "authenticated" ||
        result.capability.activatedAt === null ||
        result.capability.targetSessionCorrelationId === null
      ) {
        return null;
      }
      const call = await db
        .select({
          id: runInterfaceToolCalls.id,
          status: runInterfaceToolCalls.status,
          toolName: runInterfaceToolCalls.toolName,
          pluginInstallationId: runInterfaceToolCalls.pluginInstallationId,
        })
        .from(runInterfaceToolCalls)
        .where(
          and(
            eq(runInterfaceToolCalls.id, child.runInterfaceToolCallId),
            eq(runInterfaceToolCalls.capabilityConnectionId, child.capabilityConnectionId),
            eq(runInterfaceToolCalls.capabilityGeneration, child.capabilityGeneration),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!call || call.status !== "executing" || call.pluginInstallationId !== child.pluginInstallationId) {
        return null;
      }
      const installation = await db
        .select({
          status: plugins.status,
          pluginKey: plugins.pluginKey,
          manifestJson: plugins.manifestJson,
        })
        .from(plugins)
        .where(eq(plugins.id, child.pluginInstallationId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        installation?.status !== "ready" ||
        !pluginManifestDeclaresAgentTool(
          {
            pluginKey: installation.pluginKey,
            manifest: installation.manifestJson,
          },
          call.toolName,
        )
      ) {
        return null;
      }
      if (child.firstUsedAt === null) {
        await db
          .update(pluginRunContexts)
          .set({ firstUsedAt: at })
          .where(
            and(
              eq(pluginRunContexts.handleHash, handleHash),
              eq(pluginRunContexts.capabilityConnectionId, child.capabilityConnectionId),
              eq(pluginRunContexts.capabilityGeneration, child.capabilityGeneration),
            ),
          );
      }
      return {
        capability: result.capability as PromptCapabilityBinding,
        runInterfaceToolCallId: child.runInterfaceToolCallId,
        pluginInstallationId: child.pluginInstallationId,
      };
    },
  } satisfies Pick<
    PromptCapabilityGatewayRepository,
    | "authenticateBearerHash"
    | "revalidate"
    | "resolveCompileInput"
    | "createPluginRunContext"
    | "resolvePluginRunContextHash"
  >;
}

export { lockActivePromptCapabilityBinding } from "./prompt-capability-postgres-foundation.js";

export function createPostgresPromptCapabilityGatewayRepository(
  db: Db,
  compiler: PromptCapabilityCompiler,
  runService: Pick<TaskExecutionRunService, "readRun">,
): PromptCapabilityGatewayRepository {
  const context = createPromptCapabilityGatewayPostgresContext(db, compiler, runService);
  const helpers1 = buildPromptCapabilityGatewayPostgresPromptCapabilityPostgresValidation(context);
  const scope1 = { ...context, ...helpers1 };
  const scope = scope1;
  const methods1 = createPromptCapabilityGatewayPostgresMethods1(scope);
  return { ...methods1 };
}
