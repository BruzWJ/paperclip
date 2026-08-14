import { agents, approvals, runtimeAgentConfigurationAudits } from "@paperclipai/db";
import { isCanonicalUuid } from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  InternalActor,
  PROTECTED_SELF_IDENTITY_KEYS,
  ParsedUpdateConfiguration,
  RuntimeAgentConfigurationConflict,
  RuntimeAgentConfigurationInvalid,
  RuntimeAgentConfigurationResult,
} from "./runtime-agent-configuration-part-1.js";
import {
  actorAuditColumns,
  loadSnapshot,
  runtimeAgentConfigurationDisplayedDiff,
  sha256,
  snapshotsChangedKeys,
} from "./runtime-agent-configuration-part-2.js";
import * as agentConfigOps from "./runtime-agent-configuration-part-3.js";
import {
  type createRuntimeAgentConfigurationServiceContext,
  findIdempotentResult,
  replaceMentionReachGrants,
  updateChangedIdentityKeys,
} from "./runtime-agent-configuration-part-4.js";

export function createRuntimeAgentConfigurationServiceOperationsSection1Update(
  context: ReturnType<typeof createRuntimeAgentConfigurationServiceContext>,
) {
  const { db, options, clock, idFactory } = context;
  async function updateInternal(input: {
    companyId: string;
    targetAgentId: string;
    actor: InternalActor;
    source: "board" | "onboarding" | "agent_configure" | "plugin_control";
    configuration: ParsedUpdateConfiguration;
    idempotencyKey: string | null;
  }): Promise<RuntimeAgentConfigurationResult> {
    if (!isCanonicalUuid(input.targetAgentId)) {
      throw new RuntimeAgentConfigurationInvalid("targetAgentId must be a UUID");
    }
    const requestDigest = sha256({
      operation: "update",
      companyId: input.companyId,
      targetAgentId: input.targetAgentId,
      source: input.source,
      actor: actorAuditColumns(input.actor),
      configuration: input.configuration,
    });
    return db.transaction(async (tx) => {
      const now = clock();
      const locked = await agentConfigOps.lockCompanyAndAgents(tx, input.companyId);
      let responsibleUserId: string | null = null;
      if (input.actor.kind === "agent") {
        responsibleUserId = (
          await agentConfigOps.assertRunActionAuthority(
            tx,
            input.actor,
            "agent_configure",
            now,
            locked.company,
            locked.agents,
          )
        ).responsibleUserId;
      }
      const retry = await findIdempotentResult(tx, input.companyId, input.idempotencyKey, requestDigest);
      if (retry) return retry;
      const target = locked.agents.find((candidate) => candidate.id === input.targetAgentId);
      if (!target || target.status === "terminated") {
        throw new RuntimeAgentConfigurationInvalid(
          "Runtime-agent configuration target must be a non-terminated agent in the same company",
        );
      }
      const openHireApproval =
        target.status === "paused" && target.pauseReason === "system"
          ? await tx
              .select({ id: approvals.id })
              .from(approvals)
              .where(
                and(
                  eq(approvals.companyId, input.companyId),
                  eq(approvals.type, "hire_agent"),
                  inArray(approvals.status, ["pending", "revision_requested"]),
                  sql`${approvals.payload} ->> 'agentId' = ${target.id}`,
                ),
              )
              .orderBy(asc(approvals.id))
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
      if (target.status === "pending_approval" || openHireApproval) {
        throw new RuntimeAgentConfigurationConflict(
          "Pending hire configuration can be changed only through its exact linked approval resubmission",
        );
      }
      const before = await loadSnapshot(tx, input.companyId, input.targetAgentId);
      const changedIdentityKeys = updateChangedIdentityKeys(before, input.configuration);
      const requestedKeys = Object.keys(input.configuration).sort();
      const displayedDiff = runtimeAgentConfigurationDisplayedDiff(
        input.targetAgentId,
        before,
        input.configuration,
      );
      if (input.actor.kind === "board") {
        await agentConfigOps.assertBoardAuthority(
          tx,
          input.actor,
          input.companyId,
          "update",
          input.targetAgentId,
        );
      } else if (input.actor.kind === "plugin") {
        await agentConfigOps.assertPluginAuthority(
          tx,
          input.actor,
          "update",
          input.targetAgentId,
          requestedKeys,
          options,
        );
      } else {
        const isSelf = input.targetAgentId === input.actor.actorId;
        const requiresProtectedGrant =
          !isSelf || changedIdentityKeys.some((key) => PROTECTED_SELF_IDENTITY_KEYS.has(key));
        await agentConfigOps.assertAgentConfigureAuthority(
          tx,
          input.actor,
          responsibleUserId,
          input.targetAgentId,
          requestedKeys,
          requiresProtectedGrant,
          displayedDiff,
          options,
        );
      }
      if (input.configuration.reportsTo !== undefined) {
        agentConfigOps.assertReportsTo(input.targetAgentId, input.configuration.reportsTo, locked.agents);
      }
      const identityPatch: Partial<typeof agents.$inferInsert> = {
        updatedAt: now,
      };
      if (input.configuration.name !== undefined) {
        identityPatch.name = input.configuration.name;
      }
      if (input.configuration.title !== undefined) {
        identityPatch.title = input.configuration.title;
      }
      if (input.configuration.capabilities !== undefined) {
        identityPatch.capabilities = input.configuration.capabilities;
      }
      if (input.configuration.reportsTo !== undefined) {
        identityPatch.reportsTo = input.configuration.reportsTo;
      }
      if (input.configuration.instruction !== undefined) {
        identityPatch.instruction = input.configuration.instruction;
      }
      await tx
        .update(agents)
        .set(identityPatch)
        .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.targetAgentId)));
      if (input.configuration.contextGrants !== undefined) {
        await agentConfigOps.replaceContextGrants(
          tx,
          input.companyId,
          input.targetAgentId,
          input.configuration.contextGrants,
          input.actor,
          now,
        );
      }
      if (input.configuration.actionGrants !== undefined) {
        await agentConfigOps.replaceActionGrants(
          tx,
          input.companyId,
          input.targetAgentId,
          input.configuration.actionGrants,
          input.actor,
          now,
        );
      }
      if (input.configuration.mentionReachGrants !== undefined) {
        await replaceMentionReachGrants(
          tx,
          input.companyId,
          input.targetAgentId,
          input.configuration.mentionReachGrants,
          input.actor,
          now,
        );
      }
      const after = await loadSnapshot(tx, input.companyId, input.targetAgentId);
      const auditId = idFactory();
      const actorColumns = actorAuditColumns(input.actor);
      await tx.insert(runtimeAgentConfigurationAudits).values({
        id: auditId,
        companyId: input.companyId,
        agentId: input.targetAgentId,
        operation: "update",
        source: input.source,
        ...actorColumns,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        changedKeys: snapshotsChangedKeys(before, after),
        beforeSnapshot: before,
        afterSnapshot: after,
        createdAt: now,
      });
      return {
        agentId: input.targetAgentId,
        companyId: input.companyId,
        configuration: after,
        auditId,
        approvalId: null,
        retried: false,
      };
    });
  }
  return { updateInternal };
}
