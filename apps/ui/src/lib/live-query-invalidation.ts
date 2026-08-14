import type { ActivityLoggedLiveEventPayload } from "@paperclipai/shared";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateEntityActivityQueries, readString } from "./live-query-entity-invalidation";
import { queryKeys } from "./queryKeys";

export interface VisibleTaskRoute {
  taskId: string | null;
  foregrounded: boolean;
}

interface VisibleTaskRouteContext {
  taskId: string;
}

export function isPageForegrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  return true;
}

function resolveVisibleTaskRouteContext(route: VisibleTaskRoute): VisibleTaskRouteContext | null {
  if (!route.foregrounded || route.taskId === null) return null;
  return { taskId: route.taskId };
}

export function shouldSuppressActivityToastForVisibleTask(
  route: VisibleTaskRoute,
  payload: ActivityLoggedLiveEventPayload,
): boolean {
  const entityType = payload.entityType;
  const taskId = payload.taskId;
  if (entityType !== "task" || !taskId) return false;

  const context = resolveVisibleTaskRouteContext(route);
  if (!context) return false;

  return context.taskId === taskId;
}

export function shouldDeferTaskRefetchForVisibleAgentActivity(
  route: VisibleTaskRoute,
  payload: ActivityLoggedLiveEventPayload,
): boolean {
  const entityType = payload.entityType;
  const taskId = payload.taskId;
  const actorType = payload.actorType;
  const action = payload.action;
  const details = payload.details;

  if (entityType !== "task" || !taskId) return false;
  if (actorType !== "agent" && actorType !== "system") return false;
  if (action !== "task.updated") return false;
  if (readString(details?.source) === "comment") return false;

  const context = resolveVisibleTaskRouteContext(route);
  if (!context) return false;

  return context.taskId === taskId;
}

export function shouldDeferVisibleTaskCommentActivity(
  route: VisibleTaskRoute,
  payload: ActivityLoggedLiveEventPayload,
): boolean {
  const entityType = payload.entityType;
  const taskId = payload.taskId;
  const action = payload.action;

  if (entityType !== "task" || !taskId) return false;
  if (action !== "task.comment_added") return false;

  const context = resolveVisibleTaskRouteContext(route);
  if (!context) return false;

  return context.taskId === taskId;
}

export async function refreshVisibleTaskCommentGroups(
  queryClient: QueryClient,
  route: VisibleTaskRoute,
  payload: ActivityLoggedLiveEventPayload,
) {
  const entityType = payload.entityType;
  const action = payload.action;
  const details = payload.details;
  const commentId = readString(details?.commentId);

  if (entityType !== "task" || action !== "task.comment_added" || !commentId) return false;

  const context = resolveVisibleTaskRouteContext(route);
  if (!context) return false;

  const taskId = payload.taskId;
  if (!taskId || context.taskId !== taskId) return false;

  await queryClient.invalidateQueries({
    queryKey: queryKeys.tasks.comments(context.taskId),
  });
  return true;
}

const TASK_DOCUMENT_ACTIVITY_ACTIONS = new Set([
  "task.document_created",
  "task.document_updated",
  "task.document_restored",
  "task.document_deleted",
]);
const TASK_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS = new Set([
  "task.document_annotation_thread_created",
  "task.document_annotation_comment_added",
  "task.document_annotation_thread_resolved",
  "task.document_annotation_thread_reopened",
  "task.document_annotation_remapped",
]);

