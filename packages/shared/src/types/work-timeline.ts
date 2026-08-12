import type {
  TaskExecutionRunKind,
  TaskExecutionRunStatus,
} from "./task-execution-run.js";

/**
 * Work Timeline (Gantt) types — shared between the aggregation service
 * (`apps/server/src/services/work-timeline.ts`) and the UI page
 * (`apps/ui/src/routes/_authenticated/$companyId/timeline/index.tsx`). Defined here so both sides consume one contract
 * without redefining DTOs. Returned by `GET /api/companies/:companyId/timeline`.
 */

export type TimelineActorType = "agent" | "user" | "system" | "plugin";
export type TimelineEventKind =
  "created" | "commented" | "approved" | "delegated" | "assigned";
export type TimelineEdgeKind = "delegation" | "assignment" | "mention";

export interface WorkTimelineActor {
  /** Namespaced id, e.g. `agent:<id>`, `user:<id>`, `system:<id>`. */
  id: string;
  type: TimelineActorType;
  name: string;
  avatar?: string | null;
}

export interface WorkTimelineSpan {
  actorId: string;
  runId: string;
  kind: TaskExecutionRunKind;
  taskId: string;
  taskNumber: number;
  taskIdentifier: string;
  /** Human-readable task title, shown truncated in the hover tooltip (bars carry no ID). */
  taskTitle: string | null;
  /** ISO timestamp of run start. */
  start: string;
  /** ISO timestamp of run finish, or null when the run is still in progress. */
  end: string | null;
  status: TaskExecutionRunStatus;
  retryOfRunId: string | null;
}

export interface WorkTimelineEvent {
  actorId: string;
  kind: TimelineEventKind;
  taskId: string;
  /** ISO timestamp. */
  at: string;
}

export interface WorkTimelineEdge {
  fromActorId: string;
  toActorId: string;
  taskId: string;
  /** ISO timestamp. */
  at: string;
  kind: TimelineEdgeKind;
}

export interface WorkTimelineResult {
  actors: WorkTimelineActor[];
  spans: WorkTimelineSpan[];
  events: WorkTimelineEvent[];
  edges: WorkTimelineEdge[];
  pagination: {
    limit: number;
    offset: number;
    totalTasks: number;
    hasMore: boolean;
  };
  window: {
    /** ISO timestamp of the window start. */
    from: string;
    /** ISO timestamp of the window end. */
    to: string;
    capped: boolean;
  };
}
