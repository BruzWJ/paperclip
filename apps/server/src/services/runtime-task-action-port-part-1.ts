import { taskCreateIdempotencyKeys, taskExecutionRefs, tasks, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  allocateCanonicalTaskIdentityInTx,
  persistCanonicalTaskAggregateInTx,
} from "./canonical-task-aggregate.js";
import {
  renderPaperclipManagedToolPrompt,
  type PaperclipManagedToolPrompt,
} from "./paperclip-agent-message.js";
import { promptCapabilityGenerationIdentity } from "./prompt-capability-gateway.js";
import * as taskAction from "./runtime-task-action-port-shared.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  PostgresRuntimeTaskActionServiceOptions,
  RuntimeTaskActionService,
} from "./runtime-task-action-port-shared-part-1.js";

export function createPostgresRuntimeTaskActionServicePart1(
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
    async create(input) {
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        const authorized = await taskAction.lockRuntimeActionAuthority(
          tx,
          input.capability,
          "task_create",
          now,
          { requireOwner: true },
        );
        const key = taskAction.runtimeInvocationKey(
          "create",
          promptCapabilityGenerationIdentity(input.capability),
          input.invocationId,
        );
        const requestedOwnerId = taskAction.ownerAgentId(input.owner, input.capability.targetAgentId);
        const prior = await tx
          .select({
            key: taskCreateIdempotencyKeys,
            task: tasks,
          })
          .from(taskCreateIdempotencyKeys)
          .innerJoin(tasks, eq(tasks.id, taskCreateIdempotencyKeys.taskId))
          .where(
            and(
              eq(taskCreateIdempotencyKeys.companyId, input.capability.companyId),
              eq(taskCreateIdempotencyKeys.idempotencyKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (prior) {
          if (
            prior.task.parentId !== input.capability.taskId ||
            prior.task.request !== input.request ||
            prior.task.title !== (input.title ?? null) ||
            prior.task.priority !== (input.priority ?? "medium") ||
            prior.task.ownerKind !== "agent" ||
            prior.task.ownerAgentId !== requestedOwnerId ||
            prior.task.creatorKind !== "agent-execution" ||
            prior.task.creatorAuthorityId !== input.capability.taskExecutionAuthorityId
          ) {
            throw new taskAction.RuntimeTaskActionConflict(
              "task_create invocation was retried with different immutable arguments",
            );
          }
          const ref = await tx
            .select()
            .from(taskExecutionRefs)
            .where(
              and(
                eq(taskExecutionRefs.companyId, input.capability.companyId),
                eq(taskExecutionRefs.deliveryIdempotencyKey, key),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!ref) {
            throw new taskAction.RuntimeTaskActionConflict("Accepted task_create is missing its owner ref");
          }
          return { task: prior.task, ref, retried: true };
        }

        const targetAgentId = taskAction.assertCreateOwnerCatalog(authorized, input.owner);
        const targetRevisionId = await taskAction.assertTargetAdapterRevision(
          tx,
          input.capability.companyId,
          targetAgentId,
        );
        if (!input.capability.taskExecutionAuthorityId) {
          throw new taskAction.RuntimeTaskActionDenied(
            "task_create requires a stable parent execution authority",
            "execution_authority_invalid",
          );
        }
        const { taskNumber, identifier } = await allocateCanonicalTaskIdentityInTx(
          tx,
          input.capability.companyId,
          now,
        );

        const taskId = taskAction.deterministicUuid("runtime-task-create", key);
        const sessionId = taskAction.stableSessionId(`runtime-task-create:${key}`);
        const authorityId = taskAction.deterministicUuid(
          "task-execution-authority",
          `${taskId}:1:${targetAgentId}`,
        );
        const aggregate = await taskAction.withRuntimeWorkspaceReservationErrors(() =>
          persistCanonicalTaskAggregateInTx(tx, {
            task: {
              id: taskId,
              companyId: input.capability.companyId,
              projectId: authorized.task.projectId,
              projectWorkspaceId: authorized.task.projectWorkspaceId,
              goalId: authorized.task.goalId,
              parentId: input.capability.taskId,
              title: input.title ?? null,
              request: input.request,
              boardPresentationStatus: "todo",
              lifecycleStatus: "open",
              disposition: null,
              priority: input.priority ?? "medium",
              ownerKind: "agent",
              ownerAgentId: targetAgentId,
              ownerUserId: null,
              ownerAssignmentSource: null,
              ownershipEpoch: 1,
              creatorKind: "agent-execution",
              creatorAuthorityId: input.capability.taskExecutionAuthorityId,
              creatorAdapterConfigRevisionId: input.capability.adapterConfigIdentity,
              taskNumber,
              identifier,
              originKind: "agent_task_create",
              originId: input.capability.taskId,
              originRunId: input.capability.runId,
              originFingerprint: key,
              requestDepth: authorized.task.requestDepth + 1,
              createdAt: now,
              updatedAt: now,
            },
            session: {
              id: sessionId,
              parentSessionId: input.capability.sessionId,
              now,
            },
            workspaceReservation: {
              provenance: {
                agentId: input.capability.targetAgentId,
                userId: null,
              },
            },
            authority: {
              id: authorityId,
              agentId: targetAgentId,
              auditAdapterConfigRevisionId: targetRevisionId,
              createdAt: now,
            },
            idempotency: {
              id: taskAction.deterministicUuid("task-create-idempotency", key),
              key,
            },
          }),
        );
        const created = aggregate.task;
        const sessionRoot = aggregate.sessionRoot;
        const edge = aggregate.creatorEdge;
        if (!edge) {
          throw new taskAction.RuntimeTaskActionConflict("task_create did not persist its creator edge");
        }
        const assignmentPrompt = {
          toolName: "task_create",
          arguments: {
            request: input.request,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            owner: input.owner,
          },
          context: {
            task: created,
            from: taskAction.messageAgent(authorized.companyAgents, input.capability.targetAgentId),
            owner: taskAction.messageAgent(authorized.companyAgents, targetAgentId),
            status: "open",
          },
        } satisfies PaperclipManagedToolPrompt<"task_create">;
        const admission = await admitTaskExecutionInTransaction({
          sessionAdmission,
          transaction: tx,
          work: {
            companyId: created.companyId,
            taskId: created.id,
            sessionId,
            ownershipEpoch: 1,
            targetAgentId,
            taskExecutionAuthorityId: authorityId,
            consultExecutionId: null,
            adapterConfigRevisionId: targetRevisionId,
            contextEpoch: sessionRoot.contextEpoch.generation,
            mode: "owner",
            counterpartTaskId: input.capability.taskId,
            counterpartAuthorityId: input.capability.taskExecutionAuthorityId,
            counterpartOwnershipEpoch: input.capability.ownershipEpoch,
            sourceKind: "task_request",
            actor: taskAction.executionActorForCapability(input.capability),
            immutableSourceKey: key,
            sourceRecordId: created.id,
            exactText: renderPaperclipManagedToolPrompt(assignmentPrompt),
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
          },
        });
        if (!admission.ref) {
          throw new taskAction.RuntimeTaskActionConflict(
            "task_create did not reserve an owner execution ref",
          );
        }
        return {
          task: created,
          sessionId,
          authorityId,
          creatorEdgeId: edge.id,
          ref: admission.ref,
          comment: admission.comment,
          retried: false,
        };
      });
      await options.dispatchPersistedRef(committed.ref.id);
      return committed;
    },
  } satisfies Partial<RuntimeTaskActionService>;
}
