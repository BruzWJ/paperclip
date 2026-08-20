import {
  taskBoardUserComments,
  taskComments,
  taskExecutionAuthorities,
  taskExecutionRefs,
  tasks,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as runtime from "./ordinary-task-runtime-shared.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import {
  createTaskFormCommitRuntime,
  type CanonicalCreatorFormAuthority,
  type CanonicalOwnerFormAuthority,
  type CanonicalOwnerFormUpdate,
} from "./runtime-task-action-port.js";
import {
  createTaskSessionAdmissionService,
  type TaskSessionAdmissionResult,
} from "./task-session/admission.js";
import type {
  OrdinaryTaskRuntimeOptions,
  OrdinaryTaskUserCommentInput,
} from "./ordinary-task-runtime-shared-part-1.js";
export function createOrdinaryTaskRuntimePart3(db: Db, options: OrdinaryTaskRuntimeOptions) {
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
  return {
    async userComment(input: OrdinaryTaskUserCommentInput) {
      const actorUserId = runtime.exactNonBlank(input.actorUserId, "actorUserId");
      const message = runtime.nonBlankPreservingBytes(input.message, "message");
      const idempotencyKey = runtime.exactNonBlank(input.idempotencyKey, "idempotencyKey");
      const mention =
        input.mention == null
          ? null
          : {
              targetAgentId: runtime.exactNonBlank(input.mention.targetAgentId, "mention.targetAgentId"),
              ownershipEpoch: input.mention.ownershipEpoch,
            };
      const replyToCommentId =
        input.replyToCommentId == null
          ? null
          : runtime.exactNonBlank(input.replyToCommentId, "replyToCommentId");
      if (mention && (!Number.isInteger(mention.ownershipEpoch) || mention.ownershipEpoch <= 0)) {
        throw new runtime.OrdinaryTaskRuntimeRejected(
          "Mention ownership epoch must be a positive integer",
          "human_mention_epoch_invalid",
        );
      }
      const commandId = runtime.deterministicUuid(
        "board-user-comment",
        `${input.companyId}:${idempotencyKey}`,
      );
      const identityDigest = createHash("sha256")
        .update(
          runtime.canonicalJson({
            contract: "ordinary-board-user-comment/v2",
            companyId: input.companyId,
            taskId: input.taskId,
            actorUserId,
            message,
            idempotencyKey,
            mention,
            replyToCommentId,
          }),
        )
        .digest("hex");
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-user-comment:${idempotencyKey}`}, 0))`,
        );
        const priorCommand = await tx
          .select()
          .from(taskBoardUserComments)
          .where(
            and(
              eq(taskBoardUserComments.companyId, input.companyId),
              eq(taskBoardUserComments.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorCommand) {
          if (
            priorCommand.identityDigest !== identityDigest ||
            priorCommand.taskId !== input.taskId ||
            priorCommand.actorUserId !== actorUserId
          ) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Board comment idempotency key changed immutable input",
              "board_comment_idempotency_conflict",
            );
          }
          const [task, comment, ref] = await Promise.all([
            tx
              .select()
              .from(tasks)
              .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, priorCommand.taskId)))
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskComments)
              .where(eq(taskComments.id, priorCommand.commentId))
              .then((rows) => rows[0] ?? null),
            priorCommand.executionRefId
              ? tx
                  .select()
                  .from(taskExecutionRefs)
                  .where(eq(taskExecutionRefs.id, priorCommand.executionRefId))
                  .then((rows) => rows[0] ?? null)
              : Promise.resolve(null),
          ]);
          if (!task || !comment || (priorCommand.executionRefId !== null && !ref)) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Accepted board comment is missing canonical records",
              "board_comment_incomplete",
            );
          }
          return {
            task,
            comment,
            ref,
            command: priorCommand,
            retried: true,
          };
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!task || !task.lifecycleStatus || !task.ownershipEpoch) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board comments require a canonical ordinary task",
            "board_comment_target_invalid",
          );
        }
        const sessionState = await runtime.lockTaskSessionState(tx, input.companyId, task.id);
        if (!sessionState) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board comment target Session is missing",
            "board_comment_session_missing",
          );
        }
        const { session, contextGeneration } = sessionState;
        const replyParentExists = replyToCommentId
          ? await tx
              .select({ id: taskComments.id })
              .from(taskComments)
              .where(
                and(
                  eq(taskComments.companyId, input.companyId),
                  eq(taskComments.taskId, task.id),
                  eq(taskComments.id, replyToCommentId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
        if (replyToCommentId && !replyParentExists) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Reply target is not a persisted comment on this task",
            "human_reply_parent_missing",
          );
        }
        const sourceKey = `board-user-comment:${input.companyId}:${idempotencyKey}`;
        let admission: TaskSessionAdmissionResult;
        if (mention) {
          if (
            task.ownerKind !== "agent" ||
            !task.ownerAgentId ||
            task.ownerAgentId !== mention.targetAgentId ||
            task.ownershipEpoch !== mention.ownershipEpoch
          ) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Mention target must be the exact current owner and ownership epoch",
              "human_mention_scope_invalid",
            );
          }
          const { revisionId } = await runtime.resolveOrdinaryTaskOwner(
            tx,
            input.companyId,
            task.ownerAgentId,
          );
          const authority = await tx
            .select()
            .from(taskExecutionAuthorities)
            .where(
              and(
                eq(taskExecutionAuthorities.companyId, input.companyId),
                eq(taskExecutionAuthorities.taskId, task.id),
                eq(taskExecutionAuthorities.ownershipEpoch, mention.ownershipEpoch),
                eq(taskExecutionAuthorities.agentId, mention.targetAgentId),
                eq(taskExecutionAuthorities.state, "current"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!authority) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Mention target authority is missing",
              "human_mention_authority_missing",
            );
          }
          admission = await admitTaskExecutionInTransaction({
            sessionAdmission: sessions,
            transaction: tx,
            work: {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              ownershipEpoch: mention.ownershipEpoch,
              targetAgentId: mention.targetAgentId,
              taskExecutionAuthorityId: authority.id,
              consultExecutionId: null,
              adapterConfigRevisionId: revisionId,
              contextEpoch: contextGeneration,
              mode: "owner",
              sourceKind: "mention_agent",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
                replyToCommentId,
                body: message,
              },
              idempotencyKey: sourceKey,
            },
          });
        } else {
          admission = await sessions.appendNonDispatchUserComment(
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              sourceKind: "human_comment",
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
                replyToCommentId,
                body: message,
              },
            },
            tx,
          );
        }
        if (!admission.comment || (mention !== null && !admission.ref)) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board comment did not persist its canonical projection",
            "board_comment_projection_missing",
          );
        }
        const now = clock();
        const command = await tx
          .insert(taskBoardUserComments)
          .values({
            id: commandId,
            companyId: input.companyId,
            taskId: task.id,
            ownershipEpoch: task.ownershipEpoch,
            actorUserId,
            idempotencyKey,
            identityDigest,
            mentionTargetAgentId: mention?.targetAgentId ?? null,
            commentId: admission.comment.id,
            executionRefId: admission.ref?.id ?? null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board comment command was not persisted",
            "board_comment_audit_missing",
          );
        }
        return {
          task,
          comment: admission.comment,
          ref: admission.ref,
          command,
          retried: false,
        };
      });
      if (result.ref) {
        await dispatch(result.ref.id);
      }
      return result;
    },
    async commitOwnerFormUpdate(
      taskId: string,
      input: CanonicalOwnerFormUpdate,
      ownerAuthority: CanonicalOwnerFormAuthority,
    ) {
      return runtime.withOrdinaryTaskFormErrors(() =>
        taskForms.commitOwnerFormUpdate(taskId, input, ownerAuthority),
      );
    },
    async commitCreatorFormUpdate(
      taskId: string,
      message: string,
      creatorAuthority: CanonicalCreatorFormAuthority,
    ) {
      return runtime.withOrdinaryTaskFormErrors(() =>
        taskForms.commitCreatorFormUpdate(taskId, message, creatorAuthority),
      );
    },
  };
}
