import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  assets,
  companies,
  decisionTrainingExamples,
  inboxDismissals,
  invites,
  issueApprovals,
  issueAttachments,
  issueRelations,
  issues,
  joinRequests,
  projects,
  projectWorkspaces,
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
  IssueExecutionRunStatus,
} from "@paperclipai/shared";
import { budgetService } from "./budgets.js";
import {
  listActiveIssueLivenessAttentionRows,
} from "./issue-liveness-reconciliation.js";
import { issueService } from "./issues.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  listIssueExecutionRunsForActivity,
  type IssueExecutionRunEnvelope,
  type IssueExecutionRunListCursor,
} from "./issue-execution-run-service.js";

const ATTENTION_SOURCE_KINDS: AttentionSourceKind[] = [
  "approval",
  "join_request",
  "blocker_attention",
  "review",
  "failed_run",
  "budget_alert",
  "agent_error_alert",
  "agent_liveness",
];

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SOURCE_RANK: Record<AttentionSourceKind, number> = {
  failed_run: 0,
  blocker_attention: 1,
  budget_alert: 2,
  agent_liveness: 3,
  agent_error_alert: 4,
  approval: 5,
  review: 6,
  join_request: 7,
};

const FAILED_RUN_STATUSES = ["failed", "timed_out"] as const;
const DETAIL_EXCERPT_LENGTH = 160;
const DETAIL_IMAGE_LIMIT = 3;

async function listCompanyRuns(
  db: Db,
  companyId: string,
  statuses?: readonly IssueExecutionRunStatus[],
): Promise<IssueExecutionRunEnvelope[]> {
  const runs: IssueExecutionRunEnvelope[] = [];
  let cursor: IssueExecutionRunListCursor | null = null;
  do {
    const page = await listIssueExecutionRunsForActivity(db, {
      companyId,
      statuses,
      cursor,
      limit: 200,
    });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return runs;
}

async function listCompanyRunsCreatedAfter(
  db: Db,
  companyId: string,
  after: Date,
): Promise<IssueExecutionRunEnvelope[]> {
  const runs: IssueExecutionRunEnvelope[] = [];
  let cursor: IssueExecutionRunListCursor | null = null;
  let reachedBoundary = false;
  do {
    const page = await listIssueExecutionRunsForActivity(db, {
      companyId,
      cursor,
      limit: 200,
    });
    for (const run of page.items) {
      if (run.createdAt > after) runs.push(run);
      else reachedBoundary = true;
    }
    cursor = reachedBoundary ? null : page.nextCursor;
  } while (cursor !== null);
  return runs;
}

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

type BlockingIssueSummary = {
  id: string | null;
  identifier: string | null;
  title: string | null;
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
    trainingExampleId: null,
    rank: 0,
  };
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
      workspaceId: projectWorkspaces.id,
      workspaceName: projectWorkspaces.name,
    })
    .from(issues)
    .leftJoin(projects, and(eq(issues.projectId, projects.id), eq(projects.companyId, companyId)))
    .leftJoin(projectWorkspaces, and(
      eq(issues.projectWorkspaceId, projectWorkspaces.id),
      eq(projectWorkspaces.companyId, companyId),
    ))
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
    workspace: row.workspaceId && row.workspaceName ? {
      id: row.workspaceId,
      name: row.workspaceName,
    } : null,
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

