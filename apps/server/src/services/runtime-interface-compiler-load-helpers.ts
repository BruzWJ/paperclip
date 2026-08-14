import { taskExecutionRefs, type Db } from "@paperclipai/db";
import { pluginAgentToolName, type JsonSchema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { and, asc, eq } from "drizzle-orm";
import { listAuthorizedPluginAgentTools } from "./plugin-agent-tool-authority.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";
import type { PromptCapabilityCompileScope } from "./prompt-capability-gateway.js";
import type { RuntimePluginTool, RuntimeToolTurn } from "./runtime-interface-compiler.js";
import { classifyOrderedExecutionScopePair } from "./task-execution-initial-request-pair.js";

export function readyPluginTools(
  rows: readonly {
    id: string;
    pluginKey: string;
    manifestJson: PaperclipPluginManifestV1;
  }[],
): RuntimePluginTool[] {
  return rows
    .flatMap((row) =>
      listAuthorizedPluginAgentTools({
        pluginKey: row.pluginKey,
        manifest: row.manifestJson,
      }).map((tool) => ({
        installationId: row.id,
        manifestIdentity: pluginManifestIdentity(row.manifestJson),
        name: pluginAgentToolName(row.pluginKey, tool.name),
        toolName: tool.name,
        title: tool.displayName,
        description: tool.description,
        inputSchema: tool.parametersSchema as JsonSchema,
        bootstrapEnabled: tool.bootstrapEnabled === true,
      })),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.installationId.localeCompare(right.installationId),
    );
}

/** @internal Resolves the exact ref's structural role without source aliases. */
export async function resolveRuntimeToolTurn(
  db: Db,
  capability: PromptCapabilityCompileScope,
): Promise<RuntimeToolTurn> {
  if (capability.refId === undefined) return "work";
  const rows = await db
    .select()
    .from(taskExecutionRefs)
    .where(
      and(
        eq(taskExecutionRefs.id, capability.refId),
        eq(taskExecutionRefs.companyId, capability.companyId),
        eq(taskExecutionRefs.taskId, capability.taskId),
        eq(taskExecutionRefs.ownershipEpoch, capability.ownershipEpoch),
        eq(taskExecutionRefs.targetAgentId, capability.targetAgentId),
        eq(taskExecutionRefs.mode, capability.executionMode),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw new Error("Prompt-capability execution ref no longer exists");
  }
  const current = rows[0]!;
  const grouped = await db
    .select()
    .from(taskExecutionRefs)
    .where(
      and(
        eq(taskExecutionRefs.companyId, current.companyId),
        eq(taskExecutionRefs.taskId, current.taskId),
        eq(taskExecutionRefs.sessionId, current.sessionId),
        eq(taskExecutionRefs.executionScopeId, current.executionScopeId),
        eq(taskExecutionRefs.executionLineageId, current.executionLineageId),
      ),
    )
    .orderBy(asc(taskExecutionRefs.laneOrdinal))
    .limit(3);
  const pair = classifyOrderedExecutionScopePair(grouped);
  if (!pair) {
    if (grouped.length > 1) {
      throw new Error("Execution scope lost its exact ordered pair");
    }
    return "work";
  }
  if (pair.instruction.id === current.id) return "bootstrap";
  if (pair.work.id === current.id) return "work";
  throw new Error("Execution ref is not a member of its ordered scope");
}
