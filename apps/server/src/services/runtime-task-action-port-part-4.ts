import { taskConsultExecutions, taskExecutionRefs, taskSessionEvents, type Db } from "@paperclipai/db";
import { isCanonicalUuid } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { paperclipEnvelopeHasBody } from "./paperclip-agent-message.js";
import { promptCapabilityGenerationIdentity } from "./prompt-capability-gateway.js";
import * as taskAction from "./runtime-task-action-port-shared.js";
import { TaskConsultChainInvalid, lockAndValidateTaskConsultChain } from "./task-consult-chain-postgres.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  PostgresRuntimeTaskActionServiceOptions,
  RuntimeTaskActionService,
} from "./runtime-task-action-port-shared-part-1.js";

export function createPostgresRuntimeTaskActionServicePart4(
  db: Db,
  options: PostgresRuntimeTaskActionServiceOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createTaskSessionAdmissionService(db, { clock });
  const taskForms = taskAction.createTaskFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchPersistedRef,
    taskExecutionCancellation: options.taskExecutionCancellation,
  });

  return {
    async mention(input) {
      if (
        input.runInterfaceToolCallId.length === 0 ||
        input.runInterfaceToolCallId !== input.runInterfaceToolCallId.trim() ||
        !isCanonicalUuid(input.runInterfaceToolCallId)
      ) {
        throw new taskAction.RuntimeTaskActionConflict(
          "Mention admission requires its exact run-interface tool-call identity",
        );
      }
      if (!Number.isSafeInteger(input.ingressOrdinal) || input.ingressOrdinal < 0) {
        throw new taskAction.RuntimeTaskActionConflict(
          "Mention admission requires its immutable nonnegative ingress ordinal",
        );
      }
      const key = `${taskAction.runtimeInvocationKey(
        "mention",
        promptCapabilityGenerationIdentity(input.capability),
        input.invocationId,
      )}:tool-call:${input.runInterfaceToolCallId}:ingress:${input.ingressOrdinal}`;
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        const authorized = await taskAction.lockRuntimeActionAuthority(
          tx,
          input.capability,
          "mention_agent",
          now,
          {
            requireOwner: false,
            additionalLaneTargetAgentId: input.targetAgentId,
          },
        );
        if (!authorized.catalog.mentionTargets.some((candidate) => candidate.id === input.targetAgentId)) {
          throw new taskAction.RuntimeTaskActionDenied(
            "Mention target is no longer in the current reach catalog",
            "mention_catalog_changed",
          );
        }
        const priorEvent = await tx
          .select()
          .from(taskSessionEvents)
          .where(
            and(
              eq(taskSessionEvents.companyId, input.capability.companyId),
              eq(taskSessionEvents.taskId, input.capability.taskId),
              eq(taskSessionEvents.sessionId, input.capability.sessionId),
              eq(taskSessionEvents.ownershipEpoch, input.capability.ownershipEpoch),
              eq(taskSessionEvents.sourceKind, "consult_mention"),
              eq(taskSessionEvents.immutableSourceKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorEvent) {
          const priorRef = await tx
            .select()
            .from(taskExecutionRefs)
            .where(
              and(
                eq(taskExecutionRefs.companyId, input.capability.companyId),
                eq(taskExecutionRefs.taskId, input.capability.taskId),
                eq(taskExecutionRefs.sessionId, input.capability.sessionId),
                eq(taskExecutionRefs.ownershipEpoch, input.capability.ownershipEpoch),
                eq(taskExecutionRefs.sourceId, priorEvent.sourceId!),
              ),
            )
            .limit(1)
            .for("update")
            .then((rows) => rows[0] ?? null);
          const consult = priorRef?.consultExecutionId
            ? await tx
                .select()
                .from(taskConsultExecutions)
                .where(eq(taskConsultExecutions.id, priorRef.consultExecutionId))
                .limit(1)
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;
          if (
            !priorRef ||
            priorRef.mode !== "consult" ||
            priorRef.sourceKind !== "consult_mention" ||
            priorRef.consultCallerRefId !== input.capability.refId ||
            priorRef.targetAgentId !== input.targetAgentId ||
            !paperclipEnvelopeHasBody(priorRef.exactMessage, "[Paperclip agent message]", input.message) ||
            !consult ||
            consult.state !== "active" ||
            consult.sourceRunId !== input.capability.runId ||
            consult.sourceRefId !== input.capability.refId ||
            consult.targetAgentId !== input.targetAgentId ||
            priorEvent.sourceRecordId !== consult.id
          ) {
            throw new taskAction.RuntimeTaskActionConflict(
              "mention invocation was retried with different immutable arguments",
            );
          }
          return input.commitMentionAction(tx, {
            accepted: true,
            consultExecutionId: consult.id,
            refId: priorRef.id,
            commentId: null,
            retried: true,
          });
        }

        const targetRevisionId = await taskAction.assertTargetAdapterRevision(
          tx,
          input.capability.companyId,
          input.targetAgentId,
        );
        let chain;
        try {
          chain = await lockAndValidateTaskConsultChain(tx, {
            ref: authorized.ref,
            requireLiveAncestors: false,
            leafState: "active",
          });
        } catch (error) {
          if (error instanceof TaskConsultChainInvalid) {
            throw new taskAction.RuntimeTaskActionDenied(
              error.message,
              error.reason === "cycle" ? "mention_chain_cycle" : "mention_chain_invalid",
            );
          }
          throw error;
        }
        if (chain.agentIds.has(input.targetAgentId)) {
          throw new taskAction.RuntimeTaskActionDenied(
            "Mention target would loop within its active mention chain",
            "mention_chain_loop",
          );
        }

        const consultId = taskAction.deterministicUuid("task-consult", key);
        const consult = await tx
          .insert(taskConsultExecutions)
          .values({
            id: consultId,
            companyId: input.capability.companyId,
            taskId: input.capability.taskId,
            sessionId: input.capability.sessionId,
            ownershipEpoch: input.capability.ownershipEpoch,
            sourceRunId: input.capability.runId,
            sourceRefId: input.capability.refId,
            callerExecutionScopeId: authorized.ref.executionScopeId,
            targetAgentId: input.targetAgentId,
            adapterConfigRevisionId: targetRevisionId,
            chainToken: chain.chainToken,
            state: "active",
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!consult) {
          throw new taskAction.RuntimeTaskActionConflict("Mention execution binding was not persisted");
        }
        const admission = await taskAction.mentionAgentInTransaction(sessionAdmission, tx, {
          companyId: input.capability.companyId,
          taskId: input.capability.taskId,
          sessionId: input.capability.sessionId,
          ownershipEpoch: input.capability.ownershipEpoch,
          targetAgentId: input.targetAgentId,
          taskExecutionAuthorityId: null,
          consultExecutionId: consult.id,
          adapterConfigRevisionId: targetRevisionId,
          contextEpoch: authorized.contextGeneration,
          mode: "consult",
          executionLineageId: authorized.ref.executionLineageId,
          consultCallerRefId: authorized.ref.id,
          consultChainToken: chain.chainToken,
          sourceKind: "consult_mention",
          actor: taskAction.executionActorForCapability(input.capability),
          immutableSourceKey: key,
          sourceRecordId: consult.id,
          prompt: {
            toolName: "mention_agent",
            arguments: {
              agentId: input.targetAgentId,
              message: `@board ${input.message}`,
            },
            context: {
              task: authorized.task,
              from: taskAction.messageAgent(authorized.companyAgents, input.capability.targetAgentId),
              to: taskAction.messageAgent(authorized.companyAgents, input.targetAgentId),
            },
          },
          comment: {
            author: {
              kind: "agent",
              agentId: input.capability.targetAgentId,
            },
            producingRun: {
              runId: input.capability.runId,
              adapterConfigRevisionId: input.capability.adapterConfigIdentity,
            },
          },
          idempotencyKey: key,
        });
        if (!admission.ref || !admission.comment) {
          throw new taskAction.RuntimeTaskActionConflict(
            "Mention did not reserve its canonical ref and comment",
          );
        }
        return input.commitMentionAction(tx, {
          accepted: true,
          consultExecutionId: consult.id,
          refId: admission.ref.id,
          commentId: admission.comment.id,
          retried: false,
        });
      });
      await options.dispatchPersistedRef(committed.refId);
      return committed;
    },
  } satisfies Partial<RuntimeTaskActionService>;
}
