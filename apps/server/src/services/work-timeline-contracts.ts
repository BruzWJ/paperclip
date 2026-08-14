import type { TimelineActorType } from "@paperclipai/shared";
import { type TaskExecutionRunEnvelope } from "./task-execution-run-service.js";

import type { Db } from "@paperclipai/db";

export function createWorkTimelineContext(db: Db) {
  return { db };
}

export type WorkTimelineContext = ReturnType<typeof createWorkTimelineContext>;

export interface WorkTimelineQuery {
  companyId: string;
  from?: Date;
  to?: Date;
  userId?: string;
  goalId?: string;
  projectId?: string;
  taskId?: string;
  limit?: number;
  offset?: number;
  canReadTask?: (task: WorkTimelineTaskAccessInput) => Promise<boolean>;
}

export interface WorkTimelineTaskAccessInput {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  boardPresentationStatus: string;
}

export type TaskRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  taskNumber: number;
  identifier: string;
  title: string | null;
  creatorKind: string | null;
  creatorAgentId: string | null;
  creatorUserId: string | null;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  boardPresentationStatus: string;
  createdAt: Date;
};

export const DEFAULT_LIMIT = 200;

export const MAX_LIMIT = 500;

export const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_SOURCE_ROWS = 5_000;

export const ACL_FILTER_CONCURRENCY = 16;

export function actorId(type: TimelineActorType, id: string) {
  return `${type}:${id}`;
}

export function normalizeLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

export function normalizeOffset(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

export function normalizeTimelineWindow(input: { from?: Date; to?: Date }, now = new Date()) {
  const rawTo = input.to ?? now;
  const to = rawTo.getTime() > now.getTime() ? now : rawTo;
  const requestedFrom = input.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  let from = requestedFrom;
  let capped = false;
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    from = new Date(to.getTime() - MAX_WINDOW_MS);
    capped = true;
  }
  if (from.getTime() > to.getTime()) {
    from = new Date(to.getTime() - DEFAULT_WINDOW_MS);
    capped = true;
  }
  return { from, to, capped };
}

export function dateIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

export function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

export function maybeUuidList(ids: Iterable<string>) {
  return Array.from(new Set(Array.from(ids).filter((id) => id.length > 0)));
}

export function runOverlapsWindow(run: TaskExecutionRunEnvelope, from: Date, to: Date) {
  const startedAt = run.startedAt ?? run.createdAt;
  const finishedAt = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return startedAt <= to && finishedAt >= from;
}
