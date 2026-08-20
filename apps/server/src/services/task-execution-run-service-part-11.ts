import { taskExecutionRunRefs, taskExecutionRuns, tasks, type Db } from "@paperclipai/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type TaskExecutionRunService } from "./task-execution-run-service-part-10.js";
import {
  TaskExecutionRunInvariantViolation,
  assertExactRunIdentifier,
} from "./task-execution-run-service-part-1-section-1.js";
import {
  assertRunEnvelopeInvariant,
  projectRunEnvelope,
  readTaskExecutionRun,
} from "./task-execution-run-service-part-2-section-1.js";
import {
  attachTaskExecutionRunAttemptInTransaction,
  createTaskExecutionRunInTransaction,
  transitionTaskExecutionRunStatusInTransaction,
} from "./task-execution-run-service-part-5-section-1.js";
import {
  attachTaskExecutionRunCancellationInTransaction,
  attachTaskExecutionRunFinalizationInTransaction,
  detachTaskExecutionRunCancellationInTransaction,
  listTaskExecutionRunsForActivity,
  listTaskExecutionRunsForAgent,
  listTaskExecutionRunsForTask,
  listTaskExecutionRunsForWorkTimeline,
} from "./task-execution-run-service-part-6-section-1.js";
import { detachTaskExecutionRunAttemptInTransaction } from "./task-execution-run-service-part-5-section-2.js";
import { lockTaskExecutionRunInTransaction } from "./task-execution-run-service-part-3-section-1.js";
import { readJoinedTaskExecutionRunDetail } from "./task-execution-run-service-part-8.js";
import type { TaskSessionStore } from "./task-session/store.js";

export function createTaskExecutionRunService(options: {
  readonly database: Db;
  readonly taskSessionStore: TaskSessionStore;
}): TaskExecutionRunService {
  const service: TaskExecutionRunService = {
    createRun(transaction, input) {
      return createTaskExecutionRunInTransaction(transaction, input);
    },

    lockRun(transaction, input) {
      return lockTaskExecutionRunInTransaction(transaction, input);
    },

    readRun(input) {
      return readTaskExecutionRun(options.database, input);
    },

    async lockActiveRunsForAgentsInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      const agentIds = [...new Set(input.agentIds)];
      for (const agentId of agentIds) {
        assertExactRunIdentifier(agentId, "target agent id");
      }
      if (agentIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            inArray(taskExecutionRuns.targetAgentId, agentIds),
            inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.taskId, "task id");
      const byEpoch = "ownershipEpoch" in input;
      if (byEpoch && (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1)) {
        throw new TaskExecutionRunInvariantViolation("ownership epoch must be a positive integer");
      }
      const refIds = byEpoch ? [] : [...new Set(input.refIds)];
      for (const refId of refIds) {
        assertExactRunIdentifier(refId, "execution ref id");
      }
      if (!byEpoch && refIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            eq(taskExecutionRuns.taskId, input.taskId),
            inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
            byEpoch
              ? eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch)
              : sql`exists (
                  select 1
                  from ${taskExecutionRunRefs}
                  where ${taskExecutionRunRefs.companyId} = ${taskExecutionRuns.companyId}
                    and ${taskExecutionRunRefs.taskId} = ${taskExecutionRuns.taskId}
                    and ${taskExecutionRunRefs.runId} = ${taskExecutionRuns.id}
                    and ${inArray(taskExecutionRunRefs.refId, refIds)}
                )`,
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveAgentRunsForTaskEpochInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.taskId, "task id");
      if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
        throw new TaskExecutionRunInvariantViolation("ownership epoch must be a positive integer");
      }
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            eq(taskExecutionRuns.taskId, input.taskId),
            eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
            inArray(taskExecutionRuns.kind, ["productive", "consult"]),
            inArray(taskExecutionRuns.status, ["queued", "scheduled_retry", "running"]),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForBudgetScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.scopeId, "budget scope id");
      if (input.scopeType === "company" && input.scopeId !== input.companyId) {
        throw new TaskExecutionRunInvariantViolation("company budget scope must target its exact company");
      }
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
            input.scopeType === "company"
              ? undefined
              : input.scopeType === "project"
                ? sql`exists (
                    select 1
                    from ${tasks}
                    where ${tasks.companyId} = ${taskExecutionRuns.companyId}
                      and ${tasks.id} = ${taskExecutionRuns.taskId}
                      and ${tasks.projectId} = ${input.scopeId}
                  )`
                : eq(taskExecutionRuns.targetAgentId, input.scopeId),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      return Object.freeze(rows.map(projectRunEnvelope));
    },

    transitionRunStatus(transaction, input) {
      return transitionTaskExecutionRunStatusInTransaction(transaction, input);
    },

    attachAttempt(transaction, input) {
      return attachTaskExecutionRunAttemptInTransaction(transaction, input);
    },

    detachAttempt(transaction, input) {
      return detachTaskExecutionRunAttemptInTransaction(transaction, input);
    },

    attachCancellation(transaction, input) {
      return attachTaskExecutionRunCancellationInTransaction(transaction, input);
    },

    detachCancellation(transaction, input) {
      return detachTaskExecutionRunCancellationInTransaction(transaction, input);
    },

    attachFinalization(transaction, input) {
      return attachTaskExecutionRunFinalizationInTransaction(transaction, input);
    },

    listForTask(input) {
      return listTaskExecutionRunsForTask(options.database, input);
    },

    listForAgent(input) {
      return listTaskExecutionRunsForAgent(options.database, input);
    },

    listForActivity(input) {
      return listTaskExecutionRunsForActivity(options.database, input);
    },

    listForWorkTimeline(input) {
      return listTaskExecutionRunsForWorkTimeline(options.database, input);
    },

    readJoinedRunDetail(input) {
      return readJoinedTaskExecutionRunDetail(options.database, options.taskSessionStore, input);
    },
  };
  return Object.freeze(service);
}
