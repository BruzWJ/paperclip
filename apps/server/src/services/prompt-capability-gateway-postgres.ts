import {
  agents,
  companies,
  issueConsultExecutions,
  issueExecutionAttempts,
  issueExecutionAuthorities,
  issueExecutionLeases,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRefs,
  issueExecutionRunControls,
  issueExecutionRunRefs,
  issueExecutionSessions,
  issueExecutionWorkspaceBindings,
  issues,
  pluginRunContexts,
  plugins,
  runInterfaceToolCalls,
  toolAccessAuditEvents,
  type Db,
} from "@paperclipai/db";
import { and, eq, gt, or, sql } from "drizzle-orm";
import type { RuntimeInterfaceCompileInput } from "./runtime-interface-compiler.js";
import type { IssueExecutionRunService } from "./issue-execution-run-service.js";
import {
  PromptCapabilityAuthorityError,
  type PromptCapabilityAuthenticationResult,
  type PromptCapabilityBinding,
  type PromptCapabilityGatewayRepository,
} from "./prompt-capability-gateway.js";
import type {
  IssueSessionDbTransaction,
} from "./issue-session/event-store.js";
import { activeIssueTreePauseHoldExistsSql } from "./issue-execution-lifecycle-gate.js";
import { lockPluginInstallationCompanyScopeInTransaction } from "./plugin-authorization-locks.js";
import { pluginManifestDeclaresAgentTool } from "./plugin-agent-tool-authority.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";

interface PromptCapabilityCompiler {
  resolve(
    capability: PromptCapabilityBinding,
  ): Promise<RuntimeInterfaceCompileInput>;
}

type PromptCapabilityRow =
  typeof issueExecutionPromptCapabilities.$inferSelect;

async function transactionClockTimestamp(
  transaction: IssueSessionDbTransaction,
): Promise<Date> {
  const rows = Array.from(
    await transaction.execute(sql<{ timestamp: Date }>`
      select clock_timestamp() as "timestamp"
    `),
  );
  const timestamp = rows[0]?.timestamp;
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    throw new PromptCapabilityAuthorityError("database_clock_invalid");
  }
  return timestamp;
}

function inactive(): PromptCapabilityAuthenticationResult {
  return { kind: "inactive" };
}

function invalid(reason: string): PromptCapabilityAuthenticationResult {
  return { kind: "authority_invalid", reason };
}

function sameBinding(
  left: PromptCapabilityBinding,
  right: PromptCapabilityBinding,
): boolean {
  return left.companyId === right.companyId &&
    left.capabilityConnectionId === right.capabilityConnectionId &&
    left.capabilityGeneration === right.capabilityGeneration &&
    left.runId === right.runId &&
    left.runBatchDigest === right.runBatchDigest &&
    left.refId === right.refId &&
    left.refOrdinal === right.refOrdinal &&
    left.segmentOrdinal === right.segmentOrdinal &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.workerProcessIdentity === right.workerProcessIdentity &&
    left.issueId === right.issueId &&
    left.sessionId === right.sessionId &&
    left.ownershipEpoch === right.ownershipEpoch &&
    left.targetAgentId === right.targetAgentId &&
    left.laneKind === right.laneKind &&
    left.executionMode === right.executionMode &&
    left.issueExecutionAuthorityId === right.issueExecutionAuthorityId &&
    left.consultExecutionId === right.consultExecutionId &&
    left.adapterConfigIdentity === right.adapterConfigIdentity &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.targetSessionCorrelationId === right.targetSessionCorrelationId &&
    left.effectiveContextExposureDigest ===
      right.effectiveContextExposureDigest &&
    left.effectiveToolsDigest === right.effectiveToolsDigest &&
    left.activatedAt.getTime() === right.activatedAt.getTime() &&
    left.createdAt.getTime() === right.createdAt.getTime();
}

