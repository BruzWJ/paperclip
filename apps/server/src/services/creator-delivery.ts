import {
  agents,
  companies,
  creatorDeliveries,
  issueExecutionAttempts,
  issueExecutionAuthorities,
  issueExecutionHistoryViews,
  issueExecutionLeases,
  issueExecutionRefs,
  issueExecutionRunRefs,
  issueSessionContextEpochs,
  issueSessions,
  issueUpdates,
  issues,
  pluginCreatorDeliveries,
  plugins,
  routineRuns,
  routines,
  type Db,
} from "@paperclipai/db";
import {
  isIssueCreatorEdgeTerminalReason,
  type IssueCreatorEdgeTerminalReason,
} from "@paperclipai/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  createIssueSessionAdmissionService,
  type IssueSessionExecutionActor,
  type IssueSessionProjectedCommentSource,
} from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { finalizeSummarySlotsForTerminalIssue } from "./summary-slot-finalization.js";
import type {
  TerminalizeCreatorDeliveryInput,
} from "./system-escalation-postgres.js";
import { readIssueExecutionRun } from "./issue-execution-run-service.js";

type DeliveryRow = typeof creatorDeliveries.$inferSelect;
type PluginDeliveryRow = typeof pluginCreatorDeliveries.$inferSelect;
type PluginCreatorCallbackAcknowledgement = {
  deliveryId: string;
  accepted: true;
};

interface LeasedDelivery {
  row: DeliveryRow;
  leaseGeneration: number;
}

interface CreatorDeliveryBatch {
  counterpartExecutionKey: string;
  deliveries: LeasedDelivery[];
}

type AgentExecutionRecipient = {
  authority:
    | typeof issueExecutionAuthorities.$inferSelect
    | null;
  agent: typeof agents.$inferSelect | null;
};

export type CreatorDeliveryRefNotificationOutcome =
  | "notified"
  | "already_scheduled"
  | "running"
  | "preparing"
  | "settled";

export interface PostgresCreatorDeliveryOptions {
  workerId: string;
  pluginWorkerManager: PluginWorkerManager;
  notifyRef(
    refId: string,
  ): Promise<CreatorDeliveryRefNotificationOutcome>;
  terminalizeCreatorDelivery(
    input: TerminalizeCreatorDeliveryInput,
  ): Promise<unknown>;
  clock?: () => Date;
  leaseDurationMs?: number;
  maxBatchSize?: number;
  pluginTimeoutMs?: number;
}

class PermanentCreatorDeliveryError extends Error {
  constructor(
    readonly reason: IssueCreatorEdgeTerminalReason,
    message: string,
  ) {
    super(message);
    this.name = "PermanentCreatorDeliveryError";
  }
}

