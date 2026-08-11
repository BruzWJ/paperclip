import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createCoalescingQueryClient, createInvalidationBatcher } from "../lib/query-invalidation-batcher";
import type {
  Agent,
  Task,
  TaskExecutionRunListPageRecord,
  LiveEvent,
} from "@paperclipai/shared";
import type { CompanyUserDirectoryResponse } from "../api/access";
import { authApi } from "../api/auth";
import { useCompany } from "./CompanyContext";
import type { ToastInput } from "./ToastContext";
import { useToastActions } from "./ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES } from "../api/runs";
import { toCompanyRelativePath } from "../lib/company-routes";
import { useLocation } from "../lib/router";
import { buildSameOriginWebSocketUrl } from "../lib/websocket-url";

const TOAST_COOLDOWN_WINDOW_MS = 10_000;
const TOAST_COOLDOWN_MAX = 3;
const RECONNECT_SUPPRESS_MS = 2000;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

type LiveUpdatesSocketLike = {
  readyState: number;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null;
  close: (code?: number, reason?: string) => void;
};

export type CompanyLiveEventHandler = (event: LiveEvent) => void;

interface LiveEventSubscription {
  subscribe: (handler: CompanyLiveEventHandler) => () => void;
}

const LiveEventSubscriptionContext = createContext<LiveEventSubscription | null>(null);

function dispatchLiveEventToSubscribers(
  subscribers: Set<CompanyLiveEventHandler>,
  expectedCompanyId: string,
  event: LiveEvent,
) {
  if (event.companyId !== expectedCompanyId) return;
  // Snapshot so a handler that (un)subscribes mid-dispatch can't mutate the set
  // we're iterating.
  for (const handler of Array.from(subscribers)) {
    try {
      handler(event);
    } catch {
      // A misbehaving subscriber must never break the shared socket pipeline
      // or the toast/invalidation handling that runs alongside it.
    }
  }
}

/**
 * Subscribe to live company events off the single shared LiveUpdates socket.
 * Components can react to `activity.logged` and other company events
 * without opening a WebSocket per mount. Events are already filtered to the
 * active company. No-ops when rendered outside a LiveUpdatesProvider (e.g. in
 * isolated tests), so callers get graceful degradation for free.
 */
export function useCompanyLiveEvent(handler: CompanyLiveEventHandler): void {
  const subscription = useContext(LiveEventSubscriptionContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!subscription) return;
    return subscription.subscribe((event) => {
      handlerRef.current(event);
    });
  }, [subscription]);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function resolveAgentName(
  queryClient: QueryClient,
  companyId: string,
  agentId: string,
): string | null {
  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  if (!agents) return null;
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? null;
}

function resolveUserName(
  queryClient: QueryClient,
  companyId: string,
  userId: string,
): string | null {
  const directory = queryClient.getQueryData<CompanyUserDirectoryResponse>(
    queryKeys.access.companyUserDirectory(companyId),
  );
  if (!directory) return null;
  const entry = directory.users.find((u) => u.principalId === userId);
  return entry?.user?.name?.trim() || entry?.user?.email?.trim() || null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function resolveActorLabel(
  queryClient: QueryClient,
  companyId: string,
  actorType: string | null,
  actorId: string | null,
): string {
  if (actorType === "agent" && actorId) {
    return resolveAgentName(queryClient, companyId, actorId) ?? `Agent ${shortId(actorId)}`;
  }
  if (actorType === "system") return "System";
  if (actorType === "user" && actorId) {
    return resolveUserName(queryClient, companyId, actorId) ?? "Board";
  }
  return "Someone";
}

interface TaskToastContext {
  ref: string;
  title: string | null;
  label: string;
  href: string;
}

interface VisibleRouteOptions {
  isForegrounded?: boolean;
}

interface VisibleTaskRouteContext {
  routeTaskRef: string;
  taskRefs: Set<string>;
  ownerAgentId: string | null;
  runIds: Set<string>;
}

function resolveTaskQueryRefs(
  queryClient: QueryClient,
  companyId: string,
  taskId: string,
  details: Record<string, unknown> | null,
): string[] {
  const refs = new Set<string>([taskId]);
  const detailTask = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId));
  const listTasks = queryClient.getQueryData<Task[]>(queryKeys.tasks.list(companyId));
  const detailsIdentifier =
    readString(details?.identifier) ??
    readString(details?.taskIdentifier);

  if (detailsIdentifier) refs.add(detailsIdentifier);

  if (detailTask?.id) refs.add(detailTask.id);
  if (detailTask?.identifier) refs.add(detailTask.identifier);

  const listTask = listTasks?.find((task) => {
    if (task.id === taskId) return true;
    if (task.identifier && task.identifier === taskId) return true;
    if (detailsIdentifier && task.identifier === detailsIdentifier) return true;
    return false;
  });
  if (listTask?.id) refs.add(listTask.id);
  if (listTask?.identifier) refs.add(listTask.identifier);

  return Array.from(refs);
}

