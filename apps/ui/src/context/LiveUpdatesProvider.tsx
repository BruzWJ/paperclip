import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createCoalescingQueryClient, createInvalidationBatcher } from "../lib/query-invalidation-batcher";
import type {
  Agent,
  Issue,
  IssueExecutionRunListPageRecord,
  LiveEvent,
} from "@paperclipai/shared";
import type { CompanyUserDirectoryResponse } from "../api/access";
import { authApi } from "../api/auth";
import { useCompany } from "./CompanyContext";
import type { ToastInput } from "./ToastContext";
import { useToastActions } from "./ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { ACTIVE_ISSUE_EXECUTION_RUN_STATUSES } from "../api/runs";
import { toCompanyRelativePath } from "../lib/company-routes";
import { useLocation } from "../lib/router";
import { buildSameOriginWebSocketUrl } from "../lib/websocket-url";
import {
  createIssueExecutionLivePlanStore,
  type IssueExecutionLivePlanSnapshot,
  type IssueExecutionLivePlanStore,
  type VisibleActiveIssueExecutionPrompt,
} from "../lib/issue-execution-live-plan";

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

interface IssueExecutionLivePlanContextValue {
  store: IssueExecutionLivePlanStore;
}

const IssueExecutionLivePlanContext =
  createContext<IssueExecutionLivePlanContextValue | null>(null);

const subscribeToNothing = () => () => undefined;
const readNoLivePlan = () => null;

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

/**
 * Observe the disposable plan for one exact visible prompt. Passing null is
 * the terminal/not-active state and clears the view; no plan is hydrated from
 * REST, query data, Session history, or a reconnect.
 */
export function useIssueExecutionLivePlan(
  prompt: VisibleActiveIssueExecutionPrompt | null,
): IssueExecutionLivePlanSnapshot | null {
  const context = useContext(IssueExecutionLivePlanContext);
  const store = context?.store ?? null;
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    store?.getSnapshot ?? readNoLivePlan,
    readNoLivePlan,
  );

  useEffect(() => {
    if (!store) return;
    if (!prompt) {
      store.clearVisibility();
      return;
    }
    return store.registerVisiblePrompt(prompt);
  }, [
    store,
    prompt?.companyId,
    prompt?.issueId,
    prompt?.runId,
    prompt?.refId,
    prompt?.runOrdinal,
    prompt?.segmentOrdinal,
    prompt?.promptActive,
  ]);

  return snapshot;
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

interface IssueToastContext {
  ref: string;
  title: string | null;
  label: string;
  href: string;
}

interface VisibleRouteOptions {
  isForegrounded?: boolean;
}

interface VisibleIssueRouteContext {
  routeIssueRef: string;
  issueRefs: Set<string>;
  ownerAgentId: string | null;
  runIds: Set<string>;
}

function resolveIssueQueryRefs(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): string[] {
  const refs = new Set<string>([issueId]);
  const detailIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId));
  const listIssues = queryClient.getQueryData<Issue[]>(queryKeys.issues.list(companyId));
  const detailsIdentifier =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier);

  if (detailsIdentifier) refs.add(detailsIdentifier);

  if (detailIssue?.id) refs.add(detailIssue.id);
  if (detailIssue?.identifier) refs.add(detailIssue.identifier);

  const listIssue = listIssues?.find((issue) => {
    if (issue.id === issueId) return true;
    if (issue.identifier && issue.identifier === issueId) return true;
    if (detailsIdentifier && issue.identifier === detailsIdentifier) return true;
    return false;
  });
  if (listIssue?.id) refs.add(listIssue.id);
  if (listIssue?.identifier) refs.add(listIssue.identifier);

  return Array.from(refs);
}

function resolveIssueToastContext(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): IssueToastContext {
  const issueRefs = resolveIssueQueryRefs(queryClient, companyId, issueId, details);
  const detailIssue = issueRefs
    .map((ref) => queryClient.getQueryData<Issue>(queryKeys.issues.detail(ref)))
    .find((issue): issue is Issue => !!issue);
  const listIssue = queryClient
    .getQueryData<Issue[]>(queryKeys.issues.list(companyId))
    ?.find((issue) => issueRefs.some((ref) => issue.id === ref || issue.identifier === ref));
  const cachedIssue = detailIssue ?? listIssue ?? null;
  const ref =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier) ??
    cachedIssue?.identifier ??
    `Task ${shortId(issueId)}`;
  const title =
    readString(details?.title) ??
    readString(details?.issueTitle) ??
    cachedIssue?.title ??
    null;
  return {
    ref,
    title,
    label: title ? `${ref} - ${truncate(title, 72)}` : ref,
    href: `/issues/${cachedIssue?.identifier ?? issueId}`,
  };
}

function isPageForegrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  return true;
}

function resolveVisibleIssueRouteContext(
  queryClient: QueryClient,
  pathname: string,
  options?: VisibleRouteOptions,
): VisibleIssueRouteContext | null {
  const isForegrounded = options?.isForegrounded ?? isPageForegrounded();
  if (!isForegrounded) return null;

  const relativePath = toCompanyRelativePath(pathname);
  const segments = relativePath.split("/").filter(Boolean);
  if (segments[0] !== "issues" || !segments[1]) return null;

  const issueRef = decodeURIComponent(segments[1]);
  const issue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueRef)) ?? null;
  const issueRefs = new Set<string>([issueRef]);
  if (issue?.id) issueRefs.add(issue.id);
  if (issue?.identifier) issueRefs.add(issue.identifier);

  const runIds = new Set<string>();
  const runs = queryClient.getQueryData<IssueExecutionRunListPageRecord>(
    queryKeys.issues.runs(issueRef, ACTIVE_ISSUE_EXECUTION_RUN_STATUSES),
  );
  for (const run of runs?.items ?? []) {
    runIds.add(run.id);
  }

  return {
    routeIssueRef: issueRef,
    issueRefs,
    ownerAgentId: issue?.ownerAgentId ?? null,
    runIds,
  };
}

function buildIssueRefsForPayload(entityId: string, details: Record<string, unknown> | null): Set<string> {
  const refs = new Set<string>([entityId]);
  const identifier = readString(details?.identifier) ?? readString(details?.issueIdentifier);
  if (identifier) refs.add(identifier);
  return refs;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function shouldSuppressActivityToastForVisibleIssue(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  if (entityType !== "issue" || !entityId) return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, readRecord(payload.details)));
}

function invalidateVisibleIssueRunQueries(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  const runId = readString(payload.runId);
  const agentId = readString(payload.agentId);
  const matchesVisibleIssue =
    (runId !== null && context.runIds.has(runId)) ||
    (!!agentId && !!context.ownerAgentId && agentId === context.ownerAgentId);
  if (!matchesVisibleIssue) return false;

  for (const issueRef of context.issueRefs) {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueRef) });
    queryClient.invalidateQueries({ queryKey: ["issues", "runs", issueRef] });
  }
  return true;
}

function shouldSuppressAgentStatusToastForVisibleIssue(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context?.ownerAgentId) return false;

  const agentId = readString(payload.agentId);
  return !!agentId && agentId === context.ownerAgentId;
}

function shouldDeferIssueRefetchForVisibleAgentActivity(
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

  if (entityType !== "issue" || !entityId) return false;
  if (actorType !== "agent" && actorType !== "system") return false;
  if (action !== "issue.updated") return false;
  if (readString(details?.source) === "comment") return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, details));
}

function shouldDeferVisibleIssueCommentActivity(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
): boolean {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const details = readRecord(payload.details);

  if (entityType !== "issue" || !entityId) return false;
  if (action !== "issue.comment_added") return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  return overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, details));
}

async function refreshVisibleIssueCommentGroups(
  queryClient: QueryClient,
  pathname: string,
  payload: Record<string, unknown>,
  options?: VisibleRouteOptions,
) {
  const entityType = readString(payload.entityType);
  const action = readString(payload.action);
  const details = readRecord(payload.details);
  const commentId = readString(details?.commentId);

  if (entityType !== "issue" || action !== "issue.comment_added" || !commentId) return false;

  const context = resolveVisibleIssueRouteContext(queryClient, pathname, options);
  if (!context) return false;

  const entityId = readString(payload.entityId);
  if (!entityId || !overlaps(context.issueRefs, buildIssueRefsForPayload(entityId, details))) {
    return false;
  }

  await queryClient.invalidateQueries({
    queryKey: queryKeys.issues.comments(context.routeIssueRef),
  });
  return true;
}

