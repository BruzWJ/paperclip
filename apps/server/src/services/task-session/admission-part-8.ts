import { type Db } from "@paperclipai/db";
import * as TaskSession from "@paperclipai/shared/task-session";
import { classifyOrderedExecutionScopePair } from "../task-execution-initial-request-pair.js";
import * as admissionCore from "./admission-part-1.js";
import {
  admitQueuedUserExecutionSource,
  admitSyntheticExecutionSource,
  appendNonDispatchEvent,
  appendNonDispatchSyntheticComment,
} from "./admission-part-6-section-1.js";
import { assertCanonicalScope, findRetry, lockCompanyLifecycle } from "./admission-part-4.js";
import {
  assertDispatchingExecutionSource,
  assertExecutionSourceCommentProvenance,
  assertProjectedCommentProducer,
  assertProjectedCommentSourceShape,
  resolveDispatchingExecutionBatchMessageKinds,
} from "./admission-part-3.js";
import { assertDispatchScope } from "./admission-part-5.js";
import {
  assertSourceIdentity,
  reserveStableMessageIdentity,
  scopeDigest,
  stableIdentityForSource,
  v2MessageKindForExecutionSource,
} from "./admission-part-2.js";
import { type TaskSessionDbTransaction } from "./event-store.js";
import { TaskSessionLifecycleConflict } from "./store.js";

function dispatchingExecutionSourceIdentityDigest(
  input: admissionCore.DispatchingExecutionSourceInput,
  messageKind: "user" | "synthetic",
) {
  return admissionCore.digest({
    contract: "dispatching-execution-source/v1",
    sourceKind: input.sourceKind,
    actor: input.actor,
    immutableSourceKey: input.immutableSourceKey,
    sourceRecordId: input.sourceRecordId,
    ...scopeDigest(input),
    messageKind,
    exactText: input.exactText,
    idempotencyKey: input.idempotencyKey,
    comment: input.comment,
  });
}

