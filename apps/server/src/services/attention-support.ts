import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  assets,
  companies,
  inboxDismissals,
  projectWorkspaces,
  projects,
  taskAttachments,
  taskComments,
  tasks,
  type Db,
} from "@paperclipai/db";
import {
  compareMoneyAmounts,
  parseMoneyAmount,
  type AttentionDecisionVerb,
  type AttentionDetailImage,
  type AttentionItem,
  type AttentionItemDetail,
  type AttentionProjectRef,
  type AttentionSeverity,
  type AttentionSourceKind,
  type AttentionSubject,
  type AttentionWorkspaceRef,
  type MoneyAmount,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

export const ATTENTION_SOURCE_KINDS: AttentionSourceKind[] = [
  "approval",
  "join_request",
  "review",
  "budget_alert",
  "mention_board",
];

export const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const SOURCE_RANK: Record<AttentionSourceKind, number> = {
  mention_board: 0,
  budget_alert: 1,
  approval: 2,
  review: 3,
  join_request: 4,
};

export const DETAIL_EXCERPT_LENGTH = 160;
export const DETAIL_IMAGE_LIMIT = 3;
export const boardMentionComments = alias(taskComments, "board_mention_comments");
export const boardReplyComments = alias(taskComments, "board_reply_comments");

export type TaskSummaryRow = {
  id: string;
  companyId: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
  boardPresentationStatus: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
};

export type TaskSubjectRow = Omit<TaskSummaryRow, "project" | "workspace">;

export type DismissalState = {
  kind: "dismiss" | "snooze";
  dismissedAt: Date;
  snoozedUntil: Date | null;
};

export type AttentionListOptions = {
  userId?: string | null;
  includeDismissed?: boolean;
};

export function emptyCounts(): Record<AttentionSourceKind, number> {
  return Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<
    AttentionSourceKind,
    number
  >;
}

export function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function activeDismissalState(
  dismissalByKey: ReadonlyMap<string, DismissalState>,
  dismissalKey: string,
  activityAt: string,
  now: number,
) {
  const dismissal = dismissalByKey.get(dismissalKey);
  if (!dismissal) return null;

  const dismissedAt = toIso(dismissal.dismissedAt);
  const snoozedUntil = dismissal.snoozedUntil ? toIso(dismissal.snoozedUntil) : null;
  const isActive =
    dismissal.kind === "snooze"
      ? dismissal.snoozedUntil != null && timestamp(dismissal.snoozedUntil) > now
      : timestamp(dismissal.dismissedAt) >= timestamp(activityAt);

  return {
    kind: dismissal.kind,
    dismissedAt,
    snoozedUntil,
    isActive,
  };
}

export function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_~#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(value: unknown, maxLength = DETAIL_EXCERPT_LENGTH) {
  if (typeof value !== "string") return null;
  const cleaned = stripMarkdown(value);
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function taskContext(task: TaskSummaryRow | null | undefined) {
  return {
    project: task?.project ?? null,
    workspace: task?.workspace ?? null,
  };
}

export function taskImages(
  imageMap: ReadonlyMap<string, AttentionDetailImage[]>,
  taskId: string | null | undefined,
) {
  return taskId ? (imageMap.get(taskId) ?? []) : [];
}

export function genericDetail(summary: unknown, images: AttentionDetailImage[]): AttentionItemDetail {
  return { kind: "generic", summaryExcerpt: excerpt(summary), images };
}

export function approvalDetail(type: string, payload: Record<string, unknown>): AttentionItemDetail {
  return {
    kind: "approval",
    approvalType: type,
    summaryExcerpt: excerpt(payload.summary ?? payload.title ?? payload.recommendedAction),
    images: [],
  };
}

export function taskSubject(task: TaskSubjectRow): AttentionSubject {
  return {
    kind: "task",
    id: task.id,
    companyId: task.companyId,
    taskNumber: task.taskNumber,
    title: task.title,
    identifier: task.identifier,
    status: task.boardPresentationStatus,
    routeTarget: { kind: "task", taskNumber: task.taskNumber, hash: null },
    metadata: {
      priority: task.priority,
      ownerAgentId: task.ownerAgentId,
      ownerUserId: task.ownerUserId,
    },
  };
}

export function itemId(sourceKind: AttentionSourceKind, dedupKey: string) {
  return `${sourceKind}:${dedupKey}`;
}

export function decisionVerbs(...verbs: AttentionDecisionVerb[]): AttentionDecisionVerb[] {
  return verbs;
}

export type CreateAttentionItemInput = Omit<
  AttentionItem,
  "id" | "dismissalKey" | "rank" | "dismissal" | "project" | "workspace" | "detail"
> & {
  project?: AttentionProjectRef | null;
  workspace?: AttentionWorkspaceRef | null;
  detail?: AttentionItemDetail | null;
};

export function createItem(input: CreateAttentionItemInput): AttentionItem {
  return {
    ...input,
    id: itemId(input.sourceKind, input.dedupKey),
    dismissalKey: `attention:${input.dedupKey}`,
    dismissal: null,
    project: input.project ?? null,
    workspace: input.workspace ?? null,
    detail: input.detail ?? null,
    rank: 0,
  };
}

export function compareAttentionItems(left: AttentionItem, right: AttentionItem) {
  const timeDiff = timestamp(right.activityAt) - timestamp(left.activityAt);
  if (timeDiff !== 0) return timeDiff;
  const severityDiff = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  const sourceDiff = SOURCE_RANK[left.sourceKind] - SOURCE_RANK[right.sourceKind];
  if (sourceDiff !== 0) return sourceDiff;
  return left.dedupKey.localeCompare(right.dedupKey);
}

export function betterDuplicate(left: AttentionItem, right: AttentionItem) {
  return compareAttentionItems(left, right) <= 0 ? left : right;
}

export function approvalTitle(type: string, payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) return title;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  return type.replaceAll("_", " ");
}

