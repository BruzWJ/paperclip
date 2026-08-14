import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { createCoalescingQueryClient, createInvalidationBatcher } from "../lib/query-invalidation-batcher";
import {
  LIVE_EVENT_SOCKET_EVENT,
  isCanonicalUuid,
  type ActivityLoggedLiveEventPayload,
  type Agent,
  type CompanyBoardRouteTarget,
  type Task,
  type LiveEvent,
} from "@paperclipai/shared";
import type { CompanyUserDirectoryResponse } from "../api/access";
import { authApi } from "../api/auth";
import { toast } from "sonner";
import { useNavigateCompanyBoardTarget } from "../components/CompanyBoardLink";
import { queryKeys } from "../lib/queryKeys";
import {
  invalidateActivityQueries,
  isPageForegrounded,
  refreshVisibleTaskCommentGroups,
  shouldDeferVisibleTaskCommentActivity,
  shouldSuppressActivityToastForVisibleTask,
  type VisibleTaskRoute,
} from "../lib/live-query-invalidation";
import { createLiveUpdatesSocket, reconcileActiveCompanyQueries } from "../lib/live-updates-transport";

const TOAST_COOLDOWN_WINDOW_MS = 10_000;
const TOAST_COOLDOWN_MAX = 3;
const RECONNECT_SUPPRESS_MS = 2000;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function resolveAgentName(queryClient: QueryClient, companyId: string, agentId: string): string | null {
  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  if (!agents) return null;
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? null;
}

function resolveUserName(queryClient: QueryClient, companyId: string, userId: string): string | null {
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
  taskNumber: number | null;
}

function resolveTaskToastContext(
  queryClient: QueryClient,
  companyId: string,
  taskId: string,
  details: Record<string, unknown> | null,
): TaskToastContext {
  const detailTask = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId));
  const listTask = queryClient
    .getQueryData<Task[]>(queryKeys.tasks.list(companyId))
    ?.find((task) => task.id === taskId);
  const cachedTask = detailTask ?? listTask ?? null;
  const detailsTaskNumber = details?.taskNumber;
  const taskNumber =
    cachedTask?.taskNumber ??
    (typeof detailsTaskNumber === "number" && Number.isSafeInteger(detailsTaskNumber) && detailsTaskNumber > 0
      ? detailsTaskNumber
      : null);
  const ref = cachedTask?.identifier ?? (taskNumber === null ? "Task unavailable" : `Task ${taskNumber}`);
  const title = readString(details?.title) ?? cachedTask?.title ?? null;
  return {
    ref,
    title,
    label: title ? `${ref} - ${truncate(title, 72)}` : ref,
    taskNumber,
  };
}

