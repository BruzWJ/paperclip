import type { Db } from "@paperclipai/db";
import { createOrdinaryTaskRuntimePart1 } from "./ordinary-task-runtime-part-1.js";
import { createOrdinaryTaskRuntimePart3 } from "./ordinary-task-runtime-part-3.js";
import { createOrdinaryTaskRuntimePart4 } from "./ordinary-task-runtime-part-4.js";
import { createOrdinaryTaskRuntimePart5 } from "./ordinary-task-runtime-part-5.js";
import { createOrdinaryTaskRuntimePart6 } from "./ordinary-task-runtime-part-6.js";
import type { OrdinaryTaskRuntimeOptions } from "./ordinary-task-runtime-shared.js";

export {
  OrdinaryTaskRuntimeRejected,
  type OrdinaryPluginWithdrawalInput,
  type OrdinaryPluginWithdrawalPrepareInput,
  type OrdinaryTaskBoardReassignInput,
  type OrdinaryTaskCreateInput,
  type OrdinaryTaskCreateResult,
  type OrdinaryTaskCreator,
  type OrdinaryTaskReassignInput,
  type OrdinaryTaskRuntimeOptions,
  type OrdinaryTaskUserCommentInput,
} from "./ordinary-task-runtime-shared.js";
export function createOrdinaryTaskRuntime(db: Db, options: OrdinaryTaskRuntimeOptions) {
  return {
    ...createOrdinaryTaskRuntimePart1(db, options),
    ...createOrdinaryTaskRuntimePart3(db, options),
    ...createOrdinaryTaskRuntimePart4(db, options),
    ...createOrdinaryTaskRuntimePart5(db),
    ...createOrdinaryTaskRuntimePart6(db, options),
  };
}

export type OrdinaryTaskRuntime = ReturnType<typeof createOrdinaryTaskRuntime>;
export type CreateOrdinaryTaskRuntimeResult = OrdinaryTaskRuntime;
