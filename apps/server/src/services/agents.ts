import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentConfigRevisions,
  agentRuntimeState,
  approvals,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  tasks,
  taskSessions,
  taskUpdates,
} from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  getAgentWorkEligibility,
  isUuidLike,
  normalizeAgentUrlKey,
  type AgentRuntimeState,
  type AgentEligibilityAgent,
  type MoneyAmount,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import { terminalizeAgentCreatorEdgesInTransaction } from "./system-escalation-postgres.js";
import {
  admitCounterpartTaskUpdate,
  lockTaskMentionRecipient,
} from "./runtime-task-action-port.js";
import {
  listCompanyAgentGraphDescendants,
  lockCompanyAgentGraph,
} from "./agent-org-graph-lock.js";
import { budgetService } from "./budgets.js";
import { logActivity } from "./activity-log.js";
import type {
  TaskExecutionCancellationActor,
  TaskExecutionCancellationService,
  RequestedAgentRunCancellations,
} from "./task-execution-cancellation.js";

export type AgentLifecycleTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface AgentTerminationCommit {
  tombstone: typeof agents.$inferSelect;
  dispatchRefIds: string[];
  cancellationRequests: RequestedAgentRunCancellations | null;
  suspensionRequests: RequestedAgentRunCancellations | null;
}

export type AgentLifecycleCancellationService = Pick<
  TaskExecutionCancellationService,
  | "requestAgentCancellationsInTransaction"
  | "reconcileRequestedCancellations"
  | "requestAgentSuspensionsInTransaction"
>;

export type AgentSuspensionService = Pick<
  TaskExecutionCancellationService,
  | "requestAgentSuspensionsInTransaction"
  | "reconcileRequestedCancellations"
>;

export interface AgentSuspensionPostCommit {
  taskExecutionCancellation: AgentSuspensionService;
  actor: AgentTerminationActor;
}

export type AgentTerminationActor = Extract<
  TaskExecutionCancellationActor,
  { readonly kind: "system" } | { readonly kind: "user" }
>;

export interface AgentLifecyclePostCommit {
  taskExecutionCancellation: AgentLifecycleCancellationService;
  dispatchRef(refId: string): Promise<void>;
}

export interface AgentTerminationPostCommit extends AgentLifecyclePostCommit {
  actor: AgentTerminationActor;
}

function lifecycleUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function admitOwnedTaskTerminationRecoveryInTransaction(
  tx: AgentLifecycleTransaction,
  input: {
    companyId: string;
    agentId: string;
    agentName: string;
    sourceId: string;
    now: Date;
  },
): Promise<string[]> {
  const sessions = createTaskSessionAdmissionService(
    tx as unknown as Db,
  );
  const ownedTasks = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, input.companyId),
        eq(tasks.ownerKind, "agent"),
        eq(tasks.ownerAgentId, input.agentId),
        eq(tasks.lifecycleStatus, "open"),
      ),
    )
    .orderBy(tasks.id)
    .for("update");
  if (ownedTasks.length === 0) return [];

  const dispatchRefIds: string[] = [];
  for (const task of ownedTasks) {
    if (!task.ownershipEpoch) {
      throw new Error(
        `Owned task ${task.id} has no current ownership epoch`,
      );
    }
    const session = await tx
      .select()
      .from(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, input.companyId),
          eq(taskSessions.taskId, task.id),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const authority = await tx
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(
            taskExecutionAuthorities.companyId,
            input.companyId,
          ),
          eq(taskExecutionAuthorities.taskId, task.id),
          eq(
            taskExecutionAuthorities.ownershipEpoch,
            task.ownershipEpoch,
          ),
          eq(taskExecutionAuthorities.agentId, input.agentId),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const edge = await tx
      .select()
      .from(taskCreatorEdgeReceivability)
      .where(
        and(
          eq(
            taskCreatorEdgeReceivability.companyId,
            input.companyId,
          ),
          eq(
            taskCreatorEdgeReceivability.taskId,
            task.id,
          ),
          eq(
            taskCreatorEdgeReceivability.ownershipEpoch,
            task.ownershipEpoch,
          ),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!session || !authority || !edge) {
      throw new Error(
        `Owned task ${task.id} is missing its canonical recovery graph`,
      );
    }
    const recoveryKey =
      `${input.sourceId}:owned-task:${task.id}:${task.ownershipEpoch}`;
    const exactText =
      `Agent ${input.agentName} was terminated. This task is blocked because its owner is no longer executable.`;
    const blockedTask = await tx
      .update(tasks)
      .set({
        lifecycleStatus: "blocked",
        boardPresentationStatus: "blocked",
        disposition: null,
        completedAt: null,
        cancelledAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.companyId, input.companyId),
          eq(tasks.ownershipEpoch, task.ownershipEpoch),
          eq(tasks.lifecycleStatus, "open"),
        ),
      )
      .returning({ id: tasks.id })
      .then((rows) => rows[0] ?? null);
    if (!blockedTask) {
      throw conflict(
        `Owned task ${task.id} lost its locked termination-recovery transition`,
      );
    }
    const updateId = lifecycleUuid(
      "agent-termination-recovery-update",
      recoveryKey,
    );
    const targetTaskId = task.parentId ?? task.id;
    const admission = await admitCounterpartTaskUpdate(
      sessions,
      tx as never,
      {
        companyId: input.companyId,
        target: await lockTaskMentionRecipient(
          tx as never,
          input.companyId,
          targetTaskId,
        ),
        actor: {
          kind: "system",
          sourceKind: "agent_termination",
          sourceId: input.sourceId,
        },
        comment: {
          author: { kind: "system", source: "recovery" },
          producingRun: null,
        },
        sourceAgentTarget: {
          taskId: task.id,
          agentId: input.agentId,
        },
        sourceKind: "task_update",
        immutableSourceKey: recoveryKey,
        sourceRecordId: updateId,
        message: exactText,
      },
    );
    if (!admission.comment) {
      throw new Error(
        `Owned task ${task.id} termination recovery has no canonical comment`,
      );
    }
    const update = await tx
      .insert(taskUpdates)
      .values({
        id: updateId,
        companyId: input.companyId,
        taskId: task.id,
        sessionId: session.id,
        ownershipEpoch: task.ownershipEpoch,
        form: "owner",
        sourceKind: "system",
        sourceAuthorityId: authority.id,
        sourceIdentity: {
          sourceKind: "agent_termination",
          sourceId: input.sourceId,
          terminatedAgentId: input.agentId,
        },
        runId: null,
        gatewayInvocationId: recoveryKey,
        runSequence: 0,
        message: exactText,
        status: "blocked",
        disposition: null,
        commentId: admission.comment.id,
        creatorEdgeId: edge.id,
        createdAt: input.now,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!update) {
      throw new Error(
        `Owned task ${task.id} termination update was not persisted`,
      );
    }
    if (admission.ref) dispatchRefIds.push(admission.ref.id);
  }
  return dispatchRefIds;
}

/**
 * Canonical in-transaction agent termination. Callers that must atomically
 * couple another control-plane transition (for example hire rejection) use
 * this exact implementation rather than replaying configuration or deleting
 * the agent.
 */
