import type { QueryClient } from "@tanstack/react-query";
import type { ActivityLoggedLiveEventPayload } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

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
  if (typeof document.hasFocus === "function" && !document.hasFocus())
    return false;
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

function shouldDeferTaskRefetchForVisibleAgentActivity(
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

  if (entityType !== "task" || action !== "task.comment_added" || !commentId)
    return false;

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
const ROUTINE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS = new Set([
  "routine.document_annotation_thread_created",
  "routine.document_annotation_comment_added",
  "routine.document_annotation_thread_resolved",
  "routine.document_annotation_thread_reopened",
  "routine.document_annotation_remapped",
]);
export function invalidateActivityQueries(
  queryClient: QueryClient,
  companyId: string,
  payload: ActivityLoggedLiveEventPayload,
  currentActor: { userId: string | null },
  visibleTaskRoute: VisibleTaskRoute,
) {
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

  const entityType = payload.entityType;
  const entityId = payload.entityId;
  const action = payload.action;
  const actorType = payload.actorType;
  const actorId = payload.actorId;
  const details = payload.details;
  const runId = payload.runId;
  const taskId = payload.taskId;
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
    queryClient.invalidateQueries({
      queryKey: ["finance-summary", companyId],
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.budgets.overview(companyId),
    });
    if (entityType === "finance_event") {
      queryClient.invalidateQueries({ queryKey: ["tasks", "cost-summary"] });
    }
  }
  const ownActorActivity =
    actorType === "user" &&
    !!currentActor.userId &&
    actorId === currentActor.userId;

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

  if (taskId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(companyId) });
    const selfCommentActivity =
      entityType === "task" &&
      (action === "task.comment_added" ||
        (action === "task.updated" &&
          readString(details?.source) === "comment")) &&
      actorType === "user" &&
      !!currentActor.userId &&
      actorId === currentActor.userId;
    const visibleTaskAgentActivity =
      shouldDeferTaskRefetchForVisibleAgentActivity(
        visibleTaskRoute,
        payload,
      );
    const visibleTaskCommentActivity = shouldDeferVisibleTaskCommentActivity(
      visibleTaskRoute,
      payload,
    );
    const invalidationOptions =
      selfCommentActivity ||
      visibleTaskAgentActivity ||
      visibleTaskCommentActivity
        ? { refetchType: "inactive" as const }
        : undefined;

    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.detail(taskId),
      ...invalidationOptions,
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.activity(taskId),
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
      (TASK_DOCUMENT_ACTIVITY_ACTIONS.has(action) ||
        TASK_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action))
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

    if (
      action === "task.attachment_added" ||
      action === "task.attachment_removed"
    ) {
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

    if (
      action === "task.approval_linked" ||
      action === "task.approval_unlinked"
    ) {
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

  switch (entityType) {
    case "task":
      return;

    case "agent":
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detail(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: ["runs", companyId, entityId],
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeState(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeConfiguration(entityId, companyId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.adapterConfigRevisions(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.currentAdapterConfigRevisionRoot(entityId),
        });
      }
      return;

    case "agent_adapter_config_revision": {
      const targetAgentId = readString(details?.targetAgentId);
      if (targetAgentId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.detail(targetAgentId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.runtimeConfiguration(
            targetAgentId,
            companyId,
          ),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.adapterConfigRevisions(targetAgentId),
        });
        queryClient.invalidateQueries({
          queryKey:
            queryKeys.agents.currentAdapterConfigRevisionRoot(targetAgentId),
        });
      }
      return;
    }

    case "project":
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.detail(entityId),
        });
      }
      return;

    case "goal":
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(companyId),
      });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.detail(entityId),
        });
      }
      return;

    case "approval":
      queryClient.invalidateQueries({ queryKey: ["approvals", companyId] });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.detail(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.comments(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.tasks(entityId),
        });
      }
      return;

    case "join_request":
      queryClient.invalidateQueries({
        queryKey: ["access", "join-requests", companyId],
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyMembers(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyUserDirectory(companyId),
      });
      return;

    case "invite":
      queryClient.invalidateQueries({
        queryKey: ["access", "invites", "paginated-v1", companyId],
      });
      return;

    case "company_membership":
    case "principal_permission_grants":
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyMembers(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyUserDirectory(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["access", "current-board-access"],
      });
      queryClient.invalidateQueries({
        queryKey: ["access", "user-company-access"],
      });
      queryClient.invalidateQueries({ queryKey: ["user-profile", companyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      return;

    case "routine":
    case "routine_trigger":
    case "routine_run": {
      queryClient.invalidateQueries({
        queryKey: ["routines", companyId],
      });
      const routineId =
        entityType === "routine" ? entityId : readString(details?.routineId);
      if (routineId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(routineId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.runs(routineId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.revisions(routineId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.activity(companyId, routineId),
        });
        if (
          entityType === "routine" &&
          action &&
          ROUTINE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action)
        ) {
          const documentKey = readString(details?.documentKey);
          if (documentKey) {
            queryClient.invalidateQueries({
              queryKey: [
                "routines",
                "document-annotations",
                routineId,
                documentKey,
              ],
              ...(ownActorActivity
                ? { refetchType: "inactive" as const }
                : undefined),
            });
          }
        }
      }
      queryClient.invalidateQueries({ queryKey: ["folders", companyId] });
      return;
    }

    case "folder":
      queryClient.invalidateQueries({ queryKey: ["folders", companyId] });
      return;

    case "company":
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companies.detail(companyId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      if (action?.startsWith("inbox.")) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.inboxDismissals(companyId),
        });
      }
      return;

    case "instance_settings":
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.settings });
      queryClient.invalidateQueries({
        queryKey: queryKeys.instance.generalSettings,
      });
      return;

    case "label":
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.labels(companyId),
      });
      return;

    case "secret": {
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["user-secrets", companyId],
      });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.usage(entityId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.accessEvents(entityId),
        });
      }
      const definitionId = readString(details?.userSecretDefinitionId);
      if (definitionId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userDefinitionCoverage(
            companyId,
            definitionId,
          ),
        });
      }
      return;
    }

    case "secret_provider_config":
    case "secret_provider_config_discovery":
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.providers(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.providerConfigs(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["secret-provider-health", companyId],
      });
      return;

    case "user_secret_definition":
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.userDefinitions(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: ["user-secrets", companyId],
      });
      if (entityId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userDefinitionCoverage(
            companyId,
            entityId,
          ),
        });
      }
      return;

    case "user":
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.companyUserDirectory(companyId),
      });
      queryClient.invalidateQueries({ queryKey: ["user-profile", companyId] });
      queryClient.invalidateQueries({ queryKey: ["access", "admin-users"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      return;

    case "user_inbox_agent_policy":
      queryClient.invalidateQueries({
        queryKey: entityId
          ? queryKeys.inboxAgentPolicy(companyId, entityId)
          : ["inbox-agent-policy", companyId],
      });
      return;

    case "plugin":
      return;

    case "asset":
      queryClient.invalidateQueries({ queryKey: ["artifacts", companyId] });
      return;

    case "budget_incident":
    case "budget_policy":
      queryClient.invalidateQueries({
        queryKey: queryKeys.budgets.overview(companyId),
      });
      return;

    case "execution_workspace":
    case "finance_event":
    case "local_run_lease":
      return;

    default:
      // Plugins may publish their own entity types. Aggregate and plugin cache
      // invalidations above remain canonical without inventing host aliases.
      return;
  }
}
