import {
  agents,
  companies,
  taskConsultExecutions,
  taskExecutionAttempts,
  taskExecutionAuthorities,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  tasks,
} from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { type PromptCapabilityAuthenticationResult } from "./prompt-capability-gateway.js";
import { activeTaskTreePauseHoldExistsSql } from "./task-execution-lifecycle-gate.js";
import { lifecycleAcceptsExecution, terminalExecutionRef } from "./task-execution-terminal-eligibility.js";
import * as capabilityCore from "./prompt-capability-postgres-foundation.js";

export function buildPromptCapabilityGatewayPostgresPromptCapabilityPostgresValidation(
  scope: capabilityCore.PromptCapabilityGatewayPostgresContext,
) {
  const { db, runService } = scope;

  async function validateRow(
    row: capabilityCore.PromptCapabilityRow,
    at: Date,
  ): Promise<PromptCapabilityAuthenticationResult> {
    if (
      row.state !== "active" ||
      row.targetSessionCorrelationId === null ||
      row.activatedAt === null ||
      row.expiresAt <= at
    ) {
      return capabilityCore.inactive();
    }

    // The canonical run service is the only production owner allowed to read
    // the run envelope. Every other query below addresses a separately owned
    // exact authority/ref/attempt/lease/correlation fact.
    const run = await runService.readRun({
      companyId: row.companyId,
      taskId: row.taskId,
      runId: row.runId,
    });
    if (!run) return capabilityCore.invalid("run_not_found");
    if (!capabilityCore.runMatchesCapability(run, row)) {
      return capabilityCore.invalid("run_scope_changed");
    }

    const [
      companyRows,
      taskRows,
      agentRows,
      refRows,
      memberRows,
      controlRows,
      attemptRows,
      leaseRows,
      correlationRows,
      workspaceRows,
      authorityRows,
      consultRows,
    ] = await Promise.all([
      db
        .select({
          status: companies.status,
          integrity: companies.sessionIntegrityState,
        })
        .from(companies)
        .where(eq(companies.id, row.companyId))
        .limit(1),
      db
        .select({
          companyId: tasks.companyId,
          ownershipEpoch: tasks.ownershipEpoch,
          lifecycleStatus: tasks.lifecycleStatus,
          ownerKind: tasks.ownerKind,
          ownerAgentId: tasks.ownerAgentId,
          executionPaused: activeTaskTreePauseHoldExistsSql(tasks.companyId, tasks.id),
        })
        .from(tasks)
        .where(eq(tasks.id, row.taskId))
        .limit(1),
      db
        .select({
          companyId: agents.companyId,
          status: agents.status,
          currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
        })
        .from(agents)
        .where(eq(agents.id, row.targetAgentId))
        .limit(1),
      db.select().from(taskExecutionRefs).where(eq(taskExecutionRefs.id, row.refId)).limit(1),
      db
        .select()
        .from(taskExecutionRunRefs)
        .where(
          and(
            eq(taskExecutionRunRefs.runId, row.runId),
            eq(taskExecutionRunRefs.refId, row.refId),
            eq(taskExecutionRunRefs.refOrdinal, row.refOrdinal),
          ),
        )
        .limit(1),
      db
        .select()
        .from(taskExecutionRunControls)
        .where(eq(taskExecutionRunControls.runId, row.runId))
        .limit(1),
      db.select().from(taskExecutionAttempts).where(eq(taskExecutionAttempts.id, row.attemptId)).limit(1),
      db
        .select()
        .from(taskExecutionLeases)
        .where(
          and(
            eq(taskExecutionLeases.id, row.leaseId),
            gt(taskExecutionLeases.expiresAt, sql<Date>`clock_timestamp()`),
          ),
        )
        .limit(1),
      db
        .select()
        .from(taskExecutionSessions)
        .where(
          and(
            eq(taskExecutionSessions.companyId, row.companyId),
            eq(taskExecutionSessions.id, row.targetSessionCorrelationId),
          ),
        )
        .limit(1),
      db
        .select()
        .from(taskExecutionWorkspaceBindings)
        .where(eq(taskExecutionWorkspaceBindings.id, row.workspaceIdentity))
        .limit(1),
      row.taskExecutionAuthorityId
        ? db
            .select()
            .from(taskExecutionAuthorities)
            .where(eq(taskExecutionAuthorities.id, row.taskExecutionAuthorityId))
            .limit(1)
        : Promise.resolve([]),
      row.consultExecutionId
        ? db
            .select()
            .from(taskConsultExecutions)
            .where(eq(taskConsultExecutions.id, row.consultExecutionId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const company = companyRows[0];
    if (!company || company.status !== "active" || company.integrity !== "ready") {
      return capabilityCore.invalid("company_inactive");
    }
    const task = taskRows[0];
    const ref = refRows[0];
    if (
      !task ||
      task.companyId !== row.companyId ||
      task.ownershipEpoch !== row.ownershipEpoch ||
      (row.executionMode === "owner" &&
        (task.ownerKind !== "agent" || task.ownerAgentId !== row.targetAgentId))
    ) {
      return capabilityCore.invalid("ownership_epoch_changed");
    }
    const terminalEligible = ref
      ? terminalExecutionRef({
          sourceKind: ref.sourceKind,
          messageKind: ref.messageKind,
          mode: ref.mode,
        })
      : false;
    if (!lifecycleAcceptsExecution({ lifecycleStatus: task.lifecycleStatus, terminalEligible })) {
      return capabilityCore.invalid("task_lifecycle_terminal");
    }
    if (task.executionPaused) {
      return capabilityCore.invalid("task_execution_paused");
    }
    const agent = agentRows[0];
    if (
      !agent ||
      agent.companyId !== row.companyId ||
      agent.status === "terminated" ||
      agent.currentAdapterConfigRevisionId !== row.adapterConfigIdentity
    ) {
      return capabilityCore.invalid("adapter_revision_changed");
    }
    if (
      !ref ||
      ref.companyId !== row.companyId ||
      ref.taskId !== row.taskId ||
      ref.sessionId !== run.sessionId ||
      ref.ownershipEpoch !== row.ownershipEpoch ||
      ref.mode !== row.executionMode ||
      ref.targetAgentId !== row.targetAgentId ||
      ref.taskExecutionAuthorityId !== row.taskExecutionAuthorityId ||
      ref.consultExecutionId !== row.consultExecutionId ||
      ref.adapterConfigRevisionId !== row.adapterConfigIdentity ||
      ref.disposition !== "active"
    ) {
      return capabilityCore.invalid("ref_scope_changed");
    }
    const member = memberRows[0];
    if (
      !member ||
      member.companyId !== row.companyId ||
      member.taskId !== row.taskId ||
      member.sessionId !== run.sessionId ||
      member.batchDigest !== row.runBatchDigest ||
      member.attemptId !== row.attemptId ||
      member.protocolSettlementState !== null ||
      member.capabilityConnectionId !== row.capabilityConnectionId ||
      member.capabilityGeneration !== row.capabilityGeneration
    ) {
      return capabilityCore.invalid("run_ref_changed");
    }
    const control = controlRows[0];
    if (
      !control ||
      control.currentRefId !== row.refId ||
      control.currentOrdinal !== row.refOrdinal
    ) {
      return capabilityCore.invalid("current_prompt_changed");
    }
    const attempt = attemptRows[0];
    if (
      !attempt ||
      attempt.companyId !== row.companyId ||
      attempt.taskId !== row.taskId ||
      attempt.sessionId !== run.sessionId ||
      attempt.runId !== row.runId ||
      attempt.runKind !== run.kind ||
      attempt.refId !== row.refId ||
      attempt.refOrdinal !== row.refOrdinal ||
      attempt.state !== "running"
    ) {
      return capabilityCore.invalid("attempt_changed");
    }
    const lease = leaseRows[0];
    if (
      !lease ||
      lease.companyId !== row.companyId ||
      lease.taskId !== row.taskId ||
      lease.runId !== row.runId ||
      lease.attemptId !== row.attemptId ||
      lease.leaseGeneration !== row.leaseGeneration ||
      lease.state !== "active" ||
      lease.expiresAt <= at
    ) {
      return capabilityCore.invalid("lease_lost");
    }
    const workspace = workspaceRows[0];
    if (
      !workspace ||
      workspace.companyId !== row.companyId ||
      workspace.taskId !== row.taskId ||
      workspace.sessionId !== run.sessionId ||
      workspace.ownershipEpoch !== row.ownershipEpoch
    ) {
      return capabilityCore.invalid("workspace_changed");
    }
    const authority = authorityRows[0];
    if (
      row.executionMode === "owner" &&
      (!authority ||
        authority.companyId !== row.companyId ||
        authority.taskId !== row.taskId ||
        authority.sessionId !== run.sessionId ||
        authority.ownershipEpoch !== row.ownershipEpoch ||
        authority.agentId !== row.targetAgentId ||
        authority.state !== "current")
    ) {
      return capabilityCore.invalid("owner_authority_revoked");
    }
    const consult = consultRows[0];
    if (
      row.executionMode === "consult" &&
      (!consult ||
        consult.companyId !== row.companyId ||
        consult.taskId !== row.taskId ||
        consult.sessionId !== run.sessionId ||
        consult.ownershipEpoch !== row.ownershipEpoch ||
        consult.targetAgentId !== row.targetAgentId ||
        consult.adapterConfigRevisionId !== row.adapterConfigIdentity ||
        consult.state !== "active")
    ) {
      return capabilityCore.invalid("consult_authority_revoked");
    }
    const correlation = correlationRows[0];
    const sameCorrelationScope = Boolean(
      correlation &&
      correlation.taskId === row.taskId &&
      correlation.ownershipEpoch === row.ownershipEpoch &&
      correlation.targetAgentId === row.targetAgentId &&
      correlation.adapterConfigIdentity === row.adapterConfigIdentity &&
      correlation.workspaceIdentity === row.workspaceIdentity,
    );
    const currentCorrelation = Boolean(
      sameCorrelationScope &&
      correlation.state === "eligible" &&
      correlation.laneKind === row.laneKind &&
      correlation.authorizedContextExposureDigest === row.effectiveContextExposureDigest,
    );
    if (!currentCorrelation) {
      return capabilityCore.invalid("native_correlation_changed");
    }

    const capability = capabilityCore.projectBinding(row, run.sessionId);
    return capability ? { kind: "authenticated", capability } : capabilityCore.inactive();
  }

  async function activeRowByIdentity(input: {
    capabilityConnectionId: string;
    capabilityGeneration: number;
  }): Promise<{
    readonly row: capabilityCore.PromptCapabilityRow;
    readonly at: Date;
  } | null> {
    return db.transaction(async (transaction) => {
      const row = await transaction
        .select()
        .from(taskExecutionPromptCapabilities)
        .where(
          and(
            eq(taskExecutionPromptCapabilities.capabilityConnectionId, input.capabilityConnectionId),
            eq(taskExecutionPromptCapabilities.capabilityGeneration, input.capabilityGeneration),
            eq(taskExecutionPromptCapabilities.state, "active"),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      const at = await capabilityCore.transactionClockTimestamp(transaction);
      return row && row.expiresAt > at ? { row, at } : null;
    });
  }

  return { validateRow, activeRowByIdentity };
}
