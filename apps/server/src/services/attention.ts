import { and, asc, desc, eq, gt, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  assets,
  companies,
  inboxDismissals,
  invites,
  issueApprovals,
  issueAttachments,
  issueBoardMentions,
  issueBoardReopenCommands,
  issueBoardUserComments,
  issueComments,
  issues,
  joinRequests,
  projects,
} from "@paperclipai/db";
import { compareMoneyAmounts, deriveProjectUrlKey, parseMoneyAmount } from "@paperclipai/shared";
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
import { budgetService } from "./budgets.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

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
const boardMentionComments = alias(issueComments, "board_mention_comments");
const boardReplyComments = alias(issueComments, "board_reply_comments");

type IssueSummaryRow = {
  id: string;
  companyId: string;
  identifier: string | null;
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

type IssueSubjectRow = Omit<IssueSummaryRow, "project" | "workspace">;

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
  return Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<AttentionSourceKind, number>;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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
  const snoozedUntil = dismissal.snoozedUntil ? toIso(dismissal.snoozedUntil) : null;
  const isActive = dismissal.kind === "snooze"
    ? dismissal.snoozedUntil != null && timestamp(dismissal.snoozedUntil) > now
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

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function issueContext(issue: IssueSummaryRow | null | undefined) {
  return {
    project: issue?.project ?? null,
    workspace: issue?.workspace ?? null,
  };
}

function issueImages(imageMap: ReadonlyMap<string, AttentionDetailImage[]>, issueId: string | null | undefined) {
  return issueId ? imageMap.get(issueId) ?? [] : [];
}

function genericDetail(summary: unknown, images: AttentionDetailImage[]): AttentionItemDetail {
  return { kind: "generic", summaryExcerpt: excerpt(summary), images };
}

function approvalDetail(type: string, payload: Record<string, unknown>): AttentionItemDetail {
  return {
    kind: "approval",
    approvalType: type,
    summaryExcerpt: excerpt(payload.summary ?? payload.title ?? payload.recommendedAction),
    images: [],
  };
}

function issueHref(prefix: string, issue: Pick<IssueSubjectRow, "id" | "identifier">) {
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function issueSubject(prefix: string, issue: IssueSubjectRow): AttentionSubject {
  return {
    kind: "issue",
    id: issue.id,
    companyId: issue.companyId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.boardPresentationStatus,
    href: issueHref(prefix, issue),
    metadata: {
      priority: issue.priority,
      ownerAgentId: issue.ownerAgentId,
      ownerUserId: issue.ownerUserId,
    },
  };
}

function itemId(sourceKind: AttentionSourceKind, dedupKey: string) {
  return `${sourceKind}:${dedupKey}`;
}

function decisionVerbs(...verbs: AttentionDecisionVerb[]): AttentionDecisionVerb[] {
  return verbs;
}

type CreateAttentionItemInput = Omit<AttentionItem, "id" | "dismissalKey" | "rank" | "dismissal" | "project" | "workspace" | "detail" | "trainingExampleId"> & {
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
  } as AttentionItem;
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem) {
  const timeDiff = timestamp(right.activityAt) - timestamp(left.activityAt);
  if (timeDiff !== 0) return timeDiff;
  const severityDiff = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  const sourceDiff = SOURCE_RANK[left.sourceKind] - SOURCE_RANK[right.sourceKind];
  if (sourceDiff !== 0) return sourceDiff;
  return left.dedupKey.localeCompare(right.dedupKey);
}

function betterDuplicate(left: AttentionItem, right: AttentionItem) {
  return compareAttentionItems(left, right) <= 0 ? left : right;
}

function approvalTitle(type: string, payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) return title;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  return type.replaceAll("_", " ");
}

const ZERO_MONEY_AMOUNT = parseMoneyAmount("0");