function resolveTaskToastContext(
  queryClient: QueryClient,
  companyId: string,
  taskId: string,
  details: Record<string, unknown> | null,
): TaskToastContext {
  const taskRefs = resolveTaskQueryRefs(queryClient, companyId, taskId, details);
  const detailTask = taskRefs
    .map((ref) => queryClient.getQueryData<Task>(queryKeys.tasks.detail(ref)))
    .find((task): task is Task => !!task);
  const listTask = queryClient
    .getQueryData<Task[]>(queryKeys.tasks.list(companyId))
    ?.find((task) => taskRefs.some((ref) => task.id === ref || task.identifier === ref));
  const cachedTask = detailTask ?? listTask ?? null;
  const ref =
    readString(details?.identifier) ??
    readString(details?.taskIdentifier) ??
    cachedTask?.identifier ??
    `Task ${shortId(taskId)}`;
  const title =
    readString(details?.title) ??
    readString(details?.taskTitle) ??
    cachedTask?.title ??
    null;
  return {
    ref,
    title,
    label: title ? `${ref} - ${truncate(title, 72)}` : ref,
    href: `/tasks/${cachedTask?.identifier ?? taskId}`,
  };
}

function isPageForegrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  return true;
}

function resolveVisibleTaskRouteContext(
  queryClient: QueryClient,
  pathname: string,
  options?: VisibleRouteOptions,
): VisibleTaskRouteContext | null {
  const isForegrounded = options?.isForegrounded ?? isPageForegrounded();
  if (!isForegrounded) return null;

  const relativePath = toCompanyRelativePath(pathname);
  const segments = relativePath.split("/").filter(Boolean);
  if (segments[0] !== "tasks" || !segments[1]) return null;

  const taskRef = decodeURIComponent(segments[1]);
  const task = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskRef)) ?? null;
  const taskRefs = new Set<string>([taskRef]);
  if (task?.id) taskRefs.add(task.id);
  if (task?.identifier) taskRefs.add(task.identifier);

  const runIds = new Set<string>();
  const runs = queryClient.getQueryData<TaskExecutionRunListPageRecord>(
    queryKeys.tasks.runs(taskRef, ACTIVE_TASK_EXECUTION_RUN_STATUSES),
  );
  for (const run of runs?.items ?? []) {
    runIds.add(run.id);
  }

  return {
    routeTaskRef: taskRef,
    taskRefs,
    ownerAgentId: task?.ownerAgentId ?? null,
    runIds,
  };
}

function buildTaskRefsForPayload(entityId: string, details: Record<string, unknown> | null): Set<string> {
  const refs = new Set<string>([entityId]);
  const identifier = readString(details?.identifier) ?? readString(details?.taskIdentifier);
  if (identifier) refs.add(identifier);
  return refs;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function shouldSuppressActivityToastForVisibleTask(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  if (entityType !== "task" || !entityId) return false;

  const context = resolveVisibleTaskRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.taskRefs, buildTaskRefsForPayload(entityId, readRecord(payload.details)));
}