/** Owns physical Task Session source admission and projection. */
export function createTaskSessionAdmissionService(
  db: Db,
  options: {
    clock?: () => Date;
    hooks?: admissionCore.TaskSessionAdmissionHooks;
  } = {},
): admissionCore.TaskSessionAdmissionService {
  const clock = options.clock ?? (() => new Date());
  const hooks = options.hooks ?? {};

  async function admitExecutionSourceInTx(
    transaction: TaskSessionDbTransaction,
    input: admissionCore.DispatchingExecutionSourceInput,
    messageKind: "user" | "synthetic",
  ): Promise<admissionCore.TaskSessionAdmissionResult> {
    await assertProjectedCommentProducer(transaction, input, input.comment);
    const identityDigest = dispatchingExecutionSourceIdentityDigest(input, messageKind);
    const retry = await findRetry(
      transaction,
      input,
      identityDigest,
      messageKind === "user" ? TaskSession.Event.PromptAdmitted.type : TaskSession.Event.Synthetic.type,
    );
    if (retry) return retry;
    const stableIds = stableIdentityForSource(input);
    const ids = await reserveStableMessageIdentity(transaction, input, stableIds);
    const validated = await assertDispatchScope(transaction, input, messageKind);
    await hooks.assertImmutableSource?.(transaction, input);
    return messageKind === "user"
      ? admitQueuedUserExecutionSource(transaction, input, {
          ids,
          identityDigest,
          contextEpochBaselineSeq: validated.contextEpochBaselineSeq,
          now: clock(),
        })
      : admitSyntheticExecutionSource(
          transaction,
          input,
          ids,
          identityDigest,
          validated.contextEpochBaselineSeq,
          clock,
        );
  }

  return {
    admitExecutionSource(input, dbTransaction) {
      const messageKind = assertDispatchingExecutionSource(input);
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        return admitExecutionSourceInTx(transaction, input, messageKind);
      };
      return dbTransaction ? operation(dbTransaction) : db.transaction(operation);
    },

    admitExecutionSourceBatch(input, dbTransaction) {
      if (!input.batchKey.trim()) {
        throw new TaskSessionLifecycleConflict("Dispatching execution-source batch key must be non-empty");
      }
      const first = input.sources[0]!;
      const targetScope = {
        companyId: first.companyId,
        taskId: first.taskId,
        sessionId: first.sessionId,
        ownershipEpoch: first.ownershipEpoch,
        targetAgentId: first.targetAgentId,
        taskExecutionAuthorityId: first.taskExecutionAuthorityId,
        consultExecutionId: first.consultExecutionId,
        adapterConfigRevisionId: first.adapterConfigRevisionId,
        contextEpoch: first.contextEpoch,
        mode: first.mode,
        consultCallerRefId: first.consultCallerRefId ?? null,
        consultChainToken: first.consultChainToken ?? null,
      };
      const targetScopeJson = admissionCore.canonicalJson(targetScope);
      const sourceKeys = new Set<string>();
      const idempotencyKeys = new Set<string>();
      for (const source of input.sources) {
        const eventTargetScope = admissionCore.canonicalJson({
          companyId: source.companyId,
          taskId: source.taskId,
          sessionId: source.sessionId,
          ownershipEpoch: source.ownershipEpoch,
          targetAgentId: source.targetAgentId,
          taskExecutionAuthorityId: source.taskExecutionAuthorityId,
          consultExecutionId: source.consultExecutionId,
          adapterConfigRevisionId: source.adapterConfigRevisionId,
          contextEpoch: source.contextEpoch,
          mode: source.mode,
          consultCallerRefId: source.consultCallerRefId ?? null,
          consultChainToken: source.consultChainToken ?? null,
        });
        if (eventTargetScope !== targetScopeJson) {
          throw new TaskSessionLifecycleConflict(
            "Dispatching execution-source batch crossed counterpart execution scopes",
          );
        }
        if (sourceKeys.has(source.immutableSourceKey) || idempotencyKeys.has(source.idempotencyKey)) {
          throw new TaskSessionLifecycleConflict(
            "Dispatching execution-source batch contains duplicate source identity",
          );
        }
        sourceKeys.add(source.immutableSourceKey);
        idempotencyKeys.add(source.idempotencyKey);
      }
      const groupingKey = admissionCore.canonicalJson({
        contract: "dispatching-execution-source-batch/v1",
        batchKey: input.batchKey,
        targetScope,
      });
      const executionScopeId = admissionCore.deterministicUuid("counterpart-execution-scope", groupingKey);
      const executionLineageId =
        first.executionLineageId ??
        admissionCore.deterministicUuid("counterpart-execution-lineage", groupingKey);
      const grouped = input.sources.map((source) => {
        if (
          (source.executionScopeId && source.executionScopeId !== executionScopeId) ||
          (source.executionLineageId && source.executionLineageId !== executionLineageId)
        ) {
          throw new TaskSessionLifecycleConflict(
            "Dispatching execution-source batch changed its stable execution grouping",
          );
        }
        return {
          ...source,
          executionScopeId,
          executionLineageId,
        };
      });
      const messageKinds = resolveDispatchingExecutionBatchMessageKinds(grouped);
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, first.companyId);
        const results: admissionCore.TaskSessionAdmissionResult[] = [];
        for (const [index, source] of grouped.entries()) {
          results.push(await admitExecutionSourceInTx(transaction, source, messageKinds[index]!));
        }
        if (
          classifyOrderedExecutionScopePair(results.flatMap((result) => (result.ref ? [result.ref] : []))) ===
          null
        ) {
          throw new TaskSessionLifecycleConflict(
            "Execution-source pair did not persist one exact ordered scope",
          );
        }
        return results;
      };
      return dbTransaction ? operation(dbTransaction) : db.transaction(operation);
    },

    appendNonDispatchUserComment(input, dbTransaction) {
      assertSourceIdentity(input);
      assertProjectedCommentSourceShape(input.comment);
      const stableIds = stableIdentityForSource(input);
      const identityDigest = admissionCore.digest({
        contract: "non-dispatch-user/v1",
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        comment: input.comment,
      });
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        const retry = await findRetry(transaction, input, identityDigest, TaskSession.Event.Prompted.type);
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(transaction, input, stableIds);
        await assertCanonicalScope(transaction, input, {
          allowTerminal: true,
        });
        await hooks.assertImmutableSource?.(transaction, input);
        return appendNonDispatchEvent(transaction, input, {
          user: true,
          identityDigest,
          ids,
          clock,
        });
      };
      return dbTransaction ? operation(dbTransaction) : db.transaction(operation);
    },

    appendNonDispatchControlNotice(input, dbTransaction) {
      assertSourceIdentity(input);
      if (input.comment) {
        assertProjectedCommentSourceShape(input.comment);
      }
      const stableIds = stableIdentityForSource(input);
      const identityDigest = admissionCore.digest({
        contract: "non-dispatch-control/v1",
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        actor: input.actor ?? null,
        counterpartTaskId: input.counterpartTaskId ?? null,
        counterpartAuthorityId: input.counterpartAuthorityId ?? null,
        counterpartOwnershipEpoch: input.counterpartOwnershipEpoch ?? null,
        comment: input.comment,
        allowTerminal: input.allowTerminal,
      });
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        await assertProjectedCommentProducer(transaction, input, input.comment);
        const retry = await findRetry(
          transaction,
          input,
          identityDigest,
          TaskSession.Event.ContextUpdated.type,
        );
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(transaction, input, stableIds);
        await assertCanonicalScope(transaction, input, {
          allowTerminal: input.allowTerminal,
        });
        await hooks.assertImmutableSource?.(transaction, input);
        return appendNonDispatchEvent(transaction, input, {
          user: false,
          identityDigest,
          ids,
          clock,
        });
      };
      return dbTransaction ? operation(dbTransaction) : db.transaction(operation);
    },

    appendNonDispatchSyntheticComment(input, dbTransaction) {
      assertSourceIdentity(input);
      assertProjectedCommentSourceShape(input.comment);
      if (
        !Number.isInteger(input.ownershipEpoch) ||
        input.ownershipEpoch < 1 ||
        !input.agentId ||
        !input.adapterConfigRevisionId ||
        !input.runId ||
        input.comment.author.agentId !== input.agentId ||
        input.comment.producingRun.runId !== input.runId ||
        input.comment.producingRun.adapterConfigRevisionId !== input.adapterConfigRevisionId
      ) {
        throw new TaskSessionLifecycleConflict("Non-dispatch synthetic source has an invalid run binding");
      }
      const stableIds = stableIdentityForSource(input);
      const identityDigest = admissionCore.digest({
        contract: "non-dispatch-synthetic/v1",
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        ownershipEpoch: input.ownershipEpoch,
        agentId: input.agentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
        runId: input.runId,
        actor: input.actor ?? null,
        counterpartTaskId: input.counterpartTaskId ?? null,
        counterpartAuthorityId: input.counterpartAuthorityId ?? null,
        counterpartOwnershipEpoch: input.counterpartOwnershipEpoch ?? null,
        projectionKind: input.projectionKind ?? "task_update",
        comment: input.comment,
      });
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        await assertProjectedCommentProducer(transaction, input, input.comment);
        const retry = await findRetry(transaction, input, identityDigest, TaskSession.Event.Synthetic.type);
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(transaction, input, stableIds);
        const { task } = await assertCanonicalScope(transaction, input, {
          allowTerminal: input.projectionKind === "run_progress",
        });
        if (task.ownershipEpoch !== input.ownershipEpoch) {
          throw new TaskSessionLifecycleConflict("Non-dispatch synthetic source ownership epoch is stale", {
            taskId: input.taskId,
          });
        }
        await hooks.assertImmutableSource?.(transaction, input);
        return appendNonDispatchSyntheticComment(transaction, input, {
          identityDigest,
          ids,
          clock,
        });
      };
      return dbTransaction ? operation(dbTransaction) : db.transaction(operation);
    },
  };
}
