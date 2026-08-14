import { taskCreatorEdgeReceivability, tasks, type Db } from "@paperclipai/db";
import { isTaskCreatorEdgeTerminalReason } from "@paperclipai/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  type EnsureSystemEscalationInput,
  type PostgresSystemEscalationOptions,
  type SystemEscalationTransactionResult,
  type TerminalizeCreatorEdgeInput,
  PostgresSystemEscalationConflict,
} from "./system-escalation-postgres-part-1.js";
import {
  ensureSystemEscalationInTransaction,
  terminalizeCreatorEdgeInTransaction,
} from "./system-escalation-postgres-part-3.js";
import { inspectEndpointTerminality } from "./system-escalation-postgres-part-4.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";

export function createPostgresSystemEscalationService(db: Db, options: PostgresSystemEscalationOptions) {
  const clock = options.clock ?? (() => new Date());
  const sessions = createTaskSessionAdmissionService(db, { clock });

  async function dispatch(refId: string | null): Promise<void> {
    if (refId) await options.dispatchRef(refId);
  }

  return {
    async ensure(input: EnsureSystemEscalationInput): Promise<SystemEscalationTransactionResult> {
      const result = await db.transaction((tx) =>
        ensureSystemEscalationInTransaction(tx, sessions, input, clock),
      );
      await dispatch(result.dispatchRefId);
      return result;
    },

    async terminalizeCreatorEdge(input: TerminalizeCreatorEdgeInput) {
      const result = await db.transaction((tx) =>
        terminalizeCreatorEdgeInTransaction(tx, sessions, input, clock),
      );
      await dispatch(result.escalation?.dispatchRefId ?? null);
      return result;
    },

    async reconcile(input: { limit?: number } = {}) {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
      const candidates = await db
        .select({
          edge: taskCreatorEdgeReceivability,
          taskLifecycleStatus: tasks.lifecycleStatus,
          taskOwnershipEpoch: tasks.ownershipEpoch,
        })
        .from(taskCreatorEdgeReceivability)
        .innerJoin(
          tasks,
          and(
            eq(tasks.companyId, taskCreatorEdgeReceivability.companyId),
            eq(tasks.id, taskCreatorEdgeReceivability.taskId),
            eq(tasks.ownershipEpoch, taskCreatorEdgeReceivability.ownershipEpoch),
          ),
        )
        .where(sql`${taskCreatorEdgeReceivability.endpointKind} not in ('user/board', 'system')`)
        .orderBy(
          asc(taskCreatorEdgeReceivability.companyId),
          asc(taskCreatorEdgeReceivability.taskId),
          asc(taskCreatorEdgeReceivability.ownershipEpoch),
          asc(taskCreatorEdgeReceivability.id),
        )
        .limit(limit);
      const dispatchRefIds: string[] = [];
      let terminalized = 0;
      let ensured = 0;
      for (const candidate of candidates) {
        const result = await db.transaction(async (tx) => {
          const task = await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.companyId, candidate.edge.companyId), eq(tasks.id, candidate.edge.taskId)))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!task || task.ownershipEpoch !== candidate.edge.ownershipEpoch) {
            return null;
          }
          const edge = await tx
            .select()
            .from(taskCreatorEdgeReceivability)
            .where(
              and(
                eq(taskCreatorEdgeReceivability.id, candidate.edge.id),
                eq(taskCreatorEdgeReceivability.companyId, task.companyId),
                eq(taskCreatorEdgeReceivability.taskId, task.id),
                eq(taskCreatorEdgeReceivability.ownershipEpoch, task.ownershipEpoch),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!edge) return null;
          if (edge.state === "terminal") {
            if (!isTaskCreatorEdgeTerminalReason(edge.terminalReason)) {
              throw new PostgresSystemEscalationConflict(
                "Terminal creator edge has no canonical terminal reason",
                "creator_edge_reason_not_escalating",
              );
            }
            const terminalizedResult = await terminalizeCreatorEdgeInTransaction(
              tx,
              sessions,
              {
                companyId: edge.companyId,
                taskId: edge.taskId,
                ownershipEpoch: edge.ownershipEpoch,
                creatorEdgeId: edge.id,
                reason: edge.terminalReason,
                sourceKind: "creator_edge_reconciler",
                sourceId: `reconcile:${edge.id}`,
                systemSource: "recovery",
                triggeringRunId: null,
                audit: { reconciled: true },
              },
              clock,
            );
            return {
              terminalized: false,
              escalation: terminalizedResult.escalation,
            };
          }
          const endpoint = await inspectEndpointTerminality(tx, edge);
          if (!endpoint) return null;
          const terminalizedResult = await terminalizeCreatorEdgeInTransaction(
            tx,
            sessions,
            {
              companyId: edge.companyId,
              taskId: edge.taskId,
              ownershipEpoch: edge.ownershipEpoch,
              creatorEdgeId: edge.id,
              reason: endpoint.reason,
              sourceKind: "creator_endpoint_reconciler",
              sourceId: `reconcile:${edge.id}`,
              systemSource: "recovery",
              triggeringRunId: null,
              endpointTombstone: endpoint.tombstone,
              audit: { reconciled: true },
            },
            clock,
          );
          return {
            terminalized: task.lifecycleStatus === "open" || task.lifecycleStatus === "blocked",
            escalation: terminalizedResult.escalation,
          };
        });
        if (!result?.escalation) continue;
        if (result.terminalized) terminalized += 1;
        ensured += 1;
        if (result.escalation.dispatchRefId) {
          dispatchRefIds.push(result.escalation.dispatchRefId);
        }
      }
      for (const refId of dispatchRefIds) {
        await dispatch(refId);
      }
      return {
        inspected: candidates.length,
        terminalized,
        ensured,
        dispatchRefIds,
      };
    },
  };
}
export * from "./system-escalation-postgres-part-1.js";
export * from "./system-escalation-postgres-part-2.js";
export * from "./system-escalation-postgres-part-3.js";
export * from "./system-escalation-postgres-part-4.js";
