import {
  taskExecutionPromptCapabilities,
  taskExecutionRunRefs,
  taskExecutionSessions,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as promptCycle from "./task-execution-prompt-cycle-postgres-shared.js";
import type {
  CreatePostgresTaskExecutionPromptCycleRepositoryResult,
  PostgresTaskExecutionPromptCycleOptions,
} from "./task-execution-prompt-cycle-postgres.js";

export function createPostgresTaskExecutionPromptCycleRepositoryPart3(
  options: PostgresTaskExecutionPromptCycleOptions,
) {
  const idFactory = options.idFactory ?? randomUUID;
  const capabilityTtlMs = options.capabilityTtlMs ?? promptCycle.DEFAULT_CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs < 1) {
    promptCycle.reject("prompt capability TTL must be a positive integer");
  }
  const leaseTtlMs = options.leaseTtlMs ?? promptCycle.DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000) {
    promptCycle.reject("attempt lease TTL must be at least one second");
  }
  const leaseRenewalIntervalMs = Math.max(1, Math.floor(Math.min(leaseTtlMs, capabilityTtlMs) / 3));
  const endpoint = new URL(options.capabilityEndpoint);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    promptCycle.reject("prompt capability endpoint must use HTTP transport");
  }

  return {
    async activatePrompt({ prompt, capability, correlation }) {
      await options.database.transaction(async (transaction) => {
        const { lease } = await promptCycle.assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const currentCapability = await promptCycle.lockCapability(transaction, prompt.identity, capability);
        const scope = prompt.activationCorrelationScope;
        const timestamp = await promptCycle.transactionClockTimestamp(transaction, "prompt activation time");
        if (
          lease.expiresAt <= timestamp ||
          currentCapability.state !== "pending_setup" ||
          currentCapability.targetSessionCorrelationId !== null ||
          currentCapability.activatedAt !== null ||
          currentCapability.expiresAt <= timestamp
        ) {
          promptCycle.reject("capability is not pending exact prompt activation");
        }
        const old = await promptCycle.selectCurrentCorrelation(transaction, {
          identity: prompt.identity,
          carryContext: prompt.carryContext,
          effectiveContextExposureDigest: prompt.effectiveContextExposureDigest,
          targetFingerprint: scope.targetFingerprint,
        });
        const incompatibleCarryRows = !prompt.carryContext
          ? await transaction
              .select({ id: taskExecutionSessions.id })
              .from(taskExecutionSessions)
              .where(
                and(
                  eq(taskExecutionSessions.companyId, prompt.identity.companyId),
                  eq(taskExecutionSessions.taskId, prompt.identity.taskId),
                  eq(taskExecutionSessions.ownershipEpoch, prompt.identity.ownershipEpoch),
                  eq(taskExecutionSessions.targetAgentId, prompt.identity.targetAgentId),
                  eq(taskExecutionSessions.adapterConfigIdentity, prompt.identity.adapterConfigRevisionId),
                  eq(taskExecutionSessions.workspaceIdentity, prompt.identity.executionWorkspaceBindingId),
                  eq(taskExecutionSessions.state, "eligible"),
                  eq(taskExecutionSessions.laneKind, prompt.identity.laneKind),
                ),
              )
              .limit(2)
              .for("update")
          : [];
        if (incompatibleCarryRows.length > 1) {
          promptCycle.reject("false-carry activation found ambiguous stale carry state");
        }
        const replacedCorrelationIds = new Set<string>([
          ...(old ? [old.id] : []),
          ...(prompt.storedCorrelation ? [prompt.storedCorrelation.id] : []),
          ...incompatibleCarryRows.map((row) => row.id),
        ]);
        for (const correlationId of replacedCorrelationIds) {
          await promptCycle.supersedeCorrelation(
            transaction,
            correlationId,
            "generation_replaced",
            timestamp,
          );
        }
        const cursorSourceId = prompt.storedCorrelation?.id ?? old?.id ?? null;
        const oldCursor = cursorSourceId
          ? await transaction
              .select()
              .from(taskExecutionSessions)
              .where(eq(taskExecutionSessions.id, cursorSourceId))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const correlationId = idFactory();
        await transaction.insert(taskExecutionSessions).values({
          id: correlationId,
          companyId: prompt.identity.companyId,
          taskId: prompt.identity.taskId,
          ownershipEpoch: prompt.identity.ownershipEpoch,
          state: "eligible",
          targetAgentId: prompt.identity.targetAgentId,
          adapterConfigIdentity: prompt.identity.adapterConfigRevisionId,
          workspaceIdentity: prompt.identity.executionWorkspaceBindingId,
          laneKind: scope.laneKind,
          authorizedContextExposureDigest: scope.authorizedContextExposureDigest,
          envelopeVersion: correlation.envelopeVersion,
          codecKind: correlation.codecKind,
          acpWireProtocolVersion: 1,
          protectedTargetSession: correlation.ciphertext,
          protectedTargetSessionDigest: correlation.digest,
          targetFingerprint: scope.targetFingerprint,
          correlationGeneration: scope.correlationGeneration,
          lastProtocolSettledRunId: oldCursor?.lastProtocolSettledRunId ?? null,
          lastProtocolSettledRefId: oldCursor?.lastProtocolSettledRefId ?? null,
          lastProtocolSettledRefOrdinal: oldCursor?.lastProtocolSettledRefOrdinal ?? null,
          costCursorState: oldCursor?.costCursorState ?? "unanchored",
          costCursorAmount: oldCursor?.costCursorAmount ?? null,
          costCursorCurrency: oldCursor?.costCursorCurrency ?? null,
          supersessionReason: null,
          supersededAt: null,
          createdAt: timestamp,
        });
        const activated = await transaction
          .update(taskExecutionPromptCapabilities)
          .set({
            state: "active",
            targetSessionCorrelationId: correlationId,
            activatedAt: timestamp,
          })
          .where(
            and(
              eq(taskExecutionPromptCapabilities.capabilityConnectionId, capability.capabilityConnectionId),
              eq(taskExecutionPromptCapabilities.capabilityGeneration, capability.capabilityGeneration),
              eq(taskExecutionPromptCapabilities.state, "pending_setup"),
            ),
          )
          .returning({
            capabilityConnectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
          });
        if (activated.length !== 1) promptCycle.reject("prompt activation lost its capability");
      });
    },
    async beginPromptTransmission({ prompt, capability }) {
      await options.database.transaction(async (transaction) => {
        const { lease } = await promptCycle.assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const currentCapability = await promptCycle.lockCapability(transaction, prompt.identity, capability);
        const timestamp = await promptCycle.transactionClockTimestamp(
          transaction,
          "prompt transmission time",
        );
        if (
          lease.expiresAt <= timestamp ||
          currentCapability.state !== "active" ||
          !currentCapability.targetSessionCorrelationId ||
          currentCapability.expiresAt <= timestamp
        ) {
          promptCycle.reject("prompt transmission requires one active capability");
        }
        const changed = await transaction
          .update(taskExecutionRunRefs)
          .set({ promptTransmissionPhase: "transmitted" })
          .where(
            and(
              eq(taskExecutionRunRefs.runId, prompt.identity.runId),
              eq(taskExecutionRunRefs.refId, prompt.identity.refId),
              eq(taskExecutionRunRefs.refOrdinal, prompt.identity.refOrdinal),
              eq(taskExecutionRunRefs.attemptId, prompt.identity.attemptId),
              eq(taskExecutionRunRefs.promptTransmissionPhase, "not_transmitted"),
              sql`${taskExecutionRunRefs.protocolSettlementState} is null`,
            ),
          )
          .returning({ runId: taskExecutionRunRefs.runId });
        if (changed.length !== 1) promptCycle.reject("prompt transmission was not monotonic");
      });
    },
  } satisfies Partial<CreatePostgresTaskExecutionPromptCycleRepositoryResult>;
}