function invalidateVisibleTaskRunQueries(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const context = resolveVisibleTaskRouteContext(queryClient, pathname, options);
  if (!context) return false;

  const runId = readString(payload.runId);
  const agentId = readString(payload.agentId);
  const matchesVisibleTask =
    (runId !== null && context.runIds.has(runId)) ||
    (!!agentId && !!context.ownerAgentId && agentId === context.ownerAgentId);
  if (!matchesVisibleTask) return false;

  for (const taskRef of context.taskRefs) {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(taskRef) });
    queryClient.invalidateQueries({ queryKey: ["tasks", "runs", taskRef] });
  }
  return true;
}

function shouldSuppressAgentStatusToastForVisibleTask(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const context = resolveVisibleTaskRouteContext(queryClient, pathname, options);
  if (!context?.ownerAgentId) return false;

  const agentId = readString(payload.agentId);
  return !!agentId && agentId === context.ownerAgentId;
}

function shouldDeferTaskRefetchForVisibleAgentActivity(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const actorType = readString(payload.actorType);
  const action = readString(payload.action);
  const details = readRecord(payload.details);

  if (entityType !== "task" || !entityId) return false;
  if (actorType !== "agent" && actorType !== "system") return false;
  if (action !== "task.updated") return false;
  if (readString(details?.source) === "comment") return false;

  const context = resolveVisibleTaskRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.taskRefs, buildTaskRefsForPayload(entityId, details));
}

function shouldDeferVisibleTaskCommentActivity(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const details = readRecord(payload.details);

  if (entityType !== "task" || !entityId) return false;
  if (action !== "task.comment_added") return false;

  const context = resolveVisibleTaskRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.taskRefs, buildTaskRefsForPayload(entityId, details));
}

async function refreshVisibleTaskCommentGroups(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
) {
  const entityType = readString(payload.entityType);
  const action = readString(payload.action);
  const details = readRecord(payload.details);
  const commentId = readString(details?.commentId);

  if (entityType !== "task" || action !== "task.comment_added" || !commentId) return false;

  const context = resolveVisibleTaskRouteContext(queryClient, pathname, options);
  if (!context) return false;

  const entityId = readString(payload.entityId);
  if (!entityId || !overlaps(context.taskRefs, buildTaskRefsForPayload(entityId, details))) {
    return false;
  }

  await queryClient.invalidateQueries({
    queryKey: queryKeys.tasks.comments(context.routeTaskRef),
  });
  return true;
}

const TASK_TOAST_ACTIONS = new Set(["task.created", "task.updated", "task.comment_added"]);
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
const AGENT_TOAST_STATUSES = new Set(["error"]);

function describeTaskUpdate(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const changes: string[] = [];
  if (typeof details.lifecycleStatus === "string") {
    changes.push(`lifecycle -> ${details.lifecycleStatus.replace(/_/g, " ")}`);
  }
  if (
    typeof details.ownerKind === "string"
    || typeof details.ownerAgentId === "string"
    || typeof details.ownerUserId === "string"
  ) {
    changes.push("owner changed");
  }
  if (details.reopened === true) {
    const from = readString(details.reopenedFrom);
    changes.push(from ? `reopened from ${from.replace(/_/g, " ")}` : "reopened");
  }
  if (typeof details.title === "string") changes.push("title changed");
  if (changes.length > 0) return changes.join(", ");
  return null;
}

