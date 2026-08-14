import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type Db, approvals } from "@paperclipai/db";
import { conflict } from "../errors.js";
import {
  terminateAgentToTombstoneInTransaction,
  type AgentLifecycleCancellationService,
  type AgentTerminationCommit,
} from "./agents.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import { type ApprovalStatus } from "@paperclipai/shared";
import { instanceSettingsService } from "./instance-settings.js";

export function createApprovalsContext(
  db: Db,
  options: {
    taskExecutionCancellation: AgentLifecycleCancellationService;
    terminateHireRejectionAgentInTransaction: HireRejectionAgentTerminationOwner;
    dispatchRef(refId: string): Promise<void>;
  },
) {
  const instanceSettings = instanceSettingsService(db);

  const resolvableStatuses = ["pending", "revision_requested"] as const satisfies readonly ApprovalStatus[];

  const canResolveStatuses = new Set<string>(resolvableStatuses);

  return {
    db,
    options,
    instanceSettings,
    resolvableStatuses,
    canResolveStatuses,
  };
}

export type ApprovalsContext = ReturnType<typeof createApprovalsContext>;

export type ApprovalLifecycleTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface HireRejectionAgentTerminationInput {
  companyId: string;
  agentId: string;
  sourceId: string;
  decidedByUserId: string;
  now: Date;
}

export interface HireRejectionAgentTerminationOwner {
  (
    tx: ApprovalLifecycleTransaction,
    input: HireRejectionAgentTerminationInput,
    cancellation: AgentLifecycleCancellationService,
  ): Promise<AgentTerminationCommit | null>;
}

/**
 * Withdraws a still-open hire when the system-owned source of that pending
 * agent disappears. This is the lifecycle counterpart to a board rejection:
 * the approval and its pending agent become terminal in the same transaction.
 */
export async function withdrawOpenHireApprovalForAgentInTransaction(
  tx: ApprovalLifecycleTransaction,
  input: {
    companyId: string;
    agentId: string;
    decidedByUserId: string | null;
    decisionNote: string;
    sourceId: string;
    now: Date;
  },
  cancellation: AgentLifecycleCancellationService,
): Promise<{
  approvalId: string;
  dispatchRefIds: string[];
  cancellationRequests: AgentTerminationCommit["cancellationRequests"];
  suspensionRequests: AgentTerminationCommit["suspensionRequests"];
  activities: AgentTerminationCommit["activities"];
} | null> {
  await lockCompanyAgentGraph(tx, input.companyId);
  const openApprovals = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, input.companyId),
        eq(approvals.type, "hire_agent"),
        inArray(approvals.status, ["pending", "revision_requested"]),
        sql`${approvals.payload} ->> 'agentId' = ${input.agentId}`,
      ),
    )
    .orderBy(asc(approvals.id))
    .for("update");
  if (openApprovals.length > 1) {
    throw conflict("Pending agent has multiple open hire approvals", {
      code: "hire_approval_link_not_unique",
      agentId: input.agentId,
      approvalIds: openApprovals.map((approval) => approval.id),
    });
  }
  const approval = openApprovals[0];
  if (!approval) return null;

  const terminated = await terminateAgentToTombstoneInTransaction(
    tx,
    {
      companyId: input.companyId,
      agentId: input.agentId,
      sourceId: input.sourceId,
      actor: input.decidedByUserId ? { kind: "user", userId: input.decidedByUserId } : { kind: "system" },
      now: input.now,
    },
    cancellation,
  );
  if (!terminated) {
    throw conflict("Hire withdrawal lost its pending-agent transition", {
      code: "hire_approval_pending_agent_conflict",
      approvalId: approval.id,
      agentId: input.agentId,
    });
  }

  const rejected = await tx
    .update(approvals)
    .set({
      status: "rejected",
      decidedByUserId: input.decidedByUserId,
      decisionNote: input.decisionNote,
      decidedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(eq(approvals.id, approval.id), inArray(approvals.status, ["pending", "revision_requested"])))
    .returning({ id: approvals.id })
    .then((rows) => rows[0] ?? null);
  if (!rejected) {
    throw conflict("Hire withdrawal lost its approval transition", {
      code: "hire_approval_resolution_conflict",
      approvalId: approval.id,
    });
  }
  return {
    approvalId: rejected.id,
    dispatchRefIds: terminated.dispatchRefIds,
    cancellationRequests: terminated.cancellationRequests,
    suspensionRequests: terminated.suspensionRequests,
    activities: terminated.activities,
  };
}