export const ZERO_MONEY_AMOUNT = parseMoneyAmount("0");

export function decimalParts(value: MoneyAmount) {
  const [integer, fraction = ""] = value.split(".");
  return { units: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

export function budgetObservedPercent(observedAmount: MoneyAmount, limitAmount: MoneyAmount) {
  if (compareMoneyAmounts(limitAmount, ZERO_MONEY_AMOUNT) === 0) return 0;
  const observed = decimalParts(observedAmount);
  const limit = decimalParts(limitAmount);
  const scale = Math.max(observed.scale, limit.scale);
  const observedUnits = observed.units * 10n ** BigInt(scale - observed.scale);
  const limitUnits = limit.units * 10n ** BigInt(scale - limit.scale);
  const basisPoints = (observedUnits * 10_000n) / limitUnits;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(basisPoints > maximum ? maximum : basisPoints) / 100;
}

export async function requireCompany(db: Db, companyId: string) {
  const row = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Company not found");
}

export async function dismissalByKey(db: Db, companyId: string, userId: string | null | undefined) {
  if (!userId) return new Map<string, DismissalState>();
  const rows = await db
    .select({
      itemKey: inboxDismissals.itemKey,
      kind: inboxDismissals.kind,
      dismissedAt: inboxDismissals.dismissedAt,
      snoozedUntil: inboxDismissals.snoozedUntil,
    })
    .from(inboxDismissals)
    .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)));
  return new Map(
    rows.map((row) => [
      row.itemKey,
      {
        kind: row.kind,
        dismissedAt: row.dismissedAt,
        snoozedUntil: row.snoozedUntil,
      },
    ]),
  );
}

export async function taskSummaryMap(
  db: Db,
  companyId: string,
  taskIds: Array<string | null | undefined>,
  options: { includeHidden?: boolean } = {},
) {
  const ids = [...new Set(taskIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, TaskSummaryRow>();
  const rows = await db
    .select({
      id: tasks.id,
      companyId: tasks.companyId,
      taskNumber: tasks.taskNumber,
      identifier: tasks.identifier,
      title: tasks.title,
      boardPresentationStatus: tasks.boardPresentationStatus,
      priority: tasks.priority,
      ownerAgentId: tasks.ownerAgentId,
      ownerUserId: tasks.ownerUserId,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      projectId: projects.id,
      projectName: projects.name,
      projectColor: projects.color,
      projectIcon: projects.icon,
      workspaceId: projectWorkspaces.id,
    })
    .from(tasks)
    .leftJoin(projects, and(eq(tasks.projectId, projects.id), eq(projects.companyId, companyId)))
    .leftJoin(
      projectWorkspaces,
      and(eq(tasks.projectWorkspaceId, projectWorkspaces.id), eq(projectWorkspaces.companyId, companyId)),
    )
    .where(
      and(
        eq(tasks.companyId, companyId),
        inArray(tasks.id, ids),
        options.includeHidden ? undefined : isNull(tasks.hiddenAt),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        companyId: row.companyId,
        taskNumber: row.taskNumber,
        identifier: row.identifier,
        title: row.title,
        boardPresentationStatus: row.boardPresentationStatus,
        priority: row.priority,
        ownerAgentId: row.ownerAgentId,
        ownerUserId: row.ownerUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        project:
          row.projectId && row.projectName
            ? {
                id: row.projectId,
                name: row.projectName,
                color: row.projectColor,
                icon: row.projectIcon,
              }
            : null,
        workspace:
          row.workspaceId && row.projectName
            ? {
                id: row.workspaceId,
                name: row.projectName,
              }
            : null,
      },
    ]),
  );
}

export async function taskImageMap(db: Db, companyId: string, taskIds: Array<string | null | undefined>) {
  const ids = [...new Set(taskIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, AttentionDetailImage[]>();
  const rows = await db
    .select({
      taskId: taskAttachments.taskId,
      assetId: taskAttachments.assetId,
      originalFilename: assets.originalFilename,
    })
    .from(taskAttachments)
    .innerJoin(assets, eq(taskAttachments.assetId, assets.id))
    .where(
      and(
        eq(taskAttachments.companyId, companyId),
        eq(assets.companyId, companyId),
        inArray(taskAttachments.taskId, ids),
        sql`${assets.contentType} like 'image/%'`,
      ),
    )
    .orderBy(asc(taskAttachments.taskId), asc(taskAttachments.createdAt), asc(taskAttachments.id));

  const map = new Map<string, AttentionDetailImage[]>();
  for (const row of rows) {
    const images = map.get(row.taskId) ?? [];
    if (images.length >= DETAIL_IMAGE_LIMIT) continue;
    images.push({ assetId: row.assetId, alt: row.originalFilename ?? null });
    map.set(row.taskId, images);
  }
  return map;
}
