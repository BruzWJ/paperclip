import { buffer } from "node:stream/consumers";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { type Db, tasks } from "@paperclipai/db";
import {
  COMPANY_ARTIFACTS_MAX_LIMIT,
  type CompanyArtifact,
  type CompanyArtifactGroup,
  type CompanyArtifactGroupBy,
  type CompanyArtifactMediaKind,
  type CompanyArtifactsQuery,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import type { StorageService } from "../storage/types.js";

export interface CompanyArtifactSourceContext {
  db: Db;
  storage?: StorageService;
  companyId: string;
  query: CompanyArtifactsQuery;
  cursor: ReturnType<typeof decodeCursor>;
  groupBy: Exclude<CompanyArtifactsQuery["groupBy"], "none"> | null;
  taskConditions: SQL[];
  sourceFetchLimit: number;
  q: string | null;
}

export const TEXT_PREVIEW_BYTES = 4096;

export const PREVIEW_TEXT_MAX_LENGTH = 280;

export const GROUP_PREVIEW_ARTIFACT_LIMIT = 3;

export const GROUPED_ARTIFACT_FETCH_LIMIT = COMPANY_ARTIFACTS_MAX_LIMIT * 10;

export type ArtifactCursor = {
  updatedAt: string;
  id: string;
};

export type ArtifactGroupBy = Exclude<CompanyArtifactGroupBy, "none">;

export type TaskGroupingRow = {
  id: string;
  parentId: string | null;
  taskNumber: number;
  identifier: string;
  title: string | null;
  updatedAt: Date;
};

export function encodeCursor(cursor: ArtifactCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): ArtifactCursor | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("Noncanonical cursor");
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<ArtifactCursor>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      Object.keys(parsed).sort().join(",") !== "id,updatedAt"
    ) {
      throw new Error("Invalid cursor");
    }
    const date = new Date(parsed.updatedAt);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed.updatedAt) {
      throw new Error("Invalid cursor date");
    }
    return { id: parsed.id, updatedAt: parsed.updatedAt };
  } catch {
    throw badRequest("Invalid artifacts cursor");
  }
}

export function cursorCondition(
  updatedAt: SQL<Date>,
  artifactId: SQL<string>,
  cursor: ArtifactCursor | null,
) {
  if (!cursor) return undefined;
  return sql`(${updatedAt} < ${cursor.updatedAt}::timestamptz OR (${updatedAt} = ${cursor.updatedAt}::timestamptz AND ${artifactId} < ${cursor.id}))`;
}

export function isAfterCursor(item: { updatedAt: string; id: string }, cursor: ArtifactCursor | null) {
  if (!cursor) return true;
  const dateDiff = Date.parse(item.updatedAt) - Date.parse(cursor.updatedAt);
  return dateDiff < 0 || (dateDiff === 0 && item.id < cursor.id);
}

export function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function normalizePreviewText(input: string | null | undefined) {
  if (!input) return null;
  const stripped = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_\-~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.length > PREVIEW_TEXT_MAX_LENGTH
    ? `${stripped.slice(0, PREVIEW_TEXT_MAX_LENGTH - 3).trimEnd()}...`
    : stripped;
}

export function classifyMediaKind(
  contentType: string | null | undefined,
  fallback: CompanyArtifactMediaKind = "file",
) {
  const normalized = (contentType ?? "").toLowerCase();
  if (!normalized) return fallback;
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/markdown"
  ) {
    return "text";
  }
  return "file";
}

export function contentTypeKindCondition(
  contentTypeExpression: SQL<string>,
  kind: CompanyArtifactsQuery["kind"],
) {
  if (!kind || kind === "all") return undefined;
  if (kind === "image") return sql`${contentTypeExpression} ILIKE 'image/%'`;
  if (kind === "video") return sql`${contentTypeExpression} ILIKE 'video/%'`;
  if (kind === "text") {
    return sql`(${contentTypeExpression} ILIKE 'text/%' OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown') OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml')`;
  }
  if (kind === "file") {
    return sql`NOT (${contentTypeExpression} ILIKE 'image/%' OR ${contentTypeExpression} ILIKE 'video/%' OR ${contentTypeExpression} ILIKE 'text/%' OR ${contentTypeExpression} IN ('application/json', 'application/xml', 'application/markdown') OR ${contentTypeExpression} ILIKE '%+json' OR ${contentTypeExpression} ILIKE '%+xml')`;
  }
  return undefined;
}

