import { and, eq, inArray, sql } from "drizzle-orm";
import {
  companies,
  labels,
  taskCreateIdempotencyKeys,
  taskExecutionRefs,
  taskLabels,
  tasks,
  type Db,
} from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import {
  allocateCanonicalTaskIdentityInTx,
  persistCanonicalTaskAggregateInTx,
} from "./canonical-task-aggregate.js";
import { resolveInvokableTaskOwnerInTransaction } from "./agent-invokability.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import {
  deterministicPortableUuid,
  stablePortableSessionId,
  withPortableWorkspaceReservationErrors,
  canonicalPortableJson,
  PortableCanonicalTaskCreateInput,
} from "./company-portability-format-support.js";

export async function createPortableCanonicalTask(db: Db, input: PortableCanonicalTaskCreateInput) {
  const rawIdempotencyKey = `company-portability:${input.companyId}:${input.slug}`;
  const aggregateKey = `ordinary-task-create:${input.companyId}:${rawIdempotencyKey}`;
  const taskId = deterministicPortableUuid("ordinary-task", aggregateKey);
  const sessionId = stablePortableSessionId(aggregateKey);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${aggregateKey}, 0))`);
    const existing = await tx
      .select({ task: tasks })
      .from(taskCreateIdempotencyKeys)
      .innerJoin(tasks, eq(tasks.id, taskCreateIdempotencyKeys.taskId))
      .where(
        and(
          eq(taskCreateIdempotencyKeys.companyId, input.companyId),
          eq(taskCreateIdempotencyKeys.idempotencyKey, aggregateKey),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]?.task ?? null);
    if (existing) {
      const existingLabels = await tx
        .select({ labelId: taskLabels.labelId })
        .from(taskLabels)
        .where(eq(taskLabels.taskId, existing.id));
      const requestedLabels = [...new Set(input.labelIds)].sort();
      const persistedLabels = existingLabels.map((entry) => entry.labelId).sort();
      if (
        existing.id !== taskId ||
        existing.request !== input.request ||
        existing.title !== (input.title?.trim() || null) ||
        existing.ownerKind !== "agent" ||
        existing.ownerAgentId !== input.ownerAgentId ||
        existing.creatorKind !== "user/board" ||
        existing.creatorUserId !== input.creatorUserId ||
        existing.projectId !== input.projectId ||
        existing.lifecycleStatus !== input.lifecycleStatus ||
        existing.boardPresentationStatus !== input.boardPresentationStatus ||
        canonicalPortableJson(existing.disposition) !== canonicalPortableJson(input.disposition) ||
        existing.priority !== input.priority ||
        existing.billingCode !== input.billingCode ||
        canonicalPortableJson(persistedLabels) !== canonicalPortableJson(requestedLabels)
      ) {
        throw unprocessable(`Task ${input.slug} import idempotency changed immutable input`);
      }
      const ref =
        input.lifecycleStatus === "open"
          ? await tx
              .select()
              .from(taskExecutionRefs)
              .where(
                and(
                  eq(taskExecutionRefs.companyId, input.companyId),
                  eq(taskExecutionRefs.deliveryIdempotencyKey, aggregateKey),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
      if (input.lifecycleStatus === "open" && !ref) {
        throw unprocessable(`Task ${input.slug} import is missing its canonical execution ref`);
      }
      return { task: existing, ref, retried: true };
    }

    const company = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !company ||
      company.status !== "active" ||
      company.sessionIntegrityState !== "ready" ||
      company.hardDeleteFencedAt !== null
    ) {
      throw unprocessable("Target company Session lifecycle is not ready for task import");
    }

    const { owner, revisionId } = await resolveInvokableTaskOwnerInTransaction(tx, {
      companyId: input.companyId,
      ownerAgentId: input.ownerAgentId,
    });
    const uniqueLabelIds = [...new Set(input.labelIds)];
    if (uniqueLabelIds.length > 0) {
      const labelRows = await tx
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.companyId, input.companyId), inArray(labels.id, uniqueLabelIds)));
      if (labelRows.length !== uniqueLabelIds.length) {
        throw unprocessable(`Task ${input.slug} contains labels outside the target company`);
      }
    }

    const now = new Date();
    const { taskNumber, identifier } = await allocateCanonicalTaskIdentityInTx(tx, input.companyId, now);
    const title = input.title?.trim() || null;
    const authorityId = deterministicPortableUuid("task-execution-authority", `${taskId}:1:${owner.id}`);
    const aggregate = await withPortableWorkspaceReservationErrors(() =>
      persistCanonicalTaskAggregateInTx(tx, {
        task: {
          id: taskId,
          companyId: input.companyId,
          projectId: input.projectId,
          goalId: null,
          parentId: null,
          title,
          request: input.request,
          boardPresentationStatus: input.boardPresentationStatus,
          lifecycleStatus: input.lifecycleStatus,
          disposition: input.disposition,
          workMode: "standard",
          priority: input.priority,
          ownerKind: "agent",
          ownerAgentId: owner.id,
          ownerUserId: null,
          ownershipEpoch: 1,
          creatorKind: "user/board",
          creatorUserId: input.creatorUserId,
          responsibleUserId: null,
          taskNumber,
          identifier,
          originKind: "manual",
          originId: null,
          originRunId: null,
          originFingerprint: aggregateKey,
          billingCode: input.billingCode,
          requestDepth: 0,
          completedAt: input.lifecycleStatus === "done" ? now : null,
          cancelledAt: input.lifecycleStatus === "cancelled" ? now : null,
          createdAt: now,
          updatedAt: now,
        },
        session: {
          id: sessionId,
          parentSessionId: null,
          now,
        },
        workspaceReservation: {
          provenance: {
            agentId: null,
            userId: input.creatorUserId,
          },
        },
        authority: {
          id: authorityId,
          agentId: owner.id,
          auditAdapterConfigRevisionId: revisionId,
          createdAt: now,
        },
        idempotency: { key: aggregateKey },
      }),
    );
    const admission =
      input.lifecycleStatus === "open"
        ? await admitTaskExecutionInTransaction({
            sessionAdmission: createTaskSessionAdmissionService(db),
            transaction: tx,
            work: {
              companyId: aggregate.task.companyId,
              taskId: aggregate.task.id,
              sessionId,
              ownershipEpoch: 1,
              targetAgentId: owner.id,
              taskExecutionAuthorityId: authorityId,
              consultExecutionId: null,
              adapterConfigRevisionId: revisionId,
              contextEpoch: aggregate.sessionRoot.contextEpoch.generation,
              mode: "owner",
              sourceKind: "task_request",
              actor: {
                kind: "user/board",
                userId: input.creatorUserId,
              },
              immutableSourceKey: aggregateKey,
              sourceRecordId: aggregate.task.id,
              exactText: input.request,
              comment: {
                author: {
                  kind: "user",
                  userId: input.creatorUserId,
                },
                producingRun: null,
                body: input.request,
              },
              idempotencyKey: aggregateKey,
            },
          })
        : null;
    if (input.lifecycleStatus === "open" && !admission?.ref) {
      throw unprocessable(`Task ${input.slug} import did not persist its canonical execution ref`);
    }
    if (uniqueLabelIds.length > 0) {
      await tx.insert(taskLabels).values(
        uniqueLabelIds.map((labelId) => ({
          taskId: aggregate.task.id,
          labelId,
          companyId: input.companyId,
        })),
      );
    }
    return {
      task: aggregate.task,
      ref: admission?.ref ?? null,
      retried: false,
    };
  });
}