export async function terminateAgentToTombstoneInTransaction(
  tx: AgentLifecycleTransaction,
  input: {
    companyId?: string;
    agentId: string;
    sourceId: string;
    actor: AgentTerminationActor;
    now: Date;
  },
  cancellation: AgentLifecycleCancellationService,
): Promise<AgentTerminationCommit | null> {
  const companyId =
    input.companyId ??
    (await tx
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .then((rows) => rows[0]?.companyId ?? null));
  if (!companyId) return null;

  const locked = await lockCompanyAgentGraph(tx, companyId);
  if (!locked.company) return null;
  const existing = locked.agents.find(
    (candidate) =>
      candidate.id === input.agentId &&
      (!input.companyId || candidate.companyId === input.companyId),
  );
  if (!existing) return null;
  if (existing.status === "terminated") {
    return {
      tombstone: existing,
      dispatchRefIds: [],
      cancellationRequests: null,
      suspensionRequests: null,
    };
  }

  const descendants = listCompanyAgentGraphDescendants(
    existing.id,
    locked.agents,
  );
  const nonTerminatedDescendantIds = descendants
    .filter((descendant) => descendant.status !== "terminated")
    .map((descendant) => descendant.id);

  const tombstone = await tx
    .update(agents)
    .set({
      status: "terminated",
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agents.id, existing.id),
        eq(agents.companyId, existing.companyId),
        ne(agents.status, "terminated"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!tombstone) {
    throw conflict("Agent termination lost its locked tombstone transition");
  }

  if (nonTerminatedDescendantIds.length > 0) {
    const pausedDescendants = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "system",
        pausedAt: input.now,
        errorReason: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agents.companyId, existing.companyId),
          inArray(agents.id, nonTerminatedDescendantIds),
          ne(agents.status, "terminated"),
        ),
      )
      .returning({ id: agents.id });
    const pausedDescendantIds = new Set(
      pausedDescendants.map((descendant) => descendant.id),
    );
    if (
      pausedDescendantIds.size !== nonTerminatedDescendantIds.length ||
      nonTerminatedDescendantIds.some(
        (descendantId) => !pausedDescendantIds.has(descendantId),
      )
    ) {
      throw conflict(
        "Agent termination lost a locked descendant pause transition",
      );
    }
  }

  const escalations = await terminalizeAgentCreatorEdgesInTransaction(
    tx,
    createTaskSessionAdmissionService(tx as unknown as Db),
    {
      companyId: tombstone.companyId,
      agentId: tombstone.id,
      sourceId: input.sourceId,
      now: input.now,
    },
  );
  const cancellationRequests =
    await cancellation.requestAgentCancellationsInTransaction(tx, {
      companyId: existing.companyId,
      agentIds: [existing.id],
      reason:
        "Cancelled because the agent was terminated",
      actor: input.actor,
      now: input.now,
    });
  const suspensionRequests = nonTerminatedDescendantIds.length > 0
    ? await cancellation.requestAgentSuspensionsInTransaction(tx, {
        companyId: existing.companyId,
        agentIds: nonTerminatedDescendantIds,
        reason:
          "Suspended because the reporting chain contains a terminated agent",
        actor: input.actor,
        now: input.now,
      })
    : null;
  const recoveryDispatchRefIds =
    await admitOwnedTaskTerminationRecoveryInTransaction(tx, {
      companyId: existing.companyId,
      agentId: existing.id,
      agentName: existing.name,
      sourceId: input.sourceId,
      now: input.now,
    });
  const dispatchRefIds = [
    ...escalations.flatMap((escalation) =>
      escalation.dispatchRefId ? [escalation.dispatchRefId] : [],
    ),
    ...recoveryDispatchRefIds,
  ];
  await logActivity(tx as unknown as Db, {
    companyId: existing.companyId,
    actorType: input.actor.kind,
    actorId: input.actor.kind === "user"
      ? input.actor.userId
      : input.sourceId,
    action: "agent.terminated",
    entityType: "agent",
    entityId: existing.id,
    details: {
      sourceId: input.sourceId,
      descendantPausedAgentIds: nonTerminatedDescendantIds,
      cancellationRequestedRunIds: cancellationRequests.requests.map(
        (request) => request.runId,
      ),
      suspensionRequestedRunIds:
        suspensionRequests?.requests.map((request) => request.runId) ?? [],
      fencedExecutionRefIds: cancellationRequests.fence.refIds,
      fencedTargetCorrelationIds:
        cancellationRequests.fence.correlationIds,
      suspendedExecutionRefIds: suspensionRequests?.fence.refIds ?? [],
      supersededDescendantCorrelationIds:
        suspensionRequests?.fence.correlationIds ?? [],
      dispatchRefIds,
    },
  });
  return {
    tombstone,
    dispatchRefIds,
    cancellationRequests,
    suspensionRequests,
  };
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

