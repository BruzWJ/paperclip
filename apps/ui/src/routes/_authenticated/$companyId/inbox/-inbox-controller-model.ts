import type { InboxKeyboardNavEntry } from "@/lib/inbox";
import { createTaskDetailLocationState } from "@/lib/taskDetailBreadcrumb";

export const INBOX_RUN_LIMIT = 200;
export const INBOX_TASK_LIST_LIMIT = 500;
export const INBOX_HOT_PATH_STALE_MS = 30_000;
export const INBOX_TASK_DETAIL_LOCATION_STATE = createTaskDetailLocationState("inbox");

export type SectionKey = "work_items" | "alerts";
export type NavEntry = InboxKeyboardNavEntry;

/** Stable identity for a nav row when live updates reshape the inbox. */
export const navEntryKey = (entry: NavEntry | undefined): string | null =>
  !entry
    ? null
    : entry.type === "top"
      ? `top:${entry.itemKey}`
      : entry.type === "child"
        ? `child:${entry.taskId}`
        : `group:${entry.groupKey}`;