function stringField(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Creator delivery recipient is missing ${field}`);
  }
  return value;
}

function executionActorForCreatorUpdate(
  update: typeof issueUpdates.$inferSelect,
): IssueSessionExecutionActor {
  const identity = update.sourceIdentity;
  switch (update.sourceKind) {
    case "agent-execution":
      return {
        kind: "agent-execution",
        agentId: stringField(identity.agentId, "sourceIdentity.agentId"),
        authorityId: stringField(
          update.sourceAuthorityId,
          "sourceAuthorityId",
        ),
      };
    case "user/board":
      return {
        kind: "user/board",
        userId: stringField(identity.userId, "sourceIdentity.userId"),
      };
    case "plugin":
      return {
        kind: "plugin",
        pluginInstallationId: stringField(
          identity.pluginInstallationId,
          "sourceIdentity.pluginInstallationId",
        ),
        pluginKey: stringField(
          identity.pluginKey,
          "sourceIdentity.pluginKey",
        ),
      };
    case "routine":
      return {
        kind: "routine",
        routineId: stringField(
          identity.routineId,
          "sourceIdentity.routineId",
        ),
        routineDispatchId: stringField(
          identity.routineDispatchId,
          "sourceIdentity.routineDispatchId",
        ),
      };
    case "system":
      return {
        kind: "system",
        sourceKind: stringField(
          identity.sourceKind,
          "sourceIdentity.sourceKind",
        ),
        sourceId: stringField(
          identity.sourceId,
          "sourceIdentity.sourceId",
        ),
      };
  }
}

function projectedCommentForCreatorUpdate(
  actor: IssueSessionExecutionActor,
): IssueSessionProjectedCommentSource | null {
  return actor.kind === "user/board"
    ? {
        author: { kind: "user", userId: actor.userId },
        producingRun: null,
      }
    : null;
}

function executionSourceForCreatorDelivery(
  update: typeof issueUpdates.$inferSelect,
):
  | {
      sourceKind: "creator_update";
      actor: IssueSessionExecutionActor;
    }
  | {
      sourceKind: "termination_recovery";
      actor: Extract<IssueSessionExecutionActor, { kind: "system" }>;
    } {
  const actor = executionActorForCreatorUpdate(update);
  return actor.kind === "system" && actor.sourceKind === "agent_termination"
    ? { sourceKind: "termination_recovery", actor }
    : { sourceKind: "creator_update", actor };
}

function retryDelay(row: DeliveryRow): number {
  const exponent = Math.max(0, row.attemptCount - 1);
  return Math.min(
    row.policySnapshot.retryMaxDelayMs,
    row.policySnapshot.retryBaseDelayMs * 2 ** exponent,
  );
}

function eligibleAt(row: DeliveryRow, now: Date): boolean {
  if (row.heldSince) return false;
  if (row.state === "pending") return true;
  if (row.state === "retryable") {
    return !row.retryAt || row.retryAt <= now;
  }
  return (
    row.state === "leased" &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt <= now
  );
}

function leaseExpiry(now: Date, durationMs: number): Date {
  return new Date(now.getTime() + durationMs);
}

function deliveryCas(
  leased: LeasedDelivery,
) {
  return and(
    eq(creatorDeliveries.id, leased.row.id),
    eq(creatorDeliveries.state, "leased"),
    eq(creatorDeliveries.leaseGeneration, leased.leaseGeneration),
  );
}

async function loadPluginDelivery(
  tx: IssueSessionDbTransaction,
  parentId: string,
): Promise<PluginDeliveryRow | null> {
  return tx
    .select()
    .from(pluginCreatorDeliveries)
    .where(eq(pluginCreatorDeliveries.creatorDeliveryId, parentId))
    .for("update")
    .then((rows) => rows[0] ?? null);
}

export function createPostgresCreatorDeliveryService(
  db: Db,
  options: PostgresCreatorDeliveryOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const maxBatchSize = options.maxBatchSize ?? 20;
  const pluginTimeoutMs = options.pluginTimeoutMs ?? 30_000;
  const sessions = createIssueSessionAdmissionService(db, { clock });

  async function loadAgentExecutionRecipient(
    delivery: DeliveryRow,
  ): Promise<AgentExecutionRecipient> {
    const authorityId = stringField(
      delivery.recipientRef.authorityId,
      "authorityId",
    );
    const authority = await db
      .select()
      .from(issueExecutionAuthorities)
      .where(
        and(
          eq(issueExecutionAuthorities.companyId, delivery.companyId),
          eq(issueExecutionAuthorities.id, authorityId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!authority) return { authority: null, agent: null };
    const agent = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, delivery.companyId),
          eq(agents.id, authority.agentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return { authority, agent };
  }

  async function claimNextBatch(
    targetDeliveryId?: string,
  ): Promise<CreatorDeliveryBatch | null> {
    const now = clock();
    return db.transaction(async (tx) => {
      const target = targetDeliveryId
        ? await tx
            .select({
              id: creatorDeliveries.id,
              companyId: creatorDeliveries.companyId,
              counterpartExecutionKey:
                creatorDeliveries.counterpartExecutionKey,
              committedSequence: creatorDeliveries.committedSequence,
              state: creatorDeliveries.state,
            })
            .from(creatorDeliveries)
            .where(eq(creatorDeliveries.id, targetDeliveryId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;
      if (
        targetDeliveryId &&
        (!target ||
          !["pending", "leased", "retryable"].includes(target.state))
      ) {
        return null;
      }
      const candidate = await tx
        .select({
          delivery: creatorDeliveries,
          pluginInstallationId:
            pluginCreatorDeliveries.pluginInstallationId,
        })
        .from(creatorDeliveries)
        .leftJoin(
          pluginCreatorDeliveries,
          eq(
            pluginCreatorDeliveries.creatorDeliveryId,
            creatorDeliveries.id,
          ),
        )
        .innerJoin(
          companies,
          eq(companies.id, creatorDeliveries.companyId),
        )
        .innerJoin(
          issues,
          and(
            eq(issues.companyId, creatorDeliveries.companyId),
            eq(issues.id, creatorDeliveries.issueId),
          ),
        )
        .innerJoin(
          issueSessions,
          and(
            eq(issueSessions.companyId, creatorDeliveries.companyId),
            eq(issueSessions.issueId, creatorDeliveries.issueId),
            eq(issueSessions.id, creatorDeliveries.sessionId),
          ),
        )
        .where(
          and(
            eq(companies.status, "active"),
            eq(issues.ownershipEpoch, creatorDeliveries.ownershipEpoch),
            eq(issueSessions.integrityState, "ready"),
            isNull(issueSessions.timeArchived),
            isNull(issueSessions.purgeFencedAt),
            isNull(creatorDeliveries.heldSince),
            ...(target
              ? [
                  eq(creatorDeliveries.companyId, target.companyId),
                  eq(
                    creatorDeliveries.counterpartExecutionKey,
                    target.counterpartExecutionKey,
                  ),
                  lte(
                    creatorDeliveries.committedSequence,
                    target.committedSequence,
                  ),
                ]
              : []),
            or(
              eq(creatorDeliveries.state, "pending"),
              and(
                eq(creatorDeliveries.state, "retryable"),
                or(
                  isNull(creatorDeliveries.retryAt),
                  lte(creatorDeliveries.retryAt, now),
                ),
              ),
              and(
                eq(creatorDeliveries.state, "leased"),
                lte(creatorDeliveries.leaseExpiresAt, now),
              ),
            ),
            sql`not exists (
              select 1
              from creator_deliveries as earlier
              where earlier.company_id = ${creatorDeliveries.companyId}
                and earlier.counterpart_execution_key = ${creatorDeliveries.counterpartExecutionKey}
                and earlier.committed_sequence < ${creatorDeliveries.committedSequence}
                and earlier.state in ('pending', 'leased', 'retryable')
            )`,
          ),
        )
        .orderBy(
          asc(creatorDeliveries.firstQueuedAt),
          asc(creatorDeliveries.committedSequence),
          asc(creatorDeliveries.id),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!candidate) return null;

      // Plugin lifecycle transactions lock installation → managed bindings →
      // creator delivery. Claims use the same installation-first order so
      // uninstall/disable cannot deadlock against a delivery lease.
      if (candidate.delivery.recipientKind === "plugin") {
        if (!candidate.pluginInstallationId) return null;
        const installation = await tx
          .select({ status: plugins.status })
          .from(plugins)
          .where(eq(plugins.id, candidate.pluginInstallationId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!installation || installation.status !== "ready") {
          return null;
        }
      }

      const first = await tx
        .select({ delivery: creatorDeliveries })
        .from(creatorDeliveries)
        .innerJoin(
          companies,
          eq(companies.id, creatorDeliveries.companyId),
        )
        .innerJoin(
          issues,
          and(
            eq(issues.companyId, creatorDeliveries.companyId),
            eq(issues.id, creatorDeliveries.issueId),
          ),
        )
        .innerJoin(
          issueSessions,
          and(
            eq(issueSessions.companyId, creatorDeliveries.companyId),
            eq(issueSessions.issueId, creatorDeliveries.issueId),
            eq(issueSessions.id, creatorDeliveries.sessionId),
          ),
        )
        .where(
          and(
            eq(creatorDeliveries.id, candidate.delivery.id),
            eq(companies.status, "active"),
            eq(issues.ownershipEpoch, creatorDeliveries.ownershipEpoch),
            eq(issueSessions.integrityState, "ready"),
            isNull(issueSessions.timeArchived),
            isNull(issueSessions.purgeFencedAt),
            isNull(creatorDeliveries.heldSince),
            or(
              eq(creatorDeliveries.state, "pending"),
              and(
                eq(creatorDeliveries.state, "retryable"),
                or(
                  isNull(creatorDeliveries.retryAt),
                  lte(creatorDeliveries.retryAt, now),
                ),
              ),
              and(
                eq(creatorDeliveries.state, "leased"),
                lte(creatorDeliveries.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .for("update", {
          of: creatorDeliveries,
          skipLocked: true,
        })
        .then((rows) => rows[0]?.delivery ?? null);
      if (!first) return null;

      const ordered = await tx
        .select()
        .from(creatorDeliveries)
        .where(
          and(
            eq(creatorDeliveries.companyId, first.companyId),
            eq(
              creatorDeliveries.counterpartExecutionKey,
              first.counterpartExecutionKey,
            ),
            sql`${creatorDeliveries.committedSequence} >= ${first.committedSequence}`,
            inArray(creatorDeliveries.state, [
              "pending",
              "leased",
              "retryable",
            ]),
            ...(target
              ? [
                  lte(
                    creatorDeliveries.committedSequence,
                    target.committedSequence,
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          asc(creatorDeliveries.committedSequence),
          asc(creatorDeliveries.id),
        )
        .limit(
          first.recipientKind === "agent-execution" &&
            first.direction === "to_creator"
            ? maxBatchSize
            : 1,
        )
        .for("update", {
          of: creatorDeliveries,
          skipLocked: true,
        });

      const creatorAgentBatch =
        first.recipientKind === "agent-execution" &&
        first.direction === "to_creator";
      const counterpartRefIds = ordered.flatMap((row) =>
        row.counterpartRefId ? [row.counterpartRefId] : [],
      );
      const counterpartRefs =
        creatorAgentBatch && counterpartRefIds.length > 0
          ? await tx
              .select({
                id: issueExecutionRefs.id,
                executionScopeId:
                  issueExecutionRefs.executionScopeId,
                executionLineageId:
                  issueExecutionRefs.executionLineageId,
              })
              .from(issueExecutionRefs)
              .where(
                inArray(
                  issueExecutionRefs.id,
                  counterpartRefIds,
                ),
              )
          : [];
      const counterpartRefById = new Map(
        counterpartRefs.map((ref) => [ref.id, ref]),
      );
      const admittedGroup = first.counterpartRefId
        ? counterpartRefById.get(first.counterpartRefId)
        : null;
      if (
        creatorAgentBatch &&
        first.counterpartRefId &&
        !admittedGroup
      ) {
        throw new Error(
          "Creator delivery lost its admitted counterpart ref",
        );
      }

      const selected: DeliveryRow[] = [];
      for (const row of ordered) {
        if (creatorAgentBatch) {
          if (!admittedGroup) {
            if (row.counterpartRefId) break;
          } else {
            const rowRef = row.counterpartRefId
              ? counterpartRefById.get(row.counterpartRefId)
              : null;
            if (
              !rowRef ||
              rowRef.executionScopeId !==
                admittedGroup.executionScopeId ||
              rowRef.executionLineageId !==
                admittedGroup.executionLineageId
            ) {
              break;
            }
            if (!eligibleAt(row, now)) {
              // An admitted creator batch retries as one execution unit. A
              // member may not advance ahead of its original siblings.
              return null;
            }
          }
        }
        if (!eligibleAt(row, now)) break;
        selected.push(row);
      }
      if (selected.length === 0) return null;

      const leased: LeasedDelivery[] = [];
      for (const row of selected) {
        const nextGeneration = row.leaseGeneration + 1;
        const next = await tx
          .update(creatorDeliveries)
          .set({
            state: "leased",
            leaseOwner: options.workerId,
            leaseGeneration: nextGeneration,
            firstLeasedAt: row.firstLeasedAt ?? now,
            leasedAt: now,
            leaseExpiresAt: leaseExpiry(now, leaseDurationMs),
            retryAt: null,
            lastFailure: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(creatorDeliveries.id, row.id),
              eq(
                creatorDeliveries.leaseGeneration,
                row.leaseGeneration,
              ),
              inArray(creatorDeliveries.state, [
                "pending",
                "leased",
                "retryable",
              ]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!next) {
          throw new Error(
            `Creator delivery lease changed while claiming ${row.id}`,
          );
        }
        const plugin = await loadPluginDelivery(tx, row.id);
        if (plugin) {
          const pluginLeased = await tx
            .update(pluginCreatorDeliveries)
            .set({
              state: "leased",
              leaseOwner: options.workerId,
              leaseGeneration: nextGeneration,
              firstLeasedAt: plugin.firstLeasedAt ?? now,
              leasedAt: now,
              leaseExpiresAt: leaseExpiry(now, leaseDurationMs),
              retryAt: null,
              lastFailure: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(pluginCreatorDeliveries.id, plugin.id),
                eq(
                  pluginCreatorDeliveries.leaseGeneration,
                  plugin.leaseGeneration,
                ),
                inArray(pluginCreatorDeliveries.state, [
                  "pending",
                  "leased",
                  "retryable",
                ]),
              ),
            )
            .returning({ id: pluginCreatorDeliveries.id });
          if (!pluginLeased[0]) {
            throw new Error(
              `Plugin creator delivery lease changed while claiming ${plugin.id}`,
            );
          }
        }
        leased.push({ row: next, leaseGeneration: nextGeneration });
      }
      return {
        counterpartExecutionKey: first.counterpartExecutionKey,
        deliveries: leased,
      };
    });
  }

  async function beginAttempt(
    batch: CreatorDeliveryBatch,
  ): Promise<CreatorDeliveryBatch> {
    const now = clock();
    return db.transaction(async (tx) => {
      const attempted: LeasedDelivery[] = [];
      for (const leased of batch.deliveries) {
        const row = await tx
          .update(creatorDeliveries)
          .set({
            firstAttemptAt:
              leased.row.firstAttemptAt ?? now,
            attemptCount:
              sql`${creatorDeliveries.attemptCount} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              deliveryCas(leased),
              eq(creatorDeliveries.leaseOwner, options.workerId),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) {
          throw new Error(
            `Creator delivery lease was lost before attempt ${leased.row.id}`,
          );
        }
        const plugin = await loadPluginDelivery(tx, row.id);
        if (plugin) {
          const attemptedPlugin = await tx
            .update(pluginCreatorDeliveries)
            .set({
              firstAttemptAt: plugin.firstAttemptAt ?? now,
              attemptCount:
                sql`${pluginCreatorDeliveries.attemptCount} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(pluginCreatorDeliveries.id, plugin.id),
                eq(pluginCreatorDeliveries.state, "leased"),
                eq(
                  pluginCreatorDeliveries.leaseOwner,
                  options.workerId,
                ),
                eq(
                  pluginCreatorDeliveries.leaseGeneration,
                  leased.leaseGeneration,
                ),
              ),
            )
            .returning({ id: pluginCreatorDeliveries.id });
          if (!attemptedPlugin[0]) {
            throw new Error(
              `Plugin creator delivery lease was lost before attempt ${plugin.id}`,
            );
          }
        }
        attempted.push({
          row,
          leaseGeneration: leased.leaseGeneration,
        });
      }
      return { ...batch, deliveries: attempted };
    });
  }

  async function releaseForTransientAvailability(
    batch: CreatorDeliveryBatch,
    reason: string,
  ): Promise<void> {
    const now = clock();
    await db.transaction(async (tx) => {
      for (const leased of batch.deliveries) {
        const retryAt = new Date(
          now.getTime() +
            leased.row.policySnapshot.retryBaseDelayMs,
        );
        await tx
          .update(creatorDeliveries)
          .set({
            state: "retryable",
            retryAt,
            lastFailure: reason,
            leaseOwner: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              deliveryCas(leased),
              eq(creatorDeliveries.leaseOwner, options.workerId),
            ),
          );
        await tx
          .update(pluginCreatorDeliveries)
          .set({
            state: "retryable",
            retryAt,
            lastFailure: reason,
            leaseOwner: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(
                pluginCreatorDeliveries.creatorDeliveryId,
                leased.row.id,
              ),
              eq(
                pluginCreatorDeliveries.leaseGeneration,
                leased.leaseGeneration,
              ),
            ),
          );
      }
    });
  }

  async function holdAgentBatch(
    batch: CreatorDeliveryBatch,
    reason: "paused" | "budget_stopped",
  ): Promise<void> {
    const now = clock();
    await db.transaction(async (tx) => {
      for (const leased of batch.deliveries) {
        await tx
          .update(creatorDeliveries)
          .set({
            state: "retryable",
            heldSince: leased.row.heldSince ?? now,
            holdReason: reason,
            retryAt: null,
            lastFailure: `continuous_${reason}_hold`,
            leaseOwner: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              deliveryCas(leased),
              eq(creatorDeliveries.leaseOwner, options.workerId),
            ),
          );
      }
    });
  }

  async function agentAvailability(
    batch: CreatorDeliveryBatch,
  ): Promise<
    | "ready"
    | "transient"
    | "held"
    | { permanent: IssueCreatorEdgeTerminalReason }
  > {
    const first = batch.deliveries[0]!.row;
    if (first.recipientKind !== "agent-execution") return "ready";
    const { authority, agent } =
      await loadAgentExecutionRecipient(first);
    if (!authority || authority.state !== "current") {
      return { permanent: "creator_execution_superseded" };
    }
    if (!agent) return { permanent: "agent_deleted" };
    if (agent.status === "terminated") {
      return { permanent: "agent_terminated" };
    }
    const invokability =
      await evaluateAgentInvokabilityFromDb(db, agent);
    if (invokability.invokable) return "ready";
    if (invokability.reason === "paused") return "held";
    return "transient";
  }

  async function admitCreatorCounterpartRefs(
    batch: CreatorDeliveryBatch,
  ): Promise<string[]> {
    return db.transaction(async (tx) => {
      const locked: DeliveryRow[] = [];
      for (const leased of batch.deliveries) {
        const delivery = await tx
          .select()
          .from(creatorDeliveries)
          .where(deliveryCas(leased))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!delivery) {
          throw new Error(
            `Creator delivery lease was lost before admission ${leased.row.id}`,
          );
        }
        if (
          delivery.direction !== "to_creator" ||
          delivery.recipientKind !== "agent-execution" ||
          delivery.counterpartExecutionKey !==
            batch.counterpartExecutionKey
        ) {
          throw new Error(
            "Creator counterpart batch crossed its immutable delivery route",
          );
        }
        locked.push(delivery);
      }

      const existingRefIds = locked.flatMap((delivery) =>
        delivery.counterpartRefId ? [delivery.counterpartRefId] : [],
      );
      if (existingRefIds.length > 0) {
        if (existingRefIds.length !== locked.length) {
          throw new Error(
            "Creator counterpart batch was only partially admitted",
          );
        }
        const persisted = await tx
          .select({
            id: issueExecutionRefs.id,
            executionScopeId: issueExecutionRefs.executionScopeId,
            executionLineageId:
              issueExecutionRefs.executionLineageId,
            sourceRecordId: issueExecutionRefs.sourceRecordId,
          })
          .from(issueExecutionRefs)
          .where(inArray(issueExecutionRefs.id, existingRefIds));
        const byId = new Map(
          persisted.map((ref) => [ref.id, ref]),
        );
        const firstRef = byId.get(existingRefIds[0]!);
        if (
          !firstRef ||
          locked.some((delivery) => {
            const ref = byId.get(delivery.counterpartRefId!);
            return (
              !ref ||
              ref.executionScopeId !== firstRef.executionScopeId ||
              ref.executionLineageId !==
                firstRef.executionLineageId ||
              ref.sourceRecordId !== delivery.id
            );
          })
        ) {
          throw new Error(
            "Creator counterpart batch lost its stable execution grouping",
          );
        }
        return existingRefIds;
      }

      const first = locked[0];
      if (!first) return [];
      const authorityId = stringField(
        first.recipientRef.authorityId,
        "authorityId",
      );
      if (
        locked.some(
          (delivery) =>
            stringField(
              delivery.recipientRef.authorityId,
              "authorityId",
            ) !== authorityId,
        )
      ) {
        throw new Error(
          "Creator counterpart batch crossed execution authorities",
        );
      }
      const authority = await tx
        .select()
        .from(issueExecutionAuthorities)
        .where(
          and(
            eq(
              issueExecutionAuthorities.companyId,
              first.companyId,
            ),
            eq(issueExecutionAuthorities.id, authorityId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!authority || authority.state !== "current") {
        throw new PermanentCreatorDeliveryError(
          "creator_execution_superseded",
          "Creator execution authority is no longer current",
        );
      }
      const [sessionState, updates] = await Promise.all([
        tx
          .select({
            session: issueSessions,
            contextGeneration: issueSessionContextEpochs.generation,
          })
          .from(issueSessions)
          .innerJoin(
            issueSessionContextEpochs,
            and(
              eq(
                issueSessionContextEpochs.companyId,
                issueSessions.companyId,
              ),
              eq(
                issueSessionContextEpochs.issueId,
                issueSessions.issueId,
              ),
              eq(
                issueSessionContextEpochs.sessionId,
                issueSessions.id,
              ),
            ),
          )
          .where(
            and(
              eq(issueSessions.companyId, authority.companyId),
              eq(issueSessions.issueId, authority.issueId),
              eq(issueSessions.id, authority.sessionId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null),
        tx
          .select()
          .from(issueUpdates)
          .where(
            inArray(
              issueUpdates.id,
              locked.map((delivery) => delivery.issueUpdateId),
            ),
          ),
      ]);
      if (
        !sessionState ||
        sessionState.session.integrityState !== "ready" ||
        updates.length !== locked.length
      ) {
        throw new PermanentCreatorDeliveryError(
          "creator_execution_superseded",
          "Creator issue Session is no longer receivable",
        );
      }
      const updateById = new Map(
        updates.map((update) => [update.id, update]),
      );
      const { contextGeneration } = sessionState;
      const admissions =
        await sessions.admitExecutionSourceBatch(
          {
            batchKey: [
              "creator-delivery",
              batch.counterpartExecutionKey,
              ...locked.map((delivery) => delivery.id),
            ].join(":"),
            sources: locked.map((delivery) => {
              const update = updateById.get(delivery.issueUpdateId);
              if (!update) {
                throw new PermanentCreatorDeliveryError(
                  "creator_execution_superseded",
                  "Creator counterpart delivery lost its immutable issue update",
                );
              }
              const executionSource =
                executionSourceForCreatorDelivery(update);
              const counterpart =
                executionSource.actor.kind === "agent-execution"
                  ? {
                      counterpartIssueId: delivery.issueId,
                      counterpartAuthorityId:
                        executionSource.actor.authorityId,
                      counterpartOwnershipEpoch:
                        delivery.ownershipEpoch,
                    }
                  : {};
              return {
                companyId: authority.companyId,
                issueId: authority.issueId,
                sessionId: authority.sessionId,
                ownershipEpoch: authority.ownershipEpoch,
                targetAgentId: authority.agentId,
                issueExecutionAuthorityId: authority.id,
                consultExecutionId: null,
                adapterConfigRevisionId:
                  authority.auditAdapterConfigRevisionId,
                contextEpoch: contextGeneration,
                mode: "owner" as const,
                ...counterpart,
                ...executionSource,
                immutableSourceKey: delivery.deliveryId,
                sourceRecordId: delivery.id,
                exactText: update.message,
                comment: projectedCommentForCreatorUpdate(
                  executionSource.actor,
                ),
                idempotencyKey: delivery.idempotencyKey,
              };
            }),
          },
          tx,
        );
      const refs = admissions.map((admission, index) => {
        if (!admission.ref) {
          throw new Error(
            "Creator counterpart admission did not persist a ref",
          );
        }
        const delivery = locked[index]!;
        if (
          admission.ref.sourceRecordId !== delivery.id ||
          admission.ref.exactMessage !==
            updateById.get(delivery.issueUpdateId)!.message
        ) {
          throw new Error(
            "Creator counterpart admission changed committed delivery order",
          );
        }
        return admission.ref;
      });
      for (let index = 0; index < locked.length; index += 1) {
        const delivery = locked[index]!;
        const ref = refs[index]!;
        const updated = await tx
          .update(creatorDeliveries)
          .set({
            counterpartRefId: ref.id,
            updatedAt: clock(),
          })
          .where(deliveryCas(batch.deliveries[index]!))
          .returning({ id: creatorDeliveries.id });
        if (!updated[0]) {
          throw new Error(
            `Creator delivery lease was lost while binding batch ref ${delivery.id}`,
          );
        }
      }
      return refs.map((ref) => ref.id);
    });
  }

  async function refsForAgentBatch(
    batch: CreatorDeliveryBatch,
  ): Promise<string[]> {
    const first = batch.deliveries[0]!.row;
    return (
      first.direction === "to_creator"
        ? await admitCreatorCounterpartRefs(batch)
        : batch.deliveries.map((leased) => {
            if (!leased.row.counterpartRefId) {
              throw new Error(
                `Owner counterpart delivery ${leased.row.id} has no persisted ref`,
              );
            }
            return leased.row.counterpartRefId;
          })
    );
  }

  async function classifyPersistedAgentRef(
    delivery: DeliveryRow,
  ): Promise<
    | "already_scheduled"
    | "running"
    | "preparing"
    | "settled"
    | null
  > {
    if (!delivery.counterpartRefId) return null;
    const persisted = await db
      .select({
        companyId: issueExecutionRefs.companyId,
        issueId: issueExecutionRefs.issueId,
        disposition: issueExecutionRefs.disposition,
        viewState: issueExecutionHistoryViews.state,
        runId: issueExecutionRunRefs.runId,
      })
      .from(issueExecutionRefs)
      .innerJoin(
        issueExecutionHistoryViews,
        and(
          eq(
            issueExecutionHistoryViews.id,
            issueExecutionRefs.historyViewId,
          ),
          eq(
            issueExecutionHistoryViews.refId,
            issueExecutionRefs.id,
          ),
        ),
      )
      .leftJoin(
        issueExecutionRunRefs,
        and(
          eq(issueExecutionRunRefs.companyId, issueExecutionRefs.companyId),
          eq(issueExecutionRunRefs.issueId, issueExecutionRefs.issueId),
          eq(issueExecutionRunRefs.refId, issueExecutionRefs.id),
        ),
      )
      .where(eq(issueExecutionRefs.id, delivery.counterpartRefId))
      .orderBy(desc(issueExecutionRunRefs.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!persisted) return null;
    const run = persisted.runId
      ? await readIssueExecutionRun(db, {
          companyId: persisted.companyId,
          issueId: persisted.issueId,
          runId: persisted.runId,
        })
      : null;
    const [attempt, lease] = run
      ? await Promise.all([
          run.currentAttemptId
            ? db
              .select({ state: issueExecutionAttempts.state })
              .from(issueExecutionAttempts)
              .where(and(
                eq(issueExecutionAttempts.companyId, run.companyId),
                eq(issueExecutionAttempts.issueId, run.issueId),
                eq(issueExecutionAttempts.runId, run.runId),
                eq(issueExecutionAttempts.id, run.currentAttemptId),
              ))
              .limit(1)
              .then((rows) => rows[0] ?? null)
            : null,
          run.currentLeaseId
            ? db
              .select({
                state: issueExecutionLeases.state,
                expiresAt: issueExecutionLeases.expiresAt,
              })
              .from(issueExecutionLeases)
              .where(and(
                eq(issueExecutionLeases.companyId, run.companyId),
                eq(issueExecutionLeases.issueId, run.issueId),
                eq(issueExecutionLeases.runId, run.runId),
                eq(issueExecutionLeases.id, run.currentLeaseId),
              ))
              .limit(1)
              .then((rows) => rows[0] ?? null)
            : null,
        ])
      : [null, null];
    if (
      persisted.disposition === "terminal" ||
      persisted.viewState === "terminal" ||
      (run !== null &&
        !["queued", "scheduled_retry", "running"].includes(
          run.status,
        ))
    ) {
      return "settled";
    }
    if (
      persisted.disposition === "invalidated" ||
      persisted.viewState === "invalidated"
    ) {
      return null;
    }
    if (
      run?.status === "running" &&
      attempt?.state === "running" &&
      lease?.state === "active" &&
      lease.expiresAt &&
      lease.expiresAt > clock()
    ) {
      return "running";
    }
    if (
      run?.status === "running" ||
      persisted.viewState === "preparing"
    ) {
      return "preparing";
    }
    if (
      run?.status === "queued" ||
      run?.status === "scheduled_retry"
    ) {
      return "already_scheduled";
    }
    return null;
  }

  async function deliverPluginBatch(
    batch: CreatorDeliveryBatch,
  ): Promise<PluginCreatorCallbackAcknowledgement> {
    if (batch.deliveries.length !== 1) {
      throw new Error(
        "Plugin creator callbacks are delivered one committed update at a time",
      );
    }
    const parent = batch.deliveries[0]!.row;
    const pluginDelivery = await db
      .select()
      .from(pluginCreatorDeliveries)
      .where(
        eq(
          pluginCreatorDeliveries.creatorDeliveryId,
          parent.id,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!pluginDelivery || !pluginDelivery.pluginInstallationId) {
      throw new PermanentCreatorDeliveryError(
        "plugin_uninstalled",
        "Plugin creator callback installation is unavailable",
      );
    }
    const installation = await db
      .select({ status: plugins.status })
      .from(plugins)
      .where(eq(plugins.id, pluginDelivery.pluginInstallationId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!installation) {
      throw new PermanentCreatorDeliveryError(
        "plugin_uninstalled",
        "Plugin creator installation no longer exists",
      );
    }
    if (installation.status === "disabled") {
      throw new PermanentCreatorDeliveryError(
        "plugin_disabled",
        "Plugin creator installation is disabled",
      );
    }
    if (installation.status !== "ready") {
      throw new Error(
        `Plugin creator installation is temporarily unavailable (${installation.status})`,
      );
    }
    const acknowledgement = await options.pluginWorkerManager.call(
      pluginDelivery.pluginInstallationId,
      "issues.creatorCallback.deliver",
      {
        callbackKey: pluginDelivery.callbackKey,
        callbackVersion: pluginDelivery.callbackVersion,
        delivery: pluginDelivery.payload as never,
      },
      pluginTimeoutMs,
      { companyId: pluginDelivery.companyId },
    );
    if (
      acknowledgement.deliveryId !== pluginDelivery.deliveryId ||
      acknowledgement.accepted !== true
    ) {
      throw new Error(
        "Plugin creator callback acknowledgement did not exactly accept the delivery",
      );
    }
    return acknowledgement;
  }

  async function deliverRoutineBatch(
    batch: CreatorDeliveryBatch,
  ): Promise<null> {
    if (batch.deliveries.length !== 1) {
      throw new Error(
        "Routine creator hooks are delivered one committed update at a time",
      );
    }
    const leased = batch.deliveries[0]!;
    const routineId = stringField(
      leased.row.recipientRef.routineId,
      "routineId",
    );
    const routineDispatchId = stringField(
      leased.row.recipientRef.routineDispatchId,
      "routineDispatchId",
    );
    await db.transaction(async (tx) => {
      const routine = await tx
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.companyId, leased.row.companyId),
            eq(routines.id, routineId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!routine || routine.status === "archived") {
        throw new PermanentCreatorDeliveryError(
          "routine_deleted",
          "Routine creator no longer exists",
        );
      }
      const [issue, update] = await Promise.all([
        tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, leased.row.companyId),
              eq(issues.id, leased.row.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null),
        tx
          .select()
          .from(issueUpdates)
          .where(eq(issueUpdates.id, leased.row.issueUpdateId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);
      if (!issue || !update) {
        throw new Error("Routine creator delivery lost its committed update");
      }
      if (
        update.status === "done" ||
        update.status === "cancelled"
      ) {
        await finalizeSummarySlotsForTerminalIssue(
          tx as unknown as Db,
          {
            ...issue,
            boardPresentationStatus: update.status,
          },
          {
            updateId: update.id,
            commentId: update.commentId,
            runId: update.runId ?? "",
          },
        );
        await tx
          .update(routineRuns)
          .set({
            status: "completed",
            failureReason: null,
            linkedIssueId: issue.id,
            completedAt: clock(),
            updatedAt: clock(),
          })
          .where(
            and(
              eq(routineRuns.companyId, issue.companyId),
              eq(routineRuns.id, routineDispatchId),
              eq(routineRuns.routineId, routineId),
            ),
          );
      }
    });
    return null;
  }

  async function acknowledgeBatch(
    batch: CreatorDeliveryBatch,
    acknowledgement: PluginCreatorCallbackAcknowledgement | null,
  ): Promise<void> {
    const now = clock();
    await db.transaction(async (tx) => {
      for (const leased of batch.deliveries) {
        const updated = await tx
          .update(creatorDeliveries)
          .set({
            state: "delivered",
            deliveredAt: now,
            terminalAt: now,
            terminalReason: null,
            heldSince: null,
            holdReason: null,
            retryAt: null,
            lastFailure: null,
            leaseOwner: null,
            leasedAt: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              deliveryCas(leased),
              eq(creatorDeliveries.leaseOwner, options.workerId),
            ),
          )
          .returning({ id: creatorDeliveries.id });
        if (!updated[0]) {
          throw new Error(
            `Creator delivery lease was lost before acknowledgement ${leased.row.id}`,
          );
        }
        const plugin = await loadPluginDelivery(tx, leased.row.id);
        if (plugin) {
          if (
            !acknowledgement ||
            acknowledgement.deliveryId !== plugin.deliveryId ||
            acknowledgement.accepted !== true
          ) {
            throw new Error(
              "Plugin creator delivery requires its exact acknowledgement",
            );
          }
          const pluginAcknowledged = await tx
            .update(pluginCreatorDeliveries)
            .set({
              state: "delivered",
              acknowledgement,
              deliveredAt: now,
              terminalAt: now,
              terminalReason: null,
              heldSince: null,
              retryAt: null,
              lastFailure: null,
              leaseOwner: null,
              leasedAt: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(pluginCreatorDeliveries.id, plugin.id),
                eq(
                  pluginCreatorDeliveries.leaseOwner,
                  options.workerId,
                ),
                eq(
                  pluginCreatorDeliveries.leaseGeneration,
                  leased.leaseGeneration,
                ),
              ),
            )
            .returning({ id: pluginCreatorDeliveries.id });
          if (!pluginAcknowledged[0]) {
            throw new Error(
              `Plugin creator delivery lease was lost before acknowledgement ${plugin.id}`,
            );
          }
        }
      }
    });
  }

  async function terminalizeWithoutCreatorEdge(
    leased: LeasedDelivery,
    state: "exhausted" | "permanently_unreceivable",
    reason: string,
  ): Promise<void> {
    const now = clock();
    await db.transaction(async (tx) => {
      const terminalized = await tx
        .update(creatorDeliveries)
        .set({
          state,
          terminalAt: now,
          terminalReason: reason,
          fallbackAudit: {
            sink: "board/user",
            ownerDelivery: true,
            reason,
            recordedAt: now.toISOString(),
          },
          retryAt: null,
          lastFailure: reason,
          leaseOwner: null,
          leasedAt: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            deliveryCas(leased),
            eq(creatorDeliveries.leaseOwner, options.workerId),
          ),
        )
        .returning({ id: creatorDeliveries.id });
      if (!terminalized[0]) {
        throw new Error(
          `Owner creator delivery lease was lost before terminalization ${leased.row.id}`,
        );
      }
    });
  }

  async function terminalizeBatch(
    batch: CreatorDeliveryBatch,
    state: "exhausted" | "permanently_unreceivable",
    reason: IssueCreatorEdgeTerminalReason,
  ): Promise<void> {
    const creatorEdgeGroups = new Map<string, LeasedDelivery[]>();
    for (const leased of batch.deliveries) {
      if (leased.row.direction === "to_owner") {
        await terminalizeWithoutCreatorEdge(
          leased,
          state,
          reason,
        );
        continue;
      }
      const group =
        creatorEdgeGroups.get(leased.row.creatorEdgeId) ?? [];
      group.push(leased);
      creatorEdgeGroups.set(leased.row.creatorEdgeId, group);
    }
    for (const deliveries of creatorEdgeGroups.values()) {
      const leased =
        reason === "delivery_exhausted"
          ? deliveries.find(
              ({ row }) =>
                row.attemptCount >=
                row.policySnapshot.maxRetryAttempts,
            )
          : deliveries[0];
      if (!leased) {
        throw new Error(
          "Creator delivery batch has no valid terminal trigger",
        );
      }
      await options.terminalizeCreatorDelivery({
        companyId: leased.row.companyId,
        deliveryId: leased.row.id,
        state,
        reason,
        expectedLease: {
          owner: options.workerId,
          generation: leased.leaseGeneration,
        },
      });
    }
  }

  async function failBatch(
    batch: CreatorDeliveryBatch,
    failure: unknown,
  ): Promise<void> {
    if (failure instanceof PermanentCreatorDeliveryError) {
      await terminalizeBatch(
        batch,
        "permanently_unreceivable",
        failure.reason,
      );
      return;
    }
    const message =
      failure instanceof Error ? failure.message : String(failure);
    const exhausted = batch.deliveries.some(
      ({ row }) =>
        row.attemptCount >= row.policySnapshot.maxRetryAttempts,
    );
    if (!exhausted) {
      const now = clock();
      const retryAt = new Date(
        now.getTime() +
          Math.max(
            ...batch.deliveries.map(({ row }) => retryDelay(row)),
          ),
      );
      await db.transaction(async (tx) => {
        for (const leased of batch.deliveries) {
          const parentRetried = await tx
            .update(creatorDeliveries)
            .set({
              state: "retryable",
              retryAt,
              lastFailure: message,
              leaseOwner: null,
              leasedAt: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                deliveryCas(leased),
                eq(
                  creatorDeliveries.leaseOwner,
                  options.workerId,
                ),
              ),
            )
            .returning({ id: creatorDeliveries.id });
          if (!parentRetried[0]) {
            throw new Error(
              `Creator delivery lease was lost before retry ${leased.row.id}`,
            );
          }
          const pluginRetried = await tx
            .update(pluginCreatorDeliveries)
            .set({
              state: "retryable",
              retryAt,
              lastFailure: message,
              leaseOwner: null,
              leasedAt: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(
                  pluginCreatorDeliveries.creatorDeliveryId,
                  leased.row.id,
                ),
                eq(pluginCreatorDeliveries.state, "leased"),
                eq(
                  pluginCreatorDeliveries.leaseOwner,
                  options.workerId,
                ),
                eq(
                  pluginCreatorDeliveries.leaseGeneration,
                  leased.leaseGeneration,
                ),
              ),
            )
            .returning({ id: pluginCreatorDeliveries.id });
          if (
            leased.row.recipientKind === "plugin" &&
            !pluginRetried[0]
          ) {
            throw new Error(
              `Plugin creator delivery lease was lost before retry ${leased.row.id}`,
            );
          }
        }
      });
    }
    if (exhausted) {
      await terminalizeBatch(
        batch,
        "exhausted",
        "delivery_exhausted",
      );
    }
  }

  async function reconcileHeldDeliveries(
    limit = 100,
  ): Promise<number> {
    const now = clock();
    const held = await db
      .select()
      .from(creatorDeliveries)
      .where(
        and(
          inArray(creatorDeliveries.state, [
            "pending",
            "retryable",
          ]),
          sql`${creatorDeliveries.heldSince} is not null`,
        ),
      )
      .orderBy(asc(creatorDeliveries.heldSince))
      .limit(limit);
    let changed = 0;
    for (const row of held) {
      const { agent } = await loadAgentExecutionRecipient(row);
      if (agent?.status === "paused") {
        if (
          row.heldSince &&
          now.getTime() - row.heldSince.getTime() >=
            row.policySnapshot.pausedOrBudgetStoppedStalenessMs
        ) {
          if (row.direction === "to_owner") {
            await db
              .update(creatorDeliveries)
              .set({
                state: "exhausted",
                terminalAt: now,
                terminalReason: "paused_or_budget_staleness",
                fallbackAudit: {
                  sink: "board/user",
                  ownerDelivery: true,
                  reason: "paused_or_budget_staleness",
                  recordedAt: now.toISOString(),
                },
                retryAt: null,
                lastFailure: "paused_or_budget_staleness",
                updatedAt: now,
              })
              .where(
                and(
                  eq(creatorDeliveries.id, row.id),
                  eq(creatorDeliveries.state, row.state),
                  eq(creatorDeliveries.heldSince, row.heldSince),
                ),
              );
          } else {
            await options.terminalizeCreatorDelivery({
              companyId: row.companyId,
              deliveryId: row.id,
              state: "exhausted",
              reason: "paused_or_budget_staleness",
            });
          }
          changed += 1;
        }
        continue;
      }
      await db
        .update(creatorDeliveries)
        .set({
          state: "retryable",
          heldSince: null,
          holdReason: null,
          retryAt: now,
          lastFailure: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(creatorDeliveries.id, row.id),
            eq(creatorDeliveries.state, row.state),
          ),
        );
      changed += 1;
    }
    return changed;
  }

  async function reconcileTerminalOutcomes(
    limit = 100,
  ): Promise<number> {
    const rows = await db
      .select()
      .from(creatorDeliveries)
      .where(
        and(
          inArray(creatorDeliveries.state, [
            "exhausted",
            "permanently_unreceivable",
          ]),
          isNull(creatorDeliveries.fallbackAudit),
        ),
      )
      .orderBy(
        asc(creatorDeliveries.terminalAt),
        asc(creatorDeliveries.id),
      )
      .limit(limit);
    let changed = 0;
    for (const row of rows) {
      if (
        !isIssueCreatorEdgeTerminalReason(row.terminalReason)
      ) {
        throw new Error(
          `Terminal creator delivery ${row.id} has no canonical terminal reason`,
        );
      }
      if (row.direction === "to_owner") {
        const now = clock();
        const updated = await db
          .update(creatorDeliveries)
          .set({
            fallbackAudit: {
              sink: "board/user",
              ownerDelivery: true,
              reason: row.terminalReason,
              recordedAt: now.toISOString(),
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(creatorDeliveries.id, row.id),
              eq(creatorDeliveries.state, row.state),
              isNull(creatorDeliveries.fallbackAudit),
            ),
          )
          .returning({ id: creatorDeliveries.id });
        if (updated[0]) changed += 1;
        continue;
      }
      await options.terminalizeCreatorDelivery({
        companyId: row.companyId,
        deliveryId: row.id,
        state: row.state as
          | "exhausted"
          | "permanently_unreceivable",
        reason: row.terminalReason,
      });
      changed += 1;
    }
    return changed;
  }

  async function processBatch(
    batch: CreatorDeliveryBatch,
  ): Promise<"delivered" | "deferred" | "failed"> {
    const first = batch.deliveries[0]!.row;
    if (first.recipientKind === "agent-execution") {
      const classification =
        await classifyPersistedAgentRef(first);
      if (classification) {
        await acknowledgeBatch(batch, null);
        return "delivered";
      }
      const availability = await agentAvailability(batch);
      if (availability === "held") {
        const { agent } =
          await loadAgentExecutionRecipient(
            batch.deliveries[0]!.row,
          );
        await holdAgentBatch(
          batch,
          agent?.pauseReason?.toLowerCase().includes("budget")
            ? "budget_stopped"
            : "paused",
        );
        return "deferred";
      }
      if (availability === "transient") {
        await releaseForTransientAvailability(
          batch,
          "recipient_temporarily_not_invokable",
        );
        return "deferred";
      }
      if (typeof availability === "object") {
        await terminalizeBatch(
          batch,
          "permanently_unreceivable",
          availability.permanent,
        );
        return "failed";
      }
      let notification: CreatorDeliveryRefNotificationOutcome;
      try {
        const refIds = await refsForAgentBatch(batch);
        const [primaryRefId] = refIds;
        if (!primaryRefId || refIds.length !== batch.deliveries.length) {
          throw new Error(
            "Creator delivery batch did not resolve every persisted ref",
          );
        }
        notification = await options.notifyRef(primaryRefId);
        if (
          ![
            "notified",
            "already_scheduled",
            "running",
            "preparing",
            "settled",
          ].includes(notification)
        ) {
          throw new Error(
            `Creator delivery notifier returned an invalid outcome for ${primaryRefId}`,
          );
        }
      } catch (error) {
        const attempted = await beginAttempt(batch);
        await failBatch(attempted, error);
        return "failed";
      }
      const acknowledged =
        notification === "notified"
          ? await beginAttempt(batch)
          : batch;
      await acknowledgeBatch(acknowledged, null);
      return "delivered";
    }

    const attempted = await beginAttempt(batch);
    try {
      let acknowledgement: PluginCreatorCallbackAcknowledgement | null =
        null;
      switch (first.recipientKind) {
        case "plugin":
          acknowledgement = await deliverPluginBatch(attempted);
          break;
        case "routine":
          acknowledgement = await deliverRoutineBatch(attempted);
          break;
        case "user/board":
        case "system":
          break;
      }
      await acknowledgeBatch(attempted, acknowledgement);
      return "delivered";
    } catch (error) {
      await failBatch(attempted, error);
      return "failed";
    }
  }

  return {
    async notifyPersistedDelivery(deliveryId: string) {
      const batch = await claimNextBatch(deliveryId);
      if (!batch) {
        return {
          claimed: false,
          delivered: 0,
          deferred: 0,
          failed: 0,
        };
      }
      const result = await processBatch(batch);
      return {
        claimed: true,
        delivered:
          result === "delivered" ? batch.deliveries.length : 0,
        deferred:
          result === "deferred" ? batch.deliveries.length : 0,
        failed: result === "failed" ? batch.deliveries.length : 0,
      };
    },

    async drainQueued(
      input: { maxBatches?: number } = {},
    ) {
      const maxBatches = Math.max(
        1,
        Math.min(input.maxBatches ?? 100, 500),
      );
      const terminalOutcomesChanged =
        await reconcileTerminalOutcomes();
      const holdsChanged = await reconcileHeldDeliveries();
      let delivered = 0;
      let deferred = 0;
      let failed = 0;
      let batches = 0;
      while (batches < maxBatches) {
        const batch = await claimNextBatch();
        if (!batch) break;
        batches += 1;
        const result = await processBatch(batch);
        if (result === "delivered") {
          delivered += batch.deliveries.length;
        } else if (result === "deferred") {
          deferred += batch.deliveries.length;
        } else {
          failed += batch.deliveries.length;
        }
      }
      return {
        batches,
        delivered,
        deferred,
        failed,
        holdsChanged,
        terminalOutcomesChanged,
      };
    },

    reconcileHeldDeliveries,
    reconcileTerminalOutcomes,
  };
}
