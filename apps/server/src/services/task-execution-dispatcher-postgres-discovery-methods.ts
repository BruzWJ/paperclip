import {
  companies,
  taskConsultExecutions,
  taskExecutionAttempts,
  taskExecutionHistoryViews,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunRefs,
  taskSessions,
  tasks,
} from "@paperclipai/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  publishAgentRunTerminalEvent,
  type AgentRunTerminalPluginEventInput,
} from "./agent-run-plugin-events.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup1 } from "./task-execution-dispatcher-postgres-group-1.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup2 } from "./task-execution-dispatcher-postgres-group-2.js";
import {
  type PostgresTaskExecutionDispatcherRepositoryOptions,
  exactIdentifier,
  reject,
  targetLaneIdentity,
  validDate,
} from "./task-execution-dispatcher-postgres-part-1.js";
import { terminalExecutionRefSql } from "./task-execution-terminal-eligibility.js";
import { consultSourceRunIsFinalized } from "./task-execution-dispatcher-postgres-part-3.js";
import { findExistingRunForLane } from "./task-execution-dispatcher-postgres-part-4.js";
import type { TaskExecutionTargetLaneIdentity } from "./task-execution-dispatcher.js";
import { activeTaskTreePauseHoldExistsSql } from "./task-execution-lifecycle-gate.js";
import { taskExecutionRefDeliveryEligibilitySql } from "./task-execution-ref-delivery.js";
import {
  readActiveTaskExecutionRefRunAvailability,
  terminalFinalizedTaskExecutionRunExistsSql,
} from "./task-execution-run-service-part-3-section-1.js";
import { readBlockedActiveTaskExecutionRefIds } from "./task-execution-run-service-part-4-section-1.js";

