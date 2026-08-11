import {
  companies,
  issueExecutionHistoryViews,
  issueExecutionRefs,
  issueSessions,
  issues,
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
  IssueExecutionDispatcher,
  PersistedRefNotificationOutcome,
} from "./issue-execution-dispatcher.js";
import { createIssueSessionInputService } from "./issue-session/input.js";
import {
  classifyIssueExecutionRefDelivery,
  issueExecutionRefDeliveryEligibilitySql,
} from "./issue-execution-ref-delivery.js";
import { readOccupiedIssueExecutionRefIds } from "./issue-execution-run-service.js";

type RefRow = typeof issueExecutionRefs.$inferSelect;

export interface PostgresIssueSessionCompositionOptions {
  readonly workerId: string;
}

export interface PostgresIssueSessionCompositionReconciliation {
  readonly discovered: number;
  readonly prepared: number;
  readonly notified: number;
  readonly refIds: readonly string[];
}

export interface PostgresIssueSessionCompositionRuntime {
  prepareAndNotifyPersistedRef(
    refId: string,
    dispatcher: Pick<IssueExecutionDispatcher, "notifyPersistedRef">,
  ): Promise<PersistedRefNotificationOutcome>;
  reconcilePersistedRefs(
    dispatcher: Pick<IssueExecutionDispatcher, "notifyPersistedRef">,
    limit?: number,
  ): Promise<PostgresIssueSessionCompositionReconciliation>;
}

export class PostgresIssueSessionCompositionRejected extends Error {
  readonly code = "postgres_issue_session_composition_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresIssueSessionCompositionRejected";
  }
}

function exactIdentifier(value: string, label: string): void {
  if (!value || value !== value.trim()) {
    throw new PostgresIssueSessionCompositionRejected(
      `${label} must be exact and non-empty`,
    );
  }
}

function preparedScope(ref: RefRow) {
  return {
    companyId: ref.companyId,
    issueId: ref.issueId,
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
export function createPostgresIssueSessionCompositionRuntime(
  database: Db,
  options: PostgresIssueSessionCompositionOptions,
): PostgresIssueSessionCompositionRuntime {
  exactIdentifier(options.workerId, "composition worker id");
  const inputs = createIssueSessionInputService(database);

  async function loadRef(refId: string): Promise<RefRow> {
    exactIdentifier(refId, "execution ref id");
    const rows = await database
      .select()
      .from(issueExecutionRefs)
      .where(eq(issueExecutionRefs.id, refId))
      .limit(2);
    if (rows.length !== 1) {
      throw new PostgresIssueSessionCompositionRejected(
        "execution ref is missing or ambiguous",
      );
    }
    return rows[0]!;
  }

  async function prepareRef(ref: RefRow): Promise<boolean> {
    if (ref.disposition !== "active") {
      throw new PostgresIssueSessionCompositionRejected(
        "only an active execution ref can be prepared",
      );
    }
    const deliveryState = classifyIssueExecutionRefDelivery(ref);
    if (deliveryState === "invalid") {
      throw new PostgresIssueSessionCompositionRejected(
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
    dispatcher: Pick<IssueExecutionDispatcher, "notifyPersistedRef">,
  ): Promise<PersistedRefNotificationOutcome> {
    const ref = await loadRef(refId);
    await prepareRef(ref);
    return dispatcher.notifyPersistedRef(ref.id);
  }

  const runtime: PostgresIssueSessionCompositionRuntime = {
    prepareAndNotifyPersistedRef,

    async reconcilePersistedRefs(
      dispatcher: Pick<IssueExecutionDispatcher, "notifyPersistedRef">,
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
            ref: issueExecutionRefs,
            exactCreatedAt: sql<string>`${issueExecutionRefs.createdAt}::text`,
          })
          .from(issueExecutionRefs)
          .innerJoin(
            issueExecutionHistoryViews,
            eq(issueExecutionHistoryViews.id, issueExecutionRefs.historyViewId),
          )
          .innerJoin(
            issueSessions,
            eq(issueSessions.id, issueExecutionRefs.sessionId),
          )
          .innerJoin(issues, eq(issues.id, issueExecutionRefs.issueId))
          .innerJoin(companies, eq(companies.id, issueExecutionRefs.companyId))
          .where(
            and(
              eq(issueExecutionRefs.mode, "owner"),
              eq(issueExecutionRefs.disposition, "active"),
              issueExecutionRefDeliveryEligibilitySql("reconcile"),
              inArray(issueExecutionHistoryViews.state, ["empty", "current"]),
              eq(issueSessions.integrityState, "ready"),
              isNull(issueSessions.timeArchived),
              isNull(issueSessions.purgeFencedAt),
              eq(companies.status, "active"),
              eq(companies.sessionIntegrityState, "ready"),
              inArray(issues.lifecycleStatus, ["open", "blocked"]),
              cursor === null
                ? undefined
                : sql`(${issueExecutionRefs.createdAt}, ${issueExecutionRefs.id}) > (${cursor.exactCreatedAt}::timestamptz, ${cursor.id}::uuid)`,
            ),
          )
          .orderBy(asc(issueExecutionRefs.createdAt), asc(issueExecutionRefs.id))
          .limit(scanPageLimit);
        if (candidates.length === 0) break;
        const occupiedRefIds = new Set(
          await readOccupiedIssueExecutionRefIds(database, {
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
