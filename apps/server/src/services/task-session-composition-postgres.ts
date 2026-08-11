import {
  companies,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskSessions,
  tasks,
  type Db,
} from "@paperclipai/db";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import type {
  TaskExecutionDispatcher,
  PersistedRefNotificationOutcome,
} from "./task-execution-dispatcher.js";
import { createTaskSessionInputService } from "./task-session/input.js";
import {
  classifyTaskExecutionRefDelivery,
  taskExecutionRefDeliveryEligibilitySql,
} from "./task-execution-ref-delivery.js";
import { readOccupiedTaskExecutionRefIds } from "./task-execution-run-service.js";

type RefRow = typeof taskExecutionRefs.$inferSelect;

export interface PostgresTaskSessionCompositionOptions {
  readonly workerId: string;
}

export interface PostgresTaskSessionCompositionReconciliation {
  readonly discovered: number;
  readonly prepared: number;
  readonly notified: number;
  readonly refIds: readonly string[];
}

export interface PostgresTaskSessionCompositionRuntime {
  prepareAndNotifyPersistedRef(
    refId: string,
    dispatcher: Pick<TaskExecutionDispatcher, "notifyPersistedRef">,
  ): Promise<PersistedRefNotificationOutcome>;
  reconcilePersistedRefs(
    dispatcher: Pick<TaskExecutionDispatcher, "notifyPersistedRef">,
    limit?: number,
  ): Promise<PostgresTaskSessionCompositionReconciliation>;
}

export class PostgresTaskSessionCompositionRejected extends Error {
  readonly code = "postgres_task_session_composition_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresTaskSessionCompositionRejected";
  }
}

function exactIdentifier(value: string, label: string): void {
  if (!value || value !== value.trim()) {
    throw new PostgresTaskSessionCompositionRejected(
      `${label} must be exact and non-empty`,
    );
  }
}

function preparedScope(ref: RefRow) {
  return {
    companyId: ref.companyId,
    taskId: ref.taskId,
    sessionId: ref.sessionId,
    refId: ref.id,
    ownershipEpoch: ref.ownershipEpoch,
    executionLineageId: ref.executionLineageId,
    adapterConfigRevisionId: ref.adapterConfigRevisionId,
    historyViewId: ref.historyViewId,
    contextGeneration: ref.contextEpoch,
  } as const;
}

/**
 * Canonical post-commit composition boundary. It promotes only the immutable
 * Session input already bound to a persisted ref, then notifies the dispatcher
 * by ref identity. It never builds provider text or creates execution rows.
 */
export function createPostgresTaskSessionCompositionRuntime(
  database: Db,
  options: PostgresTaskSessionCompositionOptions,
): PostgresTaskSessionCompositionRuntime {
  exactIdentifier(options.workerId, "composition worker id");
  const inputs = createTaskSessionInputService(database);

  async function loadRef(refId: string): Promise<RefRow> {
    exactIdentifier(refId, "execution ref id");
    const rows = await database
      .select()
      .from(taskExecutionRefs)
      .where(eq(taskExecutionRefs.id, refId))
      .limit(2);
    if (rows.length !== 1) {
      throw new PostgresTaskSessionCompositionRejected(
        "execution ref is missing or ambiguous",
      );
    }
    return rows[0]!;
  }

  async function prepareRef(ref: RefRow): Promise<boolean> {
    if (ref.disposition !== "active") {
      throw new PostgresTaskSessionCompositionRejected(
        "only an active execution ref can be prepared",
      );
    }
    const deliveryState = classifyTaskExecutionRefDelivery(ref);
    if (deliveryState === "invalid") {
      throw new PostgresTaskSessionCompositionRejected(
        "execution ref has an invalid user/synthetic delivery shape",
      );
    }
    if (deliveryState === "synthetic_dispatchable") {
      return false;
    }
    return inputs.promotePreparedInput(preparedScope(ref));
  }

  async function prepareAndNotifyPersistedRef(
    refId: string,
    dispatcher: Pick<TaskExecutionDispatcher, "notifyPersistedRef">,
  ): Promise<PersistedRefNotificationOutcome> {
    const ref = await loadRef(refId);
    await prepareRef(ref);
    return dispatcher.notifyPersistedRef(ref.id);
  }

  const runtime: PostgresTaskSessionCompositionRuntime = {
    prepareAndNotifyPersistedRef,

    async reconcilePersistedRefs(
      dispatcher: Pick<TaskExecutionDispatcher, "notifyPersistedRef">,
      limit = 100,
    ) {
      const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const scanPageLimit = Math.max(100, boundedLimit);
      type ReconciliationCandidate = {
        readonly ref: RefRow;
        readonly exactCreatedAt: string;
      };
      const rows: ReconciliationCandidate[] = [];
      let cursor: {
        readonly exactCreatedAt: string;
        readonly id: string;
      } | null = null;
      while (rows.length < boundedLimit) {
        const candidates: ReconciliationCandidate[] = await database
          .select({
            ref: taskExecutionRefs,
            exactCreatedAt: sql<string>`${taskExecutionRefs.createdAt}::text`,
          })
          .from(taskExecutionRefs)
          .innerJoin(
            taskExecutionHistoryViews,
            eq(taskExecutionHistoryViews.id, taskExecutionRefs.historyViewId),
          )
          .innerJoin(
            taskSessions,
            eq(taskSessions.id, taskExecutionRefs.sessionId),
          )
          .innerJoin(tasks, eq(tasks.id, taskExecutionRefs.taskId))
          .innerJoin(companies, eq(companies.id, taskExecutionRefs.companyId))
          .where(
            and(
              eq(taskExecutionRefs.mode, "owner"),
              eq(taskExecutionRefs.disposition, "active"),
              taskExecutionRefDeliveryEligibilitySql("reconcile"),
              inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
              eq(taskSessions.integrityState, "ready"),
              isNull(taskSessions.timeArchived),
              isNull(taskSessions.purgeFencedAt),
              eq(companies.status, "active"),
              eq(companies.sessionIntegrityState, "ready"),
              inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              cursor === null
                ? undefined
                : sql`(${taskExecutionRefs.createdAt}, ${taskExecutionRefs.id}) > (${cursor.exactCreatedAt}::timestamptz, ${cursor.id}::uuid)`,
            ),
          )
          .orderBy(asc(taskExecutionRefs.createdAt), asc(taskExecutionRefs.id))
          .limit(scanPageLimit);
        if (candidates.length === 0) break;
        const occupiedRefIds = new Set(
          await readOccupiedTaskExecutionRefIds(database, {
            refIds: candidates.map(({ ref }) => ref.id),
          }),
        );
        for (const candidate of candidates) {
          if (!occupiedRefIds.has(candidate.ref.id)) {
            rows.push(candidate);
            if (rows.length === boundedLimit) break;
          }
        }
        const last = candidates[candidates.length - 1]!;
        cursor = { exactCreatedAt: last.exactCreatedAt, id: last.ref.id };
        if (candidates.length < scanPageLimit) break;
      }
      const notified: string[] = [];
      let prepared = 0;
      for (const { ref } of rows) {
        if (await prepareRef(ref)) prepared += 1;
        await dispatcher.notifyPersistedRef(ref.id);
        notified.push(ref.id);
      }
      return Object.freeze({
        discovered: rows.length,
        prepared,
        notified: notified.length,
        refIds: Object.freeze(notified),
      });
    },
  };
  return Object.freeze(runtime);
}
