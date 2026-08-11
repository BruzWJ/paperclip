import type { Task } from "@paperclipai/shared";

type TaskDetailSource = "tasks" | "inbox";

type TaskDetailBreadcrumb = {
  label: string;
  href: string;
};

export type TaskDetailHeaderSeed = {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: string;
  blockerAttention?: Task["blockerAttention"];
  priority: string;
  projectId: string | null;
  projectName: string | null;
  originKind?: string;
  originId?: string | null;
};

type TaskDetailHeaderSeedSource = Pick<Task, "id" | "title"> & {
  identifier?: string | null;
  boardPresentationStatus: string;
  blockerAttention?: Task["blockerAttention"];
  priority: string;
  projectId?: string | null;
  project?: { name?: string | null } | null;
  originKind?: string;
  originId?: string | null;
};

type TaskDetailLocationState = {
  taskDetailBreadcrumb?: TaskDetailBreadcrumb;
  taskDetailSource?: TaskDetailSource;
  taskDetailInboxQuickArchiveArmed?: boolean;
  taskDetailHeaderSeed?: TaskDetailHeaderSeed;
};

const TASK_DETAIL_SOURCE_QUERY_PARAM = "from";
const TASK_DETAIL_BREADCRUMB_HREF_QUERY_PARAM = "fromHref";
const TASK_DETAIL_STORAGE_KEY_PREFIX = "paperclip:task-detail-breadcrumb:";

function isTaskDetailBreadcrumb(value: unknown): value is TaskDetailBreadcrumb {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TaskDetailBreadcrumb>;
  return typeof candidate.label === "string" && typeof candidate.href === "string";
}

function isTaskDetailSource(value: unknown): value is TaskDetailSource {
  return value === "tasks" || value === "inbox";
}

function isTaskDetailHeaderSeed(value: unknown): value is TaskDetailHeaderSeed {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TaskDetailHeaderSeed>;
  const hasOriginKind =
    candidate.originKind === undefined || typeof candidate.originKind === "string";
  const hasOriginId =
    candidate.originId === undefined || candidate.originId === null || typeof candidate.originId === "string";
  const hasBlockerAttention =
    candidate.blockerAttention === undefined
    || (typeof candidate.blockerAttention === "object" && candidate.blockerAttention !== null);
  return (
    typeof candidate.id === "string"
    && (candidate.identifier === null || typeof candidate.identifier === "string")
    && (candidate.title === null || typeof candidate.title === "string")
    && typeof candidate.boardPresentationStatus === "string"
    && hasBlockerAttention
    && typeof candidate.priority === "string"
    && (candidate.projectId === null || typeof candidate.projectId === "string")
    && (candidate.projectName === null || typeof candidate.projectName === "string")
    && hasOriginKind
    && hasOriginId
  );
}

function createTaskDetailHeaderSeed(task: TaskDetailHeaderSeedSource): TaskDetailHeaderSeed {
  return {
    id: task.id,
    identifier: task.identifier ?? null,
    title: task.title,
    boardPresentationStatus: task.boardPresentationStatus,
    blockerAttention: task.blockerAttention,
    priority: task.priority,
    projectId: task.projectId ?? null,
    projectName: task.project?.name ?? null,
    originKind: task.originKind,
    originId: task.originId ?? null,
  };
}

export function withTaskDetailHeaderSeed(state: unknown, task: TaskDetailHeaderSeedSource): TaskDetailLocationState {
  const headerSeed = createTaskDetailHeaderSeed(task);
  if (typeof state !== "object" || state === null) {
    return { taskDetailHeaderSeed: headerSeed };
  }

  return {
    ...(state as TaskDetailLocationState),
    taskDetailHeaderSeed: headerSeed,
  };
}

export function readTaskDetailHeaderSeed(state: unknown): TaskDetailHeaderSeed | null {
  if (typeof state !== "object" || state === null) return null;
  const candidate = (state as TaskDetailLocationState).taskDetailHeaderSeed;
  return isTaskDetailHeaderSeed(candidate) ? candidate : null;
}

function readTaskDetailSource(state: unknown): TaskDetailSource | null {
  if (typeof state !== "object" || state === null) return null;
  const source = (state as TaskDetailLocationState).taskDetailSource;
  return isTaskDetailSource(source) ? source : null;
}

function readTaskDetailSourceFromSearch(search?: string): TaskDetailSource | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const source = params.get(TASK_DETAIL_SOURCE_QUERY_PARAM);
  return isTaskDetailSource(source) ? source : null;
}

function readTaskDetailBreadcrumbHrefFromSearch(search?: string): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const href = params.get(TASK_DETAIL_BREADCRUMB_HREF_QUERY_PARAM);
  return href && href.startsWith("/") ? href : null;
}

