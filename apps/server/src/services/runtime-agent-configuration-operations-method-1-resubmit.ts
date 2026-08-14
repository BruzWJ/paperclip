import { agents, approvals, runtimeAgentConfigurationAudits } from "@paperclipai/db";
import {
  hireAgentApprovalPayloadSchema,
  isCanonicalUuid,
  type HireAgentApprovalPayload,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import {
  ParsedCreateConfiguration,
  RuntimeAgentConfigurationBoardActor,
  RuntimeAgentConfigurationConflict,
  RuntimeAgentConfigurationInvalid,
  RuntimeAgentConfigurationResult,
} from "./runtime-agent-configuration-part-1.js";
import {
  actorAuditColumns,
  assertCurrentRuntimeAgentConfigurationAudit,
  loadSnapshot,
  sha256,
  snapshotsChangedKeys,
} from "./runtime-agent-configuration-part-2.js";
import {
  assertBoardAuthority,
  assertReportsTo,
  lockCompanyAndAgents,
  replaceActionGrants,
  replaceContextGrants,
} from "./runtime-agent-configuration-part-3.js";
import {
  type createRuntimeAgentConfigurationServiceContext,
  findIdempotentResult,
  replaceMentionReachGrants,
} from "./runtime-agent-configuration-part-4.js";

export function createRuntimeAgentConfigurationServiceOperationsSection1Resubmit(
  context: ReturnType<typeof createRuntimeAgentConfigurationServiceContext>,
) {
  const { db, clock, idFactory } = context;
  async function resubmitHireApprovalInternal(input: {
    approvalId: string;
    actor: RuntimeAgentConfigurationBoardActor;
    expectedAgentId: string;
    expectedAuditId: string;
    expectedRequestDigest: string;
    configuration: ParsedCreateConfiguration;
  }) {
    if (
      !isCanonicalUuid(input.approvalId) ||
      !isCanonicalUuid(input.expectedAgentId) ||
      !isCanonicalUuid(input.expectedAuditId) ||
      !/^[a-f0-9]{64}$/.test(input.expectedRequestDigest)
    ) {
      throw new RuntimeAgentConfigurationInvalid("Hire approval resubmission identifiers are invalid");
    }
    const idempotencyKey = `hire_approval_resubmit:${input.approvalId}:${input.expectedAuditId}`;
    return db.transaction(async (tx) => {
      const candidateApproval = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, input.approvalId))
        .then((rows) => rows[0] ?? null);
      if (!candidateApproval || candidateApproval.type !== "hire_agent") {
        throw new RuntimeAgentConfigurationConflict("Hire approval resubmission target does not exist");
      }
      const locked = await lockCompanyAndAgents(tx, candidateApproval.companyId);
      const existingApproval = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, input.approvalId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existingApproval || existingApproval.type !== "hire_agent") {
        throw new RuntimeAgentConfigurationConflict("Hire approval resubmission target does not exist");
      }
      const existingPayload = hireAgentApprovalPayloadSchema.safeParse(existingApproval.payload);
      if (!existingPayload.success) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval is missing its canonical runtime-agent link",
        );
      }
      await assertBoardAuthority(
        tx,
        input.actor,
        existingApproval.companyId,
        "update",
        existingPayload.data.agentId,
      );
      const requestDigest = sha256({
        operation: "update",
        companyId: existingApproval.companyId,
        targetAgentId: existingPayload.data.agentId,
        source: "agent_hire",
        actor: actorAuditColumns(input.actor),
        approvalId: existingApproval.id,
        expectedAgentId: input.expectedAgentId,
        supersededAuditId: input.expectedAuditId,
        supersededRequestDigest: input.expectedRequestDigest,
        configuration: input.configuration,
      });
      const retry = await findIdempotentResult(tx, existingApproval.companyId, idempotencyKey, requestDigest);
      if (retry && existingPayload.data.runtimeAgentConfigurationAuditId === retry.auditId) {
        return {
          ...retry,
          approvalId: existingApproval.id,
        };
      }
      if (existingApproval.status !== "revision_requested") {
        throw new RuntimeAgentConfigurationConflict(
          "Only a revision-requested hire approval can be resubmitted",
        );
      }
      if (
        existingPayload.data.agentId !== input.expectedAgentId ||
        existingPayload.data.runtimeAgentConfigurationAuditId !== input.expectedAuditId ||
        existingPayload.data.runtimeAgentConfigurationRequestDigest !== input.expectedRequestDigest
      ) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission does not match the current immutable audit/digest",
        );
      }
      const target = locked.agents.find((candidate) => candidate.id === input.expectedAgentId);
      if (
        !target ||
        (target.status !== "pending_approval" &&
          !(target.status === "paused" && target.pauseReason === "system"))
      ) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission requires its existing pending or system-paused agent",
        );
      }
      if (input.configuration.reportsTo !== target.reportsTo) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission cannot change the creation-time reporting edge",
        );
      }
      const supersededAudit = await assertCurrentRuntimeAgentConfigurationAudit(tx, {
        companyId: existingApproval.companyId,
        agentId: target.id,
        auditId: input.expectedAuditId,
        requestDigest: input.expectedRequestDigest,
      });
      const before = supersededAudit.afterSnapshot;
      assertReportsTo(target.id, input.configuration.reportsTo, locked.agents);
      const now = clock();
      const updatedTarget = await tx
        .update(agents)
        .set({
          name: input.configuration.name,
          title: input.configuration.title,
          capabilities: input.configuration.capabilities,
          reportsTo: target.reportsTo,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.companyId, existingApproval.companyId),
            eq(agents.id, target.id),
            eq(agents.status, target.status),
            target.status === "paused" ? eq(agents.pauseReason, "system") : undefined,
          ),
        )
        .returning({ id: agents.id })
        .then((rows) => rows[0] ?? null);
      if (!updatedTarget) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission lost its locked agent transition",
        );
      }
      await replaceContextGrants(
        tx,
        existingApproval.companyId,
        target.id,
        input.configuration.contextGrants,
        input.actor,
        now,
      );
      await replaceActionGrants(
        tx,
        existingApproval.companyId,
        target.id,
        input.configuration.actionGrants,
        input.actor,
        now,
      );
      await replaceMentionReachGrants(
        tx,
        existingApproval.companyId,
        target.id,
        input.configuration.mentionReachGrants,
        input.actor,
        now,
      );
      const after = await loadSnapshot(tx, existingApproval.companyId, target.id);
      const auditId = idFactory();
      if (!isCanonicalUuid(auditId)) {
        throw new RuntimeAgentConfigurationInvalid("idFactory must produce UUIDs");
      }
      await tx.insert(runtimeAgentConfigurationAudits).values({
        id: auditId,
        companyId: existingApproval.companyId,
        agentId: target.id,
        operation: "update",
        source: "agent_hire",
        ...actorAuditColumns(input.actor),
        idempotencyKey,
        requestDigest,
        changedKeys: snapshotsChangedKeys(before, after),
        beforeSnapshot: before,
        afterSnapshot: after,
        createdAt: now,
      });
      const nextPayload: HireAgentApprovalPayload = {
        ...existingPayload.data,
        runtimeAgentConfigurationAuditId: auditId,
        runtimeAgentConfigurationRequestDigest: requestDigest,
      };
      const updatedApproval = await tx
        .update(approvals)
        .set({
          status: "pending",
          payload: nextPayload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, existingApproval.id), eq(approvals.status, "revision_requested")))
        .returning({ id: approvals.id })
        .then((rows) => rows[0] ?? null);
      if (!updatedApproval) {
        throw new RuntimeAgentConfigurationConflict("Hire approval resubmission lost its locked transition");
      }
      return {
        agentId: target.id,
        companyId: existingApproval.companyId,
        configuration: after,
        auditId,
        approvalId: existingApproval.id,
        retried: false,
      } satisfies RuntimeAgentConfigurationResult;
    });
  }
  return { resubmitHireApprovalInternal };
}
