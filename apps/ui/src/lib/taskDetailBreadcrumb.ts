import type { Task } from "@paperclipai/shared";

export type TaskDetailSource = "tasks" | "inbox" | "routine_runs";

export type TaskDetailHeaderSeed = {
  id: string;
  identifier: string;
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
  identifier: string;
  boardPresentationStatus: string;
  blockerAttention?: Task["blockerAttention"];
  priority: string;
  projectId?: string | null;
  project?: { name?: string | null } | null;
  originKind?: string;
  originId?: string | null;
};

export type TaskDetailLocationState = {
  taskDetailSource?: TaskDetailSource;
  taskDetailInboxQuickArchiveArmed?: boolean;
  taskDetailHeaderSeed?: TaskDetailHeaderSeed;
};

function isTaskDetailSource(value: unknown): value is TaskDetailSource {
  return value === "tasks" || value === "inbox" || value === "routine_runs";
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
    && typeof candidate.identifier === "string"
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
    identifier: task.identifier,
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

export function createTaskDetailLocationState(
  source: TaskDetailSource,
): TaskDetailLocationState {
  return { taskDetailSource: source };
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

function normalizeTaskDetailLocationState(
  state: unknown,
): TaskDetailLocationState | null {
  if (typeof state === "object" && state !== null) {
    const source = (state as TaskDetailLocationState).taskDetailSource;
    if (isTaskDetailSource(source)) {
      const headerSeed = readTaskDetailHeaderSeed(state) ?? undefined;
      return {
        taskDetailSource: source,
        taskDetailInboxQuickArchiveArmed:
          (state as TaskDetailLocationState).taskDetailInboxQuickArchiveArmed === true,
        taskDetailHeaderSeed: headerSeed,
      };
    }
  }

  return null;
}

export function readTaskDetailLocationState(
  state: unknown,
): TaskDetailLocationState | null {
  return normalizeTaskDetailLocationState(state);
}