function buildActivityToast(
  queryClient: QueryClient,
  companyId: string,
  payload: Record<string, unknown>,
  currentActor: { userId: string | null; agentId: string | null },
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const details = readRecord(payload.details);
  const actorId = readString(payload.actorId);
  const actorType = readString(payload.actorType);

  if (entityType !== "task" || !entityId || !action || !TASK_TOAST_ACTIONS.has(action)) {
    return null;
  }

  const task = resolveTaskToastContext(queryClient, companyId, entityId, details);
  const actor = resolveActorLabel(queryClient, companyId, actorType, actorId);
  const isSelfActivity =
    (actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
    (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId);
  if (isSelfActivity) return null;

  if (action === "task.created") {
    return {
      title: `${actor} created ${task.ref}`,
      body: task.title ? truncate(task.title, 96) : undefined,
      tone: "success",
      action: { label: `View ${task.ref}`, href: task.href },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  if (action === "task.updated") {
    if (readString(details?.source) === "comment") {
      // Comment-driven updates emit a paired comment event; show one combined toast on the comment event.
      return null;
    }
    const changeDesc = describeTaskUpdate(details);
    const body = changeDesc
      ? task.title
        ? `${truncate(task.title, 64)} - ${changeDesc}`
        : changeDesc
      : task.title
        ? truncate(task.title, 96)
        : task.label;
    return {
      title: `${actor} updated ${task.ref}`,
      body: truncate(body, 100),
      tone: "info",
      action: { label: `View ${task.ref}`, href: task.href },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  const commentId = readString(details?.commentId);
  const bodySnippet = readString(details?.bodySnippet);
  const reopened = details?.reopened === true;
  const updated = details?.updated === true;
  const reopenedFrom = readString(details?.reopenedFrom);
  const reopenedLabel = reopened
    ? reopenedFrom
      ? `reopened from ${reopenedFrom.replace(/_/g, " ")}`
      : "reopened"
    : null;
  const title = reopened
    ? `${actor} reopened and commented on ${task.ref}`
    : updated
      ? `${actor} commented and updated ${task.ref}`
      : `${actor} commented on ${task.ref}`;
  const body = bodySnippet
    ? reopenedLabel
      ? `${reopenedLabel} - ${bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")}`
      : bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")
    : reopenedLabel
      ? task.title
        ? `${reopenedLabel} - ${task.title}`
        : reopenedLabel
      : task.title ?? undefined;
  return {
    title,
    body: body ? truncate(body, 96) : undefined,
    tone: "info",
    action: { label: `View ${task.ref}`, href: task.href },
    dedupeKey: `activity:${action}:${entityId}:${commentId ?? "na"}`,
  };
}

function buildJoinRequestToast(
  payload: Record<string, unknown>,
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const action = readString(payload.action);
  const entityId = readString(payload.entityId);
  const details = readRecord(payload.details);

  if (entityType !== "join_request" || !action || !entityId) return null;
  if (action !== "join.requested" && action !== "join.request_replayed") return null;

  const requestType = readString(details?.requestType);
  const label = requestType === "agent" ? "Agent" : "Someone";

  return {
    title: `${label} wants to join`,
    body: "A new join request is waiting for approval.",
    tone: "info",
    action: { label: "View inbox", href: "/inbox/mine" },
    dedupeKey: `join-request:${entityId}`,
  };
}

function buildAgentStatusToast(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string | null,
  queryClient: QueryClient,
  companyId: string,
): ToastInput | null {
  const agentId = readString(payload.agentId);
  const status = readString(payload.status);
  if (!agentId || !status || !AGENT_TOAST_STATUSES.has(status)) return null;

  const tone = status === "error" ? "error" : "info";
  const name = nameOf(agentId) ?? `Agent ${shortId(agentId)}`;
  const title =
    status === "running"
      ? `${name} started`
      : `${name} errored`;

  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  const agent = agents?.find((a) => a.id === agentId);
  const body = agent?.title ?? undefined;

  return {
    title,
    body,
    tone,
    action: { label: "View agent", href: `/agents/${agentId}` },
    dedupeKey: `agent-status:${agentId}:${status}`,
  };
}

function invalidateActivityQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  payload: Record<string, unknown>,
  currentActor: { userId: string | null; agentId: string | null },
  options?: { pathname?: string; isForegrounded?: boolean },
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
  queryClient.invalidateQueries({ queryKey: ["runs", companyId] });

  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const actorType = readString(payload.actorType);
  const actorId = readString(payload.actorId);
  const details = readRecord(payload.details);
  const ownActorActivity =
    (actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
    (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId);

  if (action?.startsWith("resource_membership.")) {
    const targetUserId = readString(details?.userId);
    if (!targetUserId || targetUserId === currentActor.userId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.resourceMemberships.mine(companyId) });
    }
  }

  if (entityType === "task") {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listMineByMe(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listTouchedByMe(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.listUnreadTouchedByMe(companyId) });
    if (entityId) {
      const selfCommentActivity =
        ((action === "task.comment_added") ||
          (action === "task.updated" && readString(details?.source) === "comment")) &&
        ((actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
          (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId));
      const visibleTaskAgentActivity =
        !!options?.pathname &&
        shouldDeferTaskRefetchForVisibleAgentActivity(
          queryClient,
          options.pathname,
          payload,
          { isForegrounded: options.isForegrounded },
        );
      const visibleTaskCommentActivity =
        !!options?.pathname &&
        shouldDeferVisibleTaskCommentActivity(
          queryClient,
          options.pathname,
          payload,
          { isForegrounded: options.isForegrounded },
        );
      const taskRefs = resolveTaskQueryRefs(queryClient, companyId, entityId, details);
      for (const ref of taskRefs) {
        const invalidationOptions =
          (selfCommentActivity || visibleTaskAgentActivity || visibleTaskCommentActivity)
            ? { refetchType: "inactive" as const }
            : undefined;
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(ref), ...invalidationOptions });
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.activity(ref), ...invalidationOptions });
        queryClient.invalidateQueries({ queryKey: ["tasks", "runs", ref], ...invalidationOptions });
        if (action === "task.comment_added") {
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks.comments(ref), ...invalidationOptions });
        }
        if (action && TASK_DOCUMENT_ACTIVITY_ACTIONS.has(action)) {
          const documentKey = readString(details?.key);
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks.documents(ref), ...invalidationOptions });
          if (documentKey) {
            queryClient.invalidateQueries({ queryKey: queryKeys.tasks.document(ref, documentKey), ...invalidationOptions });
            queryClient.invalidateQueries({ queryKey: queryKeys.tasks.documentRevisions(ref, documentKey), ...invalidationOptions });
          } else {
            queryClient.invalidateQueries({ queryKey: ["tasks", "document", ref], ...invalidationOptions });
            queryClient.invalidateQueries({ queryKey: ["tasks", "document-revisions", ref], ...invalidationOptions });
          }
        }
        if (
          action &&
          (TASK_DOCUMENT_ACTIVITY_ACTIONS.has(action) || TASK_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action))
        ) {
          const documentKey = readString(details?.key) ?? readString(details?.documentKey);
          queryClient.invalidateQueries({
            queryKey: documentKey
              ? ["tasks", "document-annotations", ref, documentKey]
              : ["tasks", "document-annotations", ref],
            ...invalidationOptions,
          });
        }
      }
    }
    return;
  }

  if (entityType === "agent") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
    if (entityId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(entityId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.runs(companyId, { agentId: entityId }),
      });
    }
    return;
  }

  if (entityType === "project") {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(entityId) });
    return;
  }

  if (entityType === "goal") {
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(entityId) });
    return;
  }

  if (entityType === "approval") {
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    return;
  }

  if (entityType === "join_request") {
    queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
    return;
  }

  if (entityType === "cost_event") {
    queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.usageByProvider(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.usageWindowSpend(companyId) });
    return;
  }

  if (entityType === "routine" || entityType === "routine_trigger" || entityType === "routine_run") {
    queryClient.invalidateQueries({ queryKey: ["routines"] });
    if (entityType === "routine" && action && ROUTINE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action) && entityId) {
      const documentKey = readString(details?.key) ?? readString(details?.documentKey) ?? "description";
      const routineInvalidationOptions = ownActorActivity ? { refetchType: "inactive" as const } : undefined;
      queryClient.invalidateQueries({
        queryKey: ["routines", "document-annotations", entityId, documentKey],
        ...routineInvalidationOptions,
      });
    }
    return;
  }

  if (entityType === "company") {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }
}