async function blockingIssueMap(db: Db, companyId: string, blockedIssueIds: Array<string | null | undefined>) {
  const ids = [...new Set(blockedIssueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, BlockingIssueSummary>();
  const rows = await db
    .select({
      blockedIssueId: issueRelations.relatedIssueId,
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(and(
      eq(issueRelations.companyId, companyId),
      eq(issues.companyId, companyId),
      eq(issueRelations.type, "blocks"),
      inArray(issueRelations.relatedIssueId, ids),
      isNull(issues.hiddenAt),
    ))
    .orderBy(asc(issueRelations.relatedIssueId), asc(issueRelations.createdAt), asc(issueRelations.id));
  const map = new Map<string, BlockingIssueSummary>();
  for (const row of rows) {
    if (!map.has(row.blockedIssueId)) {
      map.set(row.blockedIssueId, { id: row.id, identifier: row.identifier, title: row.title });
    }
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

      const blockedIssues = await issueService(db).list(companyId, { status: "blocked", includeBlockedBy: true });
      const blockedIssueSummaries = await issueSummaryMap(db, companyId, blockedIssues.map((issue) => issue.id));
      const blockedImageMap = await issueImageMap(db, companyId, blockedIssues.map((issue) => issue.id));
      const blockingIssues = await blockingIssueMap(db, companyId, blockedIssues.map((issue) => issue.id));
      for (const canonicalIssue of blockedIssues) {
        const issue: IssueSubjectRow & {
          blockerAttention?: {
            state?: string;
            sampleStalledBlockerIdentifier?: string | null;
            sampleBlockerIdentifier?: string | null;
          } | null;
        } = canonicalIssue;
        const blockerAttention = issue.blockerAttention;
        if (blockerAttention?.state !== "stalled") continue;
        const issueSummary = blockedIssueSummaries.get(issue.id) ?? null;
        const summarizedIssue = issueSummary ?? issue;
        const sample = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier ?? issue.identifier ?? issue.id;
        const blockingIssue = blockingIssues.get(issue.id) ?? { id: null, identifier: sample, title: null };
        const dedupKey = `blocker:${issue.id}:${sample}`;
        add(createItem({
          companyId,
          sourceKind: "blocker_attention",
          subject: issueSubject(prefix, summarizedIssue),
          whyNow: "Blocked dependency chain is stalled and needs a human to choose the next owner or action.",
          decisionVerbs: decisionVerbs(
            { id: "unblock", label: "Unblock", description: "Repair or replace the stalled blocker path." },
            { id: "reassign", label: "Reassign", description: "Assign the stalled blocker to a live owner." },
            { id: "nudge", label: "Nudge", description: "Request a same-owner follow-up prompt." },
          ),
          inlineResolvable: false,
          entryRule: "blocked issue has blockerAttention.state = 'stalled'",
          exitRule: "Blocker chain is no longer stalled or the issue leaves blocked status.",
          dedupKey,
          severity: "high",
          activityAt: toIso(issue.updatedAt),
          createdAt: toIso(issue.createdAt),
          updatedAt: toIso(issue.updatedAt),
          relatedIssue: null,
          ...issueContext(issueSummary),
          detail: { kind: "blocker", blockingIssue, images: issueImages(blockedImageMap, issue.id) },
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

      const failedRunEnvelopes = await listCompanyRuns(
        db,
        companyId,
        FAILED_RUN_STATUSES,
      );
      const failedTargetAgentIds = [
        ...new Set(failedRunEnvelopes.map((run) => run.targetAgentId)),
      ];
      const failedTargetAgents = failedTargetAgentIds.length === 0
        ? []
        : await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(
            eq(agents.companyId, companyId),
            inArray(agents.id, failedTargetAgentIds),
            sql`${agents.status} <> 'terminated'`,
          ));
      const failedTargetAgentById = new Map(
        failedTargetAgents.map((agent) => [agent.id, agent]),
      );
      const exhaustedRunRows = failedRunEnvelopes.flatMap((run) => {
        const agent = failedTargetAgentById.get(run.targetAgentId);
        return agent
          ? [{
              id: run.runId,
              companyId: run.companyId,
              agentId: agent.id,
              agentName: agent.name,
              status: run.status,
              terminalReasonCode: run.terminalReasonCode,
              issueId: run.issueId,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              finishedAt: run.finishedAt,
            }]
          : [];
      });

      const latestExhaustedByRunId = new Map<string, (typeof exhaustedRunRows)[number]>();
      for (const row of exhaustedRunRows) {
        if (!latestExhaustedByRunId.has(row.id)) latestExhaustedByRunId.set(row.id, row);
      }
      const failedRows = [...latestExhaustedByRunId.values()];
      const failedIssueIds = failedRows.map((row) => row.issueId);
      const failedIssueMap = await issueSummaryMap(
        db,
        companyId,
        failedIssueIds,
      );
      const failedImageMap = await issueImageMap(db, companyId, failedIssueIds);
      const failedAgentIds = [...new Set(failedRows.map((row) => row.agentId))];
      const oldestFailedRunCreatedAt = failedRows.reduce<Date | null>((oldest, row) => {
        if (!oldest || row.createdAt < oldest) return row.createdAt;
        return oldest;
      }, null);
      const latestRunCreatedAtByKey = new Map<string, Date>();
      if (oldestFailedRunCreatedAt && failedAgentIds.length > 0) {
        const newerRuns = (await listCompanyRunsCreatedAfter(
          db,
          companyId,
          oldestFailedRunCreatedAt,
        )).filter((run) => failedAgentIds.includes(run.targetAgentId)).map((run) => ({
          agentId: run.targetAgentId,
          createdAt: run.createdAt,
          issueId: run.issueId,
        }));
        for (const newerRun of newerRuns) {
          const newerRunKey = `${newerRun.agentId}:${newerRun.issueId}`;
          const latestCreatedAt = latestRunCreatedAtByKey.get(newerRunKey);
          if (!latestCreatedAt || newerRun.createdAt > latestCreatedAt) {
            latestRunCreatedAtByKey.set(newerRunKey, newerRun.createdAt);
          }
        }
      }
      for (const run of failedRows) {
        const issueId = run.issueId;
        const runKey = `${run.agentId}:${issueId}`;
        const hasNewerRun = (latestRunCreatedAtByKey.get(runKey)?.getTime() ?? 0) > run.createdAt.getTime();
        if (hasNewerRun) continue;

        const issue = failedIssueMap.get(issueId) ?? null;
        const dedupKey = `run:${run.id}`;
        add(createItem({
          companyId,
          sourceKind: "failed_run",
          subject: {
            kind: "run",
            id: run.id,
            companyId,
            title: `${run.agentName} run ${run.status}`,
            identifier: null,
            status: run.status,
            href: `/${prefix}/agents/${run.agentId}/runs/${run.id}`,
            metadata: {
              agentId: run.agentId,
              agentName: run.agentName,
              issueId,
              terminalReasonCode: run.terminalReasonCode,
            },
          },
          whyNow: "The latest run for this issue and agent failed.",
          decisionVerbs: decisionVerbs(
            { id: "retry", label: "Retry", description: "Retry the failed run or issue." },
            { id: "reassign", label: "Reassign", description: "Move the work to another owner." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this failed-run attention row." },
          ),
          inlineResolvable: true,
          entryRule: "latest productive/consult run for the issue and agent is failed or timed_out.",
          exitRule: "A newer run exists for the same issue/agent pair or the row is dismissed.",
          dedupKey,
          severity: "high",
          activityAt: toIso(run.finishedAt ?? run.updatedAt ?? run.createdAt),
          createdAt: toIso(run.createdAt),
          updatedAt: toIso(run.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          ...issueContext(issue),
          detail: {
            kind: "failed_run",
            agentName: run.agentName,
            failureReasonExcerpt: excerpt(run.terminalReasonCode),
            images: issueImages(failedImageMap, issueId),
          },
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

      const erroredAgents = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          status: agents.status,
          errorReason: agents.errorReason,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.status, "error")))
        .orderBy(desc(agents.updatedAt), desc(agents.id));

      for (const agent of erroredAgents) {
        const dedupKey = `agent_error:${agent.id}`;
        add(createItem({
          companyId,
          sourceKind: "agent_error_alert",
          subject: {
            kind: "agent",
            id: agent.id,
            companyId,
            title: agent.name,
            identifier: null,
            status: agent.status,
            href: `/${prefix}/agents/${agent.id}`,
            metadata: { errorReason: agent.errorReason },
          },
          whyNow: "Agent is in error status and needs operator action or dismissal.",
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Inspect the agent error." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this alert." },
          ),
          inlineResolvable: true,
          entryRule: "agents.status = 'error'",
          exitRule: "Agent leaves error status or the row is dismissed.",
          dedupKey,
          severity: "high",
          activityAt: toIso(agent.updatedAt),
          createdAt: toIso(agent.createdAt),
          updatedAt: toIso(agent.updatedAt),
          relatedIssue: null,
          detail: {
            kind: "agent_error",
            agentName: agent.name,
            failureReasonExcerpt: excerpt(agent.errorReason),
            images: [],
          },
        }));
      }

      const livenessRows = await listActiveIssueLivenessAttentionRows(
        db,
        companyId,
      );
      const livenessIssueMap = await issueSummaryMap(
        db,
        companyId,
        livenessRows.map((row) => row.issueId),
        { includeHidden: true },
      );
      for (const reconciliation of livenessRows) {
        const issue = livenessIssueMap.get(reconciliation.issueId);
        if (!issue || !reconciliation.boardAttentionEmittedAt) continue;
        const dedupKey = `agent-liveness:${reconciliation.issueId}:${reconciliation.ownershipEpoch}:${reconciliation.frontierFinalizationId}`;
        const whyNow = reconciliation.boardAttentionReason === "agent_unavailable"
          ? "The same agent is unavailable and no continuation or lifecycle action was named."
          : reconciliation.boardAttentionReason === "agent_followup_failed"
            ? "The same-agent follow-up failed before naming a continuation or lifecycle action."
            : "The same-agent follow-up finished without naming a continuation or lifecycle action.";
        add(createItem({
          companyId,
          sourceKind: "agent_liveness",
          subject: issueSubject(prefix, issue),
          whyNow,
          decisionVerbs: [],
          inlineResolvable: false,
          entryRule: "A post-finalization liveness reconciliation emitted board Attention and has no accepted exit action.",
          exitRule: "A checked explicit same-issue work or lifecycle action records the reconciliation exit.",
          dedupKey,
          severity: "high",
          activityAt: toIso(reconciliation.boardAttentionEmittedAt),
          createdAt: toIso(reconciliation.admittedAt),
          updatedAt: toIso(reconciliation.boardAttentionEmittedAt),
          relatedIssue: issueSubject(prefix, issue),
          ...issueContext(issue),
          detail: genericDetail(whyNow, []),
        }), { suppressible: false });
      }

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(item.dedupKey, current ? betterDuplicate(current, item) : item);
      }

      const items = [...deduped.values()]
        .sort(compareAttentionItems)
        .map((item, index) => ({ ...item, rank: index + 1 }));
      if (options.userId) {
        const trainable: Array<{ sourceKind: "approval"; sourceId: string }> = [];
        for (const item of items) {
          if (item.sourceKind === "approval") {
            trainable.push({ sourceKind: "approval", sourceId: item.subject.id });
          }
        }
        if (trainable.length > 0) {
          const examples = await db
            .select({
              id: decisionTrainingExamples.id,
              sourceKind: decisionTrainingExamples.sourceKind,
              sourceId: decisionTrainingExamples.sourceId,
            })
            .from(decisionTrainingExamples)
            .where(and(
              eq(decisionTrainingExamples.companyId, companyId),
              eq(decisionTrainingExamples.createdByUserId, options.userId),
              inArray(decisionTrainingExamples.sourceId, trainable.map((item) => item.sourceId)),
            ));
          const exampleBySource = new Map(examples.map((row) => [`${row.sourceKind}:${row.sourceId}`, row.id]));
          for (const item of items) {
            const sourceKind = item.sourceKind === "approval" ? "approval" : null;
            item.trainingExampleId = sourceKind
              ? exampleBySource.get(`${sourceKind}:${item.subject.id}`) ?? null
              : null;
          }
        }
      }
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
