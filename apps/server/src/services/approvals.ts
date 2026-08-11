import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvalComments,
  approvals,
  taskExecutionRefs,
  taskExecutionRunRefs,
  plugins,
} from "@paperclipai/db";
import {
  hireAgentApprovalPayloadSchema,
  type HireAgentApprovalPayload,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import {
  terminateAgentToTombstoneInTransaction,
  type AgentLifecycleCancellationService,
  type AgentTerminationCommit,
} from "./agents.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  assertCurrentRuntimeAgentConfigurationAudit,
  createRuntimeAgentConfigurationService,
  RuntimeAgentConfigurationConflict,
  type RuntimeAgentConfigurationBoardActor,
} from "./runtime-agent-configuration.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";

export type ApprovalLifecycleTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

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
      actor: input.decidedByUserId
        ? { kind: "user", userId: input.decidedByUserId }
        : { kind: "system" },
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
    .where(
      and(
        eq(approvals.id, approval.id),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ),
    )
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
  };
}

export function approvalService(
  db: Db,
  options: {
    taskExecutionCancellation: AgentLifecycleCancellationService;
    terminateHireRejectionAgentInTransaction:
      HireRejectionAgentTerminationOwner;
    dispatchRef(refId: string): Promise<void>;
  },
) {
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };
  type ApprovalTransaction =
    Parameters<Parameters<Db["transaction"]>[0]>[0];

  function parseHirePayload(approval: ApprovalRecord): HireAgentApprovalPayload {
    const parsed = hireAgentApprovalPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) {
      throw conflict(
        "Hire approval is missing its canonical pending-agent/audit/source link",
        {
          code: "hire_approval_link_invalid",
          approvalId: approval.id,
        },
      );
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
      if (
        !sourceRef ||
        sourceRef.targetAgentId !== approval.requestedByAgentId
      ) {
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
      throw conflict(
        "Hire approval plugin source link is missing or malformed",
        {
          code: "hire_approval_source_link_missing",
          approvalId: approval.id,
        },
      );
    }
  }

  async function lockAndAssertPendingHire(
    tx: ApprovalTransaction,
    approval: ApprovalRecord,
  ) {
    const payload = parseHirePayload(approval);
    const pendingAgent = await tx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, payload.agentId),
          eq(agents.companyId, approval.companyId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !pendingAgent ||
      (
        pendingAgent.status !== "pending_approval" &&
        !(
          pendingAgent.status === "paused" &&
          pendingAgent.pauseReason === "system"
        )
      )
    ) {
      throw conflict(
        "Hire approval must reference its existing pending or system-paused agent",
        {
          code: "hire_approval_pending_agent_missing",
          approvalId: approval.id,
          agentId: payload.agentId,
        },
      );
    }

    try {
      await assertCurrentRuntimeAgentConfigurationAudit(tx, {
        companyId: approval.companyId,
        agentId: payload.agentId,
        auditId: payload.runtimeAgentConfigurationAuditId,
        requestDigest:
          payload.runtimeAgentConfigurationRequestDigest,
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
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
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
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

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
      if (!canResolveStatuses.has(existing.status)) {
        if (existing.status === targetStatus) {
          return {
            approval: existing,
            applied: false,
            dispatchRefIds: [] as string[],
            cancellationRequests: null as AgentTerminationCommit["cancellationRequests"],
            suspensionRequests: null as AgentTerminationCommit["suspensionRequests"],
          };
        }
        throw unprocessable(
          `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
        );
      }

      const { payload, pendingAgent } = await lockAndAssertPendingHire(
        tx,
        existing,
      );

      const now = new Date();
      let dispatchRefIds: string[] = [];
      let cancellationRequests: AgentTerminationCommit["cancellationRequests"] = null;
      let suspensionRequests: AgentTerminationCommit["suspensionRequests"] = null;
      if (targetStatus === "approved") {
        const preserveSystemPause =
          pendingAgent.status === "paused" &&
          pendingAgent.pauseReason === "system";
        const activated = await tx
          .update(agents)
          .set({
            status: preserveSystemPause ? "paused" : "idle",
            pauseReason: preserveSystemPause ? "system" : null,
            pausedAt: preserveSystemPause
              ? pendingAgent.pausedAt ?? now
              : null,
            errorReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, payload.agentId),
              eq(agents.companyId, existing.companyId),
              eq(agents.status, pendingAgent.status),
              ...(preserveSystemPause
                ? [eq(agents.pauseReason, "system")]
                : []),
            ),
          )
          .returning({ id: agents.id })
          .then((rows) => rows[0] ?? null);
        if (!activated) {
          throw conflict(
            "Hire approval lost its pending-agent transition",
            {
              code: "hire_approval_pending_agent_conflict",
              approvalId: existing.id,
              agentId: payload.agentId,
            },
          );
        }
      } else {
        const terminated = await options
          .terminateHireRejectionAgentInTransaction(
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
          throw conflict(
            "Hire rejection lost its pending-agent transition",
            {
              code: "hire_approval_pending_agent_conflict",
              approvalId: existing.id,
              agentId: payload.agentId,
            },
          );
        }
        dispatchRefIds = terminated.dispatchRefIds;
        cancellationRequests = terminated.cancellationRequests;
        suspensionRequests = terminated.suspensionRequests;
      }

      const updated = await tx
        .update(approvals)
        .set({
          status: targetStatus,
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(approvals.id, id),
            inArray(approvals.status, resolvableStatuses),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
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
      };
    });
    if (committed.cancellationRequests) {
      await options.taskExecutionCancellation
        .reconcileRequestedCancellations(
          committed.cancellationRequests,
        );
    }
    if (committed.suspensionRequests) {
      await options.taskExecutionCancellation
        .reconcileRequestedCancellations(committed.suspensionRequests);
    }
    for (const refId of committed.dispatchRefIds) {
      await options.dispatchRef(refId);
    }
    return {
      approval: committed.approval,
      applied: committed.applied,
    };
  }

  async function requestHireRevision(
    id: string,
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ) {
    return db.transaction(async (tx) => {
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
      if (existing.status !== "pending") {
        throw unprocessable(
          "Only pending approvals can request revision",
        );
      }
      await lockAndAssertPendingHire(tx, existing);

      const now = new Date();
      const updated = await tx
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.status, "pending"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        throw conflict(
          "Hire approval revision request lost its locked transition",
          {
            code: "hire_approval_revision_conflict",
            approvalId: id,
          },
        );
      }
      return updated;
    });
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: (
      companyId: string,
      data: Omit<typeof approvals.$inferInsert, "companyId">,
    ) => {
      if (data.type === "hire_agent") {
        throw unprocessable(
          "Hire approvals are created only by the canonical runtime-agent transaction",
        );
      }
      return db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type === "hire_agent") {
        return resolveHireApproval(
          id,
          "approved",
          decidedByUserId,
          decisionNote,
        );
      }
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );
      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type === "hire_agent") {
        return resolveHireApproval(
          id,
          "rejected",
          decidedByUserId,
          decisionNote,
        );
      }
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );
      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type === "hire_agent") {
        return requestHireRevision(
          id,
          decidedByUserId,
          decisionNote,
        );
      }
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.status, "pending"),
          ),
        )
        .returning()
        .then((rows) => {
          const updated = rows[0] ?? null;
          if (!updated) {
            throw unprocessable(
              "Only pending approvals can request revision",
            );
          }
          return updated;
        });
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }
      if (existing.type === "hire_agent") {
        throw unprocessable(
          "Hire approvals require the exact runtime-agent audit/digest resubmission contract",
        );
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmitHire: async (input: {
      approvalId: string;
      actor: RuntimeAgentConfigurationBoardActor;
      agentId: string;
      runtimeAgentConfigurationAuditId: string;
      runtimeAgentConfigurationRequestDigest: string;
      configuration: unknown;
    }) => {
      await createRuntimeAgentConfigurationService(
        db,
      ).resubmitHireApproval({
        approvalId: input.approvalId,
        actor: input.actor,
        expectedAgentId: input.agentId,
        expectedAuditId:
          input.runtimeAgentConfigurationAuditId,
        expectedRequestDigest:
          input.runtimeAgentConfigurationRequestDigest,
        configuration: input.configuration,
      });
      return getExistingApproval(input.approvalId);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