export function createTaskExecutionDispatcherDiscoveryMethods(
  options: PostgresTaskExecutionDispatcherRepositoryOptions,
  context: Pick<
    ReturnType<typeof createPostgresTaskExecutionDispatcherRepositoryGroup1>,
    "terminalEventForExpiredRun" | "recoverExpiredRunInTransaction"
  > &
    Pick<ReturnType<typeof createPostgresTaskExecutionDispatcherRepositoryGroup2>, "leaseForLane">,
) {
  const { terminalEventForExpiredRun, recoverExpiredRunInTransaction, leaseForLane } = context;
  return {
    async recoverExpiredLeases(input: { now: Date; limit: number }) {
      const at = validDate(input.now, "expired lease recovery time");
      const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit)));
      const candidates = await options.database
        .select({
          leaseId: taskExecutionLeases.id,
          runId: taskExecutionLeases.runId,
          ref: taskExecutionRefs,
        })
        .from(taskExecutionLeases)
        .innerJoin(taskExecutionAttempts, eq(taskExecutionAttempts.id, taskExecutionLeases.attemptId))
        .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskExecutionAttempts.refId))
        .where(
          and(
            eq(taskExecutionLeases.state, "active"),
            lte(taskExecutionLeases.expiresAt, at),
            eq(taskExecutionAttempts.state, "running"),
            inArray(taskExecutionAttempts.runKind, ["productive", "consult"]),
          ),
        )
        .orderBy(
          sql`case when ${taskExecutionAttempts.runKind} = 'productive' then 0 else 1 end`,
          asc(taskExecutionLeases.expiresAt),
          asc(taskExecutionLeases.id),
        )
        .limit(limit);
      const refIds: string[] = [];
      for (const candidate of candidates) {
        let recoveredTerminalEvent: AgentRunTerminalPluginEventInput | null = null;
        const recovered = await options.database.transaction(async (transaction) => {
          const run = await findExistingRunForLane(transaction, targetLaneIdentity(candidate.ref));
          if (!run || run.runId !== candidate.runId || run.currentLeaseId !== candidate.leaseId) return null;
          const result = await recoverExpiredRunInTransaction(transaction, run, at);
          recoveredTerminalEvent = terminalEventForExpiredRun(run, result, at);
          if (result.kind === "current") return null;
          const next = await transaction
            .select()
            .from(taskExecutionRefs)
            .where(
              and(
                eq(taskExecutionRefs.companyId, candidate.ref.companyId),
                eq(taskExecutionRefs.taskId, candidate.ref.taskId),
                eq(taskExecutionRefs.ownershipEpoch, candidate.ref.ownershipEpoch),
                eq(taskExecutionRefs.targetAgentId, candidate.ref.targetAgentId),
                eq(taskExecutionRefs.disposition, "active"),
              ),
            )
            .orderBy(asc(taskExecutionRefs.laneOrdinal), asc(taskExecutionRefs.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          return next && (await consultSourceRunIsFinalized(transaction, next)) ? next.id : null;
        });
        if (recoveredTerminalEvent) {
          await publishAgentRunTerminalEvent(options.pluginDomainEvents, recoveredTerminalEvent);
        }
        if (recovered) refIds.push(recovered);
      }
      return { refIds: [...new Set(refIds)] };
    },
    async listDispatchableRefIds(input: { now: Date; limit: number }) {
      validDate(input.now, "dispatch discovery time");
      const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit)));
      const blockedRefIds = await readBlockedActiveTaskExecutionRefIds(options.database, { now: input.now });
      const rows = await options.database
        .select({ id: taskExecutionRefs.id })
        .from(taskExecutionRefs)
        .innerJoin(
          taskExecutionHistoryViews,
          eq(taskExecutionHistoryViews.id, taskExecutionRefs.historyViewId),
        )
        .innerJoin(taskSessions, eq(taskSessions.id, taskExecutionRefs.sessionId))
        .innerJoin(tasks, eq(tasks.id, taskExecutionRefs.taskId))
        .innerJoin(companies, eq(companies.id, taskExecutionRefs.companyId))
        .where(
          and(
            eq(taskExecutionRefs.disposition, "active"),
            taskExecutionRefDeliveryEligibilitySql("dispatch"),
            inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
            eq(taskSessions.integrityState, "ready"),
            isNotNull(taskSessions.refAdmittableAt),
            isNull(taskSessions.timeArchived),
            isNull(taskSessions.purgeFencedAt),
            eq(companies.status, "active"),
            eq(companies.sessionIntegrityState, "ready"),
            or(
              inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              terminalExecutionRefSql(),
            ),
            sql`${tasks.ownershipEpoch} = ${taskExecutionRefs.ownershipEpoch}`,
            or(
              and(
                eq(taskExecutionRefs.mode, "owner"),
                eq(tasks.ownerKind, "agent"),
                sql`${tasks.ownerAgentId} = ${taskExecutionRefs.targetAgentId}`,
                isNotNull(taskExecutionRefs.taskExecutionAuthorityId),
              ),
              and(
                eq(taskExecutionRefs.mode, "consult"),
                isNull(taskExecutionRefs.taskExecutionAuthorityId),
                isNotNull(taskExecutionRefs.consultExecutionId),
                sql`exists (
                  select 1
                  from ${taskConsultExecutions}
                  where ${taskConsultExecutions.id} = ${taskExecutionRefs.consultExecutionId}
                    and ${taskConsultExecutions.companyId} = ${taskExecutionRefs.companyId}
                    and ${taskConsultExecutions.taskId} = ${taskExecutionRefs.taskId}
                    and ${taskConsultExecutions.state} = 'active'
                    and ${terminalFinalizedTaskExecutionRunExistsSql(taskConsultExecutions.companyId, taskConsultExecutions.taskId, taskConsultExecutions.sourceRunId)}
                )`,
              ),
            ),
            sql`not exists (
              select 1 from company_session_lifecycle_operations lifecycle
              where lifecycle.company_id = ${taskExecutionRefs.companyId}
                and lifecycle.status in ('fenced','cancelling','purge_ready')
            )`,
            sql`not (${activeTaskTreePauseHoldExistsSql(taskExecutionRefs.companyId, taskExecutionRefs.taskId)})`,
            blockedRefIds.length === 0 ? undefined : notInArray(taskExecutionRefs.id, [...blockedRefIds]),
          ),
        )
        .orderBy(asc(taskExecutionRefs.createdAt), asc(taskExecutionRefs.id))
        .limit(limit);
      return rows.map((row) => row.id);
    },
    async resolveLaneForPersistedRef(refId: string) {
      exactIdentifier(refId, "execution ref id");
      const ref = await options.database
        .select({
          companyId: taskExecutionRefs.companyId,
          taskId: taskExecutionRefs.taskId,
          sessionId: taskExecutionRefs.sessionId,
          ownershipEpoch: taskExecutionRefs.ownershipEpoch,
          targetAgentId: taskExecutionRefs.targetAgentId,
          mode: taskExecutionRefs.mode,
          disposition: taskExecutionRefs.disposition,
        })
        .from(taskExecutionRefs)
        .where(eq(taskExecutionRefs.id, refId))
        .limit(2);
      if (ref.length > 1) reject("execution ref identity is ambiguous");
      if (!ref[0]) return null;
      const active = await readActiveTaskExecutionRefRunAvailability(options.database, { refId });
      const settled =
        active === null
          ? await options.database
              .select({ outcome: taskExecutionRunRefs.outcome })
              .from(taskExecutionRunRefs)
              .where(
                and(
                  eq(taskExecutionRunRefs.refId, refId),
                  isNotNull(taskExecutionRunRefs.protocolSettlementState),
                ),
              )
              .orderBy(desc(taskExecutionRunRefs.settledAt))
              .limit(1)
          : [];
      const leaseState = active
        ? active.run.status === "scheduled_retry"
          ? ("retryable" as const)
          : active.run.currentLeaseId
            ? ("leased" as const)
            : ("available" as const)
        : settled[0]
          ? settled[0].outcome === "succeeded"
            ? ("completed" as const)
            : ("failed" as const)
          : ("available" as const);
      return {
        lane: targetLaneIdentity(ref[0]),
        mode: ref[0].mode,
        disposition: ref[0].disposition,
        leaseState,
        leaseExpiresAt: active?.leaseExpiresAt ?? active?.retryAt ?? null,
      };
    },
    async leaseNextRef(input: { lane: TaskExecutionTargetLaneIdentity; workerId: string; now: Date }) {
      const result = await leaseForLane({
        lane: input.lane,
        workerId: input.workerId,
        at: validDate(input.now, "lease time"),
      });
      return result.kind === "leased" ? result.lease : null;
    },
  };
}