function rowMatchesBinding(
  row: PromptCapabilityRow,
  capability: PromptCapabilityBinding,
): boolean {
  return row.companyId === capability.companyId &&
    row.capabilityConnectionId === capability.capabilityConnectionId &&
    row.capabilityGeneration === capability.capabilityGeneration &&
    row.runId === capability.runId &&
    row.runBatchDigest === capability.runBatchDigest &&
    row.refId === capability.refId &&
    row.refOrdinal === capability.refOrdinal &&
    row.segmentOrdinal === capability.segmentOrdinal &&
    row.attemptId === capability.attemptId &&
    row.leaseId === capability.leaseId &&
    row.leaseGeneration === capability.leaseGeneration &&
    row.workerProcessIdentity === capability.workerProcessIdentity &&
    row.issueId === capability.issueId &&
    row.ownershipEpoch === capability.ownershipEpoch &&
    row.targetAgentId === capability.targetAgentId &&
    row.laneKind === capability.laneKind &&
    row.executionMode === capability.executionMode &&
    row.issueExecutionAuthorityId === capability.issueExecutionAuthorityId &&
    row.consultExecutionId === capability.consultExecutionId &&
    row.adapterConfigIdentity === capability.adapterConfigIdentity &&
    row.workspaceIdentity === capability.workspaceIdentity &&
    row.targetSessionCorrelationId === capability.targetSessionCorrelationId &&
    row.effectiveContextExposureDigest ===
      capability.effectiveContextExposureDigest &&
    row.effectiveToolsDigest === capability.effectiveToolsDigest &&
    row.activatedAt?.getTime() === capability.activatedAt.getTime() &&
    row.createdAt.getTime() === capability.createdAt.getTime();
}

/**
 * Mutation-side fence for an already authenticated capability. The gateway
 * performs the full canonical run/ref/attempt/lease/correlation revalidation;
 * action transactions lock this exact generation so revocation/finalization
 * cannot race the protected mutation.
 */
