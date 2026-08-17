import {
  agents,
  companies,
  taskConsultExecutions,
  taskExecutionAuthorities,
  taskExecutionRefs,
  taskSessionContextEpochs,
  taskSessions,
  tasks,
  type Db,
} from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  InvokableTaskOwnerRejected,
  evaluateAgentInvokability,
  resolveInvokableTaskOwnerInTransaction,
} from "./agent-invokability.js";
import { lockActivePromptCapabilityBinding } from "./prompt-capability-gateway-postgres.js";
import { type PaperclipManagedToolName } from "./paperclip-managed-tool-registry.js";
import { createPostgresRuntimeInterfaceCompiler } from "./runtime-interface-compiler-db.js";
import {
  resolveRuntimeToolDescriptor,
  type RuntimeInterfaceCompileInput,
} from "./runtime-interface-compiler.js";
import {
  type AgentRunCapability,
  type AuthorizedRuntimeAction,
  type RuntimeTaskOwnerChoice,
  RuntimeTaskActionDenied,
} from "./runtime-task-action-port-shared-part-1.js";
import {
  lockRuntimeActionHierarchy,
  lockRuntimeActionRun,
} from "./runtime-task-action-port-shared-part-2.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function lockRuntimeToolAuthority(
  tx: TaskSessionDbTransaction,
  capability: AgentRunCapability,
  toolName: PaperclipManagedToolName,
  now: Date,
  options: { additionalLaneTargetAgentId?: string } = {},
): Promise<AuthorizedRuntimeAction> {
  await lockRuntimeActionHierarchy(tx, capability, now, {
    additionalLaneTargetAgentId: options.additionalLaneTargetAgentId,
  });
  // Run transitions own their attempt and lease projections. The canonical
  // hierarchy/Session lock above matches every lifecycle producer; the run
  // and capability locks below recheck the exact prompt authority.
  await lockRuntimeActionRun(tx, capability);
  try {
    await lockActivePromptCapabilityBinding(tx, capability, now);
  } catch {
    throw new RuntimeTaskActionDenied(
      "Prompt capability is inactive, expired, or no longer exact",
      "prompt_capability_invalid",
    );
  }
  await tx.execute(
    sql`select ${taskExecutionRefs.id} from ${taskExecutionRefs} where ${taskExecutionRefs.id} = ${capability.refId} for update`,
  );

  const [companyRows, companyAgents, sessionRows, refRows, taskRows] = await Promise.all([
    tx.select().from(companies).where(eq(companies.id, capability.companyId)).limit(1),
    tx.select().from(agents).where(eq(agents.companyId, capability.companyId)).orderBy(asc(agents.id)),
    tx
      .select({
        session: taskSessions,
        contextGeneration: taskSessionContextEpochs.generation,
      })
      .from(taskSessions)
      .innerJoin(
        taskSessionContextEpochs,
        and(
          eq(taskSessionContextEpochs.companyId, taskSessions.companyId),
          eq(taskSessionContextEpochs.taskId, taskSessions.taskId),
          eq(taskSessionContextEpochs.sessionId, taskSessions.id),
        ),
      )
      .where(eq(taskSessions.id, capability.sessionId))
      .limit(1),
    tx.select().from(taskExecutionRefs).where(eq(taskExecutionRefs.id, capability.refId)).limit(1),
    tx.select().from(tasks).where(eq(tasks.id, capability.taskId)).limit(1),
  ]);
  const company = companyRows[0];
  const sessionState = sessionRows[0];
  const taskSession = sessionState?.session;
  const ref = refRows[0];
  const task = taskRows[0];

  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new RuntimeTaskActionDenied("Company Session lifecycle is not ready", "company_inactive");
  }
  if (
    !taskSession ||
    taskSession.companyId !== capability.companyId ||
    taskSession.taskId !== capability.taskId ||
    taskSession.integrityState !== "ready" ||
    taskSession.refAdmittableAt === null ||
    taskSession.timeArchived !== null ||
    taskSession.purgeFencedAt !== null
  ) {
    throw new RuntimeTaskActionDenied("Task Session is not ready", "task_session_invalid");
  }
  if (
    !ref ||
    ref.companyId !== capability.companyId ||
    ref.taskId !== capability.taskId ||
    ref.sessionId !== capability.sessionId ||
    ref.mode !== capability.executionMode ||
    ref.ownershipEpoch !== capability.ownershipEpoch ||
    ref.targetAgentId !== capability.targetAgentId ||
    ref.taskExecutionAuthorityId !== capability.taskExecutionAuthorityId ||
    ref.consultExecutionId !== capability.consultExecutionId ||
    ref.adapterConfigRevisionId !== capability.adapterConfigIdentity ||
    ref.disposition !== "active"
  ) {
    throw new RuntimeTaskActionDenied("Task-execution reference is no longer exact", "execution_ref_invalid");
  }
  if (
    !task ||
    task.companyId !== capability.companyId ||
    task.ownershipEpoch !== capability.ownershipEpoch ||
    task.hiddenAt !== null
  ) {
    throw new RuntimeTaskActionDenied("Task ownership epoch has changed", "ownership_epoch_changed");
  }
  if (
    capability.executionMode === "owner" &&
    (task.ownerKind !== "agent" || task.ownerAgentId !== capability.targetAgentId)
  ) {
    throw new RuntimeTaskActionDenied("Run no longer owns the task", "owner_changed");
  }

  if (capability.executionMode === "owner") {
    if (!capability.taskExecutionAuthorityId) {
      throw new RuntimeTaskActionDenied(
        "Owner run has no execution authority",
        "execution_authority_invalid",
      );
    }
    const authority = await tx
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.id, capability.taskExecutionAuthorityId),
          eq(taskExecutionAuthorities.companyId, capability.companyId),
          eq(taskExecutionAuthorities.taskId, capability.taskId),
          eq(taskExecutionAuthorities.sessionId, capability.sessionId),
          eq(taskExecutionAuthorities.ownershipEpoch, capability.ownershipEpoch),
          eq(taskExecutionAuthorities.agentId, capability.targetAgentId),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!authority) {
      throw new RuntimeTaskActionDenied(
        "Task-execution authority is no longer current",
        "execution_authority_invalid",
      );
    }
  } else {
    if (!capability.consultExecutionId) {
      throw new RuntimeTaskActionDenied("Consult run has no consult execution", "consult_execution_invalid");
    }
    const consult = await tx
      .select()
      .from(taskConsultExecutions)
      .where(
        and(
          eq(taskConsultExecutions.id, capability.consultExecutionId),
          eq(taskConsultExecutions.companyId, capability.companyId),
          eq(taskConsultExecutions.taskId, capability.taskId),
          eq(taskConsultExecutions.sessionId, capability.sessionId),
          eq(taskConsultExecutions.ownershipEpoch, capability.ownershipEpoch),
          eq(taskConsultExecutions.targetAgentId, capability.targetAgentId),
          eq(taskConsultExecutions.adapterConfigRevisionId, capability.adapterConfigIdentity),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!consult) {
      throw new RuntimeTaskActionDenied("Consult execution is no longer active", "consult_execution_invalid");
    }
  }

  const caller = companyAgents.find((candidate) => candidate.id === capability.targetAgentId);
  const invokability = evaluateAgentInvokability(caller, companyAgents);
  if (!invokability.invokable) {
    throw new RuntimeTaskActionDenied(invokability.message, `agent_not_invokable:${invokability.reason}`);
  }

  let catalog: RuntimeInterfaceCompileInput;
  let toolAvailable: boolean;
  try {
    catalog = await createPostgresRuntimeInterfaceCompiler(tx as unknown as Db).resolve(capability);
    toolAvailable = resolveRuntimeToolDescriptor(catalog, toolName)?.source === "paperclip";
  } catch (error) {
    throw new RuntimeTaskActionDenied(
      error instanceof Error ? error.message : "Runtime interface could not be recompiled",
      "catalog_revalidation_failed",
    );
  }
  if (!toolAvailable) {
    throw new RuntimeTaskActionDenied(
      `Current runtime catalog no longer exposes ${toolName}`,
      "runtime_tool_unavailable",
    );
  }
  return {
    company,
    companyAgents,
    task,
    taskSession,
    contextGeneration: sessionState.contextGeneration,
    ref,
    catalog,
  };
}

