import { and, eq } from "drizzle-orm";
import {
  agents,
  plugins,
  taskExecutionRefs,
  taskExecutionRunRefs,
  type Db,
  type approvals,
} from "@paperclipai/db";
import { hireAgentApprovalPayloadSchema, type HireAgentApprovalPayload } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import {
  assertCurrentRuntimeAgentConfigurationAudit,
  RuntimeAgentConfigurationConflict,
} from "./runtime-agent-configuration.js";
import { type ApprovalsContext } from "./approval-lifecycle-foundation.js";

export function buildApprovalsApprovalHireValidation(scope: ApprovalsContext) {
  type ApprovalRecord = typeof approvals.$inferSelect;

  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  type ApprovalTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

  function parseHirePayload(approval: ApprovalRecord): HireAgentApprovalPayload {
    const parsed = hireAgentApprovalPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) {
      throw conflict("Hire approval is missing its canonical pending-agent/audit/source link", {
        code: "hire_approval_link_invalid",
        approvalId: approval.id,
      });
    }
    return parsed.data;
  }

  async function assertHireSourceLink(
    tx: ApprovalTransaction,
    approval: ApprovalRecord,
    payload: HireAgentApprovalPayload,
  ): Promise<void> {
    if (payload.source.kind === "agent_run") {
      const sourceRef = await tx
        .select({
          id: taskExecutionRefs.id,
          companyId: taskExecutionRefs.companyId,
          taskId: taskExecutionRefs.taskId,
          runId: taskExecutionRunRefs.runId,
          targetAgentId: taskExecutionRefs.targetAgentId,
        })
        .from(taskExecutionRefs)
        .innerJoin(
          taskExecutionRunRefs,
          and(
            eq(taskExecutionRunRefs.companyId, taskExecutionRefs.companyId),
            eq(taskExecutionRunRefs.taskId, taskExecutionRefs.taskId),
            eq(taskExecutionRunRefs.refId, taskExecutionRefs.id),
          ),
        )
        .where(
          and(
            eq(taskExecutionRefs.id, payload.source.taskExecutionRefId),
            eq(taskExecutionRefs.companyId, approval.companyId),
            eq(taskExecutionRefs.taskId, payload.source.taskId),
            eq(taskExecutionRunRefs.runId, payload.source.runId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!sourceRef || sourceRef.targetAgentId !== approval.requestedByAgentId) {
        throw conflict(
          "Hire approval source task/run/ref link is missing or no longer matches its requester",
          {
            code: "hire_approval_source_link_missing",
            approvalId: approval.id,
          },
        );
      }
      return;
    }

    const plugin = await tx
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.id, payload.source.pluginInstallationId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!plugin || approval.requestedByAgentId !== null) {
      throw conflict("Hire approval plugin source link is missing or malformed", {
        code: "hire_approval_source_link_missing",
        approvalId: approval.id,
      });
    }
  }

  async function lockAndAssertPendingHire(tx: ApprovalTransaction, approval: ApprovalRecord) {
    const payload = parseHirePayload(approval);
    const pendingAgent = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, payload.agentId), eq(agents.companyId, approval.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !pendingAgent ||
      (pendingAgent.status !== "pending_approval" &&
        !(pendingAgent.status === "paused" && pendingAgent.pauseReason === "system"))
    ) {
      throw conflict("Hire approval must reference its existing pending or system-paused agent", {
        code: "hire_approval_pending_agent_missing",
        approvalId: approval.id,
        agentId: payload.agentId,
      });
    }

    try {
      await assertCurrentRuntimeAgentConfigurationAudit(tx, {
        companyId: approval.companyId,
        agentId: payload.agentId,
        auditId: payload.runtimeAgentConfigurationAuditId,
        requestDigest: payload.runtimeAgentConfigurationRequestDigest,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentConfigurationConflict) {
        throw conflict(error.message, {
          code: "hire_approval_runtime_audit_conflict",
          approvalId: approval.id,
          agentId: payload.agentId,
        });
      }
      throw error;
    }
    await assertHireSourceLink(tx, approval, payload);
    return { payload, pendingAgent };
  }

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, {
        enabled: censorUsernameInLogs,
      }),
    };
  }

  return {
    parseHirePayload,
    assertHireSourceLink,
    lockAndAssertPendingHire,
    redactApprovalComment,
  };
}
