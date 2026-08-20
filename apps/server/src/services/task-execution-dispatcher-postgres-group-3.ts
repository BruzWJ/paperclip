import {
  agents,
  projects,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskSessionInputDispositions,
  tasks,
} from "@paperclipai/db";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { createPostgresTaskExecutionDispatcherRepositoryGroup1 } from "./task-execution-dispatcher-postgres-group-1.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup2 } from "./task-execution-dispatcher-postgres-group-2.js";
import type { PostgresTaskExecutionDispatcherRepositoryContext } from "./task-execution-dispatcher-postgres-part-6.js";
import {
  FencedTaskExecutionAuthority,
  TaskExecutionAuthorityFenceSelector,
  exactIdentifier,
  exactlyOne,
  reject,
  validDate,
} from "./task-execution-dispatcher-postgres-part-1.js";
import {
  clearExactLaneClaim,
  lockRunLaneClaimIfPresent,
} from "./task-execution-dispatcher-postgres-part-2.js";
import { readOccupiedTaskExecutionRefIds } from "./task-execution-run-service-part-3-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function createPostgresTaskExecutionDispatcherRepositoryGroup3(
  context: PostgresTaskExecutionDispatcherRepositoryContext,
  group1: ReturnType<typeof createPostgresTaskExecutionDispatcherRepositoryGroup1>,
  group2: ReturnType<typeof createPostgresTaskExecutionDispatcherRepositoryGroup2>,
) {
  const options = context;
  const { idFactory } = context;
  const {
    terminalEventForExpiredRun,
    recoverExpiredRunInTransaction,
    leaseExistingRunInTransaction,
    leaseForLane,
  } = Object.assign({}, group1, group2);
  async function terminalizeDetachedCancelledRunInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly reason: string;
      readonly finishedAt: Date;
    },
  ): Promise<boolean> {
    const at = validDate(input.finishedAt, "cancelled run terminal time");
    const laneClaim = await lockRunLaneClaimIfPresent(transaction, input.runId);
    const run = await options.runService.lockRun(transaction, input);
    if (["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(run.status)) {
      return false;
    }
    if (run.currentAttemptId !== null || run.currentLeaseId !== null || run.cancellationIntentId !== null) {
      reject("cancelled run still owns an attempt, lease, or cancellation pointer");
    }
    const members = await transaction
      .select({
        refId: taskExecutionRunRefs.refId,
        refOrdinal: taskExecutionRunRefs.refOrdinal,
        promptTransmissionPhase: taskExecutionRunRefs.promptTransmissionPhase,
        protocolSettlementState: taskExecutionRunRefs.protocolSettlementState,
      })
      .from(taskExecutionRunRefs)
      .where(eq(taskExecutionRunRefs.runId, input.runId))
      .orderBy(asc(taskExecutionRunRefs.refOrdinal))
      .for("update");
    const unsettled = members.filter((member) => member.protocolSettlementState === null);
    if (unsettled.some((member) => member.promptTransmissionPhase !== "not_transmitted")) {
      reject("cancelled run cannot release an unsettled transmitted prompt");
    }
    for (const member of unsettled) {
      exactlyOne(
        await transaction
          .update(taskExecutionRunRefs)
          .set({
            outcome: "released_unsent",
            outcomeReferenceId: idFactory(),
            protocolSettlementState: "not_sent",
            settlementVersion: 1,
            settledAt: at,
          })
          .where(
            and(
              eq(taskExecutionRunRefs.runId, input.runId),
              eq(taskExecutionRunRefs.refOrdinal, member.refOrdinal),
              eq(taskExecutionRunRefs.promptTransmissionPhase, "not_transmitted"),
              isNull(taskExecutionRunRefs.protocolSettlementState),
            ),
          )
          .returning({ runId: taskExecutionRunRefs.runId }),
        "cancelled run lost an unsettled prompt member",
      );
    }
    const refIds = [...new Set(members.map((member) => member.refId))];
    if (refIds.length > 0) {
      await transaction
        .update(taskExecutionRefs)
        .set({ disposition: "terminal", updatedAt: at })
        .where(and(inArray(taskExecutionRefs.id, refIds), eq(taskExecutionRefs.disposition, "active")));
      await transaction
        .update(taskExecutionHistoryViews)
        .set({ state: "terminal", finalizedAt: at, updatedAt: at })
        .where(
          and(
            inArray(taskExecutionHistoryViews.refId, refIds),
            inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
          ),
        );
    }
    await transaction
      .update(taskExecutionRunControls)
      .set({
        currentRefId: null,
        currentOrdinal: null,
      })
      .where(eq(taskExecutionRunControls.runId, input.runId));
    await options.finalizer.finalizeInTransaction(transaction, {
      companyId: input.companyId,
      taskId: input.taskId,
      runId: input.runId,
      status: "cancelled",
      terminalReasonCode: (input.reason.trim() || "cancelled").slice(0, 200),
      finishedAt: at,
    });
    if (laneClaim) {
      await clearExactLaneClaim(transaction, {
        ...laneClaim,
        at,
      });
    }
    return true;
  }

  async function fenceRevokedExecutionAuthorityInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly selector: TaskExecutionAuthorityFenceSelector;
      readonly reason: string;
      readonly at: Date;
      readonly nativeContinuity: "revoke" | "preserve_carry";
    },
  ): Promise<FencedTaskExecutionAuthority> {
    exactIdentifier(input.companyId, "authority fence company id");
    const at = validDate(input.at, "authority fence time");
    const reason = (input.reason.trim() || "execution_authority_revoked").slice(0, 200);
    const selector = input.selector;
    let budgetTaskIds: readonly string[] = Object.freeze([]);
    if (selector.kind === "agents" || selector.kind === "suspended_agents") {
      for (const agentId of selector.agentIds) {
        exactIdentifier(agentId, "authority fence agent id");
      }
      if (selector.agentIds.length === 0) {
        return Object.freeze({
          refIds: Object.freeze([]),
          correlationIds: Object.freeze([]),
        });
      }
    } else if (selector.kind === "budget_scope") {
      exactIdentifier(selector.scopeId, "budget scope id");
      if (selector.scopeType === "company") {
        if (selector.scopeId !== input.companyId) {
          reject("company budget fence crossed its exact company");
        }
      } else if (selector.scopeType === "agent") {
        const agent = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, input.companyId), eq(agents.id, selector.scopeId)))
          .limit(2)
          .for("update");
        if (agent.length !== 1) reject("agent budget scope is not canonical");
      } else {
        const project = await transaction
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, input.companyId), eq(projects.id, selector.scopeId)))
          .limit(2)
          .for("update");
        if (project.length !== 1) reject("project budget scope is not canonical");
        budgetTaskIds = Object.freeze(
          (
            await transaction
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(eq(tasks.companyId, input.companyId), eq(tasks.projectId, selector.scopeId)))
          ).map((task) => task.id),
        );
      }
    } else {
      exactIdentifier(selector.taskId, "authority fence task id");
      if (selector.kind === "ownership_epoch") {
        if (!Number.isSafeInteger(selector.ownershipEpoch) || selector.ownershipEpoch < 1) {
          reject("authority fence ownership epoch must be positive");
        }
      } else {
        for (const refId of selector.refIds) {
          exactIdentifier(refId, "authority fence ref id");
        }
        if (selector.refIds.length === 0) {
          return Object.freeze({
            refIds: Object.freeze([]),
            correlationIds: Object.freeze([]),
          });
        }
      }
    }

    const refPredicate =
      selector.kind === "agents" || selector.kind === "suspended_agents"
        ? inArray(taskExecutionRefs.targetAgentId, [...selector.agentIds])
        : selector.kind === "budget_scope"
          ? selector.scopeType === "company"
            ? sql<boolean>`true`
            : selector.scopeType === "agent"
              ? eq(taskExecutionRefs.targetAgentId, selector.scopeId)
              : budgetTaskIds.length === 0
                ? sql<boolean>`false`
                : inArray(taskExecutionRefs.taskId, [...budgetTaskIds])
          : selector.kind === "ownership_epoch"
            ? and(
                eq(taskExecutionRefs.taskId, selector.taskId),
                eq(taskExecutionRefs.ownershipEpoch, selector.ownershipEpoch),
              )
            : and(
                eq(taskExecutionRefs.taskId, selector.taskId),
                inArray(taskExecutionRefs.id, [...selector.refIds]),
              );
    const occupiedRefIds = await readOccupiedTaskExecutionRefIds(transaction, {
      companyId: input.companyId,
    });
    const refs = await transaction
      .select({
        id: taskExecutionRefs.id,
        companyId: taskExecutionRefs.companyId,
        taskId: taskExecutionRefs.taskId,
        ownershipEpoch: taskExecutionRefs.ownershipEpoch,
        targetAgentId: taskExecutionRefs.targetAgentId,
        laneOrdinal: taskExecutionRefs.laneOrdinal,
      })
      .from(taskExecutionRefs)
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.disposition, "active"),
          refPredicate,
          occupiedRefIds.length === 0 ? undefined : notInArray(taskExecutionRefs.id, [...occupiedRefIds]),
        ),
      )
      .orderBy(asc(taskExecutionRefs.createdAt), asc(taskExecutionRefs.id))
      .for("update");
    const refIds = refs.map((ref) => ref.id);
    if (refIds.length > 0) {
      await transaction
        .update(taskExecutionRefs)
        .set({
          disposition: "invalidated",
          invalidationReason: reason,
          updatedAt: at,
        })
        .where(and(inArray(taskExecutionRefs.id, refIds), eq(taskExecutionRefs.disposition, "active")));
      await transaction
        .update(taskExecutionHistoryViews)
        .set({
          state: "invalidated",
          invalidationReason: reason,
          invalidatedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            inArray(taskExecutionHistoryViews.refId, refIds),
            inArray(taskExecutionHistoryViews.state, ["empty", "preparing", "current"]),
          ),
        );
      await transaction
        .update(taskSessionInputDispositions)
        .set({
          state: "invalidated",
          invalidationReason: reason,
          invalidatedAt: at,
          invalidatedBySourceKind: "task_execution_authority_revocation",
          invalidatedBySourceId: reason,
        })
        .where(
          and(
            inArray(taskSessionInputDispositions.sourceRefId, refIds),
            eq(taskSessionInputDispositions.state, "active"),
          ),
        );
    }

    const correlationPredicate =
      selector.kind === "agents" || selector.kind === "suspended_agents"
        ? inArray(taskExecutionSessions.targetAgentId, [...selector.agentIds])
        : selector.kind === "budget_scope"
          ? selector.scopeType === "company"
            ? sql<boolean>`true`
            : selector.scopeType === "agent"
              ? eq(taskExecutionSessions.targetAgentId, selector.scopeId)
              : budgetTaskIds.length === 0
                ? sql<boolean>`false`
                : inArray(taskExecutionSessions.taskId, [...budgetTaskIds])
          : selector.kind === "ownership_epoch"
            ? and(
                eq(taskExecutionSessions.taskId, selector.taskId),
                eq(taskExecutionSessions.ownershipEpoch, selector.ownershipEpoch),
              )
            : undefined;
    const correlations =
      input.nativeContinuity === "preserve_carry" || selector.kind === "refs"
        ? []
        : await transaction
            .update(taskExecutionSessions)
            .set({
              state: "superseded",
              supersessionReason: reason,
              supersededAt: at,
            })
            .where(
              and(
                eq(taskExecutionSessions.companyId, input.companyId),
                eq(taskExecutionSessions.state, "eligible"),
                correlationPredicate,
              ),
            )
            .returning({ id: taskExecutionSessions.id });

    return Object.freeze({
      refIds: Object.freeze(refIds),
      correlationIds: Object.freeze(correlations.map((row) => row.id)),
    });
  }
  return {
    terminalizeDetachedCancelledRunInTransaction,
    fenceRevokedExecutionAuthorityInTransaction,
  };
}
