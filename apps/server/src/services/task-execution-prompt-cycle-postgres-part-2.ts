import {
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRunRefs,
} from "@paperclipai/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { contextDialDigest } from "./context-dial-resolver.js";
import { mintPromptCapabilityBearer } from "./prompt-capability-gateway.js";
import { runtimeInterfaceDigest } from "./runtime-interface-compiler.js";
import * as promptCycle from "./task-execution-prompt-cycle-postgres-shared.js";
import type {
  CreatePostgresTaskExecutionPromptCycleRepositoryResult,
  PostgresTaskExecutionPromptCycleOptions,
} from "./task-execution-prompt-cycle-postgres.js";

export function createPostgresTaskExecutionPromptCycleRepositoryPart2(
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
    async renewPromptAuthority(prompt) {
      return options.database.transaction(async (transaction) => {
        const { lease } = await promptCycle.assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const capabilityRows = await transaction
          .select()
          .from(taskExecutionPromptCapabilities)
          .where(
            and(
              eq(taskExecutionPromptCapabilities.companyId, prompt.identity.companyId),
              eq(taskExecutionPromptCapabilities.taskId, prompt.identity.taskId),
              eq(taskExecutionPromptCapabilities.runId, prompt.identity.runId),
              eq(taskExecutionPromptCapabilities.refId, prompt.identity.refId),
              eq(taskExecutionPromptCapabilities.refOrdinal, prompt.identity.refOrdinal),
              eq(taskExecutionPromptCapabilities.segmentOrdinal, prompt.identity.segmentOrdinal),
              eq(taskExecutionPromptCapabilities.attemptId, prompt.identity.attemptId),
              eq(taskExecutionPromptCapabilities.leaseId, prompt.identity.leaseId),
              eq(taskExecutionPromptCapabilities.leaseGeneration, prompt.identity.leaseGeneration),
            ),
          )
          .limit(2)
          .for("update");
        const timestamp = await promptCycle.transactionClockTimestamp(
          transaction,
          "prompt authority renewal time",
        );
        if (capabilityRows.length > 1) {
          promptCycle.reject("prompt authority renewal found ambiguous capabilities");
        }
        const liveCapability =
          capabilityRows[0]?.state === "pending_setup" || capabilityRows[0]?.state === "active"
            ? capabilityRows[0]
            : null;
        if (lease.expiresAt <= timestamp) {
          promptCycle.rejectAuthorityLoss(
            prompt.identity,
            "prompt authority renewal cannot revive an expired lease",
          );
        }
        if (liveCapability && liveCapability.expiresAt <= timestamp) {
          promptCycle.rejectAuthorityLoss(
            prompt.identity,
            "prompt authority renewal cannot revive an expired capability",
          );
        }
        const expiresAt = new Date(timestamp.getTime() + leaseTtlMs);
        const renewed = await transaction
          .update(taskExecutionLeases)
          .set({ renewedAt: timestamp, expiresAt })
          .where(
            and(
              eq(taskExecutionLeases.id, prompt.identity.leaseId),
              eq(taskExecutionLeases.attemptId, prompt.identity.attemptId),
              eq(taskExecutionLeases.leaseGeneration, prompt.identity.leaseGeneration),
              eq(taskExecutionLeases.state, "active"),
              gt(taskExecutionLeases.expiresAt, timestamp),
            ),
          )
          .returning({ id: taskExecutionLeases.id });
        if (renewed.length !== 1) {
          promptCycle.rejectAuthorityLoss(
            prompt.identity,
            "attempt lease renewal lost its compare-and-set fence",
          );
        }
        const capabilityExpiresAt = new Date(
          Math.min(expiresAt.getTime(), timestamp.getTime() + capabilityTtlMs),
        );
        if (liveCapability) {
          const capabilityRenewed = await transaction
            .update(taskExecutionPromptCapabilities)
            .set({ expiresAt: capabilityExpiresAt })
            .where(
              and(
                eq(
                  taskExecutionPromptCapabilities.capabilityConnectionId,
                  liveCapability.capabilityConnectionId,
                ),
                eq(taskExecutionPromptCapabilities.capabilityGeneration, liveCapability.capabilityGeneration),
                inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
                gt(taskExecutionPromptCapabilities.expiresAt, timestamp),
              ),
            )
            .returning({
              capabilityConnectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
            });
          if (capabilityRenewed.length !== 1) {
            promptCycle.rejectAuthorityLoss(
              prompt.identity,
              "prompt capability renewal lost its compare-and-set fence",
            );
          }
        }
      });
    },
    async mintPendingCapability(prompt) {
      const compileInput = await options.compiler.resolve(promptCycle.promptCompileScope(prompt.identity));
      if (
        compileInput.turn !== prompt.turn ||
        contextDialDigest(compileInput.contextDial) !== prompt.effectiveContextExposureDigest ||
        runtimeInterfaceDigest(compileInput) !== prompt.effectiveToolsDigest
      ) {
        promptCycle.reject("runtime interface changed before capability mint");
      }
      const bearer = mintPromptCapabilityBearer();
      const bearerHash = promptCycle.sha256(bearer);
      return options.database.transaction(async (transaction) => {
        const { lease } = await promptCycle.assertCurrentAttempt(
          transaction,
          options.runService,
          prompt.identity,
        );
        const generationRows = await transaction
          .select({
            capabilityGeneration: taskExecutionPromptCapabilities.capabilityGeneration,
          })
          .from(taskExecutionPromptCapabilities)
          .where(eq(taskExecutionPromptCapabilities.runId, prompt.identity.runId))
          .orderBy(desc(taskExecutionPromptCapabilities.capabilityGeneration))
          .limit(1)
          .for("update");
        const timestamp = await promptCycle.transactionClockTimestamp(
          transaction,
          "capability creation time",
        );
        const capabilityGeneration = (generationRows[0]?.capabilityGeneration ?? 0) + 1;
        const capabilityConnectionId = idFactory();
        const expiresAt = new Date(
          Math.min(lease.expiresAt.getTime(), timestamp.getTime() + capabilityTtlMs),
        );
        if (expiresAt <= timestamp) promptCycle.reject("prompt lease expired before capability mint");
        const ownerRows =
          prompt.identity.promptKind === "base"
            ? await transaction
                .update(taskExecutionRunRefs)
                .set({
                  attemptId: prompt.identity.attemptId,
                  capabilityConnectionId,
                  capabilityGeneration,
                })
                .where(
                  and(
                    eq(taskExecutionRunRefs.runId, prompt.identity.runId),
                    eq(taskExecutionRunRefs.refId, prompt.identity.refId),
                    eq(taskExecutionRunRefs.refOrdinal, prompt.identity.refOrdinal),
                    sql`${taskExecutionRunRefs.protocolSettlementState} is null`,
                  ),
                )
                .returning({ runId: taskExecutionRunRefs.runId })
            : await transaction
                .update(taskExecutionPromptSegments)
                .set({
                  attemptId: prompt.identity.attemptId,
                  capabilityConnectionId,
                  capabilityGeneration,
                })
                .where(
                  and(
                    eq(taskExecutionPromptSegments.runId, prompt.identity.runId),
                    eq(taskExecutionPromptSegments.refId, prompt.identity.refId),
                    eq(taskExecutionPromptSegments.refOrdinal, prompt.identity.refOrdinal),
                    eq(taskExecutionPromptSegments.segmentOrdinal, prompt.identity.segmentOrdinal),
                    eq(taskExecutionPromptSegments.steeringState, "resumed"),
                    sql`${taskExecutionPromptSegments.protocolSettlementState} is null`,
                  ),
                )
                .returning({ runId: taskExecutionPromptSegments.runId });
        if (ownerRows.length !== 1) promptCycle.reject("capability mint lost its prompt owner");
        await transaction.insert(taskExecutionPromptCapabilities).values({
          companyId: prompt.identity.companyId,
          capabilityConnectionId,
          capabilityGeneration,
          runId: prompt.identity.runId,
          runBatchDigest: prompt.identity.runBatchDigest,
          refId: prompt.identity.refId,
          refOrdinal: prompt.identity.refOrdinal,
          segmentOrdinal: prompt.identity.segmentOrdinal,
          attemptId: prompt.identity.attemptId,
          leaseId: prompt.identity.leaseId,
          leaseGeneration: prompt.identity.leaseGeneration,
          workerProcessIdentity: idFactory(),
          taskId: prompt.identity.taskId,
          ownershipEpoch: prompt.identity.ownershipEpoch,
          targetAgentId: prompt.identity.targetAgentId,
          laneKind: prompt.identity.laneKind,
          executionMode: prompt.identity.laneKind,
          taskExecutionAuthorityId: prompt.identity.taskExecutionAuthorityId,
          consultExecutionId: prompt.identity.consultExecutionId,
          adapterConfigIdentity: prompt.identity.adapterConfigRevisionId,
          workspaceIdentity: prompt.identity.executionWorkspaceBindingId,
          targetSessionCorrelationId: null,
          effectiveContextExposureDigest: prompt.effectiveContextExposureDigest,
          effectiveToolsDigest: prompt.effectiveToolsDigest,
          bearerHash,
          state: "pending_setup",
          expiresAt,
          activatedAt: null,
          revocationReason: null,
          revokedAt: null,
          createdAt: timestamp,
        });
        return Object.freeze({
          capabilityConnectionId,
          capabilityGeneration,
          endpoint: endpoint.toString(),
          bearer,
        });
      });
    },
  } satisfies Partial<CreatePostgresTaskExecutionPromptCycleRepositoryResult>;
}
