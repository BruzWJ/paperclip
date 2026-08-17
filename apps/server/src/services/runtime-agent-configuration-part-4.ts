import {
  agentMentionReachGrants,
  approvals,
  runtimeAgentConfigurationAudits,
  type Db,
  type RuntimeAgentConfigurationSnapshot,
} from "@paperclipai/db";
import {
  AGENT_MENTION_REACH_GRANT_KEYS,
  type AgentMentionReachGrantKey,
  type HireAgentApprovalPayload,
} from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as agentConfig from "./runtime-agent-configuration-part-1.js";
import { grantActorColumns } from "./runtime-agent-configuration-part-2.js";

export async function replaceMentionReachGrants(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
  values: agentConfig.SparseGrantMap<AgentMentionReachGrantKey>,
  actor: agentConfig.InternalActor,
  now: Date,
): Promise<void> {
  await tx
    .delete(agentMentionReachGrants)
    .where(
      and(eq(agentMentionReachGrants.companyId, companyId), eq(agentMentionReachGrants.agentId, agentId)),
    );
  const keys = AGENT_MENTION_REACH_GRANT_KEYS.filter((key) => values[key] === true);
  if (keys.length > 0) {
    const provenance = grantActorColumns(actor);
    await tx.insert(agentMentionReachGrants).values(
      keys.map((key) => ({
        companyId,
        agentId,
        key,
        ...provenance,
        createdAt: now,
      })),
    );
  }
}

export async function findIdempotentResult(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
  idempotencyKey: string | null,
  requestDigest: string,
): Promise<agentConfig.RuntimeAgentConfigurationResult | null> {
  if (!idempotencyKey) return null;
  const row = await tx
    .select({
      id: runtimeAgentConfigurationAudits.id,
      agentId: runtimeAgentConfigurationAudits.agentId,
      requestDigest: runtimeAgentConfigurationAudits.requestDigest,
      afterSnapshot: runtimeAgentConfigurationAudits.afterSnapshot,
    })
    .from(runtimeAgentConfigurationAudits)
    .where(
      and(
        eq(runtimeAgentConfigurationAudits.companyId, companyId),
        eq(runtimeAgentConfigurationAudits.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  if (row.requestDigest !== requestDigest) {
    throw new agentConfig.RuntimeAgentConfigurationConflict(
      "Idempotency key was already used for a different runtime-agent configuration request",
    );
  }
  const approvalId = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, "hire_agent"),
        sql`${approvals.payload} ->> 'runtimeAgentConfigurationAuditId' = ${row.id}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
  return {
    agentId: row.agentId,
    companyId,
    configuration: row.afterSnapshot,
    auditId: row.id,
    approvalId,
    retried: true,
  };
}

export function hireApprovalPayload(
  actor: Exclude<agentConfig.InternalActor, agentConfig.RuntimeAgentConfigurationBoardActor>,
  agentId: string,
  auditId: string,
  requestDigest: string,
): HireAgentApprovalPayload {
  return {
    contract: "paperclip.hire-approval/v1",
    agentId,
    runtimeAgentConfigurationAuditId: auditId,
    runtimeAgentConfigurationRequestDigest: requestDigest,
    source:
      actor.kind === "agent"
        ? {
            kind: "agent_run",
            taskId: actor.capability.taskId,
            runId: actor.capability.runId,
            taskExecutionRefId: actor.capability.refId,
          }
        : {
            kind: "plugin_control",
            pluginInstallationId: actor.pluginInstallationId,
          },
  };
}

export function createRuntimeAgentConfigurationServiceContext(
  db: Db,
  options: agentConfig.RuntimeAgentConfigurationServiceOptions = {},
) {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  return { db, options, clock, idFactory };
}