export async function lockActivePromptCapabilityBinding(
  transaction: IssueSessionDbTransaction,
  capability: PromptCapabilityBinding,
  _at: Date,
): Promise<void> {
  const row = await transaction
    .select()
    .from(issueExecutionPromptCapabilities)
    .where(
      and(
        eq(
          issueExecutionPromptCapabilities.capabilityConnectionId,
          capability.capabilityConnectionId,
        ),
        eq(
          issueExecutionPromptCapabilities.capabilityGeneration,
          capability.capabilityGeneration,
        ),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const timestamp = await transactionClockTimestamp(transaction);
  if (
    !row ||
    row.state !== "active" ||
    row.expiresAt <= timestamp ||
    !rowMatchesBinding(row, capability)
  ) {
    throw new PromptCapabilityAuthorityError(
      "capability_generation_changed",
    );
  }
}

function projectBinding(input: {
  row: PromptCapabilityRow;
  sessionId: string;
}): PromptCapabilityBinding | null {
  const { row } = input;
  if (
    row.state !== "active" ||
    row.targetSessionCorrelationId === null ||
    row.activatedAt === null ||
    (row.executionMode !== "owner" && row.executionMode !== "consult") ||
    row.executionMode !== row.laneKind
  ) {
    return null;
  }
  return Object.freeze({
    companyId: row.companyId,
    capabilityConnectionId: row.capabilityConnectionId,
    capabilityGeneration: row.capabilityGeneration,
    runId: row.runId,
    runBatchDigest: row.runBatchDigest,
    refId: row.refId,
    refOrdinal: row.refOrdinal,
    segmentOrdinal: row.segmentOrdinal,
    attemptId: row.attemptId,
    leaseId: row.leaseId,
    leaseGeneration: row.leaseGeneration,
    workerProcessIdentity: row.workerProcessIdentity,
    issueId: row.issueId,
    sessionId: input.sessionId,
    ownershipEpoch: row.ownershipEpoch,
    targetAgentId: row.targetAgentId,
    laneKind: row.laneKind,
    executionMode: row.executionMode,
    issueExecutionAuthorityId: row.issueExecutionAuthorityId,
    consultExecutionId: row.consultExecutionId,
    adapterConfigIdentity: row.adapterConfigIdentity,
    workspaceIdentity: row.workspaceIdentity,
    targetSessionCorrelationId: row.targetSessionCorrelationId,
    effectiveContextExposureDigest: row.effectiveContextExposureDigest,
    effectiveToolsDigest: row.effectiveToolsDigest,
    expiresAt: row.expiresAt,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  });
}

function projectIngressBinding(row: PromptCapabilityRow) {
  return Object.freeze({
    companyId: row.companyId,
    capabilityConnectionId: row.capabilityConnectionId,
    capabilityGeneration: row.capabilityGeneration,
    runId: row.runId,
    refId: row.refId,
    refOrdinal: row.refOrdinal,
    segmentOrdinal: row.segmentOrdinal,
    issueId: row.issueId,
    targetAgentId: row.targetAgentId,
  });
}

export function createPostgresPromptCapabilityGatewayRepository(
  db: Db,
  compiler: PromptCapabilityCompiler,
  runService: Pick<IssueExecutionRunService, "readRun">,
): PromptCapabilityGatewayRepository {
  async function validateRow(
    row: PromptCapabilityRow,
    at: Date,
  ): Promise<PromptCapabilityAuthenticationResult> {
    if (
      row.state !== "active" ||
      row.targetSessionCorrelationId === null ||
      row.activatedAt === null ||
      row.expiresAt <= at
    ) {
      return inactive();
    }

    // The canonical run service is the only production owner allowed to read
    // the run envelope. Every other query below addresses a separately owned
    // exact authority/ref/attempt/lease/correlation fact.
    const run = await runService.readRun({
      companyId: row.companyId,
      issueId: row.issueId,
      runId: row.runId,
    });
    if (!run) return invalid("run_not_found");
    if (
      run.status !== "running" ||
      run.sessionId.length === 0 ||
      run.ownershipEpoch !== row.ownershipEpoch ||
      run.targetAgentId !== row.targetAgentId ||
      run.executionMode !== row.executionMode ||
      run.issueExecutionAuthorityId !== row.issueExecutionAuthorityId ||
      run.consultExecutionId !== row.consultExecutionId ||
      run.adapterConfigRevisionId !== row.adapterConfigIdentity ||
      run.executionWorkspaceBindingId !== row.workspaceIdentity ||
      run.currentAttemptId !== row.attemptId ||
      run.currentLeaseId !== row.leaseId ||
      run.cancellationIntentId !== null ||
      run.terminalFinalizationId !== null
    ) {
      return invalid("run_scope_changed");
    }

    const [
      companyRows,
      issueRows,
      agentRows,
      refRows,
      memberRows,
      segmentRows,
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
          companyId: issues.companyId,
          ownershipEpoch: issues.ownershipEpoch,
          lifecycleStatus: issues.lifecycleStatus,
          ownerKind: issues.ownerKind,
          ownerAgentId: issues.ownerAgentId,
          executionPaused: activeIssueTreePauseHoldExistsSql(
            issues.companyId,
            issues.id,
          ),
        })
        .from(issues)
        .where(eq(issues.id, row.issueId))
        .limit(1),
      db
        .select({
          companyId: agents.companyId,
          status: agents.status,
          currentAdapterConfigRevisionId:
            agents.currentAdapterConfigRevisionId,
        })
        .from(agents)
        .where(eq(agents.id, row.targetAgentId))
        .limit(1),
      db
        .select()
        .from(issueExecutionRefs)
        .where(eq(issueExecutionRefs.id, row.refId))
        .limit(1),
      db
        .select()
        .from(issueExecutionRunRefs)
        .where(
          and(
            eq(issueExecutionRunRefs.runId, row.runId),
            eq(issueExecutionRunRefs.refId, row.refId),
            eq(issueExecutionRunRefs.refOrdinal, row.refOrdinal),
          ),
        )
        .limit(1),
      row.segmentOrdinal === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(issueExecutionPromptSegments)
            .where(
              and(
                eq(issueExecutionPromptSegments.runId, row.runId),
                eq(issueExecutionPromptSegments.refId, row.refId),
                eq(
                  issueExecutionPromptSegments.refOrdinal,
                  row.refOrdinal,
                ),
                eq(
                  issueExecutionPromptSegments.segmentOrdinal,
                  row.segmentOrdinal,
                ),
              ),
            )
            .limit(1),
      db
        .select()
        .from(issueExecutionRunControls)
        .where(eq(issueExecutionRunControls.runId, row.runId))
        .limit(1),
      db
        .select()
        .from(issueExecutionAttempts)
        .where(eq(issueExecutionAttempts.id, row.attemptId))
        .limit(1),
      db
        .select()
        .from(issueExecutionLeases)
        .where(
          and(
            eq(issueExecutionLeases.id, row.leaseId),
            gt(issueExecutionLeases.expiresAt, sql<Date>`clock_timestamp()`),
          ),
        )
        .limit(1),
      db
        .select()
        .from(issueExecutionSessions)
        .where(
          and(
            eq(issueExecutionSessions.companyId, row.companyId),
            eq(issueExecutionSessions.id, row.targetSessionCorrelationId),
          ),
        )
        .limit(1),
      db
        .select()
        .from(issueExecutionWorkspaceBindings)
        .where(eq(issueExecutionWorkspaceBindings.id, row.workspaceIdentity))
        .limit(1),
      row.issueExecutionAuthorityId
        ? db
            .select()
            .from(issueExecutionAuthorities)
            .where(
              eq(
                issueExecutionAuthorities.id,
                row.issueExecutionAuthorityId,
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      row.consultExecutionId
        ? db
            .select()
            .from(issueConsultExecutions)
            .where(eq(issueConsultExecutions.id, row.consultExecutionId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const company = companyRows[0];
    if (
      !company ||
      company.status !== "active" ||
      company.integrity !== "ready"
    ) {
      return invalid("company_inactive");
    }
    const issue = issueRows[0];
    if (
      !issue ||
      issue.companyId !== row.companyId ||
      issue.ownershipEpoch !== row.ownershipEpoch ||
      (row.executionMode === "owner" &&
        (issue.ownerKind !== "agent" ||
          issue.ownerAgentId !== row.targetAgentId))
    ) {
      return invalid("ownership_epoch_changed");
    }
    if (!["open", "blocked"].includes(issue.lifecycleStatus)) {
      return invalid("issue_lifecycle_terminal");
    }
    if (issue.executionPaused) {
      return invalid("issue_execution_paused");
    }
    const agent = agentRows[0];
    if (
      !agent ||
      agent.companyId !== row.companyId ||
      agent.status === "terminated" ||
      agent.currentAdapterConfigRevisionId !== row.adapterConfigIdentity
    ) {
      return invalid("adapter_revision_changed");
    }
    const ref = refRows[0];
    if (
      !ref ||
      ref.companyId !== row.companyId ||
      ref.issueId !== row.issueId ||
      ref.sessionId !== run.sessionId ||
      ref.ownershipEpoch !== row.ownershipEpoch ||
      ref.mode !== row.executionMode ||
      ref.targetAgentId !== row.targetAgentId ||
      ref.issueExecutionAuthorityId !== row.issueExecutionAuthorityId ||
      ref.consultExecutionId !== row.consultExecutionId ||
      ref.adapterConfigRevisionId !== row.adapterConfigIdentity ||
      ref.disposition !== "active"
    ) {
      return invalid("ref_scope_changed");
    }
    const member = memberRows[0];
    if (
      !member ||
      member.companyId !== row.companyId ||
      member.issueId !== row.issueId ||
      member.sessionId !== run.sessionId ||
      member.batchDigest !== row.runBatchDigest ||
      member.attemptId !== row.attemptId ||
      member.protocolSettlementState !== null ||
      (row.segmentOrdinal === 0 &&
        (member.capabilityConnectionId !== row.capabilityConnectionId ||
          member.capabilityGeneration !== row.capabilityGeneration))
    ) {
      return invalid("run_ref_changed");
    }
    const segment = segmentRows[0];
    if (
      row.segmentOrdinal > 0 &&
      (!segment ||
        segment.companyId !== row.companyId ||
        segment.issueId !== row.issueId ||
        segment.sessionId !== run.sessionId ||
        segment.attemptId !== row.attemptId ||
        segment.capabilityConnectionId !== row.capabilityConnectionId ||
        segment.capabilityGeneration !== row.capabilityGeneration ||
        segment.protocolSettlementState !== null ||
        segment.steeringState !== "resumed")
    ) {
      return invalid("prompt_segment_changed");
    }
    const control = controlRows[0];
    if (
      !control ||
      control.currentRefId !== row.refId ||
      control.currentOrdinal !== row.refOrdinal ||
      control.currentSegmentOrdinal !== row.segmentOrdinal
    ) {
      return invalid("current_prompt_changed");
    }
    const attempt = attemptRows[0];
    if (
      !attempt ||
      attempt.companyId !== row.companyId ||
      attempt.issueId !== row.issueId ||
      attempt.sessionId !== run.sessionId ||
      attempt.runId !== row.runId ||
      attempt.runKind !== run.kind ||
      attempt.promptKind !==
        (row.segmentOrdinal === 0 ? "base" : "steering") ||
      attempt.refId !== row.refId ||
      attempt.refOrdinal !== row.refOrdinal ||
      attempt.segmentOrdinal !== row.segmentOrdinal ||
      attempt.state !== "running"
    ) {
      return invalid("attempt_changed");
    }
    const lease = leaseRows[0];
    if (
      !lease ||
      lease.companyId !== row.companyId ||
      lease.issueId !== row.issueId ||
      lease.runId !== row.runId ||
      lease.attemptId !== row.attemptId ||
      lease.leaseGeneration !== row.leaseGeneration ||
      lease.state !== "active" ||
      lease.expiresAt <= at
    ) {
      return invalid("lease_lost");
    }
    const workspace = workspaceRows[0];
    if (
      !workspace ||
      workspace.companyId !== row.companyId ||
      workspace.issueId !== row.issueId ||
      workspace.sessionId !== run.sessionId ||
      workspace.ownershipEpoch !== row.ownershipEpoch
    ) {
      return invalid("workspace_changed");
    }
    const authority = authorityRows[0];
    if (
      row.executionMode === "owner" &&
      (!authority ||
        authority.companyId !== row.companyId ||
        authority.issueId !== row.issueId ||
        authority.sessionId !== run.sessionId ||
        authority.ownershipEpoch !== row.ownershipEpoch ||
        authority.agentId !== row.targetAgentId ||
        authority.state !== "current")
    ) {
      return invalid("owner_authority_revoked");
    }
    const consult = consultRows[0];
    if (
      row.executionMode === "consult" &&
      (!consult ||
        consult.companyId !== row.companyId ||
        consult.issueId !== row.issueId ||
        consult.sessionId !== run.sessionId ||
        consult.ownershipEpoch !== row.ownershipEpoch ||
        consult.targetAgentId !== row.targetAgentId ||
        consult.adapterConfigRevisionId !== row.adapterConfigIdentity ||
        consult.state !== "active")
    ) {
      return invalid("consult_authority_revoked");
    }
    const correlation = correlationRows[0];
    const sameCorrelationScope = Boolean(
      correlation &&
        correlation.issueId === row.issueId &&
        correlation.ownershipEpoch === row.ownershipEpoch &&
        correlation.targetAgentId === row.targetAgentId &&
        correlation.adapterConfigIdentity === row.adapterConfigIdentity &&
        correlation.workspaceIdentity === row.workspaceIdentity,
    );
    const currentCarry = Boolean(
      sameCorrelationScope &&
        correlation?.purpose === "carry" &&
        correlation.state === "eligible" &&
        correlation.laneKind === row.laneKind,
    );
    const currentSteering = Boolean(
      sameCorrelationScope &&
        correlation?.purpose === "active_run_steering" &&
        correlation.state === "current" &&
        correlation.runId === row.runId &&
        correlation.currentRefId === row.refId &&
        correlation.currentRefOrdinal === row.refOrdinal &&
        correlation.currentSegmentOrdinal === row.segmentOrdinal,
    );
    if (!currentCarry && !currentSteering) {
      return invalid("native_correlation_changed");
    }

    const capability = projectBinding({ row, sessionId: run.sessionId });
    return capability
      ? { kind: "authenticated", capability }
      : inactive();
  }

  async function activeRowByIdentity(input: {
    capabilityConnectionId: string;
    capabilityGeneration: number;
  }): Promise<{ readonly row: PromptCapabilityRow; readonly at: Date } | null> {
    return db.transaction(async (transaction) => {
      const row = await transaction
        .select()
        .from(issueExecutionPromptCapabilities)
        .where(
          and(
            eq(
              issueExecutionPromptCapabilities.capabilityConnectionId,
              input.capabilityConnectionId,
            ),
            eq(
              issueExecutionPromptCapabilities.capabilityGeneration,
              input.capabilityGeneration,
            ),
            eq(issueExecutionPromptCapabilities.state, "active"),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      const at = await transactionClockTimestamp(transaction);
      return row && row.expiresAt > at ? { row, at } : null;
    });
  }

  return {
    async authenticateIngressBearerHash(bearerHash, _at) {
      const locked = await db.transaction(async (transaction) => {
        const row = await transaction
          .select()
          .from(issueExecutionPromptCapabilities)
          .where(
            and(
              eq(issueExecutionPromptCapabilities.bearerHash, bearerHash),
              or(
                eq(
                  issueExecutionPromptCapabilities.state,
                  "pending_setup",
                ),
                eq(issueExecutionPromptCapabilities.state, "active"),
              ),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        const at = await transactionClockTimestamp(transaction);
        return row && row.expiresAt > at ? { row, at } : null;
      });
      if (!locked) return inactive();
      const { row, at } = locked;
      if (row.state === "active") {
        const result = await validateRow(row, at);
        if (result.kind !== "authenticated") return result;
      }
      return {
        kind: "authenticated" as const,
        capability: projectIngressBinding(row),
      };
    },

    async authenticateBearerHash(bearerHash, _at) {
      const locked = await db.transaction(async (transaction) => {
        const row = await transaction
          .select()
          .from(issueExecutionPromptCapabilities)
          .where(
            and(
              eq(issueExecutionPromptCapabilities.bearerHash, bearerHash),
              eq(issueExecutionPromptCapabilities.state, "active"),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        const at = await transactionClockTimestamp(transaction);
        return row && row.expiresAt > at ? { row, at } : null;
      });
      return locked ? validateRow(locked.row, locked.at) : inactive();
    },

    async revalidate(capability, _at) {
      const locked = await activeRowByIdentity({
        capabilityConnectionId: capability.capabilityConnectionId,
        capabilityGeneration: capability.capabilityGeneration,
      });
      if (!locked) return inactive();
      const result = await validateRow(locked.row, locked.at);
      if (result.kind !== "authenticated") return result;
      return sameBinding(capability, result.capability)
        ? result
        : invalid("capability_generation_changed");
    },

    resolveCompileInput(capability) {
      return compiler.resolve(capability);
    },

    async createPluginRunContext(input) {
      await db.transaction(async (tx) => {
        const parent = await tx
          .select({
            state: issueExecutionPromptCapabilities.state,
            expiresAt: issueExecutionPromptCapabilities.expiresAt,
          })
          .from(issueExecutionPromptCapabilities)
          .where(
            and(
              eq(
                issueExecutionPromptCapabilities.capabilityConnectionId,
                input.capability.capabilityConnectionId,
              ),
              eq(
                issueExecutionPromptCapabilities.capabilityGeneration,
                input.capability.capabilityGeneration,
              ),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        const authorizationTime = await transactionClockTimestamp(tx);
        if (
          !parent ||
          parent.state !== "active" ||
          parent.expiresAt <= authorizationTime
        ) {
          throw new Error(
            "Prompt capability changed before plugin context binding",
          );
        }
        const call = await tx
          .select({
            id: runInterfaceToolCalls.id,
            toolName: runInterfaceToolCalls.toolName,
          })
          .from(runInterfaceToolCalls)
          .where(
            and(
              eq(
                runInterfaceToolCalls.id,
                input.runInterfaceToolCallId,
              ),
              eq(
                runInterfaceToolCalls.companyId,
                input.capability.companyId,
              ),
              eq(
                runInterfaceToolCalls.capabilityConnectionId,
                input.capability.capabilityConnectionId,
              ),
              eq(
                runInterfaceToolCalls.capabilityGeneration,
                input.capability.capabilityGeneration,
              ),
              eq(
                runInterfaceToolCalls.pluginInstallationId,
                input.pluginInstallationId,
              ),
              eq(runInterfaceToolCalls.status, "executing"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!call) {
          throw new Error(
            "Plugin context is not bound to the exact active tool call",
          );
        }
        const pluginScope = await lockPluginInstallationCompanyScopeInTransaction(
          tx,
          {
            pluginInstallationId: input.pluginInstallationId,
            companyId: input.capability.companyId,
          },
        );
        const installation = pluginScope.installation;
        if (
          installation?.status !== "ready" ||
          !pluginScope.company ||
          pluginManifestIdentity(installation.manifestJson) !==
            input.pluginManifestIdentity ||
          !pluginManifestDeclaresAgentTool(
            {
              pluginKey: installation.pluginKey,
              manifest: installation.manifestJson,
            },
            call.toolName,
          )
        ) {
          throw new Error(
            "Plugin context is not bound to a ready tool",
          );
        }
        await tx.insert(pluginRunContexts).values({
          capabilityConnectionId:
            input.capability.capabilityConnectionId,
          capabilityGeneration: input.capability.capabilityGeneration,
          runInterfaceToolCallId: input.runInterfaceToolCallId,
          pluginInstallationId: input.pluginInstallationId,
          handleHash: input.handleHash,
          firstUsedAt: null,
          createdAt: input.createdAt,
        });
      });
    },

    async resolvePluginRunContextHash(handleHash, at) {
      const child = await db
        .select()
        .from(pluginRunContexts)
        .where(eq(pluginRunContexts.handleHash, handleHash))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!child) return null;
      const locked = await activeRowByIdentity({
        capabilityConnectionId: child.capabilityConnectionId,
        capabilityGeneration: child.capabilityGeneration,
      });
      if (!locked) return null;
      const result = await validateRow(locked.row, locked.at);
      if (result.kind !== "authenticated") return null;
      const call = await db
        .select({
          id: runInterfaceToolCalls.id,
          status: runInterfaceToolCalls.status,
          toolName: runInterfaceToolCalls.toolName,
          pluginInstallationId: runInterfaceToolCalls.pluginInstallationId,
        })
        .from(runInterfaceToolCalls)
        .where(
          and(
            eq(runInterfaceToolCalls.id, child.runInterfaceToolCallId),
            eq(
              runInterfaceToolCalls.capabilityConnectionId,
              child.capabilityConnectionId,
            ),
            eq(
              runInterfaceToolCalls.capabilityGeneration,
              child.capabilityGeneration,
            ),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !call ||
        call.status !== "executing" ||
        call.pluginInstallationId !== child.pluginInstallationId
      ) {
        return null;
      }
      const installation = await db
        .select({
          status: plugins.status,
          pluginKey: plugins.pluginKey,
          manifestJson: plugins.manifestJson,
        })
        .from(plugins)
        .where(
          eq(plugins.id, child.pluginInstallationId),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        installation?.status !== "ready" ||
        !pluginManifestDeclaresAgentTool(
          {
            pluginKey: installation.pluginKey,
            manifest: installation.manifestJson,
          },
          call.toolName,
        )
      ) {
        return null;
      }
      if (child.firstUsedAt === null) {
        await db
          .update(pluginRunContexts)
          .set({ firstUsedAt: at })
          .where(
            and(
              eq(pluginRunContexts.handleHash, handleHash),
              eq(pluginRunContexts.capabilityConnectionId, child.capabilityConnectionId),
              eq(pluginRunContexts.capabilityGeneration, child.capabilityGeneration),
            ),
          );
      }
      return {
        capability: result.capability,
        runInterfaceToolCallId: child.runInterfaceToolCallId,
        pluginInstallationId: child.pluginInstallationId,
      };
    },

    async writeAudit(event, transaction) {
      if (!event.capability) return;
      await (transaction ?? db).insert(toolAccessAuditEvents).values({
        companyId: event.capability.companyId,
        actorType: "agent",
        actorId: event.capability.targetAgentId,
        action: `prompt_capability.${event.event}`,
        outcome: event.outcome,
        reasonCode: event.reason ?? null,
        correlationId:
          `${event.capability.capabilityConnectionId}:` +
          String(event.capability.capabilityGeneration),
        details: {
          capabilityConnectionId:
            event.capability.capabilityConnectionId,
          capabilityGeneration: event.capability.capabilityGeneration,
          issueId: event.capability.issueId,
          runId: event.capability.runId,
          refId: event.capability.refId,
          refOrdinal: event.capability.refOrdinal,
          segmentOrdinal: event.capability.segmentOrdinal,
          toolName: event.toolName,
          dialDigest: event.dialDigest,
          grantSnapshot: event.grantSnapshot,
        },
        createdAt: event.occurredAt,
      });
    },
  };
}