function inferTaskDetailSource(
  state: Partial<TaskDetailLocationState> | null,
  breadcrumb: TaskDetailBreadcrumb | null,
): TaskDetailSource | null {
  if (isTaskDetailSource(state?.taskDetailSource)) return state.taskDetailSource;
  if (!breadcrumb) return null;
  if (breadcrumb.label === "Inbox" || breadcrumb.href.includes("/inbox")) return "inbox";
  if (breadcrumb.label === "Tasks" || breadcrumb.href.includes("/tasks")) return "tasks";
  return null;
}

function breadcrumbForSource(source: TaskDetailSource): TaskDetailBreadcrumb {
  if (source === "inbox") return { label: "Inbox", href: "/inbox" };
  return { label: "Tasks", href: "/tasks" };
}

export function createTaskDetailLocationState(
  label: string,
  href: string,
  source?: TaskDetailSource,
): TaskDetailLocationState {
  return {
    taskDetailBreadcrumb: { label, href },
    taskDetailSource: source,
  };
}

export function armTaskDetailInboxQuickArchive(state: unknown): TaskDetailLocationState {
  if (typeof state !== "object" || state === null) {
    return { taskDetailInboxQuickArchiveArmed: true };
  }

  return {
    ...(state as TaskDetailLocationState),
    taskDetailInboxQuickArchiveArmed: true,
  };
}

function readStoredTaskDetailLocationState(taskPathId: string): TaskDetailLocationState | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;

  const raw = window.sessionStorage.getItem(`${TASK_DETAIL_STORAGE_KEY_PREFIX}${taskPathId}`);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<TaskDetailLocationState>;
    const breadcrumb = isTaskDetailBreadcrumb(parsed.taskDetailBreadcrumb)
      ? parsed.taskDetailBreadcrumb
      : null;
    const source = inferTaskDetailSource(parsed, breadcrumb);
    if (!breadcrumb || !source) return null;
    const headerSeed = isTaskDetailHeaderSeed(parsed.taskDetailHeaderSeed)
      ? parsed.taskDetailHeaderSeed
      : undefined;
    return {
      taskDetailBreadcrumb: breadcrumb,
      taskDetailSource: source,
      taskDetailInboxQuickArchiveArmed: parsed.taskDetailInboxQuickArchiveArmed === true,
      taskDetailHeaderSeed: headerSeed,
    };
  } catch {
    return null;
  }
}

function normalizeTaskDetailLocationState(
  state: unknown,
  search?: string,
): TaskDetailLocationState | null {
  if (typeof state === "object" && state !== null) {
    const candidate = (state as TaskDetailLocationState).taskDetailBreadcrumb;
    if (isTaskDetailBreadcrumb(candidate)) {
      const source = inferTaskDetailSource(state as Partial<TaskDetailLocationState>, candidate);
      if (!source) return null;
      const headerSeed = readTaskDetailHeaderSeed(state) ?? undefined;
      return {
        taskDetailBreadcrumb: candidate,
        taskDetailSource: source,
        taskDetailInboxQuickArchiveArmed:
          (state as TaskDetailLocationState).taskDetailInboxQuickArchiveArmed === true,
        taskDetailHeaderSeed: headerSeed,
      };
    }
  }

  const source = readTaskDetailSourceFromSearch(search);
  const href = readTaskDetailBreadcrumbHrefFromSearch(search);
  if (!source) return null;

  return {
    taskDetailBreadcrumb: href ? { ...breadcrumbForSource(source), href } : breadcrumbForSource(source),
    taskDetailSource: source,
    taskDetailInboxQuickArchiveArmed: false,
  };
}

export function rememberTaskDetailLocationState(taskPathId: string, state: unknown, search?: string): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;

  const normalized = normalizeTaskDetailLocationState(state, search);
  if (!normalized) return;

  window.sessionStorage.setItem(
    `${TASK_DETAIL_STORAGE_KEY_PREFIX}${taskPathId}`,
    JSON.stringify(normalized),
  );
}

export function createTaskDetailPath(taskPathId: string): string {
  return `/tasks/${taskPathId}`;
}

export function readTaskDetailLocationState(
  taskPathId: string | null | undefined,
  state: unknown,
  search?: string,
): TaskDetailLocationState | null {
  const normalized = normalizeTaskDetailLocationState(state, search);
  if (normalized) return normalized;
  if (!taskPathId) return null;
  return readStoredTaskDetailLocationState(taskPathId);
}

export function readTaskDetailBreadcrumb(
  taskPathId: string | null | undefined,
  state: unknown,
  search?: string,
): TaskDetailBreadcrumb | null {
  return readTaskDetailLocationState(taskPathId, state, search)?.taskDetailBreadcrumb ?? null;
}

export function shouldArmTaskDetailInboxQuickArchive(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  return (state as TaskDetailLocationState).taskDetailInboxQuickArchiveArmed === true;
}