function decimalParts(value: MoneyAmount) {
  const [integer, fraction = ""] = value.split(".");
  return { units: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function budgetObservedPercent(observedAmount: MoneyAmount, limitAmount: MoneyAmount) {
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

async function companyPrefix(db: Db, companyId: string) {
  const row = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return row?.issuePrefix ?? "PAP";
}

async function dismissalByKey(db: Db, companyId: string, userId: string | null | undefined) {
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
  return new Map(rows.map((row) => [row.itemKey, {
    kind: row.kind,
    dismissedAt: row.dismissedAt,
    snoozedUntil: row.snoozedUntil,
  }]));
}

async function issueSummaryMap(
  db: Db,
  companyId: string,
  issueIds: Array<string | null | undefined>,
  options: { includeHidden?: boolean } = {},
) {
  const ids = [...new Set(issueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, IssueSummaryRow>();
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      boardPresentationStatus: issues.boardPresentationStatus,
      priority: issues.priority,
      ownerAgentId: issues.ownerAgentId,
      ownerUserId: issues.ownerUserId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      projectId: projects.id,
      projectName: projects.name,
      projectColor: projects.color,
      projectIcon: projects.icon,
    })
    .from(issues)
    .leftJoin(projects, and(eq(issues.projectId, projects.id), eq(projects.companyId, companyId)))
    .where(and(
      eq(issues.companyId, companyId),
      inArray(issues.id, ids),
      options.includeHidden ? undefined : isNull(issues.hiddenAt),
    ));
  return new Map(rows.map((row) => [row.id, {
    id: row.id,
    companyId: row.companyId,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus: row.boardPresentationStatus,
    priority: row.priority,
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    project: row.projectId && row.projectName ? {
      id: row.projectId,
      name: row.projectName,
      urlKey: deriveProjectUrlKey(row.projectName, row.projectId),
      color: row.projectColor,
      icon: row.projectIcon,
    } : null,
    workspace: null,
  }]));
}

async function issueImageMap(db: Db, companyId: string, issueIds: Array<string | null | undefined>) {
  const ids = [...new Set(issueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, AttentionDetailImage[]>();
  const rows = await db
    .select({
      issueId: issueAttachments.issueId,
      assetId: issueAttachments.assetId,
      originalFilename: assets.originalFilename,
    })
    .from(issueAttachments)
    .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
    .where(and(
      eq(issueAttachments.companyId, companyId),
      eq(assets.companyId, companyId),
      inArray(issueAttachments.issueId, ids),
      sql`${assets.contentType} like 'image/%'`,
    ))
    .orderBy(asc(issueAttachments.issueId), asc(issueAttachments.createdAt), asc(issueAttachments.id));

  const map = new Map<string, AttentionDetailImage[]>();
  for (const row of rows) {
    const images = map.get(row.issueId) ?? [];
    if (images.length >= DETAIL_IMAGE_LIMIT) continue;
    images.push({ assetId: row.assetId, alt: row.originalFilename ?? null });
    map.set(row.issueId, images);
  }
  return map;
}

export function attentionService(db: Db) {
  return {
    list: async (companyId: string, options: AttentionListOptions = {}): Promise<AttentionFeed> => {
      const prefix = await companyPrefix(db, companyId);
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
        const dismissal = activeDismissalState(dismissals, item.dismissalKey, item.activityAt, now);
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
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.updatedAt), desc(approvals.id));

      const pendingApprovalIds = pendingApprovals.map((approval) => approval.id);
      const approvalIssueRows = pendingApprovalIds.length > 0
        ? await db
          .select({ approvalId: issueApprovals.approvalId, issueId: issueApprovals.issueId })
          .from(issueApprovals)
          .where(and(
            eq(issueApprovals.companyId, companyId),
            inArray(issueApprovals.approvalId, pendingApprovalIds),
          ))
          .orderBy(asc(issueApprovals.approvalId), asc(issueApprovals.issueId))
        : [];
      const approvalIssueMap = new Map<string, string>();
      for (const row of approvalIssueRows) {
        if (!approvalIssueMap.has(row.approvalId)) approvalIssueMap.set(row.approvalId, row.issueId);
      }

      for (const approval of pendingApprovals) {
        const dedupKey = `approval:${approval.id}`;
        const title = approvalTitle(approval.type, approval.payload);
        add(createItem({
          companyId,
          sourceKind: "approval",
          subject: {
            kind: "approval",
            id: approval.id,
            companyId,
            title,
            identifier: null,
            status: approval.status,
            href: `/${prefix}/approvals/${approval.id}`,
            metadata: {
              type: approval.type,
              requestedByAgentId: approval.requestedByAgentId,
              requestedByUserId: approval.requestedByUserId,
              issueId: approvalIssueMap.get(approval.id) ?? null,
            },
          },
          whyNow: "Approval is pending a board decision.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve the request." },
            { id: "reject", label: "Reject", description: "Reject the request." },
            { id: "request_revision", label: "Request revision", description: "Send the request back for changes." },
          ),
          inlineResolvable: approval.type !== "request_board_approval",
          entryRule: "approvals.status = 'pending'",
          exitRule: "Approval leaves pending status.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(approval.updatedAt),
          createdAt: toIso(approval.createdAt),
          updatedAt: toIso(approval.updatedAt),
          relatedIssue: null,
          detail: approvalDetail(approval.type, approval.payload),
        }));
      }


      const pendingJoins = await db
        .select({
          id: joinRequests.id,
          requestType: joinRequests.requestType,
          status: joinRequests.status,
          requestingUserId: joinRequests.requestingUserId,
          requestEmailSnapshot: joinRequests.requestEmailSnapshot,
          agentName: joinRequests.agentName,
          adapterType: joinRequests.adapterType,
          createdAt: joinRequests.createdAt,
          updatedAt: joinRequests.updatedAt,
        })
        .from(joinRequests)
        .innerJoin(invites, eq(joinRequests.inviteId, invites.id))
        .where(and(
          eq(joinRequests.companyId, companyId),
          eq(invites.companyId, companyId),
          eq(joinRequests.status, "pending_approval"),
        ))
        .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.id));

      for (const join of pendingJoins) {
        const label = join.requestType === "agent"
          ? join.agentName ?? "Agent join request"
          : join.requestEmailSnapshot ?? join.requestingUserId ?? "Human join request";
        const dedupKey = `join:${join.id}`;
        add(createItem({
          companyId,
          sourceKind: "join_request",
          subject: {
            kind: "join_request",
            id: join.id,
            companyId,
            title: label,
            identifier: null,
            status: join.status,
            href: `/${prefix}/settings/access`,
            metadata: {
              requestType: join.requestType,
              requestingUserId: join.requestingUserId,
              adapterType: join.adapterType,
            },
          },
          whyNow: "Join request is pending approval.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve this join request." },
            { id: "reject", label: "Reject", description: "Reject this join request." },
          ),
          inlineResolvable: true,
          entryRule: "join_requests.status = 'pending_approval'",
          exitRule: "Join request is approved or rejected.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(join.updatedAt),
          createdAt: toIso(join.createdAt),
          updatedAt: toIso(join.updatedAt),
          relatedIssue: null,
          detail: genericDetail(label, []),
        }));
      }

      const reviewRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          priority: issues.priority,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
          executionState: issues.executionState,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.boardPresentationStatus, "in_review"), isNull(issues.hiddenAt)))
        .orderBy(desc(issues.updatedAt), desc(issues.id));
      const reviewIssueIds = reviewRows.map((row) => row.id);
      const pendingReviewApprovalRows = reviewIssueIds.length === 0
        ? []
        : await db
          .select({ issueId: issueApprovals.issueId, approvalId: approvals.id })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(and(
            eq(issueApprovals.companyId, companyId),
            eq(approvals.companyId, companyId),
            inArray(issueApprovals.issueId, reviewIssueIds),
            eq(approvals.status, "pending"),
          ));
      const pendingApprovalByIssueId = new Map(pendingReviewApprovalRows.map((row) => [row.issueId, row.approvalId]));
      const reviewIssueMap = await issueSummaryMap(db, companyId, reviewIssueIds);
      const reviewImageMap = await issueImageMap(db, companyId, reviewIssueIds);

      for (const review of reviewRows) {
        const state = parseIssueExecutionState(review.executionState);
        const currentParticipant = state?.status === "pending" ? state.currentParticipant : null;
        const hasHumanParticipant = currentParticipant?.type === "user";
        const pendingApprovalId = pendingApprovalByIssueId.get(review.id) ?? null;
        if (!hasHumanParticipant && !review.ownerUserId && !pendingApprovalId) continue;
        const issue = reviewIssueMap.get(review.id);
        if (!issue) continue;
        const dedupKey = `review:${review.id}`;
        add(createItem({
          companyId,
          sourceKind: "review",
          subject: issueSubject(prefix, issue),
          whyNow: pendingApprovalId
            ? "Issue is in review with a linked pending approval."
            : hasHumanParticipant
              ? "Issue is in review and the current execution participant is a user."
              : "Issue is in review and owned by a user.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve the review and advance the issue." },
            { id: "request_changes", label: "Request changes", description: "Return the issue to its owner with changes requested." },
          ),
          inlineResolvable: false,
          entryRule: "issues.boardPresentationStatus = 'in_review' and human reviewer, user owner, or linked pending approval exists.",
          exitRule: "Issue leaves in_review or the human review path resolves.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(review.updatedAt),
          createdAt: toIso(review.createdAt),
          updatedAt: toIso(review.updatedAt),
          relatedIssue: null,
          ...issueContext(issue),
          detail: genericDetail(review.title, issueImages(reviewImageMap, review.id)),
        }));
      }

      const activeBoardMentions = await db
        .select({
          id: issueBoardMentions.id,
          issueId: issueBoardMentions.issueId,
          message: boardMentionComments.body,
          createdAt: issueBoardMentions.createdAt,
        })
        .from(issueBoardMentions)
        .innerJoin(
          boardMentionComments,
          and(
            eq(boardMentionComments.companyId, issueBoardMentions.companyId),
            eq(boardMentionComments.issueId, issueBoardMentions.issueId),
            eq(boardMentionComments.id, issueBoardMentions.commentId),
          ),
        )
        .innerJoin(
          issues,
          and(
            eq(issues.companyId, issueBoardMentions.companyId),
            eq(issues.id, issueBoardMentions.issueId),
            eq(issues.ownershipEpoch, issueBoardMentions.ownershipEpoch),
          ),
        )
        .where(and(
          eq(issueBoardMentions.companyId, companyId),
          isNull(issues.hiddenAt),
          inArray(issues.lifecycleStatus, ["open", "blocked"]),
          notExists(
            db
              .select({ id: issueBoardUserComments.id })
              .from(issueBoardUserComments)
              .innerJoin(
                boardReplyComments,
                and(
                  eq(boardReplyComments.companyId, issueBoardUserComments.companyId),
                  eq(boardReplyComments.issueId, issueBoardUserComments.issueId),
                  eq(boardReplyComments.id, issueBoardUserComments.commentId),
                ),
              )
              .where(and(
                eq(issueBoardUserComments.companyId, issueBoardMentions.companyId),
                eq(issueBoardUserComments.issueId, issueBoardMentions.issueId),
                eq(issueBoardUserComments.ownershipEpoch, issueBoardMentions.ownershipEpoch),
                eq(issueBoardUserComments.mentionTargetAgentId, issueBoardMentions.agentId),
                gt(boardReplyComments.projectedEventSeq, boardMentionComments.projectedEventSeq),
              )),
          ),
          notExists(
            db
              .select({ id: issueBoardReopenCommands.id })
              .from(issueBoardReopenCommands)
              .where(and(
                eq(issueBoardReopenCommands.companyId, issueBoardMentions.companyId),
                eq(issueBoardReopenCommands.issueId, issueBoardMentions.issueId),
                eq(issueBoardReopenCommands.ownershipEpoch, issueBoardMentions.ownershipEpoch),
                sql`${issueBoardReopenCommands.createdAt} >= ${issueBoardMentions.createdAt}`,
              )),
          ),
        ))
        .orderBy(desc(issueBoardMentions.createdAt), desc(issueBoardMentions.id));
      const boardMentionIssueMap = await issueSummaryMap(
        db,
        companyId,
        activeBoardMentions.map((mention) => mention.issueId),
      );
      const boardMentionImageMap = await issueImageMap(
        db,
        companyId,
        activeBoardMentions.map((mention) => mention.issueId),
      );
      for (const mention of activeBoardMentions) {
        const issue = boardMentionIssueMap.get(mention.issueId);
        if (!issue) continue;
        add(createItem({
          companyId,
          sourceKind: "mention_board",
          subject: issueSubject(prefix, issue),
          whyNow: "An agent requested information or direction from the Board.",
          decisionVerbs: decisionVerbs(
            { id: "reply_and_continue", label: "Reply & continue", description: "Reply to the agent and continue this issue." },
          ),
          inlineResolvable: false,
          entryRule: "An active agent Board mention exists for the current nonterminal issue ownership epoch.",
          exitRule: "A Board user resumes the exact owner/epoch, the issue is reopened, or the ownership epoch leaves scope.",
          dedupKey: `board-mention:${mention.id}`,
          severity: "medium",
          activityAt: toIso(mention.createdAt),
          createdAt: toIso(mention.createdAt),
          updatedAt: toIso(mention.createdAt),
          relatedIssue: null,
          ...issueContext(issue),
          detail: genericDetail(
            mention.message,
            issueImages(boardMentionImageMap, mention.issueId),
          ),
        }));
      }

      const budgetOverview = await budgetService(db).overview(companyId);
      for (const incident of budgetOverview.activeIncidents) {
        const observedPercent = budgetObservedPercent(incident.observedAmount, incident.limitAmount);
        if (incident.thresholdType !== "hard" && observedPercent < 85) continue;
        const dedupKey = `budget:${incident.policyId}:${toIso(incident.windowStart)}:${incident.thresholdType}`;
        add(createItem({
          companyId,
          sourceKind: "budget_alert",
          subject: {
            kind: "budget_incident",
            id: incident.id,
            companyId,
            title: `${incident.scopeName} budget ${incident.thresholdType === "hard" ? "hard stop" : "warning"}`,
            identifier: null,
            status: incident.status,
            href: `/${prefix}/costs`,
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
          whyNow: incident.thresholdType === "hard"
            ? "Budget hard stop was reached."
            : "Budget crossed the 85% warning threshold.",
          decisionVerbs: decisionVerbs(
            { id: "raise_budget_and_resume", label: "Raise budget", description: "Raise the budget and resume paused work." },
            { id: "keep_paused", label: "Keep paused", description: "Dismiss or keep the budget stop in place." },
          ),
          inlineResolvable: true,
          entryRule: "open budget incident is hard, or soft with observed spend >= 85% of limit.",
          exitRule: "Budget incident is resolved or dismissed.",
          dedupKey,
          severity: incident.thresholdType === "hard" ? "high" : "medium",
          activityAt: toIso(incident.updatedAt),
          createdAt: toIso(incident.createdAt),
          updatedAt: toIso(incident.updatedAt),
          relatedIssue: null,
          detail: {
            kind: "budget",
            observedPercent,
            budgetCurrency: incident.budgetCurrency,
            observedAmount: incident.observedAmount,
            limitAmount: incident.limitAmount,
            images: [],
          },
        }));
      }

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(item.dedupKey, current ? betterDuplicate(current, item) : item);
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