const TASK_TOAST_ACTIONS = new Set(["task.created", "task.updated", "task.comment_added"]);
function describeTaskUpdate(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const changes: string[] = [];
  if (typeof details.lifecycleStatus === "string") {
    changes.push(`lifecycle -> ${details.lifecycleStatus.replace(/_/g, " ")}`);
  }
  if (
    typeof details.ownerKind === "string" ||
    typeof details.ownerAgentId === "string" ||
    typeof details.ownerUserId === "string"
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

interface ActivityNotification {
  title: string;
  description?: string;
  tone: "info" | "success";
  id: string;
  action?: {
    label: string;
    target: CompanyBoardRouteTarget;
  };
}

function buildActivityNotification(
  queryClient: QueryClient,
  companyId: string,
  payload: ActivityLoggedLiveEventPayload,
  currentActor: { userId: string | null },
): ActivityNotification | null {
  const entityType = payload.entityType;
  const entityId = payload.entityId;
  const taskId = payload.taskId;
  const action = payload.action;
  const details = payload.details;
  const actorId = payload.actorId;
  const actorType = payload.actorType;

  if (entityType !== "task" || !entityId || !taskId || !action || !TASK_TOAST_ACTIONS.has(action)) {
    return null;
  }

  const task = resolveTaskToastContext(queryClient, companyId, taskId, details);
  const taskAction: ActivityNotification["action"] =
    task.taskNumber !== null
      ? {
          label: `View ${task.ref}`,
          target: { kind: "task", taskNumber: task.taskNumber, hash: null },
        }
      : undefined;
  const actor = resolveActorLabel(queryClient, companyId, actorType, actorId);
  const isSelfActivity = actorType === "user" && !!currentActor.userId && actorId === currentActor.userId;
  if (isSelfActivity) return null;

  if (action === "task.created") {
    return {
      title: `${actor} created ${task.ref}`,
      description: task.title ? truncate(task.title, 96) : undefined,
      tone: "success",
      action: taskAction,
      id: `activity:${action}:${entityId}`,
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
      description: truncate(body, 100),
      tone: "info",
      action: taskAction,
      id: `activity:${action}:${entityId}`,
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
      : (task.title ?? undefined);
  return {
    title,
    description: body ? truncate(body, 96) : undefined,
    tone: "info",
    action: taskAction,
    id: `activity:${action}:${entityId}:${commentId ?? "na"}`,
  };
}

function buildJoinRequestNotification(payload: ActivityLoggedLiveEventPayload): ActivityNotification | null {
  const entityType = payload.entityType;
  const action = payload.action;
  const entityId = payload.entityId;
  if (entityType !== "join_request" || !action || !entityId) return null;
  if (action !== "join.requested" && action !== "join.request_replayed") return null;

  return {
    title: "Someone wants to join",
    description: "A new join request is waiting for approval.",
    tone: "info",
    action: { label: "View inbox", target: { kind: "inbox" } },
    id: `join-request:${entityId}`,
  };
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

function handleLiveEvent(
  queryClient: QueryClient,
  expectedCompanyId: string,
  visibleTaskRoute: VisibleTaskRoute,
  event: LiveEvent,
  navigateToBoardTarget: (target: CompanyBoardRouteTarget) => void,
  gate: ToastGate,
  currentActor: { userId: string | null },
) {
  if (event.companyId !== expectedCompanyId) return;

  const payload = event.payload;

  invalidateActivityQueries(queryClient, expectedCompanyId, payload, currentActor, visibleTaskRoute);
  if (shouldDeferVisibleTaskCommentActivity(visibleTaskRoute, payload)) {
    void refreshVisibleTaskCommentGroups(queryClient, visibleTaskRoute, payload);
  }
  const action = payload.action;
  const notification =
    buildActivityNotification(queryClient, expectedCompanyId, payload, currentActor) ??
    buildJoinRequestNotification(payload);
  const category = `activity:${action}`;
  if (
    !notification ||
    shouldSuppressActivityToastForVisibleTask(visibleTaskRoute, payload) ||
    shouldSuppressToast(gate, category)
  ) {
    return;
  }

  const options = {
    description: notification.description,
    id: notification.id,
    action: notification.action
      ? {
          label: notification.action.label,
          onClick: () => navigateToBoardTarget(notification.action!.target),
        }
      : undefined,
  };
  if (notification.tone === "success") {
    toast.success(notification.title, options);
  } else {
    toast.info(notification.title, options);
  }
  recordToastHit(gate, category);
}

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigateToBoardTarget = useNavigateCompanyBoardTarget();
  const companyRouteMatch = useMatch({
    from: "/_authenticated/$companyId",
    shouldThrow: false,
  });
  const taskRouteMatch = useMatch({
    from: "/_authenticated/$companyId/tasks/$taskNumber/",
    shouldThrow: false,
  });
  const gateRef = useRef<ToastGate>({
    cooldownHits: new Map(),
    suppressUntil: 0,
  });
  const visibleTaskRef = useRef<string | null>(taskRouteMatch?.loaderData?.id ?? null);
  const { data: session, status: sessionStatus } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user.id ?? null;
  const socketAuthKey = session?.session.id ?? "signed_out";
  const routeCompanyId = companyRouteMatch?.params.companyId ?? null;
  const liveCompanyId = routeCompanyId && isCanonicalUuid(routeCompanyId) ? routeCompanyId : null;
  const canConnectSocket = sessionStatus === "success" && session !== null && liveCompanyId !== null;
  const currentUserIdRef = useRef(currentUserId);

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
    visibleTaskRef.current = taskRouteMatch?.loaderData?.id ?? null;
  }, [taskRouteMatch?.loaderData?.id]);

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    if (!canConnectSocket || !liveCompanyId) return;

    const socket = createLiveUpdatesSocket(liveCompanyId);
    let connectedOnce = false;

    const onConnect = () => {
      if (connectedOnce) {
        gateRef.current.suppressUntil = Date.now() + RECONNECT_SUPPRESS_MS;
      }
      connectedOnce = true;
      void reconcileActiveCompanyQueries(queryClient);
    };

    const onLiveEvent = (event: LiveEvent) => {
      handleLiveEvent(
        coalescingClient,
        liveCompanyId,
        {
          taskId: visibleTaskRef.current,
          foregrounded: isPageForegrounded(),
        },
        event,
        navigateToBoardTarget,
        gateRef.current,
        { userId: currentUserIdRef.current },
      );
    };

    socket.on("connect", onConnect);
    socket.on(LIVE_EVENT_SOCKET_EVENT, onLiveEvent);

    // Defer the first handshake so StrictMode's probe cleanup can cancel it.
    const connectTimer = window.setTimeout(() => socket.connect(), 0);

    return () => {
      window.clearTimeout(connectTimer);
      socket.off("connect", onConnect);
      socket.off(LIVE_EVENT_SOCKET_EVENT, onLiveEvent);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [coalescingClient, liveCompanyId, navigateToBoardTarget, canConnectSocket, socketAuthKey]);

  return children;
}
