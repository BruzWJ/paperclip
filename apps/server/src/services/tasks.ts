import * as d from "./tasks-dependencies.js";

import { taskServicePart1 } from "./tasks-part-1.js";
import { taskServicePart2 } from "./tasks-part-2.js";
import { taskServicePart3 } from "./tasks-part-3.js";
import { taskServicePart4 } from "./tasks-part-4.js";

export {
  deriveTaskUserContext,
  parseStatusFilter,
  TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  TASK_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
  TASK_SUBTREE_DIAGNOSTICS_MAX_DEPTH,
  TASK_SUBTREE_DIAGNOSTICS_MAX_NODES,
  taskServiceContext,
  type TaskDependencyReadiness,
  type TaskFilters,
} from "./tasks-shared.js";
export function taskService(db: d.Db) {
  return {
    ...taskServicePart1(db),
    ...taskServicePart2(db),
    ...taskServicePart3(db),
    ...taskServicePart4(db),
  };
}

export type TaskServiceResult = ReturnType<typeof taskService>;
