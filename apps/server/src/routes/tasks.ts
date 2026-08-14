import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { registerTaskAttachmentRoutes } from "./task-attachment-routes.js";
import { registerTaskCommentRoutes } from "./task-comment-routes.js";
import { registerTaskDocumentAnnotationRoutes } from "./task-document-annotation-routes.js";
import { registerTaskDocumentRoutes } from "./task-document-routes.js";
import { registerTaskExecutionPolicyRoutes } from "./task-execution-policy-routes.js";
import { registerTaskLabelAndDiagnosticRoutes } from "./task-label-diagnostic-routes.js";
import { registerTaskMutationRoutes } from "./task-mutation-routes.js";
import { createTaskRouteContext, type TaskRouteOptions } from "./task-route-context.js";
import { registerTaskSearchAndListRoutes } from "./task-search-list-routes.js";
import { registerTaskStateAndApprovalRoutes } from "./task-state-approval-routes.js";
import { registerTaskWorkProductRoutes } from "./task-work-product-routes.js";

export { TASK_LIST_SERVER_CACHE_MAX_ENTRIES } from "./task-route-list-cache.js";
export { requireNamedBoardUser } from "./task-route-list-coordinator.js";

export function taskRoutes(db: Db, storage: StorageService, options: TaskRouteOptions) {
  const context = createTaskRouteContext(db, storage, options);
  registerTaskSearchAndListRoutes(context);
  registerTaskLabelAndDiagnosticRoutes(context);
  registerTaskDocumentAnnotationRoutes(context);
  registerTaskDocumentRoutes(context);
  registerTaskWorkProductRoutes(context);
  registerTaskStateAndApprovalRoutes(context);
  registerTaskExecutionPolicyRoutes(context);
  registerTaskMutationRoutes(context);
  registerTaskCommentRoutes(context);
  registerTaskAttachmentRoutes(context);
  return context.router;
}