export function ownerAgentId(owner: RuntimeTaskOwnerChoice, callerAgentId: string): string {
  return owner.kind === "self" ? callerAgentId : owner.agentId;
}

export async function assertTargetAdapterRevision(
  tx: TaskSessionDbTransaction,
  companyId: string,
  targetAgentId: string,
): Promise<string> {
  try {
    const resolved = await resolveInvokableTaskOwnerInTransaction(tx, {
      companyId,
      ownerAgentId: targetAgentId,
    });
    return resolved.revisionId;
  } catch (error) {
    if (error instanceof InvokableTaskOwnerRejected) {
      const reason = error.reason.startsWith("owner_not_invokable:")
        ? `target_not_invokable:${error.reason.slice("owner_not_invokable:".length)}`
        : "target_revision_missing";
      throw new RuntimeTaskActionDenied(error.message, reason);
    }
    throw error;
  }
}

export function assertCreateOwnerCatalog(
  authorized: AuthorizedRuntimeAction,
  owner: RuntimeTaskOwnerChoice,
): string {
  if (owner.kind === "self") return authorized.ref.targetAgentId;
  if (!authorized.catalog.taskCreateDirectChildren.some((candidate) => candidate.id === owner.agentId)) {
    throw new RuntimeTaskActionDenied(
      "The selected owner is no longer a direct eligible child",
      "owner_catalog_changed",
    );
  }
  return owner.agentId;
}

export function assertAssignOwnerCatalog(
  authorized: AuthorizedRuntimeAction,
  taskId: string,
  owner: RuntimeTaskOwnerChoice,
): string {
  const target = authorized.catalog.taskAssignTargets.find((candidate) => candidate.taskId === taskId);
  if (!target) {
    throw new RuntimeTaskActionDenied(
      "The task is no longer in the caller's creator catalog",
      "creator_catalog_changed",
    );
  }
  if (owner.kind === "self") {
    if (!target.owners.some((candidate) => candidate.kind === "self")) {
      throw new RuntimeTaskActionDenied("Self ownership is no longer available", "owner_catalog_changed");
    }
    return authorized.ref.targetAgentId;
  }
  if (!target.owners.some((candidate) => candidate.kind === "agent" && candidate.id === owner.agentId)) {
    throw new RuntimeTaskActionDenied(
      "The selected owner is no longer in the target's owner catalog",
      "owner_catalog_changed",
    );
  }
  return owner.agentId;
}
