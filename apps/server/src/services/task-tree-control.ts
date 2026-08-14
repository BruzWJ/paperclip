import type { Db } from "@paperclipai/db";
import { taskTreeControlServiceGroup1 } from "./task-tree-control-group-1.js";
import { taskTreeControlServiceGroup2 } from "./task-tree-control-group-2.js";
import { taskTreeControlServiceGroup3 } from "./task-tree-control-group-3.js";
import type { TaskTreeCancellationPort } from "./task-tree-control-foundation.js";

export * from "./task-tree-control-foundation.js";

export function taskTreeControlService(
  db: Db,
  options: { taskExecutionCancellation?: TaskTreeCancellationPort } = {},
) {
  const groupContext = { db, options };
  const group1 = taskTreeControlServiceGroup1(groupContext);
  const group2 = taskTreeControlServiceGroup2(groupContext, group1);
  const group3 = taskTreeControlServiceGroup3(groupContext, group1, group2);
  return Object.assign({}, group1, group2, group3);
}