interface ToastGate {
  cooldownHits: Map<string, number[]>;
  suppressUntil: number;
}

function shouldSuppressToast(gate: ToastGate, category: string): boolean {
  const now = Date.now();
  if (now < gate.suppressUntil) return true;

  const hits = gate.cooldownHits.get(category);
  if (!hits) return false;

  const recent = hits.filter((t) => now - t < TOAST_COOLDOWN_WINDOW_MS);
  gate.cooldownHits.set(category, recent);
  return recent.length >= TOAST_COOLDOWN_MAX;
}

function recordToastHit(gate: ToastGate, category: string) {
  const now = Date.now();
  const hits = gate.cooldownHits.get(category) ?? [];
  hits.push(now);
  gate.cooldownHits.set(category, hits);
}

function gatedPushToast(
  gate: ToastGate,
  pushToast: (toast: ToastInput) => string | null,
  category: string,
  toast: ToastInput,
) {
  if (shouldSuppressToast(gate, category)) return;
  const id = pushToast(toast);
  if (id !== null) recordToastHit(gate, category);
}

function handleLiveEvent(
  queryClient: QueryClient,
  expectedCompanyId: string,
  pathname: string,
  event: LiveEvent,
  pushToast: (toast: ToastInput) => string | null,
  gate: ToastGate,
  currentActor: { userId: string | null; agentId: string | null },
) {
  if (event.companyId !== expectedCompanyId) return;

  const nameOf = (id: string) => resolveAgentName(queryClient, expectedCompanyId, id);
  const payload = event.payload ?? {};

  if (event.type === "agent.status") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(expectedCompanyId) });
    const agentId = readString(payload.agentId);
    if (agentId) queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    const toast = buildAgentStatusToast(payload, nameOf, queryClient, expectedCompanyId);
    if (
      toast &&
      !shouldSuppressAgentStatusToastForVisibleTask(queryClient, pathname, payload)
    ) {
      gatedPushToast(gate, pushToast, "agent-status", toast);
    }
    return;
  }

  if (event.type === "activity.logged") {
    invalidateActivityQueries(queryClient, expectedCompanyId, payload, currentActor, { pathname });
    if (shouldDeferVisibleTaskCommentActivity(queryClient, pathname, payload)) {
      void refreshVisibleTaskCommentGroups(queryClient, pathname, payload);
    }
    const action = readString(payload.action);
    const toast =
      buildActivityToast(queryClient, expectedCompanyId, payload, currentActor) ??
      buildJoinRequestToast(payload);
    if (
      toast &&
      !shouldSuppressActivityToastForVisibleTask(queryClient, pathname, payload)
    ) {
      gatedPushToast(gate, pushToast, `activity:${action ?? "unknown"}`, toast);
    }
  }
}