export function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${attachmentId}/content`;
}

export async function readTextAttachmentPreview(
  storage: StorageService | undefined,
  input: { companyId: string; objectKey: string; byteSize: number },
) {
  if (!storage || input.byteSize <= 0) return null;
  try {
    const object = await storage.getObject(input.companyId, input.objectKey, {
      range: {
        start: 0,
        end: Math.min(input.byteSize, TEXT_PREVIEW_BYTES) - 1,
      },
    });
    const body = await buffer(object.stream);
    return normalizePreviewText(body.toString("utf8"));
  } catch {
    return null;
  }
}

export function sortArtifacts(artifacts: CompanyArtifact[]) {
  return artifacts.sort((a, b) => {
    const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dateDiff !== 0) return dateDiff;
    return b.id.localeCompare(a.id);
  });
}

export function pageByCursor<T extends { id: string; updatedAt: string }>(
  items: T[],
  limit: number,
  cursor: ArtifactCursor | null,
) {
  const filtered = items.filter((item) => isAfterCursor(item, cursor));
  const page = filtered.slice(0, limit);
  const nextCursor =
    filtered.length > limit
      ? encodeCursor({
          id: page[page.length - 1]?.id ?? "",
          updatedAt: page[page.length - 1]?.updatedAt ?? new Date(0).toISOString(),
        })
      : null;
  return { page, nextCursor };
}

export async function loadTaskGroupingRows(db: Db, companyId: string, seedTaskIds: Iterable<string>) {
  const rowsById = new Map<string, TaskGroupingRow>();
  let pending = [...new Set(seedTaskIds)];

  while (pending.length > 0) {
    const rows = await db
      .select({
        id: tasks.id,
        parentId: tasks.parentId,
        taskNumber: tasks.taskNumber,
        identifier: tasks.identifier,
        title: tasks.title,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, pending)));

    const nextPending = new Set<string>();
    for (const row of rows) {
      rowsById.set(row.id, row);
      if (row.parentId && !rowsById.has(row.parentId)) {
        nextPending.add(row.parentId);
      }
    }
    pending = [...nextPending];
  }

  return rowsById;
}

export function getTaskSummary(task: TaskGroupingRow) {
  return {
    id: task.id,
    taskNumber: task.taskNumber,
    identifier: task.identifier,
    title: task.title,
  };
}

export function resolveRootTaskId(taskId: string, taskRows: Map<string, TaskGroupingRow>) {
  let current = taskRows.get(taskId);
  if (!current) return taskId;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = taskRows.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

export function resolveGroupTaskId(
  groupBy: ArtifactGroupBy,
  taskId: string,
  taskRows: Map<string, TaskGroupingRow>,
) {
  return groupBy === "task" ? taskId : resolveRootTaskId(taskId, taskRows);
}

export function emptyGroup(input: { groupBy: ArtifactGroupBy; task: TaskGroupingRow }): CompanyArtifactGroup {
  const summary = getTaskSummary(input.task);
  return {
    id: `${input.groupBy}:${input.task.id}`,
    groupBy: input.groupBy,
    task: summary,
    title: summary.title ?? summary.identifier,
    count: 0,
    mediaKinds: [],
    previewArtifacts: [],
    updatedAt: input.task.updatedAt.toISOString(),
  };
}

export function buildArtifactGroups(input: {
  artifacts: CompanyArtifact[];
  groupBy: ArtifactGroupBy;
  taskRows: Map<string, TaskGroupingRow>;
}) {
  const groups = new Map<string, CompanyArtifactGroup>();

  for (const artifact of input.artifacts) {
    const groupTaskId = resolveGroupTaskId(input.groupBy, artifact.task.id, input.taskRows);
    const groupTask = input.taskRows.get(groupTaskId) ?? {
      id: artifact.task.id,
      parentId: null,
      taskNumber: artifact.task.taskNumber,
      identifier: artifact.task.identifier,
      title: artifact.task.title,
      updatedAt: new Date(artifact.updatedAt),
    };
    const groupId = `${input.groupBy}:${groupTaskId}`;
    const existing = groups.get(groupId);
    const group =
      existing ??
      emptyGroup({
        groupBy: input.groupBy,
        task: groupTask,
      });
    if (!existing) groups.set(groupId, group);

    group.count += 1;
    if (!group.mediaKinds.includes(artifact.mediaKind)) {
      group.mediaKinds.push(artifact.mediaKind);
    }
    if (group.previewArtifacts.length < GROUP_PREVIEW_ARTIFACT_LIMIT) {
      group.previewArtifacts.push(artifact);
    }
    if (Date.parse(artifact.updatedAt) > Date.parse(group.updatedAt)) {
      group.updatedAt = artifact.updatedAt;
    }
  }

  return [...groups.values()].sort((a, b) => {
    const dateDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dateDiff !== 0) return dateDiff;
    return b.id.localeCompare(a.id);
  });
}
