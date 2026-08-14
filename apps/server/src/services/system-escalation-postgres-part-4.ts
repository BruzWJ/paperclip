import {
  agents,
  plugins,
  routines,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  tasks,
} from "@paperclipai/db";
import { type TaskCreatorEdgeTerminalReason } from "@paperclipai/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { EdgeRow, SystemEscalationTransactionResult } from "./system-escalation-postgres-part-1.js";
import { terminalizeCreatorEdgeInTransaction } from "./system-escalation-postgres-part-3.js";
import { type TaskSessionAdmissionService } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function terminalizeAgentCreatorEdgesInTransaction(
  tx: TaskSessionDbTransaction,
  sessions: TaskSessionAdmissionService,
  input: {
    companyId: string;
    agentId: string;
    sourceId: string;
    now: Date;
  },
): Promise<SystemEscalationTransactionResult[]> {
  const authorityRows = await tx
    .select({ id: taskExecutionAuthorities.id })
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(taskExecutionAuthorities.companyId, input.companyId),
        eq(taskExecutionAuthorities.agentId, input.agentId),
      ),
    )
    .orderBy(asc(taskExecutionAuthorities.id))
    .for("update");
  const authorityIds = authorityRows.map((authority) => authority.id);
  if (authorityIds.length === 0) return [];
  const edges = await tx
    .select({ edge: taskCreatorEdgeReceivability })
    .from(taskCreatorEdgeReceivability)
    .innerJoin(
      tasks,
      and(
        eq(tasks.companyId, taskCreatorEdgeReceivability.companyId),
        eq(tasks.id, taskCreatorEdgeReceivability.taskId),
        eq(tasks.ownershipEpoch, taskCreatorEdgeReceivability.ownershipEpoch),
      ),
    )
    .where(
      and(
        eq(taskCreatorEdgeReceivability.companyId, input.companyId),
        eq(taskCreatorEdgeReceivability.endpointKind, "agent-execution"),
        inArray(taskCreatorEdgeReceivability.endpointId, authorityIds),
        eq(taskCreatorEdgeReceivability.state, "receivable"),
      ),
    )
    .orderBy(
      asc(taskCreatorEdgeReceivability.taskId),
      asc(taskCreatorEdgeReceivability.ownershipEpoch),
      asc(taskCreatorEdgeReceivability.id),
    );
  const seenTasks = new Set<string>();
  const escalations: SystemEscalationTransactionResult[] = [];
  for (const row of edges) {
    if (seenTasks.has(row.edge.taskId)) continue;
    seenTasks.add(row.edge.taskId);
    const result = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessions,
      {
        companyId: input.companyId,
        taskId: row.edge.taskId,
        ownershipEpoch: row.edge.ownershipEpoch,
        creatorEdgeId: row.edge.id,
        reason: "agent_terminated",
        sourceKind: "agent_tombstone",
        sourceId: input.sourceId,
        systemSource: "recovery",
        triggeringRunId: null,
        endpointTombstone: {
          agentId: input.agentId,
          status: "terminated",
        },
        audit: {
          agentId: input.agentId,
          terminalReason: "agent_terminated",
        },
      },
      () => input.now,
    );
    if (result.escalation) escalations.push(result.escalation);
  }
  return escalations;
}

export async function terminalizePluginCreatorEdgesInTransaction(
  tx: TaskSessionDbTransaction,
  sessions: TaskSessionAdmissionService,
  input: {
    pluginInstallationId: string;
    reason: "plugin_disabled" | "plugin_uninstalled";
    sourceId: string;
    now: Date;
  },
): Promise<SystemEscalationTransactionResult[]> {
  const edges = await tx
    .select({ edge: taskCreatorEdgeReceivability })
    .from(taskCreatorEdgeReceivability)
    .innerJoin(
      tasks,
      and(
        eq(tasks.companyId, taskCreatorEdgeReceivability.companyId),
        eq(tasks.id, taskCreatorEdgeReceivability.taskId),
        eq(tasks.ownershipEpoch, taskCreatorEdgeReceivability.ownershipEpoch),
      ),
    )
    .where(
      and(
        eq(taskCreatorEdgeReceivability.endpointKind, "plugin"),
        eq(taskCreatorEdgeReceivability.endpointId, input.pluginInstallationId),
        eq(taskCreatorEdgeReceivability.state, "receivable"),
      ),
    )
    .orderBy(
      asc(taskCreatorEdgeReceivability.companyId),
      asc(taskCreatorEdgeReceivability.taskId),
      asc(taskCreatorEdgeReceivability.ownershipEpoch),
      asc(taskCreatorEdgeReceivability.id),
    );
  const seenTasks = new Set<string>();
  const escalations: SystemEscalationTransactionResult[] = [];
  for (const row of edges) {
    const pluginTaskScope = `${row.edge.companyId}:${row.edge.taskId}`;
    if (seenTasks.has(pluginTaskScope)) continue;
    seenTasks.add(pluginTaskScope);
    const result = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessions,
      {
        companyId: row.edge.companyId,
        taskId: row.edge.taskId,
        ownershipEpoch: row.edge.ownershipEpoch,
        creatorEdgeId: row.edge.id,
        reason: input.reason,
        sourceKind: "plugin_lifecycle",
        sourceId: input.sourceId,
        systemSource: "recovery",
        triggeringRunId: null,
        endpointTombstone: {
          pluginInstallationId: input.pluginInstallationId,
          status: input.reason === "plugin_disabled" ? "disabled" : "deleted",
        },
        audit: {
          pluginInstallationId: input.pluginInstallationId,
          terminalReason: input.reason,
        },
      },
      () => input.now,
    );
    if (result.escalation) escalations.push(result.escalation);
  }
  return escalations;
}

