import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  assets,
  companies,
  inboxDismissals,
  invites,
  taskApprovals,
  taskAttachments,
  taskBoardMentions,
  taskBoardReopenCommands,
  taskBoardUserComments,
  taskComments,
  tasks,
  joinRequests,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { compareMoneyAmounts, parseMoneyAmount } from "@paperclipai/shared";
import type {
  AttentionDecisionVerb,
  AttentionFeed,
  AttentionDetailImage,
  AttentionItem,
  AttentionItemDetail,
  AttentionProjectRef,
  AttentionSeverity,
  AttentionSourceKind,
  AttentionSubject,
  AttentionWorkspaceRef,
  MoneyAmount,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { parseTaskExecutionState } from "./task-execution-policy.js";

const ATTENTION_SOURCE_KINDS: AttentionSourceKind[] = [
  "approval",
  "join_request",
  "review",
  "budget_alert",
  "mention_board",
];

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SOURCE_RANK: Record<AttentionSourceKind, number> = {
  mention_board: 0,
  budget_alert: 1,
  approval: 2,
  review: 3,
  join_request: 4,
};

const DETAIL_EXCERPT_LENGTH = 160;
const DETAIL_IMAGE_LIMIT = 3;
const boardMentionComments = alias(taskComments, "board_mention_comments");
const boardReplyComments = alias(taskComments, "board_reply_comments");

type TaskSummaryRow = {
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

type TaskSubjectRow = Omit<TaskSummaryRow, "project" | "workspace">;

type DismissalState = {
  kind: "dismiss" | "snooze";
  dismissedAt: Date;
  snoozedUntil: Date | null;
};

type AttentionListOptions = {
  userId?: string | null;
  includeDismissed?: boolean;
};

function emptyCounts(): Record<AttentionSourceKind, number> {
  return Object.fromEntries(
    ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0]),
  ) as Record<AttentionSourceKind, number>;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function activeDismissalState(
  dismissalByKey: ReadonlyMap<string, DismissalState>,
  dismissalKey: string,
  activityAt: string,
  now: number,
) {
  const dismissal = dismissalByKey.get(dismissalKey);
  if (!dismissal) return null;

  const dismissedAt = toIso(dismissal.dismissedAt);
  const snoozedUntil = dismissal.snoozedUntil
    ? toIso(dismissal.snoozedUntil)
    : null;
  const isActive =
    dismissal.kind === "snooze"
      ? dismissal.snoozedUntil != null &&
        timestamp(dismissal.snoozedUntil) > now
      : timestamp(dismissal.dismissedAt) >= timestamp(activityAt);

  return {
    kind: dismissal.kind,
    dismissedAt,
    snoozedUntil,
    isActive,
  };
}

function stripMarkdown(value: string) {
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

function excerpt(value: unknown, maxLength = DETAIL_EXCERPT_LENGTH) {
  if (typeof value !== "string") return null;
  const cleaned = stripMarkdown(value);
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function taskContext(task: TaskSummaryRow | null | undefined) {
  return {
    project: task?.project ?? null,
    workspace: task?.workspace ?? null,
  };
}

function taskImages(
  imageMap: ReadonlyMap<string, AttentionDetailImage[]>,
  taskId: string | null | undefined,
) {
  return taskId ? (imageMap.get(taskId) ?? []) : [];
}

function genericDetail(
  summary: unknown,
  images: AttentionDetailImage[],
): AttentionItemDetail {
  return { kind: "generic", summaryExcerpt: excerpt(summary), images };
}

function approvalDetail(
  type: string,
  payload: Record<string, unknown>,
): AttentionItemDetail {
  return {
    kind: "approval",
    approvalType: type,
    summaryExcerpt: excerpt(
      payload.summary ?? payload.title ?? payload.recommendedAction,
    ),
    images: [],
  };
}

function taskSubject(task: TaskSubjectRow): AttentionSubject {
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

function itemId(sourceKind: AttentionSourceKind, dedupKey: string) {
  return `${sourceKind}:${dedupKey}`;
}

function decisionVerbs(
  ...verbs: AttentionDecisionVerb[]
): AttentionDecisionVerb[] {
  return verbs;
}

type CreateAttentionItemInput = Omit<
  AttentionItem,
  | "id"
  | "dismissalKey"
  | "rank"
  | "dismissal"
  | "project"
  | "workspace"
  | "detail"
> & {
  project?: AttentionProjectRef | null;
  workspace?: AttentionWorkspaceRef | null;
  detail?: AttentionItemDetail | null;
};

function createItem(input: CreateAttentionItemInput): AttentionItem {
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

function compareAttentionItems(left: AttentionItem, right: AttentionItem) {
  const timeDiff = timestamp(right.activityAt) - timestamp(left.activityAt);
  if (timeDiff !== 0) return timeDiff;
  const severityDiff =
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  const sourceDiff =
    SOURCE_RANK[left.sourceKind] - SOURCE_RANK[right.sourceKind];
  if (sourceDiff !== 0) return sourceDiff;
  return left.dedupKey.localeCompare(right.dedupKey);
}

function betterDuplicate(left: AttentionItem, right: AttentionItem) {
  return compareAttentionItems(left, right) <= 0 ? left : right;
}

function approvalTitle(type: string, payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) return title;
  const summary =
    typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  return type.replaceAll("_", " ");
}

const ZERO_MONEY_AMOUNT = parseMoneyAmount("0");

function decimalParts(value: MoneyAmount) {
  const [integer, fraction = ""] = value.split(".");
  return { units: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function budgetObservedPercent(
  observedAmount: MoneyAmount,
  limitAmount: MoneyAmount,
) {
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

async function requireCompany(db: Db, companyId: string) {
  const row = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Company not found");
}

async function dismissalByKey(
  db: Db,
  companyId: string,
  userId: string | null | undefined,
) {
  if (!userId) return new Map<string, DismissalState>();
  const rows = await db
    .select({
      itemKey: inboxDismissals.itemKey,
      kind: inboxDismissals.kind,
      dismissedAt: inboxDismissals.dismissedAt,
      snoozedUntil: inboxDismissals.snoozedUntil,
    })
    .from(inboxDismissals)
    .where(
      and(
        eq(inboxDismissals.companyId, companyId),
        eq(inboxDismissals.userId, userId),
      ),
    );
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

async function taskSummaryMap(
  db: Db,
  companyId: string,
  taskIds: Array<string | null | undefined>,
  options: { includeHidden?: boolean } = {},
) {
  const ids = [
    ...new Set(taskIds.filter((value): value is string => Boolean(value))),
  ];
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
    .leftJoin(
      projects,
      and(eq(tasks.projectId, projects.id), eq(projects.companyId, companyId)),
    )
    .leftJoin(
      projectWorkspaces,
      and(
        eq(tasks.projectWorkspaceId, projectWorkspaces.id),
        eq(projectWorkspaces.companyId, companyId),
      ),
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

async function taskImageMap(
  db: Db,
  companyId: string,
  taskIds: Array<string | null | undefined>,
) {
  const ids = [
    ...new Set(taskIds.filter((value): value is string => Boolean(value))),
  ];
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
    .orderBy(
      asc(taskAttachments.taskId),
      asc(taskAttachments.createdAt),
      asc(taskAttachments.id),
    );

  const map = new Map<string, AttentionDetailImage[]>();
  for (const row of rows) {
    const images = map.get(row.taskId) ?? [];
    if (images.length >= DETAIL_IMAGE_LIMIT) continue;
    images.push({ assetId: row.assetId, alt: row.originalFilename ?? null });
    map.set(row.taskId, images);
  }
  return map;
}

export function attentionService(db: Db) {
  return {
    list: async (
      companyId: string,
      options: AttentionListOptions = {},
    ): Promise<AttentionFeed> => {
      await requireCompany(db, companyId);
      const dismissals = await dismissalByKey(db, companyId, options.userId);
      const includeDismissed = options.includeDismissed === true;
      const now = Date.now();
      const collected: AttentionItem[] = [];

      const add = (
        item: AttentionItem,
        options: { suppressible?: boolean } = {},
      ) => {
        if (options.suppressible === false) {
          collected.push({ ...item, dismissal: null });
          return;
        }
        const dismissal = activeDismissalState(
          dismissals,
          item.dismissalKey,
          item.activityAt,
          now,
        );
        if (!includeDismissed && dismissal?.isActive) return;
        collected.push({ ...item, dismissal });
      };

      const pendingApprovals = await db
        .select({
          id: approvals.id,
          type: approvals.type,
          status: approvals.status,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          payload: approvals.payload,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.status, "pending"),
          ),
        )
        .orderBy(desc(approvals.updatedAt), desc(approvals.id));

      const pendingApprovalIds = pendingApprovals.map(
        (approval) => approval.id,
      );
      const approvalTaskRows =
        pendingApprovalIds.length > 0
          ? await db
              .select({
                approvalId: taskApprovals.approvalId,
                taskId: taskApprovals.taskId,
              })
              .from(taskApprovals)
              .where(
                and(
                  eq(taskApprovals.companyId, companyId),
                  inArray(taskApprovals.approvalId, pendingApprovalIds),
                ),
              )
              .orderBy(asc(taskApprovals.approvalId), asc(taskApprovals.taskId))
          : [];
      const approvalTaskMap = new Map<string, string>();
      for (const row of approvalTaskRows) {
        if (!approvalTaskMap.has(row.approvalId))
          approvalTaskMap.set(row.approvalId, row.taskId);
      }

      for (const approval of pendingApprovals) {
        const dedupKey = `approval:${approval.id}`;
        const title = approvalTitle(approval.type, approval.payload);
        add(
          createItem({
            companyId,
            sourceKind: "approval",
            subject: {
              kind: "approval",
              id: approval.id,
              companyId,
              taskNumber: null,
              title,
              identifier: null,
              status: approval.status,
              routeTarget: { kind: "approval", id: approval.id },
              metadata: {
                type: approval.type,
                requestedByAgentId: approval.requestedByAgentId,
                requestedByUserId: approval.requestedByUserId,
                taskId: approvalTaskMap.get(approval.id) ?? null,
              },
            },
            whyNow: "Approval is pending a board decision.",
            decisionVerbs: decisionVerbs(
              {
                id: "approve",
                label: "Approve",
                description: "Approve the request.",
              },
              {
                id: "reject",
                label: "Reject",
                description: "Reject the request.",
              },
              {
                id: "request_revision",
                label: "Request revision",
                description: "Send the request back for changes.",
              },
            ),
            inlineResolvable: approval.type !== "request_board_approval",
            entryRule: "approvals.status = 'pending'",
            exitRule: "Approval leaves pending status.",
            dedupKey,
            severity: "medium",
            activityAt: toIso(approval.updatedAt),
            createdAt: toIso(approval.createdAt),
            updatedAt: toIso(approval.updatedAt),
            relatedTask: null,
            detail: approvalDetail(approval.type, approval.payload),
          }),
        );
      }

      const pendingJoins = await db
        .select({
          id: joinRequests.id,
          status: joinRequests.status,
          requestingUserId: joinRequests.requestingUserId,
          requestEmailSnapshot: joinRequests.requestEmailSnapshot,
          createdAt: joinRequests.createdAt,
          updatedAt: joinRequests.updatedAt,
        })
        .from(joinRequests)
        .innerJoin(invites, eq(joinRequests.inviteId, invites.id))
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(invites.companyId, companyId),
            eq(joinRequests.status, "pending_approval"),
          ),
        )
        .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.id));

      for (const join of pendingJoins) {
        const label =
          join.requestEmailSnapshot ??
          join.requestingUserId ??
          "User join request";
        const dedupKey = `join:${join.id}`;
        add(
          createItem({
            companyId,
            sourceKind: "join_request",
            subject: {
              kind: "join_request",
              id: join.id,
              companyId,
              taskNumber: null,
              title: label,
              identifier: null,
              status: join.status,
              routeTarget: { kind: "join_requests" },
              metadata: {
                requestingUserId: join.requestingUserId,
              },
            },
            whyNow: "Join request is pending approval.",
            decisionVerbs: decisionVerbs(
              {
                id: "approve",
                label: "Approve",
                description: "Approve this join request.",
              },
              {
                id: "reject",
                label: "Reject",
                description: "Reject this join request.",
              },
            ),
            inlineResolvable: true,
            entryRule: "join_requests.status = 'pending_approval'",
            exitRule: "Join request is approved or rejected.",
            dedupKey,
            severity: "medium",
            activityAt: toIso(join.updatedAt),
            createdAt: toIso(join.createdAt),
            updatedAt: toIso(join.updatedAt),
            relatedTask: null,
            detail: genericDetail(label, []),
          }),
        );
      }

      const reviewRows = await db
        .select({
          id: tasks.id,
          companyId: tasks.companyId,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          priority: tasks.priority,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
          executionState: tasks.executionState,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            eq(tasks.boardPresentationStatus, "in_review"),
            isNull(tasks.hiddenAt),
          ),
        )
        .orderBy(desc(tasks.updatedAt), desc(tasks.id));
      const reviewTaskIds = reviewRows.map((row) => row.id);
      const pendingReviewApprovalRows =
        reviewTaskIds.length === 0
          ? []
          : await db
              .select({
                taskId: taskApprovals.taskId,
                approvalId: approvals.id,
              })
              .from(taskApprovals)
              .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
              .where(
                and(
                  eq(taskApprovals.companyId, companyId),
                  eq(approvals.companyId, companyId),
                  inArray(taskApprovals.taskId, reviewTaskIds),
                  eq(approvals.status, "pending"),
                ),
              );
      const pendingApprovalByTaskId = new Map(
        pendingReviewApprovalRows.map((row) => [row.taskId, row.approvalId]),
      );
      const reviewTaskMap = await taskSummaryMap(db, companyId, reviewTaskIds);
      const reviewImageMap = await taskImageMap(db, companyId, reviewTaskIds);

      for (const review of reviewRows) {
        const state = parseTaskExecutionState(review.executionState);
        const currentParticipant =
          state?.status === "pending" ? state.currentParticipant : null;
        const hasHumanParticipant = currentParticipant?.type === "user";
        const pendingApprovalId =
          pendingApprovalByTaskId.get(review.id) ?? null;
        if (!hasHumanParticipant && !review.ownerUserId && !pendingApprovalId)
          continue;
        const task = reviewTaskMap.get(review.id);
        if (!task) continue;
        const dedupKey = `review:${review.id}`;
        add(
          createItem({
            companyId,
            sourceKind: "review",
            subject: taskSubject(task),
            whyNow: pendingApprovalId
              ? "Task is in review with a linked pending approval."
              : hasHumanParticipant
                ? "Task is in review and the current execution participant is a user."
                : "Task is in review and owned by a user.",
            decisionVerbs: decisionVerbs(
              {
                id: "approve",
                label: "Approve",
                description: "Approve the review and advance the task.",
              },
              {
                id: "request_changes",
                label: "Request changes",
                description:
                  "Return the task to its owner with changes requested.",
              },
            ),
            inlineResolvable: false,
            entryRule:
              "tasks.boardPresentationStatus = 'in_review' and human reviewer, user owner, or linked pending approval exists.",
            exitRule:
              "Task leaves in_review or the human review path resolves.",
            dedupKey,
            severity: "medium",
            activityAt: toIso(review.updatedAt),
            createdAt: toIso(review.createdAt),
            updatedAt: toIso(review.updatedAt),
            relatedTask: null,
            ...taskContext(task),
            detail: genericDetail(
              review.title,
              taskImages(reviewImageMap, review.id),
            ),
          }),
        );
      }

      const activeBoardMentions = await db
        .select({
          id: taskBoardMentions.id,
          taskId: taskBoardMentions.taskId,
          message: boardMentionComments.body,
          createdAt: taskBoardMentions.createdAt,
        })
        .from(taskBoardMentions)
        .innerJoin(
          boardMentionComments,
          and(
            eq(boardMentionComments.companyId, taskBoardMentions.companyId),
            eq(boardMentionComments.taskId, taskBoardMentions.taskId),
            eq(boardMentionComments.id, taskBoardMentions.commentId),
          ),
        )
        .innerJoin(
          tasks,
          and(
            eq(tasks.companyId, taskBoardMentions.companyId),
            eq(tasks.id, taskBoardMentions.taskId),
            eq(tasks.ownershipEpoch, taskBoardMentions.ownershipEpoch),
          ),
        )
        .where(
          and(
            eq(taskBoardMentions.companyId, companyId),
            isNull(tasks.hiddenAt),
            inArray(tasks.lifecycleStatus, ["open", "blocked"]),
            notExists(
              db
                .select({ id: taskBoardUserComments.id })
                .from(taskBoardUserComments)
                .innerJoin(
                  boardReplyComments,
                  and(
                    eq(
                      boardReplyComments.companyId,
                      taskBoardUserComments.companyId,
                    ),
                    eq(boardReplyComments.taskId, taskBoardUserComments.taskId),
                    eq(boardReplyComments.id, taskBoardUserComments.commentId),
                  ),
                )
                .where(
                  and(
                    eq(
                      taskBoardUserComments.companyId,
                      taskBoardMentions.companyId,
                    ),
                    eq(taskBoardUserComments.taskId, taskBoardMentions.taskId),
                    eq(
                      taskBoardUserComments.ownershipEpoch,
                      taskBoardMentions.ownershipEpoch,
                    ),
                    eq(
                      taskBoardUserComments.mentionTargetAgentId,
                      taskBoardMentions.agentId,
                    ),
                    gt(
                      boardReplyComments.projectedEventSeq,
                      boardMentionComments.projectedEventSeq,
                    ),
                  ),
                ),
            ),
            notExists(
              db
                .select({ id: taskBoardReopenCommands.id })
                .from(taskBoardReopenCommands)
                .where(
                  and(
                    eq(
                      taskBoardReopenCommands.companyId,
                      taskBoardMentions.companyId,
                    ),
                    eq(
                      taskBoardReopenCommands.taskId,
                      taskBoardMentions.taskId,
                    ),
                    eq(
                      taskBoardReopenCommands.ownershipEpoch,
                      taskBoardMentions.ownershipEpoch,
                    ),
                    sql`${taskBoardReopenCommands.createdAt} >= ${taskBoardMentions.createdAt}`,
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(taskBoardMentions.createdAt), desc(taskBoardMentions.id));
      const boardMentionTaskMap = await taskSummaryMap(
        db,
        companyId,
        activeBoardMentions.map((mention) => mention.taskId),
      );
      const boardMentionImageMap = await taskImageMap(
        db,
        companyId,
        activeBoardMentions.map((mention) => mention.taskId),
      );
      for (const mention of activeBoardMentions) {
        const task = boardMentionTaskMap.get(mention.taskId);
        if (!task) continue;
        add(
          createItem({
            companyId,
            sourceKind: "mention_board",
            subject: taskSubject(task),
            whyNow:
              "An agent requested information or direction from the Board.",
            decisionVerbs: decisionVerbs({
              id: "reply_and_continue",
              label: "Reply & continue",
              description: "Reply to the agent and continue this task.",
            }),
            inlineResolvable: false,
            entryRule:
              "An active agent Board mention exists for the current nonterminal task ownership epoch.",
            exitRule:
              "A Board user resumes the exact owner/epoch, the task is reopened, or the ownership epoch leaves scope.",
            dedupKey: `board-mention:${mention.id}`,
            severity: "medium",
            activityAt: toIso(mention.createdAt),
            createdAt: toIso(mention.createdAt),
            updatedAt: toIso(mention.createdAt),
            relatedTask: null,
            ...taskContext(task),
            detail: genericDetail(
              mention.message,
              taskImages(boardMentionImageMap, mention.taskId),
            ),
          }),
        );
      }

      const budgetOverview = await budgetService(db).overview(companyId);
      for (const incident of budgetOverview.activeIncidents) {
        const observedPercent = budgetObservedPercent(
          incident.observedAmount,
          incident.limitAmount,
        );
        if (incident.thresholdType !== "hard" && observedPercent < 85) continue;
        const dedupKey = `budget:${incident.policyId}:${toIso(incident.windowStart)}:${incident.thresholdType}`;
        add(
          createItem({
            companyId,
            sourceKind: "budget_alert",
            subject: {
              kind: "budget_incident",
              id: incident.id,
              companyId,
              taskNumber: null,
              title: `${incident.scopeName} budget ${incident.thresholdType === "hard" ? "hard stop" : "warning"}`,
              identifier: null,
              status: incident.status,
              routeTarget: { kind: "costs" },
              metadata: {
                policyId: incident.policyId,
                scopeType: incident.scopeType,
                scopeId: incident.scopeId,
                thresholdType: incident.thresholdType,
                budgetCurrency: incident.budgetCurrency,
                observedAmount: incident.observedAmount,
                limitAmount: incident.limitAmount,
                observedPercent,
                approvalId: incident.approvalId,
                approvalStatus: incident.approvalStatus,
              },
            },
            whyNow:
              incident.thresholdType === "hard"
                ? "Budget hard stop was reached."
                : "Budget crossed the 85% warning threshold.",
            decisionVerbs: decisionVerbs(
              {
                id: "raise_budget_and_resume",
                label: "Raise budget",
                description: "Raise the budget and resume paused work.",
              },
              {
                id: "keep_paused",
                label: "Keep paused",
                description: "Dismiss or keep the budget stop in place.",
              },
            ),
            inlineResolvable: true,
            entryRule:
              "open budget incident is hard, or soft with observed spend >= 85% of limit.",
            exitRule: "Budget incident is resolved or dismissed.",
            dedupKey,
            severity: incident.thresholdType === "hard" ? "high" : "medium",
            activityAt: toIso(incident.updatedAt),
            createdAt: toIso(incident.createdAt),
            updatedAt: toIso(incident.updatedAt),
            relatedTask: null,
            detail: {
              kind: "budget",
              observedPercent,
              budgetCurrency: incident.budgetCurrency,
              observedAmount: incident.observedAmount,
              limitAmount: incident.limitAmount,
              images: [],
            },
          }),
        );
      }

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(
          item.dedupKey,
          current ? betterDuplicate(current, item) : item,
        );
      }

      const items = [...deduped.values()]
        .sort(compareAttentionItems)
        .map((item, index) => ({ ...item, rank: index + 1 }));
      const countsBySourceKind = emptyCounts();
      for (const item of items) countsBySourceKind[item.sourceKind] += 1;

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        totalCount: items.length,
        countsBySourceKind,
        items,
      };
    },
  };
}