const ISSUE_TOAST_ACTIONS = new Set(["issue.created", "issue.updated", "issue.comment_added"]);
const ISSUE_DOCUMENT_ACTIVITY_ACTIONS = new Set([
  "issue.document_created",
  "issue.document_updated",
  "issue.document_restored",
  "issue.document_deleted",
]);
const ISSUE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS = new Set([
  "issue.document_annotation_thread_created",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_resolved",
  "issue.document_annotation_thread_reopened",
  "issue.document_annotation_remapped",
]);
const ROUTINE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS = new Set([
  "routine.document_annotation_thread_created",
  "routine.document_annotation_comment_added",
  "routine.document_annotation_thread_resolved",
  "routine.document_annotation_thread_reopened",
  "routine.document_annotation_remapped",
]);
const AGENT_TOAST_STATUSES = new Set(["error"]);

function describeIssueUpdate(details: Record<string, unknown> | null): string | null {
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

  if (entityType !== "issue" || !entityId || !action || !ISSUE_TOAST_ACTIONS.has(action)) {
    return null;
  }

  const issue = resolveIssueToastContext(queryClient, companyId, entityId, details);
  const actor = resolveActorLabel(queryClient, companyId, actorType, actorId);
  const isSelfActivity =
    (actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
    (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId);
  if (isSelfActivity) return null;

  if (action === "issue.created") {
    return {
      title: `${actor} created ${issue.ref}`,
      body: issue.title ? truncate(issue.title, 96) : undefined,
      tone: "success",
      action: { label: `View ${issue.ref}`, href: issue.href },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  if (action === "issue.updated") {
    if (readString(details?.source) === "comment") {
      // Comment-driven updates emit a paired comment event; show one combined toast on the comment event.
      return null;
    }
    const changeDesc = describeIssueUpdate(details);
    const body = changeDesc
      ? issue.title
        ? `${truncate(issue.title, 64)} - ${changeDesc}`
        : changeDesc
      : issue.title
        ? truncate(issue.title, 96)
        : issue.label;
    return {
      title: `${actor} updated ${issue.ref}`,
      body: truncate(body, 100),
      tone: "info",
      action: { label: `View ${issue.ref}`, href: issue.href },
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
    ? `${actor} reopened and commented on ${issue.ref}`
    : updated
      ? `${actor} commented and updated ${issue.ref}`
      : `${actor} commented on ${issue.ref}`;
  const body = bodySnippet
    ? reopenedLabel
      ? `${reopenedLabel} - ${bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")}`
      : bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")
    : reopenedLabel
      ? issue.title
        ? `${reopenedLabel} - ${issue.title}`
        : reopenedLabel
      : issue.title ?? undefined;
  return {
    title,
    body: body ? truncate(body, 96) : undefined,
    tone: "info",
    action: { label: `View ${issue.ref}`, href: issue.href },
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

  if (entityType === "issue") {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
    if (entityId) {
      const selfCommentActivity =
        ((action === "issue.comment_added") ||
          (action === "issue.updated" && readString(details?.source) === "comment")) &&
        ((actorType === "user" && !!currentActor.userId && actorId === currentActor.userId) ||
          (actorType === "agent" && !!currentActor.agentId && actorId === currentActor.agentId));
      const visibleIssueAgentActivity =
        !!options?.pathname &&
        shouldDeferIssueRefetchForVisibleAgentActivity(
          queryClient,
          options.pathname,
          payload,
          { isForegrounded: options.isForegrounded },
        );
      const visibleIssueCommentActivity =
        !!options?.pathname &&
        shouldDeferVisibleIssueCommentActivity(
          queryClient,
          options.pathname,
          payload,
          { isForegrounded: options.isForegrounded },
        );
      const issueRefs = resolveIssueQueryRefs(queryClient, companyId, entityId, details);
      for (const ref of issueRefs) {
        const invalidationOptions =
          (selfCommentActivity || visibleIssueAgentActivity || visibleIssueCommentActivity)
            ? { refetchType: "inactive" as const }
            : undefined;
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref), ...invalidationOptions });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(ref), ...invalidationOptions });
        queryClient.invalidateQueries({ queryKey: ["issues", "runs", ref], ...invalidationOptions });
        if (action === "issue.comment_added") {
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(ref), ...invalidationOptions });
        }
        if (action && ISSUE_DOCUMENT_ACTIVITY_ACTIONS.has(action)) {
          const documentKey = readString(details?.key);
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(ref), ...invalidationOptions });
          if (documentKey) {
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.document(ref, documentKey), ...invalidationOptions });
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.documentRevisions(ref, documentKey), ...invalidationOptions });
          } else {
            queryClient.invalidateQueries({ queryKey: ["issues", "document", ref], ...invalidationOptions });
            queryClient.invalidateQueries({ queryKey: ["issues", "document-revisions", ref], ...invalidationOptions });
          }
        }
        if (
          action &&
          (ISSUE_DOCUMENT_ACTIVITY_ACTIONS.has(action) || ISSUE_DOCUMENT_ANNOTATION_ACTIVITY_ACTIONS.has(action))
        ) {
          const documentKey = readString(details?.key) ?? readString(details?.documentKey);
          queryClient.invalidateQueries({
            queryKey: documentKey
              ? ["issues", "document-annotations", ref, documentKey]
              : ["issues", "document-annotations", ref],
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

  // Stable ACP plans are consumed only by the exact visible-prompt store.
  // They never trigger cache invalidation, toasts, or durable query reads.
  if (event.type === "issue.execution.plan.live") return;

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
      !shouldSuppressAgentStatusToastForVisibleIssue(queryClient, pathname, payload)
    ) {
      gatedPushToast(gate, pushToast, "agent-status", toast);
    }
    return;
  }

  if (event.type === "activity.logged") {
    invalidateActivityQueries(queryClient, expectedCompanyId, payload, currentActor, { pathname });
    if (shouldDeferVisibleIssueCommentActivity(queryClient, pathname, payload)) {
      void refreshVisibleIssueCommentGroups(queryClient, pathname, payload);
    }
    const action = readString(payload.action);
    const toast =
      buildActivityToast(queryClient, expectedCompanyId, payload, currentActor) ??
      buildJoinRequestToast(payload);
    if (
      toast &&
      !shouldSuppressActivityToastForVisibleIssue(queryClient, pathname, payload)
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
  IssueExecutionLivePlanContext,
  LiveEventSubscriptionContext,
  refreshVisibleIssueCommentGroups,
  invalidateActivityQueries,
  invalidateVisibleIssueRunQueries,
  resolveLiveCompanyId,
  shouldDeferIssueRefetchForVisibleAgentActivity,
  shouldDeferVisibleIssueCommentActivity,
  shouldSuppressActivityToastForVisibleIssue,
  shouldSuppressAgentStatusToastForVisibleIssue,
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
  const livePlanStore = useMemo(createIssueExecutionLivePlanStore, []);
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
    livePlanStore.clearPlan();
  }, [livePlanStore, location.pathname]);

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
      // A new socket can follow a apps/server/process restart whose in-process id
      // sequence begins again. The disposable view and watermark both reset.
      livePlanStore.resetConnection();
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
          // reads after a transport gap; disposable plan state stays cleared.
          queryClient.invalidateQueries({
            predicate: (query) =>
              query.queryKey[0] === "runs" ||
              (query.queryKey[0] === "issues" && query.queryKey[1] === "runs"),
          });
        }
        reconnectAttempt = 0;
      };

      nextSocket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;

        try {
          const parsed = JSON.parse(raw) as LiveEvent;
          livePlanStore.acceptEvent(parsed);
          handleLiveEvent(coalescingClient, liveCompanyId, pathnameRef.current, parsed, pushToast, gateRef.current, {
            userId: currentActorRef.current.userId,
            agentId: currentActorRef.current.agentId,
          });
          // Fan the raw event out to component subscribers after cache
          // handling so any reader sees fresh query data. Disposable plans
          // stay inside their exact validated visible-prompt store rather than
          // entering the generic subscriber surface.
          if (parsed.type !== "issue.execution.plan.live") {
            dispatchLiveEventToSubscribers(subscribersRef.current, liveCompanyId, parsed);
          }
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
        livePlanStore.resetConnection();
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
      livePlanStore.resetConnection();
      closeSocketQuietly(activeSocket, "provider_unmount");
    };
  }, [coalescingClient, liveCompanyId, pushToast, canConnectSocket, socketAuthKey, livePlanStore]);

  const livePlanContextValue = useMemo<IssueExecutionLivePlanContextValue>(
    () => ({ store: livePlanStore }),
    [livePlanStore],
  );

  return (
    <IssueExecutionLivePlanContext.Provider value={livePlanContextValue}>
      <LiveEventSubscriptionContext.Provider value={subscriptionValue}>
        {children}
      </LiveEventSubscriptionContext.Provider>
    </IssueExecutionLivePlanContext.Provider>
  );
}
