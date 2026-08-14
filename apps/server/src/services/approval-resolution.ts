import { and, eq, inArray } from "drizzle-orm";
import { type Db, agents, approvals } from "@paperclipai/db";
import { type ApprovalStatus } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { type AgentTerminationCommit } from "./agents.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import { publishCommittedActivity } from "./activity-log.js";
import { type ApprovalsContext } from "./approval-lifecycle-foundation.js";
import { buildApprovalsApprovalHireValidation } from "./approval-hire-validation.js";

export function buildApprovalsApprovalResolution(
  scope: ApprovalsContext & ReturnType<typeof buildApprovalsApprovalHireValidation>,
) {
  const { db, options, resolvableStatuses, canResolveStatuses, lockAndAssertPendingHire } = scope;

  type ApprovalRecord = typeof approvals.$inferSelect;

  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  type ApprovalTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function updateApprovalDecision(
    executor: Pick<ApprovalTransaction, "update">,
    input: {
      id: string;
      expectedStatuses: readonly [ApprovalStatus, ...ApprovalStatus[]];
      status: ApprovalStatus;
      decidedByUserId: string;
      decisionNote: string | null | undefined;
      decidedAt: Date;
    },
  ): Promise<ApprovalRecord | null> {
    return executor
      .update(approvals)
      .set({
        status: input.status,
        decidedByUserId: input.decidedByUserId,
        decisionNote: input.decisionNote ?? null,
        decidedAt: input.decidedAt,
        updatedAt: input.decidedAt,
      })
      .where(and(eq(approvals.id, input.id), inArray(approvals.status, [...input.expectedStatuses])))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function lockHireApprovalForUpdate(tx: ApprovalTransaction, id: string): Promise<ApprovalRecord> {
    const candidate = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!candidate) throw notFound("Approval not found");
    if (candidate.type !== "hire_agent") {
      throw conflict("Approval is not a hire approval", {
        code: "approval_type_mismatch",
        approvalId: id,
      });
    }

    await lockCompanyAgentGraph(tx, candidate.companyId);
    const existing = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    if (existing.type !== "hire_agent") {
      throw conflict("Approval is not a hire approval", {
        code: "approval_type_mismatch",
        approvalId: id,
      });
    }
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await updateApprovalDecision(db, {
      id,
      expectedStatuses: resolvableStatuses,
      status: targetStatus,
      decidedByUserId,
      decisionNote,
      decidedAt: now,
    });

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  async function resolveHireApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const committed = await db.transaction(async (tx) => {
      const existing = await lockHireApprovalForUpdate(tx, id);
      if (!canResolveStatuses.has(existing.status)) {
        if (existing.status === targetStatus) {
          return {
            approval: existing,
            applied: false,
            dispatchRefIds: [] as string[],
            cancellationRequests: null as AgentTerminationCommit["cancellationRequests"],
            suspensionRequests: null as AgentTerminationCommit["suspensionRequests"],
            activities: [] as AgentTerminationCommit["activities"],
          };
        }
        throw unprocessable(
          `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
        );
      }

      const { payload, pendingAgent } = await lockAndAssertPendingHire(tx, existing);

      const now = new Date();
      let dispatchRefIds: string[] = [];
      let cancellationRequests: AgentTerminationCommit["cancellationRequests"] = null;
      let suspensionRequests: AgentTerminationCommit["suspensionRequests"] = null;
      let activities: AgentTerminationCommit["activities"] = [];
      if (targetStatus === "approved") {
        const preserveSystemPause = pendingAgent.status === "paused" && pendingAgent.pauseReason === "system";
        const activated = await tx
          .update(agents)
          .set({
            status: preserveSystemPause ? "paused" : "idle",
            pauseReason: preserveSystemPause ? "system" : null,
            pausedAt: preserveSystemPause ? (pendingAgent.pausedAt ?? now) : null,
            errorReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, payload.agentId),
              eq(agents.companyId, existing.companyId),
              eq(agents.status, pendingAgent.status),
              ...(preserveSystemPause ? [eq(agents.pauseReason, "system")] : []),
            ),
          )
          .returning({ id: agents.id })
          .then((rows) => rows[0] ?? null);
        if (!activated) {
          throw conflict("Hire approval lost its pending-agent transition", {
            code: "hire_approval_pending_agent_conflict",
            approvalId: existing.id,
            agentId: payload.agentId,
          });
        }
      } else {
        const terminated = await options.terminateHireRejectionAgentInTransaction(
          tx,
          {
            companyId: existing.companyId,
            agentId: payload.agentId,
            sourceId: `hire-approval-rejection:${existing.id}`,
            decidedByUserId,
            now,
          },
          options.taskExecutionCancellation,
        );
        if (!terminated) {
          throw conflict("Hire rejection lost its pending-agent transition", {
            code: "hire_approval_pending_agent_conflict",
            approvalId: existing.id,
            agentId: payload.agentId,
          });
        }
        dispatchRefIds = terminated.dispatchRefIds;
        cancellationRequests = terminated.cancellationRequests;
        suspensionRequests = terminated.suspensionRequests;
        activities = terminated.activities;
      }

      const updated = await updateApprovalDecision(tx, {
        id,
        expectedStatuses: resolvableStatuses,
        status: targetStatus,
        decidedByUserId,
        decisionNote,
        decidedAt: now,
      });
      if (!updated) {
        throw conflict("Hire approval resolution lost its locked transition", {
          code: "hire_approval_resolution_conflict",
          approvalId: existing.id,
        });
      }
      return {
        approval: updated,
        applied: true,
        dispatchRefIds,
        cancellationRequests,
        suspensionRequests,
        activities,
      };
    });
    for (const activity of committed.activities) {
      publishCommittedActivity(activity);
    }
    if (committed.cancellationRequests) {
      await options.taskExecutionCancellation.reconcileRequestedCancellations(committed.cancellationRequests);
    }
    if (committed.suspensionRequests) {
      await options.taskExecutionCancellation.reconcileRequestedCancellations(committed.suspensionRequests);
    }
    for (const refId of committed.dispatchRefIds) {
      await options.dispatchRef(refId);
    }
    return {
      approval: committed.approval,
      applied: committed.applied,
    };
  }

  return {
    getExistingApproval,
    updateApprovalDecision,
    lockHireApprovalForUpdate,
    resolveApproval,
    resolveHireApproval,
  };
}