function resolveLiveCompanyId(
  selectedCompanyId: string | null,
  selectedCompanyLiveId: string | null,
): string | null {
  return selectedCompanyId && selectedCompanyId === selectedCompanyLiveId
    ? selectedCompanyId
    : null;
}

function resetSocketHandlers(target: LiveUpdatesSocketLike) {
  target.onopen = null;
  target.onmessage = null;
  target.onerror = null;
  target.onclose = null;
}

function closeSocketQuietly(target: LiveUpdatesSocketLike | null, reason: string) {
  if (!target) return;

  if (target.readyState === SOCKET_CONNECTING) {
    // Let the handshake complete and then close. Calling close() while the
    // socket is still CONNECTING is what triggers the noisy browser error.
    target.onopen = () => {
      resetSocketHandlers(target);
      target.close(1000, reason);
    };
    target.onmessage = null;
    target.onerror = () => undefined;
    target.onclose = null;
    return;
  }

  resetSocketHandlers(target);

  if (target.readyState === SOCKET_OPEN) {
    target.close(1000, reason);
  }
}

export const __liveUpdatesTestUtils = {
  buildAgentStatusToast,
  closeSocketQuietly,
  dispatchLiveEventToSubscribers,
  LiveEventSubscriptionContext,
  refreshVisibleTaskCommentGroups,
  invalidateActivityQueries,
  invalidateVisibleTaskRunQueries,
  resolveLiveCompanyId,
  shouldDeferTaskRefetchForVisibleAgentActivity,
  shouldDeferVisibleTaskCommentActivity,
  shouldSuppressActivityToastForVisibleTask,
  shouldSuppressAgentStatusToastForVisibleTask,
};

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const location = useLocation();
  const gateRef = useRef<ToastGate>({ cooldownHits: new Map(), suppressUntil: 0 });
  const pathnameRef = useRef(location.pathname);
  const { data: session, status: sessionStatus } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const socketAuthKey = session?.session?.id ?? currentUserId ?? "signed_out";
  const liveCompanyId = resolveLiveCompanyId(selectedCompanyId, selectedCompany?.id ?? null);
  const canConnectSocket = sessionStatus === "success" && session !== null && liveCompanyId !== null;
  const currentActorRef = useRef<{ userId: string | null; agentId: string | null }>({
    userId: currentUserId,
    agentId: null,
  });
  const subscribersRef = useRef<Set<CompanyLiveEventHandler>>(new Set());
  const subscribe = useCallback((handler: CompanyLiveEventHandler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);
  const subscriptionValue = useMemo<LiveEventSubscription>(() => ({ subscribe }), [subscribe]);

  // Coalesce the per-event invalidation storm. Optimistic setQueryData writes
  // still pass straight through (immediate); only invalidateQueries is batched
  // and flushed at most a few times per second.
  const invalidationBatcher = useMemo(() => createInvalidationBatcher(queryClient), [queryClient]);
  const coalescingClient = useMemo(
    () => createCoalescingQueryClient(queryClient, invalidationBatcher),
    [queryClient, invalidationBatcher],
  );
  useEffect(() => () => invalidationBatcher.dispose(), [invalidationBatcher]);

  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    currentActorRef.current = {
      userId: currentUserId,
      agentId: null,
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!canConnectSocket || !liveCompanyId) return;

    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectAttempt += 1;
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempt - 1, 4));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (closed) return;
      const url = buildSameOriginWebSocketUrl(
        `/api/companies/${encodeURIComponent(liveCompanyId)}/events/ws`,
      );
      const nextSocket = new WebSocket(url);
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (closed || socket !== nextSocket) {
          closeSocketQuietly(nextSocket, "stale_connection");
          return;
        }
        if (reconnectAttempt > 0) {
          gateRef.current.suppressUntil = Date.now() + RECONNECT_SUPPRESS_MS;
          // Durable run state is reconstructed through canonical list/detail
          // reads after a transport gap.
          queryClient.invalidateQueries({
            predicate: (query) =>
              query.queryKey[0] === "runs" ||
              (query.queryKey[0] === "tasks" && query.queryKey[1] === "runs"),
          });
        }
        reconnectAttempt = 0;
      };

      nextSocket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;

        try {
          const parsed = JSON.parse(raw) as LiveEvent;
          handleLiveEvent(coalescingClient, liveCompanyId, pathnameRef.current, parsed, pushToast, gateRef.current, {
            userId: currentActorRef.current.userId,
            agentId: currentActorRef.current.agentId,
          });
          // Fan the raw event out to component subscribers after cache
          // handling so any reader sees fresh query data.
          dispatchLiveEventToSubscribers(subscribersRef.current, liveCompanyId, parsed);
        } catch {
          // Ignore non-JSON payloads.
        }
      };

      nextSocket.onerror = () => {
        // Wait for onclose to drive the reconnect. Self-closing here is what
        // produces the "closed before connection established" browser noise.
      };

      nextSocket.onclose = () => {
        if (socket !== nextSocket) return;
        socket = null;
        if (closed) return;
        scheduleReconnect();
      };
    };

    // Delay initial connect slightly so React StrictMode's double-invoke
    // cleanup fires before the WebSocket is created, avoiding the
    // "WebSocket closed before connection established" dev-mode error.
    const connectTimer = window.setTimeout(connect, 0);

    return () => {
      closed = true;
      window.clearTimeout(connectTimer);
      clearReconnect();
      const activeSocket = socket;
      socket = null;
      closeSocketQuietly(activeSocket, "provider_unmount");
    };
  }, [coalescingClient, liveCompanyId, pushToast, canConnectSocket, socketAuthKey]);

  return (
    <LiveEventSubscriptionContext.Provider value={subscriptionValue}>
      {children}
    </LiveEventSubscriptionContext.Provider>
  );
}
