import {
  companies,
  taskCreateIdempotencyKeys,
  taskExecutionAuthorities,
  taskExecutionRefs,
  taskLabels,
  taskSessions,
  tasks,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import {
  allocateCanonicalTaskIdentityInTx,
  persistCanonicalTaskAggregateInTx,
} from "./canonical-task-aggregate.js";
import { createOrdinaryTaskReassignmentCommitter } from "./ordinary-task-runtime-reassignment.js";
import * as runtime from "./ordinary-task-runtime-shared.js";
import { assertPluginPermittedTaskOwnerInTransaction } from "./plugin-task-authorization.js";
import { createTaskFormCommitRuntime } from "./runtime-task-action-port.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  OrdinaryTaskCreateInput,
  OrdinaryTaskCreateResult,
  OrdinaryTaskRuntimeOptions,
} from "./ordinary-task-runtime-shared-part-1.js";

export function createOrdinaryTaskRuntimePart1(db: Db, options: OrdinaryTaskRuntimeOptions) {
  const clock = options.clock ?? (() => new Date());
  const sessions = createTaskSessionAdmissionService(db, { clock });
  const taskForms = createTaskFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchRef,
    taskExecutionCancellation: options.taskExecutionCancellation,
  });

  async function dispatch(refId: string): Promise<void> {
    await options.dispatchRef(refId);
  }
  const commitAgentOwnerReassignmentInTransaction = createOrdinaryTaskReassignmentCommitter({
    options,
    clock,
    sessions,
  });

  return {
    dispatchRef: dispatch,
    async create(rawInput: OrdinaryTaskCreateInput): Promise<OrdinaryTaskCreateResult> {
      const input = {
        ...rawInput,
        request: runtime.nonBlankPreservingBytes(rawInput.request, "request"),
        ownerAgentId: runtime.exactNonBlank(rawInput.ownerAgentId, "ownerAgentId"),
        idempotencyKey: runtime.exactNonBlank(rawInput.idempotencyKey, "idempotencyKey"),
        labelIds: [...new Set(rawInput.labelIds ?? [])],
      };
      if (input.priority && !runtime.PRIORITIES.has(input.priority)) {
        throw new runtime.OrdinaryTaskRuntimeRejected("Task priority is invalid", "priority_invalid");
      }
      const key = `ordinary-task-create:${input.companyId}:${input.idempotencyKey}`;
      const taskId = runtime.deterministicUuid("ordinary-task", key);
      const sessionId = runtime.stableSessionId(key);

      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        const pluginOwnerResolution =
          input.creator.kind === "plugin"
            ? await assertPluginPermittedTaskOwnerInTransaction(tx, {
                companyId: input.companyId,
                pluginInstallationId: input.creator.pluginInstallationId,
                pluginKey: input.creator.pluginKey,
                operation: "tasks.create",
                ownerAgentId: input.ownerAgentId,
              })
            : null;
        const existing = await tx
          .select({ task: tasks })
          .from(taskCreateIdempotencyKeys)
          .innerJoin(tasks, eq(tasks.id, taskCreateIdempotencyKeys.taskId))
          .where(
            and(
              eq(taskCreateIdempotencyKeys.companyId, input.companyId),
              eq(taskCreateIdempotencyKeys.idempotencyKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]?.task ?? null);
        if (existing) {
          if (
            existing.id !== taskId ||
            existing.request !== input.request ||
            existing.ownerAgentId !== input.ownerAgentId ||
            existing.title !== (input.title ?? null) ||
            existing.projectId !== (input.projectId ?? null) ||
            (input.projectWorkspaceId != null && existing.projectWorkspaceId !== input.projectWorkspaceId) ||
            existing.goalId !== (input.goalId ?? null) ||
            existing.parentId !== (input.parentId ?? null) ||
            existing.priority !== (input.priority ?? "medium") ||
            existing.responsibleUserId !== (input.responsibleUserId ?? null) ||
            existing.originKind !== (input.originKind ?? "manual") ||
            existing.originId !== (input.originId ?? null) ||
            existing.originRunId !== (input.originRunId ?? null) ||
            existing.originFingerprint !== (input.originFingerprint ?? key) ||
            existing.billingCode !== (input.billingCode ?? null) ||
            !runtime.sameCreator(existing, input.creator)
          ) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Task creation idempotency key was retried with different immutable input",
              "create_idempotency_conflict",
            );
          }
          const [session, authority, ref] = await Promise.all([
            tx
              .select()
              .from(taskSessions)
              .where(eq(taskSessions.taskId, existing.id))
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskExecutionAuthorities)
              .where(
                and(
                  eq(taskExecutionAuthorities.taskId, existing.id),
                  eq(taskExecutionAuthorities.ownershipEpoch, 1),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskExecutionRefs)
              .where(
                and(
                  eq(taskExecutionRefs.companyId, input.companyId),
                  eq(taskExecutionRefs.deliveryIdempotencyKey, key),
                ),
              )
              .then((rows) => rows[0] ?? null),
          ]);
          if (!session || !authority || !ref) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Accepted task creation is missing canonical runtime records",
              "canonical_create_incomplete",
            );
          }
          return {
            task: existing,
            sessionId: session.id,
            authorityId: authority.id,
            ref,
            retried: true,
          };
        }

        await tx.execute(
          sql`select ${companies.id} from ${companies} where ${companies.id} = ${input.companyId} for update`,
        );
        const company = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, input.companyId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (
          !company ||
          company.status !== "active" ||
          company.sessionIntegrityState !== "ready" ||
          company.hardDeleteFencedAt !== null
        ) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Company Session lifecycle is not ready",
            "company_inactive",
          );
        }
        if (input.creator.kind === "plugin") {
          if (input.creator.callbackRegistrationActive !== true) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Plugin creator callback is not registered",
              "plugin_callback_missing",
            );
          }
        }
        await runtime.assertCreateReferences(tx, input);
        const { owner, revisionId } =
          input.creator.kind === "plugin"
            ? pluginOwnerResolution!
            : await runtime.resolveOrdinaryTaskOwner(tx, input.companyId, input.ownerAgentId);
        const now = clock();
        const { taskNumber, identifier } = await allocateCanonicalTaskIdentityInTx(tx, input.companyId, now);
        const authorityId = runtime.deterministicUuid("task-execution-authority", `${taskId}:1:${owner.id}`);
        const aggregate = await runtime.withOrdinaryWorkspaceReservationErrors(() =>
          persistCanonicalTaskAggregateInTx(tx, {
            task: {
              id: taskId,
              companyId: input.companyId,
              projectId: input.projectId ?? null,
              projectWorkspaceId: input.projectWorkspaceId ?? null,
              goalId: input.goalId ?? null,
              parentId: input.parentId ?? null,
              title: input.title?.trim() || null,
              request: input.request,
              boardPresentationStatus: "todo",
              lifecycleStatus: "open",
              disposition: null,
              workMode: input.workMode ?? "standard",
              priority: input.priority ?? "medium",
              ownerKind: "agent",
              ownerAgentId: owner.id,
              ownerUserId: null,
              ownerAssignmentSource: null,
              ownershipEpoch: 1,
              ...runtime.creatorColumns(input.creator),
              responsibleUserId: input.responsibleUserId ?? null,
              taskNumber,
              identifier,
              originKind: input.originKind ?? "manual",
              originId: input.originId ?? null,
              originRunId: input.originRunId ?? null,
              originFingerprint: input.originFingerprint ?? key,
              billingCode: input.billingCode ?? null,
              requestDepth: input.parentId ? 1 : 0,
              createdAt: now,
              updatedAt: now,
            },
            session: {
              id: sessionId,
              now,
            },
            workspaceReservation: {
              provenance: {
                agentId: null,
                userId: input.creator.kind === "user/board" ? input.creator.userId : null,
              },
            },
            authority: {
              id: authorityId,
              agentId: owner.id,
              auditAdapterConfigRevisionId: revisionId,
              createdAt: now,
            },
            idempotency: { key },
          }),
        );
        const created = aggregate.task;
        if (input.labelIds.length > 0) {
          await tx.insert(taskLabels).values(
            input.labelIds.map((labelId) => ({
              taskId: created.id,
              labelId,
              companyId: input.companyId,
            })),
          );
        }
        const sessionRoot = aggregate.sessionRoot;
        const executionSource = runtime.executionSourceForOrdinaryCreate(input);
        const scope = {
          companyId: created.companyId,
          taskId: created.id,
          sessionId,
          ownershipEpoch: 1,
          targetAgentId: owner.id,
          taskExecutionAuthorityId: authorityId,
          consultExecutionId: null,
          adapterConfigRevisionId: revisionId,
          contextEpoch: sessionRoot.contextEpoch.generation,
          mode: "owner" as const,
        };
        const work = {
          ...scope,
          ...executionSource,
          immutableSourceKey: key,
          sourceRecordId: created.id,
          exactText: input.request,
          comment: {
            ...runtime.projectedCommentAttribution(input.creator),
            body: input.request,
          },
          idempotencyKey: key,
        };
        const admission = await admitTaskExecutionInTransaction({
          sessionAdmission: sessions,
          transaction: tx,
          work,
        });
        if (!admission.ref) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Initial owner execution ref was not persisted",
            "initial_ref_missing",
          );
        }
        await input.correlate?.(tx, {
          task: created,
          sessionId,
          authorityId,
          ref: admission.ref,
        });
        return {
          task: created,
          sessionId,
          authorityId,
          ref: admission.ref,
          retried: false,
        };
      });
      await dispatch(result.ref.id);
      return result;
    },
  };
}
