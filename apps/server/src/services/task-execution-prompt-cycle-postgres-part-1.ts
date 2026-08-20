import {
  agentAdapterConfigRevisions,
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionWorkspaceBindings,
  taskSessionMessages,
} from "@paperclipai/db";
import { agentAdapterAcpConfigurationSchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { contextDialDigest } from "./context-dial-resolver.js";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";
import { runtimeInterfaceDigest } from "./runtime-interface-compiler.js";
import type { TaskExecutionPromptIdentity } from "./task-execution-attempt-executor.js";
import {
  exactlyOne,
  promptCompileScope,
  reject,
  rejectAuthorityLoss,
  resolveInitialPromptCycleInTransaction,
  selectCurrentCorrelation,
  storedCorrelation,
  transactionClockTimestamp,
} from "./task-execution-prompt-cycle-postgres-shared.js";
import {
  createTaskExecutionPromptActivationScope,
  resolveTaskExecutionPromptCycleSettings,
} from "./task-execution-prompt-cycle-settings.js";
import { taskSessionMessageFromRow } from "./task-session/projector.js";
import type {
  CreatePostgresTaskExecutionPromptCycleRepositoryResult,
  PostgresTaskExecutionPromptCycleOptions,
} from "./task-execution-prompt-cycle-postgres.js";

export function createPostgresTaskExecutionPromptCycleRepositoryPart1(
  options: PostgresTaskExecutionPromptCycleOptions,
) {
  const { idFactory, capabilityTtlMs, leaseTtlMs, leaseRenewalIntervalMs, endpoint } =
    resolveTaskExecutionPromptCycleSettings(options);

  return {
    async resolve(lease) {
      return options.database.transaction(async (transaction) => {
        const run = await options.runService.lockRun(transaction, lease);
        if (
          run.status !== "running" ||
          run.currentAttemptId !== lease.attemptId ||
          run.currentLeaseId !== lease.leaseId
        ) {
          rejectAuthorityLoss(lease, "attempt lease is no longer current on its productive or consult run");
        }
        const controlRows = await transaction
          .select()
          .from(taskExecutionRunControls)
          .where(eq(taskExecutionRunControls.runId, run.runId))
          .limit(2)
          .for("update");
        const attemptRows = await transaction
          .select()
          .from(taskExecutionAttempts)
          .where(eq(taskExecutionAttempts.id, lease.attemptId))
          .limit(2)
          .for("update");
        const leaseRows = await transaction
          .select()
          .from(taskExecutionLeases)
          .where(eq(taskExecutionLeases.id, lease.leaseId))
          .limit(2)
          .for("update");
        const timestamp = await transactionClockTimestamp(transaction, "prompt resolution time");
        const attempt = exactlyOne(attemptRows, "attempt lease lost its attempt");
        const persistedLease = exactlyOne(leaseRows, "attempt lease lost its lease");
        const control = exactlyOne(controlRows, "run lost its current-prompt control");
        if (
          attempt.refId === null ||
          attempt.refOrdinal === null
        ) {
          reject("attempt lost its canonical productive prompt shape");
        }
        if (
          attempt.companyId !== run.companyId ||
          attempt.taskId !== run.taskId ||
          attempt.sessionId !== run.sessionId ||
          attempt.runId !== run.runId ||
          attempt.runKind !== run.kind ||
          attempt.state !== "running" ||
          persistedLease.attemptId !== attempt.id ||
          persistedLease.leaseGeneration !== lease.leaseGeneration ||
          persistedLease.state !== "active" ||
          persistedLease.expiresAt <= timestamp ||
          control.currentRefId !== attempt.refId ||
          control.currentOrdinal !== attempt.refOrdinal
        ) {
          rejectAuthorityLoss(lease, "attempt, lease, and current prompt are no longer one exact identity");
        }
        const identity: TaskExecutionPromptIdentity = Object.freeze({
          companyId: run.companyId,
          taskId: run.taskId,
          sessionId: run.sessionId,
          runId: run.runId,
          attemptId: attempt.id,
          leaseId: persistedLease.id,
          leaseGeneration: persistedLease.leaseGeneration,
          ownershipEpoch: run.ownershipEpoch,
          executionScopeId: run.executionScopeId,
          runBatchDigest: "",
          runKind: run.kind,
          refId: attempt.refId,
          refOrdinal: attempt.refOrdinal,
          attemptGeneration: attempt.attemptGeneration,
          targetAgentId: run.targetAgentId,
          laneKind: run.executionMode,
          taskExecutionAuthorityId: run.taskExecutionAuthorityId,
          consultExecutionId: run.consultExecutionId,
          adapterConfigRevisionId: run.adapterConfigRevisionId,
          executionWorkspaceBindingId: run.executionWorkspaceBindingId,
        });
        const memberRows = await transaction
          .select()
          .from(taskExecutionRunRefs)
          .where(
            and(
              eq(taskExecutionRunRefs.runId, identity.runId),
              eq(taskExecutionRunRefs.refId, identity.refId),
              eq(taskExecutionRunRefs.refOrdinal, identity.refOrdinal),
            ),
          )
          .limit(2)
          .for("update");
        const sourceRows = await transaction
          .select()
          .from(taskExecutionRefs)
          .where(eq(taskExecutionRefs.id, identity.refId))
          .limit(2)
          .for("update");
        const revisionRows = await transaction
          .select()
          .from(agentAdapterConfigRevisions)
          .where(
            and(
              eq(agentAdapterConfigRevisions.id, identity.adapterConfigRevisionId),
              eq(agentAdapterConfigRevisions.companyId, identity.companyId),
              eq(agentAdapterConfigRevisions.agentId, identity.targetAgentId),
            ),
          )
          .limit(2);
        const workspaceRows = await transaction
          .select()
          .from(taskExecutionWorkspaceBindings)
          .where(
            and(
              eq(taskExecutionWorkspaceBindings.id, identity.executionWorkspaceBindingId),
              eq(taskExecutionWorkspaceBindings.companyId, identity.companyId),
              eq(taskExecutionWorkspaceBindings.taskId, identity.taskId),
              eq(taskExecutionWorkspaceBindings.sessionId, identity.sessionId),
              eq(taskExecutionWorkspaceBindings.ownershipEpoch, identity.ownershipEpoch),
            ),
          )
          .limit(2);
        const member = exactlyOne(memberRows, "current prompt lost its run-ref member");
        const source = exactlyOne(sourceRows, "current prompt lost its immutable ref");
        const revision = exactlyOne(revisionRows, "current prompt lost its adapter revision");
        const workspace = exactlyOne(workspaceRows, "current prompt lost its workspace binding");
        if (
          source.companyId !== identity.companyId ||
          source.taskId !== identity.taskId ||
          source.sessionId !== identity.sessionId ||
          source.ownershipEpoch !== identity.ownershipEpoch ||
          source.mode !== identity.laneKind ||
          source.targetAgentId !== identity.targetAgentId ||
          source.taskExecutionAuthorityId !== identity.taskExecutionAuthorityId ||
          source.consultExecutionId !== identity.consultExecutionId ||
          source.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
          source.disposition !== "active" ||
          member.protocolSettlementState !== null
        ) {
          reject("current prompt crossed its immutable ref scope");
        }
        const completeIdentity: TaskExecutionPromptIdentity = Object.freeze({
          ...identity,
          runBatchDigest: member.batchDigest,
        });
        const sourceMessageId = source.sourceMessageId;
        const sourceMessageRow = exactlyOne(
          await transaction
            .select()
            .from(taskSessionMessages)
            .where(
              and(
                eq(taskSessionMessages.companyId, identity.companyId),
                eq(taskSessionMessages.taskId, identity.taskId),
                eq(taskSessionMessages.sessionId, identity.sessionId),
                eq(taskSessionMessages.id, sourceMessageId),
              ),
            )
            .limit(2)
            .for("update"),
          "current prompt lost its canonical Session source message",
        );
        const sourceMessage = taskSessionMessageFromRow(sourceMessageRow);
        const sourceShapeMatches =
          source.messageKind === "user"
            ? sourceMessage.type === "user" &&
              sourceMessage.id === source.inputId &&
              sourceMessage.text === source.exactMessage
            : source.messageKind === "synthetic" &&
              sourceMessage.type === "synthetic" &&
              source.inputId === null &&
              sourceMessage.text === source.exactMessage;
        if (!sourceShapeMatches) {
          reject("current prompt source changed after immutable admission");
        }
        const sourceMessageSeq = sourceMessageRow.seq;
        const sourceText = source.exactMessage;
        if (!Number.isSafeInteger(sourceMessageSeq) || sourceMessageSeq < 0) {
          reject("current prompt source has an invalid Session sequence");
        }
        const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(revision.acpConfiguration);
        const compileInput = await options.compiler.resolve(promptCompileScope(completeIdentity));
        const effectiveContextExposureDigest = contextDialDigest(compileInput.contextDial);
        const effectiveToolsDigest = runtimeInterfaceDigest(compileInput);
        const carryContext = compileInput.contextDial.carry_context;
        const targetFingerprint = localExecutionCorrelationFingerprint(identity.adapterConfigRevisionId);
        const initialCycle = await resolveInitialPromptCycleInTransaction(transaction, {
          currentRef: source,
          executionWorkspaceBindingId: identity.executionWorkspaceBindingId,
        });
        const operationMatchesCycle =
          (attempt.sessionOperation === "new"
            ? initialCycle.kind === "new" ||
              (initialCycle.kind === "singleton" && initialCycle.freshSessionAllowed)
            : attempt.sessionOperation === "resume"
              ? initialCycle.kind === "bootstrap_resume" || initialCycle.kind === "singleton"
              : false);
        if (
          initialCycle.kind === "invalid" ||
          initialCycle.kind === "bootstrap_unavailable" ||
          !operationMatchesCycle
        ) {
          reject("initial prompt cycle no longer matches the frozen session operation");
        }
        const selectedCorrelation =
          attempt.sessionOperation === "resume"
            ? initialCycle.kind === "bootstrap_resume"
              ? initialCycle.correlation
              : await selectCurrentCorrelation(transaction, {
                  identity: completeIdentity,
                  carryContext,
                  effectiveContextExposureDigest,
                  targetFingerprint,
                })
            : null;
        if (
          (attempt.sessionOperation === "resume" && !selectedCorrelation) ||
          (attempt.sessionOperation === "new" && selectedCorrelation)
        ) {
          reject("frozen session operation no longer matches native correlation state");
        }
        const activationCorrelationScope = await createTaskExecutionPromptActivationScope(transaction, {
          identity: completeIdentity,
          effectiveContextExposureDigest,
          targetFingerprint,
        });
        return Object.freeze({
          identity: completeIdentity,
          readOnly: compileInput.readOnly,
          turn: compileInput.turn,
          sessionOperation: attempt.sessionOperation,
          sourceMessageId,
          sourceMessageSeq,
          sourceText,
          contextAccess: Object.freeze({ ...compileInput.contextDial }),
          carryContext,
          storedCorrelation: selectedCorrelation ? storedCorrelation(selectedCorrelation) : null,
          bootstrapPredecessor: initialCycle.kind === "bootstrap_resume" ? initialCycle.predecessor : null,
          activationCorrelationScope,
          effectiveContextExposureDigest,
          effectiveToolsDigest,
          acpConfiguration,
          target: {
            companyId: identity.companyId,
            taskId: identity.taskId,
            runId: identity.runId,
            targetAgentId: identity.targetAgentId,
            adapterConfigRevisionId: identity.adapterConfigRevisionId,
            executionWorkspaceBindingId: identity.executionWorkspaceBindingId,
            acpConfiguration,
            hostCwd: workspace.absoluteCwd,
            localWorkspaceCwd: workspace.absoluteCwd,
            targetAdditionalDirectories: Object.freeze([]),
          },
          leaseRenewalIntervalMs,
        });
      });
    },
  } satisfies Partial<CreatePostgresTaskExecutionPromptCycleRepositoryResult>;
}
