import { randomUUID } from "node:crypto";
import { settleAcpPromptInTransaction } from "./acp-prompt-settlement.js";
import type { BudgetEnforcementScope } from "./budgets.js";
import { preserveCorrelationAfterNonProtocolClosure } from "./task-execution-correlation-retention.js";
import {
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  assertCurrentAttempt,
  boundedReason,
  deterministicUuid,
  ensureAssistantStarted,
  lockCapability,
  recordNativeCancellationSettlement,
  reject,
  revokeCapability,
  settleNonProtocolPromptInTransaction,
  sha256,
  supersedeCorrelation,
  terminalAssistantText,
  terminalOutcome,
  transactionClockTimestamp,
} from "./task-execution-prompt-cycle-postgres-shared.js";
import {
  lockTaskSessionProjectionRoot,
  reserveTaskSessionEventSequence,
} from "./task-session/event-store.js";
import type {
  CreatePostgresTaskExecutionPromptCycleRepositoryResult,
  PostgresTaskExecutionPromptCycleOptions,
} from "./task-execution-prompt-cycle-postgres.js";

export function createPostgresTaskExecutionPromptCycleRepositoryPart4(
  options: PostgresTaskExecutionPromptCycleOptions,
) {
  const idFactory = options.idFactory ?? randomUUID;
  const capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs < 1) {
    reject("prompt capability TTL must be a positive integer");
  }
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000) {
    reject("attempt lease TTL must be at least one second");
  }
  const leaseRenewalIntervalMs = Math.max(1, Math.floor(Math.min(leaseTtlMs, capabilityTtlMs) / 3));
  const endpoint = new URL(options.capabilityEndpoint);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    reject("prompt capability endpoint must use HTTP transport");
  }

  return {
    async closePrompt({ prompt, capability, outcome }) {
      let budgetScopes: readonly BudgetEnforcementScope[] = Object.freeze([]);
      const result = await options.database.transaction(async (transaction) => {
        // Closure may publish the assistant boundary. Lock its FK parents and
        // Session checkpoint before revalidating the run and capability.
        await lockTaskSessionProjectionRoot(transaction, {
          companyId: prompt.identity.companyId,
          taskId: prompt.identity.taskId,
          sessionId: prompt.identity.sessionId,
        });
        const { lease } = await assertCurrentAttempt(transaction, options.runService, prompt.identity);
        const currentCapability = await lockCapability(transaction, prompt.identity, capability);
        const timestamp = await transactionClockTimestamp(transaction, "prompt closure time");
        const nativeCancellation = outcome.kind === "cancelled";
        const preserveCorrelation = preserveCorrelationAfterNonProtocolClosure({
          turn: prompt.turn,
          carryContext: prompt.carryContext,
        });
        if (
          (outcome.kind === "cancelled" &&
            outcome.settlement !== null &&
            outcome.settlement.stopReason !== "cancelled") ||
          (outcome.kind === "settled" && outcome.settlement.stopReason === "cancelled")
        ) {
          reject("prompt cancellation closure disagrees with ACPX result status");
        }
        const steeringCancellationCapability =
          currentCapability.state === "revoked" &&
          currentCapability.revocationReason === "active_run_steering" &&
          currentCapability.revokedAt !== null &&
          nativeCancellation;
        if (
          lease.expiresAt <= timestamp ||
          (currentCapability.state !== "pending_setup" &&
            currentCapability.state !== "active" &&
            !steeringCancellationCapability) ||
          currentCapability.expiresAt <= timestamp
        ) {
          reject("prompt closure requires one live capability generation");
        }
        const protocolSettlement =
          outcome.kind === "settled"
            ? outcome.settlement
            : outcome.kind === "cancelled"
              ? outcome.settlement
              : null;
        if (protocolSettlement !== null) {
          if (currentCapability.state !== "active" && !steeringCancellationCapability) {
            reject("protocol settlement requires an active capability");
          }
          const assistantMessageId = await ensureAssistantStarted(transaction, prompt.identity, timestamp);
          const { seq } = await reserveTaskSessionEventSequence(transaction, {
            companyId: prompt.identity.companyId,
            taskId: prompt.identity.taskId,
            sessionId: prompt.identity.sessionId,
          });
          const settlementReferenceId = deterministicUuid(
            "paperclip-acp-prompt-settlement",
            `${prompt.identity.attemptId}:${capability.capabilityGeneration}`,
          );
          const settled = await settleAcpPromptInTransaction(transaction, {
            identity:
              prompt.identity.promptKind === "base"
                ? {
                    companyId: prompt.identity.companyId,
                    taskId: prompt.identity.taskId,
                    sessionId: prompt.identity.sessionId,
                    agentId: prompt.identity.targetAgentId,
                    runId: prompt.identity.runId,
                    runKind: prompt.identity.runKind,
                    promptKind: "base" as const,
                    refId: prompt.identity.refId,
                    runOrdinal: prompt.identity.refOrdinal,
                    segmentOrdinal: 0 as const,
                    attemptId: prompt.identity.attemptId,
                    adapterConfigRevisionId: prompt.identity.adapterConfigRevisionId,
                  }
                : {
                    companyId: prompt.identity.companyId,
                    taskId: prompt.identity.taskId,
                    sessionId: prompt.identity.sessionId,
                    agentId: prompt.identity.targetAgentId,
                    runId: prompt.identity.runId,
                    runKind: prompt.identity.runKind,
                    promptKind: "steering" as const,
                    refId: prompt.identity.refId,
                    runOrdinal: prompt.identity.refOrdinal,
                    segmentOrdinal: prompt.identity.segmentOrdinal,
                    attemptId: prompt.identity.attemptId,
                    adapterConfigRevisionId: prompt.identity.adapterConfigRevisionId,
                  },
            settlement: protocolSettlement,
            promptSettlementReferenceId: settlementReferenceId,
            terminalUsageReference: `acp-prompt:${prompt.identity.attemptId}:terminal-usage`,
            terminalStopReference: `acp-prompt:${prompt.identity.attemptId}:terminal-stop`,
            stepEnded: {
              eventId: `evt_${sha256(`acp-prompt:${prompt.identity.attemptId}:step-ended`).slice(0, 40)}`,
              eventSeq: seq,
              assistantMessageId,
            },
            settledAt: timestamp,
          });
          budgetScopes = settled.budgetSuspensionScopes;
          if (nativeCancellation) {
            const recordedCancellation = await recordNativeCancellationSettlement(
              transaction,
              prompt.identity,
              timestamp,
            );
            if (steeringCancellationCapability && !recordedCancellation) {
              reject("steering cancellation lost its exact active intent");
            }
          }
          if (!steeringCancellationCapability) {
            await revokeCapability(transaction, prompt.identity, capability, "protocol_settled", timestamp);
          }
          const finalText = await terminalAssistantText(transaction, prompt.identity, assistantMessageId);
          return {
            kind: "dispatch" as const,
            result: {
              kind: "terminal" as const,
              outcome: terminalOutcome(protocolSettlement.stopReason),
              reason: protocolSettlement.stopReason,
              finalText,
            },
          };
        }
        if (outcome.kind === "cancelled") {
          if (currentCapability.state !== "active" && !steeringCancellationCapability) {
            reject("native cancellation has no exact active capability");
          }
          await settleNonProtocolPromptInTransaction(transaction, prompt.identity, {
            state: "incomplete",
            outcome: "cancelled",
            referenceId: deterministicUuid("paperclip-acp-prompt-incomplete", prompt.identity.attemptId),
            at: timestamp,
          });
          const recordedCancellation = await recordNativeCancellationSettlement(
            transaction,
            prompt.identity,
            timestamp,
          );
          if (steeringCancellationCapability && !recordedCancellation) {
            reject("steering cancellation lost its exact active intent");
          }
          if (!steeringCancellationCapability) {
            await revokeCapability(
              transaction,
              prompt.identity,
              capability,
              "prompt_cancelled_incomplete",
              timestamp,
            );
            if (!preserveCorrelation) {
              await supersedeCorrelation(
                transaction,
                currentCapability.targetSessionCorrelationId,
                "prompt_cancelled_incomplete",
                timestamp,
              );
            }
          }
          return {
            kind: "dispatch" as const,
            result: {
              kind: "terminal" as const,
              outcome: "cancelled" as const,
              reason: "cancelled",
            },
          };
        }
        if (outcome.kind !== "error") {
          reject("protocol settlement closure did not commit");
        }
        const correlationId = currentCapability.targetSessionCorrelationId;
        if (!outcome.promptTransmitted) {
          const retryable =
            outcome.failure === "runtime" &&
            currentCapability.state === "pending_setup" &&
            prompt.sessionOperation === "new";
          await revokeCapability(
            transaction,
            prompt.identity,
            capability,
            retryable ? "pre_send_retry" : "pre_send_failure",
            timestamp,
          );
          if (retryable) {
            return {
              kind: "dispatch" as const,
              result: {
                kind: "retry" as const,
                reason: "transport_transient" as const,
                retryAt: new Date(timestamp.getTime() + 1_000),
              },
            };
          }
          if (!preserveCorrelation) {
            await supersedeCorrelation(
              transaction,
              prompt.storedCorrelation?.id ?? correlationId,
              "pre_send_failure",
              timestamp,
            );
          }
          await settleNonProtocolPromptInTransaction(transaction, prompt.identity, {
            state: "not_sent",
            outcome: "released_unsent",
            referenceId: deterministicUuid("paperclip-acp-prompt-not-sent", prompt.identity.attemptId),
            at: timestamp,
          });
          return {
            kind: "dispatch" as const,
            result: {
              kind: "terminal" as const,
              outcome: "failed" as const,
              reason: boundedReason(outcome.message, "pre_send_failure"),
            },
          };
        }
        if (currentCapability.state !== "active") {
          reject("post-send failure has no active exact capability");
        }
        await settleNonProtocolPromptInTransaction(transaction, prompt.identity, {
          state: "incomplete",
          outcome: "failed",
          referenceId: deterministicUuid("paperclip-acp-prompt-incomplete", prompt.identity.attemptId),
          at: timestamp,
        });
        await revokeCapability(
          transaction,
          prompt.identity,
          capability,
          "prompt_failed_incomplete",
          timestamp,
        );
        if (!preserveCorrelation) {
          await supersedeCorrelation(transaction, correlationId, "prompt_failed_incomplete", timestamp);
        }
        return {
          kind: "dispatch" as const,
          result: {
            kind: "terminal" as const,
            outcome: "failed" as const,
            reason: boundedReason(outcome.message, "post_send_incomplete"),
          },
        };
      });
      if (budgetScopes.length > 0) {
        await options.suspendBudgetScopes?.(budgetScopes);
      }
      return result;
    },
  } satisfies Partial<CreatePostgresTaskExecutionPromptCycleRepositoryResult>;
}