export async function terminalizeRoutineCreatorEdgesInTransaction(
  tx: TaskSessionDbTransaction,
  sessions: TaskSessionAdmissionService,
  input: {
    companyId: string;
    routineId: string;
    sourceId: string;
    now: Date;
  },
): Promise<SystemEscalationTransactionResult[]> {
  const edges = await tx
    .select({ edge: taskCreatorEdgeReceivability })
    .from(taskCreatorEdgeReceivability)
    .innerJoin(
      tasks,
      and(
        eq(tasks.companyId, taskCreatorEdgeReceivability.companyId),
        eq(tasks.id, taskCreatorEdgeReceivability.taskId),
        eq(tasks.ownershipEpoch, taskCreatorEdgeReceivability.ownershipEpoch),
      ),
    )
    .where(
      and(
        eq(taskCreatorEdgeReceivability.companyId, input.companyId),
        eq(taskCreatorEdgeReceivability.endpointKind, "routine"),
        eq(taskCreatorEdgeReceivability.endpointId, input.routineId),
        eq(taskCreatorEdgeReceivability.state, "receivable"),
      ),
    )
    .orderBy(
      asc(taskCreatorEdgeReceivability.taskId),
      asc(taskCreatorEdgeReceivability.ownershipEpoch),
      asc(taskCreatorEdgeReceivability.id),
    );
  const seenTasks = new Set<string>();
  const escalations: SystemEscalationTransactionResult[] = [];
  for (const row of edges) {
    if (seenTasks.has(row.edge.taskId)) continue;
    seenTasks.add(row.edge.taskId);
    const result = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessions,
      {
        companyId: row.edge.companyId,
        taskId: row.edge.taskId,
        ownershipEpoch: row.edge.ownershipEpoch,
        creatorEdgeId: row.edge.id,
        reason: "routine_deleted",
        sourceKind: "routine_lifecycle",
        sourceId: input.sourceId,
        systemSource: "recovery",
        triggeringRunId: null,
        endpointTombstone: {
          routineId: input.routineId,
          status: "archived",
        },
        audit: {
          routineId: input.routineId,
          terminalReason: "routine_deleted",
        },
      },
      () => input.now,
    );
    if (result.escalation) escalations.push(result.escalation);
  }
  return escalations;
}

export async function inspectEndpointTerminality(
  tx: TaskSessionDbTransaction,
  edge: EdgeRow,
): Promise<{
  reason: TaskCreatorEdgeTerminalReason;
  tombstone: Record<string, unknown>;
} | null> {
  if (edge.endpointKind === "agent-execution") {
    const authority = edge.endpointId
      ? await tx
          .select()
          .from(taskExecutionAuthorities)
          .where(
            and(
              eq(taskExecutionAuthorities.companyId, edge.companyId),
              eq(taskExecutionAuthorities.id, edge.endpointId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (!authority || authority.state !== "current") {
      return {
        reason: "creator_execution_superseded",
        tombstone: {
          authorityId: edge.endpointId,
          state: authority?.state ?? "missing",
          revocationReason: authority?.revocationReason ?? null,
        },
      };
    }
    const agent = await tx
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, edge.companyId), eq(agents.id, authority.agentId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.status === "terminated") {
      return {
        reason: agent ? "agent_terminated" : "agent_deleted",
        tombstone: {
          authorityId: authority.id,
          agentId: authority.agentId,
          status: agent?.status ?? "deleted",
        },
      };
    }
    return null;
  }
  if (edge.endpointKind === "plugin") {
    const plugin = edge.endpointId
      ? await tx
          .select()
          .from(plugins)
          .where(eq(plugins.id, edge.endpointId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (!plugin) {
      return {
        reason: "plugin_uninstalled",
        tombstone: {
          pluginInstallationId: edge.endpointId,
          status: "missing",
        },
      };
    }
    if (plugin.status === "disabled") {
      return {
        reason: "plugin_disabled",
        tombstone: {
          pluginInstallationId: plugin.id,
          status: plugin.status,
        },
      };
    }
    return null;
  }
  if (edge.endpointKind === "routine") {
    const routine = edge.endpointId
      ? await tx
          .select()
          .from(routines)
          .where(and(eq(routines.companyId, edge.companyId), eq(routines.id, edge.endpointId)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (!routine || routine.status === "archived") {
      return {
        reason: "routine_deleted",
        tombstone: {
          routineId: edge.endpointId,
          status: routine?.status ?? "missing",
        },
      };
    }
  }
  return null;
}
