import { ApiError } from "@/api/client";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES } from "@/api/runs";
import { type NavigationAction } from "@/lib/navigation-action";
import { type ClientTaskComment } from "@/lib/optimistic-task-comments";
import { queryKeys } from "@/lib/queryKeys";
import { parseDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import { parseTaskArtifactFragment, type TaskArtifactFragment } from "@/lib/task-artifact-fragment";
import { type TaskDetailSource } from "@/lib/taskDetailBreadcrumb";
import {
  type TaskExecutionRunEnvelopeRecord,
  type TaskExecutionRunListPageRecord,
  type TaskTreeControlMode,
} from "@paperclipai/shared";
import { type QueryClient } from "@tanstack/react-query";

export { fileBaseName, slugifyDocumentKey, titleizeFilename } from "@/lib/document-file-names";

export type CommentOwnerChange = {
  ownerAgentId: string;
};

export type TaskDetailComment = ClientTaskComment & {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  queueState?: "queued";
  queueTargetRunId?: string | null;
  queueReason?: "hold" | "active_run" | "other";
};

export const TASK_COMMENT_PAGE_SIZE = 50;

export const TASK_COMMENT_AUTOLOAD_LIMIT = TASK_COMMENT_PAGE_SIZE * 3;

export const JUMP_TO_LATEST_MAX_COMMENT_PAGES = 10;

export const TREE_CONTROL_MODE_LABEL: Record<TaskTreeControlMode, string> = {
  pause: "Pause subtree",
  resume: "Resume subtree",
  cancel: "Cancel subtree",
  restore: "Restore subtree",
};

export const LEAF_WORK_CONTROL_MODE_LABEL: Partial<Record<TaskTreeControlMode, string>> = {
  pause: "Pause work",
  resume: "Resume work",
};

export const TREE_CONTROL_MODE_HELP_TEXT: Record<TaskTreeControlMode, string> = {
  pause: "Pause active execution in this task subtree until an explicit resume.",
  resume: "Release the active subtree pause hold so held work can continue.",
  cancel: "Cancel non-terminal tasks in this subtree and stop queued/running work where possible.",
  restore: "Restore tasks cancelled by this subtree operation so work can resume.",
};

export const LEAF_WORK_CONTROL_MODE_HELP_TEXT: Partial<Record<TaskTreeControlMode, string>> = {
  pause: "Pause active execution on this task until an explicit resume.",
  resume: "Release the active pause hold so this task can continue.",
};

export function taskTreeControlLabel(mode: TaskTreeControlMode, scope: "leaf" | "subtree") {
  return scope === "leaf"
    ? (LEAF_WORK_CONTROL_MODE_LABEL[mode] ?? TREE_CONTROL_MODE_LABEL[mode])
    : TREE_CONTROL_MODE_LABEL[mode];
}

export function taskTreeControlHelpText(mode: TaskTreeControlMode, scope: "leaf" | "subtree") {
  return scope === "leaf"
    ? (LEAF_WORK_CONTROL_MODE_HELP_TEXT[mode] ?? TREE_CONTROL_MODE_HELP_TEXT[mode])
    : TREE_CONTROL_MODE_HELP_TEXT[mode];
}

export function treeControlPreviewErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Only board users can preview subtree controls.";
    if (error.status === 409) return "Preview is stale because subtree hold state changed. Retry to refresh.";
    if (error.status === 422) return "This subtree action is currently invalid for the selected tasks.";
  }
  return error instanceof Error ? error.message : "Unable to load preview.";
}

export function shouldScrollTaskDetailToTopOnNavigation(input: {
  previousTaskId: string | undefined;
  nextTaskId: string | undefined;
  navigationType: NavigationAction;
}): boolean {
  if (input.navigationType === "POP") return false;
  return input.previousTaskId !== input.nextTaskId;
}

export function resolveInterruptibleTaskRun(runs: readonly TaskExecutionRunEnvelopeRecord[] | undefined) {
  return (
    (runs ?? []).find((run) => run.status === "running") ??
    (runs ?? []).find((run) => run.status === "queued") ??
    (runs ?? []).find((run) => run.status === "scheduled_retry") ??
    null
  );
}

export function readTaskRunStateFromCache(queryClient: QueryClient, taskId: string) {
  const page = queryClient.getQueryData<TaskExecutionRunListPageRecord>(
    queryKeys.tasks.runs(taskId, ACTIVE_TASK_EXECUTION_RUN_STATUSES),
  );
  const activeRuns = page?.items ?? [];
  return {
    activeRuns,
    interruptibleTaskRun: resolveInterruptibleTaskRun(activeRuns),
  };
}

export function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".md") || name.endsWith(".markdown") || file.type === "text/markdown";
}

export type TaskDetailResourceReveal =
  { kind: "artifact"; target: TaskArtifactFragment } | { kind: "document"; documentKey: string };

export function resolveTaskDetailResourceReveal(locationHash: string): TaskDetailResourceReveal | null {
  const fragment = locationHash.startsWith("#") ? locationHash.slice(1) : locationHash;
  const artifact = parseTaskArtifactFragment(fragment);
  if (artifact) return { kind: "artifact", target: artifact };

  const document = parseDocumentAnnotationHash(fragment ? `#${fragment}` : "");
  return document ? { kind: "document", documentKey: document.documentKey } : null;
}

export function taskDetailSourceLabel(source: TaskDetailSource | null): string {
  if (source === "inbox") return "Inbox";
  if (source === "routine_runs") return "Recent Runs";
  return "Tasks";
}

export function taskDetailSourceRouteOptions(source: TaskDetailSource | null, companyId: string) {
  switch (source ?? "tasks") {
    case "inbox":
      return {
        to: "/$companyId/inbox" as const,
        params: { companyId },
      };
    case "routine_runs":
      return {
        to: "/$companyId/routines" as const,
        params: { companyId },
        search: { tab: "runs" as const },
      };
    case "tasks":
      return {
        to: "/$companyId/tasks" as const,
        params: { companyId },
      };
  }
}