export function agentService(db: Db) {
  const budgets = budgetService(db);

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentBaseRow<T extends typeof agents.$inferSelect>(row: T) {
    return withUrlKey(row);
  }

  function toEligibilityAgent(row: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "status" | "reportsTo">): AgentEligibilityAgent {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      status: row.status,
      reportsTo: row.reportsTo,
    };
  }

  function normalizeAgentRows<T extends typeof agents.$inferSelect>(
    rows: T[],
    allCompanyRows: (typeof agents.$inferSelect)[] = rows,
  ) {
    const eligibilityAgents = allCompanyRows.map(toEligibilityAgent);
    return rows.map((row) => {
      const base = normalizeAgentBaseRow(row);
      return {
        ...base,
        orgChainHealth: getAgentWorkEligibility({
          agent: toEligibilityAgent(row),
          agents: eligibilityAgents,
        }).orgChainHealth,
      };
    });
  }

  function normalizeAgentRow<T extends typeof agents.$inferSelect>(
    row: T,
    allCompanyRows?: (typeof agents.$inferSelect)[],
  ) {
    return normalizeAgentRows([row], allCompanyRows)[0]!;
  }

  async function listCompanyAgentRows(companyId: string) {
    return db.select().from(agents).where(eq(agents.companyId, companyId));
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    return budgets.getAgentMonthlyKnownSpend(companyId, agentIds);
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string }>(
    rows: T[],
  ): Promise<Array<T & { knownSpendAmount: MoneyAmount }>> {
    if (rows.length === 0) return [];
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]!.companyId;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      knownSpendAmount: spendByAgentId.get(row.id)!,
    }));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [companyRows, hydrated] = await Promise.all([
      listCompanyAgentRows(row.companyId),
      hydrateAgentSpend([row]).then((rows) => rows[0]!),
    ]);
    return normalizeAgentRow(hydrated, companyRows);
  }

  async function requireGetById(id: string) {
    const agent = await getById(id);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const [rows, allCompanyRows] = await Promise.all([
        db.select().from(agents).where(and(...conditions)),
        listCompanyAgentRows(companyId),
      ]);
      const hydrated = await hydrateAgentSpend(rows);
      return normalizeAgentRows(hydrated, allCompanyRows);
    },

    getById,

    getRuntimeState: async (agentId: string): Promise<AgentRuntimeState | null> => {
      const row = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        ...row,
        aggregateKnownCostAmount: canonicalizeMoneyAmount(
          row.aggregateKnownCostAmount,
        ),
      };
    },

    pause: async (
      id: string,
      postCommit: AgentSuspensionPostCommit,
      reason: "manual" | "budget" | "system" = "manual",
    ) => {
      const committed = await db.transaction(async (tx) => {
        const companyId = await tx
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, id))
          .then((rows) => rows[0]?.companyId ?? null);
        if (!companyId) return null;

        const locked = await lockCompanyAgentGraph(tx, companyId);
        const existing = locked.agents.find((candidate) => candidate.id === id);
        if (!existing) return null;
        if (existing.status === "terminated") {
          throw conflict("Cannot pause terminated agent");
        }
        if (existing.status === "pending_approval") {
          throw conflict(
            "Pending approval agents must be rejected instead of paused",
            { code: "pending_hire_requires_rejection", agentId: id },
          );
        }

        const now = new Date();
        if (existing.status !== "paused") {
          const updated = await tx
            .update(agents)
            .set({
              status: "paused",
              pauseReason: reason,
              pausedAt: now,
              errorReason: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(agents.id, existing.id),
                eq(agents.companyId, existing.companyId),
                eq(agents.status, existing.status),
              ),
            )
            .returning({ id: agents.id })
            .then((rows) => rows[0] ?? null);
          if (!updated) {
            throw conflict("Agent pause lost its locked lifecycle transition");
          }
        }

        const suspensionRequests =
          await postCommit.taskExecutionCancellation
            .requestAgentSuspensionsInTransaction(tx, {
              companyId: existing.companyId,
              agentIds: [existing.id],
              reason: "Suspended because the agent was paused",
              actor: postCommit.actor,
              now,
            });
        return { agentId: existing.id, suspensionRequests };
      });
      if (!committed) return null;
      await postCommit.taskExecutionCancellation
        .reconcileRequestedCancellations(committed.suspensionRequests);
      return getById(committed.agentId);
    },

    resume: async (id: string) => {
      const updatedId = await db.transaction(async (tx) => {
        const companyId = await tx
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, id))
          .then((rows) => rows[0]?.companyId ?? null);
        if (!companyId) return null;
        const locked = await lockCompanyAgentGraph(tx, companyId);
        const existing = locked.agents.find(
          (candidate) => candidate.id === id,
        );
        if (!existing) return null;
        if (existing.status === "terminated") {
          throw conflict("Cannot resume terminated agent");
        }
        if (existing.pauseReason === "budget") {
          throw conflict(
            "Budget-paused agents must be resumed through budget resolution",
            {
              code: "budget_resume_requires_budget_resolution",
              agentId: existing.id,
            },
          );
        }

        const eligibility = getAgentWorkEligibility({
          agent: toEligibilityAgent(existing),
          agents: locked.agents.map(toEligibilityAgent),
        });
        if (eligibility.orgChainHealth.status === "invalid_org_chain") {
          throw conflict(
            eligibility.orgChainHealth.repairGuidance ??
              "Repair this agent's reporting chain before resuming it",
            {
              code: "invalid_agent_org_chain",
              agentId: existing.id,
            },
          );
        }

        const openHireApproval = await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, existing.companyId),
              eq(approvals.type, "hire_agent"),
              inArray(approvals.status, ["pending", "revision_requested"]),
              sql`${approvals.payload} ->> 'agentId' = ${existing.id}`,
            ),
          )
          .orderBy(approvals.id)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          existing.status === "pending_approval" ||
          openHireApproval
        ) {
          throw conflict("Pending approval agents cannot be resumed", {
            code: "pending_hire_requires_approval",
            agentId: existing.id,
            approvalId: openHireApproval?.id ?? null,
          });
        }

        const now = new Date();
        const updated = await tx
          .update(agents)
          .set({
            status: "idle",
            pauseReason: null,
            pausedAt: null,
            errorReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, existing.id),
              eq(agents.companyId, existing.companyId),
              eq(agents.status, existing.status),
            ),
          )
          .returning({ id: agents.id })
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Agent resume lost its locked lifecycle transition");
        }
        return updated.id;
      });
      return updatedId ? getById(updatedId) : null;
    },

    clearError: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot clear error on terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot have errors cleared");
      }
      if (existing.status !== "error") {
        throw conflict("Only agents in error status can have their error cleared");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, id), eq(agents.status, "error")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw conflict("Only agents in error status can have their error cleared");
      }
      return getById(updated.id);
    },

    terminate: async (
      id: string,
      postCommit: AgentTerminationPostCommit,
    ) => {
      const committed = await db.transaction(async (tx) => {
        const now = new Date();
        return terminateAgentToTombstoneInTransaction(
          tx,
          {
            agentId: id,
            sourceId: `agent-termination:${id}`,
            actor: postCommit.actor,
            now,
          },
          postCommit.taskExecutionCancellation,
        );
      });
      if (committed?.cancellationRequests) {
        await postCommit.taskExecutionCancellation
          .reconcileRequestedCancellations(
            committed.cancellationRequests,
          );
      }
      if (committed?.suspensionRequests) {
        await postCommit.taskExecutionCancellation
          .reconcileRequestedCancellations(
            committed.suspensionRequests,
          );
      }
      for (const refId of committed?.dispatchRefIds ?? []) {
        await postCommit.dispatchRef(refId);
      }
      return committed ? getById(id) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    orgForCompany: async (companyId: string) => {
      const allCompanyRows = await listCompanyAgentRows(companyId);
      const rows = allCompanyRows.filter((row) => row.status !== "terminated");
      const normalizedRows = normalizeAgentRows(rows, allCompanyRows);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo && rows.some((candidate) => candidate.id === row.reportsTo) ? row.reportsTo : null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = normalizeAgentRows(rows, rows)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
