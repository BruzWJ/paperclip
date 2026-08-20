import {
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskSessionInputDispositions,
  taskSessionInputs,
  type Db,
} from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import type { TaskSessionInputService } from "./input-part-1.js";
import { candidateMatchesScope, validateActiveExecution } from "./input-part-2.js";
import { promoteCandidate } from "./input-part-3.js";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./store.js";

export function createTaskSessionInputService(
  db: Db,
  options: { clock?: () => Date } = {},
): TaskSessionInputService {
  const clock = options.clock ?? (() => new Date());
  return {
    promotePreparedInput(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, {
          ...scope,
          activeRefId: scope.refId,
          runId: null,
        });
        if (active.ref.inputId === null || active.ref.promotedSeq !== null) {
          return false;
        }
        const rows = await transaction
          .select({
            inbox: taskSessionInputs,
            disposition: taskSessionInputDispositions,
            ref: taskExecutionRefs,
            view: taskExecutionHistoryViews,
          })
          .from(taskSessionInputs)
          .innerJoin(
            taskSessionInputDispositions,
            eq(taskSessionInputDispositions.inputId, taskSessionInputs.id),
          )
          .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskSessionInputDispositions.sourceRefId))
          .innerJoin(
            taskExecutionHistoryViews,
            eq(taskExecutionHistoryViews.id, taskExecutionRefs.historyViewId),
          )
          .where(and(eq(taskSessionInputs.id, active.ref.inputId), isNull(taskSessionInputs.promotedSeq)))
          .limit(1)
          .for("update");
        const candidate = rows[0];
        if (!candidate) {
          throw new TaskSessionInvariantError(
            `Prepared Task Session input ${active.ref.inputId} disappeared before promotion`,
          );
        }
        if (!candidateMatchesScope(active, candidate, false)) {
          throw new TaskSessionLifecycleConflict(
            "Prepared Task Session input no longer matches its exact ref and history view",
            { refId: scope.refId, inputId: active.ref.inputId },
          );
        }
        await promoteCandidate(transaction, candidate, clock());
        return true;
      });
    },
  };
}