export function invalidateTaskActivityQueries(
  queryClient: QueryClient,
  companyId: string,
  payload: ActivityLoggedLiveEventPayload,
  currentActor: { userId: string | null },
  visibleTaskRoute: VisibleTaskRoute,
): void {
  const { action, actorId, actorType, details, entityType, taskId } = payload;
  if (!taskId) return;

  queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(companyId) });
  const selfCommentActivity =
    entityType === "task" &&
    (action === "task.comment_added" ||
      (action === "task.updated" && readString(details?.source) === "comment")) &&
    actorType === "user" &&
    !!currentActor.userId &&
    actorId === currentActor.userId;
  const visibleTaskAgentActivity = shouldDeferTaskRefetchForVisibleAgentActivity(visibleTaskRoute, payload);
  const visibleTaskCommentActivity = shouldDeferVisibleTaskCommentActivity(visibleTaskRoute, payload);
  const invalidationOptions =
    selfCommentActivity || visibleTaskAgentActivity || visibleTaskCommentActivity
      ? { refetchType: "inactive" as const }
      : undefined;

  queryClient.invalidateQueries({
    queryKey: queryKeys.tasks.detail(taskId),
    ...invalidationOptions,
  });
  queryClient.invalidateQueries({
    queryKey: ["tasks", "runs", taskId],
    ...invalidationOptions,
  });

  if (action === "task.comment_added") {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.comments(taskId),
      ...invalidationOptions,
    });
  }

  if (action && TASK_DOCUMENT_ACTIVITY_ACTIONS.has(action)) {
    const documentKey = readString(details?.key);
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.documents(taskId),
      ...invalidationOptions,
    });
    if (documentKey) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.document(taskId, documentKey),
        ...invalidationOptions,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.documentRevisions(taskId, documentKey),
        ...invalidationOptions,
      });
    } else {
      queryClient.invalidateQueries({
        queryKey: ["tasks", "document", taskId],
        ...invalidationOptions,
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", "document-revisions", taskId],
        ...invalidationOptions,
      });
    }
  }

  if (
    action &&
    (TASK_DOCUMENT_ACTIVITY_ACTIONS.has(action) || TASK_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action))
  ) {
    const documentKey = TASK_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action)
      ? readString(details?.documentKey)
      : readString(details?.key);
    if (documentKey) {
      queryClient.invalidateQueries({
        queryKey: ["tasks", "document-annotations", taskId, documentKey],
        ...invalidationOptions,
      });
    }
  }

  if (action === "task.attachment_added" || action === "task.attachment_removed") {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.attachments(taskId),
    });
    const attachmentId = readString(details?.attachmentId);
    if (attachmentId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.attachmentPreview(attachmentId),
      });
    }
  }

  if (
    action === "task.work_product_created" ||
    action === "task.work_product_updated" ||
    action === "task.work_product_deleted" ||
    action === "task.low_trust_output_promoted"
  ) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.workProducts(taskId),
    });
    queryClient.invalidateQueries({ queryKey: ["artifacts", companyId] });
  }

  if (action === "task.approval_linked" || action === "task.approval_unlinked") {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.approvals(taskId),
    });
    queryClient.invalidateQueries({ queryKey: ["approvals", companyId] });
    const approvalId = readString(details?.approvalId);
    if (approvalId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.detail(approvalId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.tasks(approvalId),
      });
    }
  }
}

export function invalidateActivityQueries(
  queryClient: QueryClient,
  companyId: string,
  payload: ActivityLoggedLiveEventPayload,
  currentActor: { userId: string | null },
  visibleTaskRoute: VisibleTaskRoute,
): void {
  // Every activity changes the operator-level aggregate projections. These are
  // the live families that previously depended on independent page polling.
  queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({
    queryKey: queryKeys.sidebarBadges(companyId),
  });
  queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
  queryClient.invalidateQueries({ queryKey: ["work-timeline", companyId] });
  queryClient.invalidateQueries({ queryKey: ["company-search", companyId] });

  const { action, actorType, details, entityType, runId, taskId } = payload;
  if (runId) {
    queryClient.invalidateQueries({ queryKey: ["runs", companyId] });
    queryClient.invalidateQueries({ queryKey: queryKeys.runDetail(runId) });
    if (taskId) {
      queryClient.invalidateQueries({
        queryKey: ["tasks", "cost-summary", taskId],
      });
    }
  }
  if (runId || entityType === "finance_event") {
    queryClient.invalidateQueries({ queryKey: ["costs", companyId] });
    queryClient.invalidateQueries({ queryKey: ["finance-summary", companyId] });
    queryClient.invalidateQueries({
      queryKey: queryKeys.budgets.overview(companyId),
    });
    if (entityType === "finance_event") {
      queryClient.invalidateQueries({ queryKey: ["tasks", "cost-summary"] });
    }
  }

  // Plugin settings include runtime summaries and recent plugin logs. Plugin
  // mutations use entityType=plugin, while plugin-originated activity retains
  // its domain entity type and identifies the installation as the actor.
  if (entityType === "plugin" || actorType === "plugin") {
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
  }

  if (action?.startsWith("resource_membership.")) {
    const targetUserId = readString(details?.userId);
    if (!targetUserId || targetUserId === currentActor.userId) {
      queryClient.invalidateQueries({
        queryKey: currentActor.userId
          ? queryKeys.resourceMemberships.forUser(companyId, currentActor.userId)
          : ["resource-memberships", companyId],
      });
    }
  }

  invalidateTaskActivityQueries(queryClient, companyId, payload, currentActor, visibleTaskRoute);
  invalidateEntityActivityQueries(queryClient, companyId, payload, currentActor);
}
