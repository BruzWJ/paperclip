import { Router } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  authUsers,
  companyMemberships,
  companies,
  costEvents,
  issueComments,
  issues,
} from "@paperclipai/db";
import type {
  UserProfileDailyPoint,
  UserProfileIdentity,
  UserProfileResponse,
  UserProfileWindowStats,
} from "@paperclipai/shared";
import {
  canonicalizeMoneyAmount,
  parseBudgetCurrency,
  parseMoneyAmount,
  type MoneyAmount,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { visibleIssueCondition } from "../services/issue-visibility.js";
import { assertCompanyAccess } from "./authz.js";

type CompanyUserRow = {
  id: string;
  principalId: string;
  status: string;
  membershipRole: string | null;
  createdAt: Date;
  userId: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
};

const PROFILE_WINDOWS = [
  { key: "last7", label: "Last 7 days", days: 7 },
  { key: "last30", label: "Last 30 days", days: 30 },
  { key: "all", label: "All time", days: null },
] as const;

function slugifyUserPart(value: string | null | undefined) {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function userSlugCandidates(row: CompanyUserRow) {
  const candidates = new Set<string>();
  const add = (value: string | null | undefined) => {
    const slug = slugifyUserPart(value);
    if (slug) candidates.add(slug);
  };
  add(row.name);
  add(row.email?.split("@")[0]);
  add(row.email);
  add(row.principalId);
  return [...candidates];
}

async function resolveCompanyUser(db: Db, companyId: string, rawSlug: string): Promise<CompanyUserRow | null> {
  const slug = slugifyUserPart(rawSlug);
  if (!slug) return null;

  const rows = await db
    .select({
      id: companyMemberships.id,
      principalId: companyMemberships.principalUserId,
      status: companyMemberships.status,
      membershipRole: companyMemberships.membershipRole,
      createdAt: companyMemberships.createdAt,
      userId: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      image: authUsers.image,
    })
    .from(companyMemberships)
    .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalUserId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
      ),
    )
    .orderBy(desc(companyMemberships.updatedAt))
    .limit(200);

  return rows.find(
    (row): row is CompanyUserRow =>
      typeof row.principalId === "string"
      && userSlugCandidates(row as CompanyUserRow).includes(slug),
  ) ?? null;
}

function userIssueInvolvementSql(companyId: string, userId: string) {
  return sql<boolean>`
    (
      (${issues.creatorKind} = 'user/board' AND ${issues.creatorUserId} = ${userId})
      OR ${issues.ownerUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.companyId} = ${companyId}
          AND ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function windowStart(days: number | null) {
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date) {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

function dayKeyExpr(dateSql: ReturnType<typeof sql>) {
  return sql<string>`to_char(date_trunc('day', ${dateSql}), 'YYYY-MM-DD')`;
}

const ZERO_AMOUNT = parseMoneyAmount("0");

function trustedAmount(value: string | null | undefined): MoneyAmount {
  return canonicalizeMoneyAmount(value ?? "0");
}

function costAggregateSelection() {
  return {
    knownCostAmount:
      sql<string>`coalesce(sum(${costEvents.knownDeltaAmount}) filter (where ${costEvents.kind} = 'known'), 0)::text`,
    pricedPromptCount:
      sql<number>`count(*) filter (where ${costEvents.kind} = 'known')::int`,
    unpricedPromptCount:
      sql<number>`count(*) filter (where ${costEvents.kind} = 'unavailable')::int`,
  };
}

async function loadWindowStats(
  db: Db,
  companyId: string,
  userId: string,
  key: UserProfileWindowStats["key"],
  label: string,
  from: Date | null,
): Promise<UserProfileWindowStats> {
  const involvement = userIssueInvolvementSql(companyId, userId);
  const openStatuses = ["backlog", "todo", "in_progress", "in_review", "blocked"];
  const fromIso = from?.toISOString();

  const [issueStats] = await db
    .select({
      touchedIssues: sql<number>`count(distinct case when ${involvement} ${fromIso ? sql`and ${issues.updatedAt} >= ${fromIso}` : sql``} then ${issues.id} end)::int`,
      createdIssues: sql<number>`count(distinct case when ${issues.creatorKind} = 'user/board' and ${issues.creatorUserId} = ${userId} ${fromIso ? sql`and ${issues.createdAt} >= ${fromIso}` : sql``} then ${issues.id} end)::int`,
      completedIssues: sql<number>`count(distinct case when ${involvement} and ${issues.boardPresentationStatus} = 'done' ${fromIso ? sql`and ${issues.completedAt} >= ${fromIso}` : sql``} then ${issues.id} end)::int`,
      assignedOpenIssues: sql<number>`count(distinct case when ${issues.ownerUserId} = ${userId} and ${issues.boardPresentationStatus} in (${sql.join(openStatuses.map((status) => sql`${status}`), sql`, `)}) then ${issues.id} end)::int`,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), visibleIssueCondition()));

  const commentConditions = [
    eq(issueComments.companyId, companyId),
    eq(issueComments.authorUserId, userId),
  ];
  if (from) commentConditions.push(gte(issueComments.createdAt, from));
  const [commentStats] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issueComments)
    .where(and(...commentConditions));

  const activityConditions = [
    eq(activityLog.companyId, companyId),
    eq(activityLog.actorType, "user"),
    eq(activityLog.actorId, userId),
  ];
  if (from) activityConditions.push(gte(activityLog.createdAt, from));
  const [activityStats] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(and(...activityConditions));

  const costConditions = [
    eq(costEvents.companyId, companyId),
    userIssueInvolvementSql(companyId, userId),
  ];
  if (from) costConditions.push(gte(costEvents.occurredAt, from));
  const [costStats] = await db
    .select({
      ...costAggregateSelection(),
    })
    .from(costEvents)
    .innerJoin(issues, and(eq(issues.id, costEvents.issueId), eq(issues.companyId, costEvents.companyId)))
    .where(and(...costConditions));

  return {
    key,
    label,
    touchedIssues: Number(issueStats?.touchedIssues ?? 0),
    createdIssues: Number(issueStats?.createdIssues ?? 0),
    completedIssues: Number(issueStats?.completedIssues ?? 0),
    assignedOpenIssues: Number(issueStats?.assignedOpenIssues ?? 0),
    commentCount: Number(commentStats?.count ?? 0),
    activityCount: Number(activityStats?.count ?? 0),
    knownCostAmount: trustedAmount(costStats?.knownCostAmount),
    pricedPromptCount: Number(costStats?.pricedPromptCount ?? 0),
    unpricedPromptCount: Number(costStats?.unpricedPromptCount ?? 0),
  };
}

async function loadDailyStats(db: Db, companyId: string, userId: string): Promise<UserProfileDailyPoint[]> {
  const firstDay = startOfUtcDay(new Date(Date.now() - 13 * 24 * 60 * 60 * 1000));
  const points = new Map<string, UserProfileDailyPoint>();
  for (let index = 0; index < 14; index += 1) {
    const date = new Date(firstDay.getTime() + index * 24 * 60 * 60 * 1000);
    points.set(isoDay(date), {
      date: isoDay(date),
      activityCount: 0,
      completedIssues: 0,
      knownCostAmount: ZERO_AMOUNT,
      pricedPromptCount: 0,
      unpricedPromptCount: 0,
    });
  }

  const activityDay = dayKeyExpr(sql`${activityLog.createdAt}`);
  const activityRows = await db
    .select({
      date: activityDay,
      count: sql<number>`count(*)::int`,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.actorType, "user"),
        eq(activityLog.actorId, userId),
        gte(activityLog.createdAt, firstDay),
      ),
    )
    .groupBy(activityDay);

  for (const row of activityRows) {
    const point = points.get(row.date);
    if (point) point.activityCount = Number(row.count);
  }

  const completedDay = dayKeyExpr(sql`${issues.completedAt}`);
  const completedRows = await db
    .select({
      date: completedDay,
      count: sql<number>`count(distinct ${issues.id})::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        visibleIssueCondition(),
        eq(issues.boardPresentationStatus, "done"),
        gte(issues.completedAt, firstDay),
        userIssueInvolvementSql(companyId, userId),
      ),
    )
    .groupBy(completedDay);

  for (const row of completedRows) {
    const point = points.get(row.date);
    if (point) point.completedIssues = Number(row.count);
  }

  const costDay = dayKeyExpr(sql`${costEvents.occurredAt}`);
  const costRows = await db
    .select({
      date: costDay,
      ...costAggregateSelection(),
    })
    .from(costEvents)
    .innerJoin(issues, and(eq(issues.id, costEvents.issueId), eq(issues.companyId, costEvents.companyId)))
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, firstDay),
        userIssueInvolvementSql(companyId, userId),
      ),
    )
    .groupBy(costDay);

  for (const row of costRows) {
    const point = points.get(row.date);
    if (!point) continue;
    point.knownCostAmount = trustedAmount(row.knownCostAmount);
    point.pricedPromptCount = Number(row.pricedPromptCount);
    point.unpricedPromptCount = Number(row.unpricedPromptCount);
  }

  return [...points.values()];
}

export function userProfileRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/users/:userSlug/profile", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userSlug = req.params.userSlug as string;
    assertCompanyAccess(req, companyId);

    const row = await resolveCompanyUser(db, companyId, userSlug);
    if (!row) throw notFound("User not found");
    const canonicalSlug = userSlugCandidates(row)[0] ?? row.principalId;
    const userId = row.userId ?? row.principalId;
    const companyAccounting = await db
      .select({ budgetCurrency: companies.budgetCurrency })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!companyAccounting) throw notFound("Company not found");

    const [stats, daily, recentIssues, recentActivity, topAgents] = await Promise.all([
      Promise.all(
        PROFILE_WINDOWS.map((entry) =>
          loadWindowStats(db, companyId, userId, entry.key, entry.label, windowStart(entry.days)),
        ),
      ),
      loadDailyStats(db, companyId, userId),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          boardPresentationStatus: issues.boardPresentationStatus,
          priority: issues.priority,
          ownerAgentId: issues.ownerAgentId,
          ownerUserId: issues.ownerUserId,
          updatedAt: issues.updatedAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            visibleIssueCondition(),
            userIssueInvolvementSql(companyId, userId),
          ),
        )
        .orderBy(desc(issues.updatedAt))
        .limit(8),
      db
        .select({
          id: activityLog.id,
          action: activityLog.action,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.actorType, "user"),
            eq(activityLog.actorId, userId),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(12),
      db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          ...costAggregateSelection(),
        })
        .from(costEvents)
        .innerJoin(issues, and(eq(issues.id, costEvents.issueId), eq(issues.companyId, costEvents.companyId)))
        .leftJoin(agents, eq(agents.id, costEvents.agentId))
        .where(and(eq(costEvents.companyId, companyId), userIssueInvolvementSql(companyId, userId)))
        .groupBy(costEvents.agentId, agents.name)
        .orderBy(
          desc(
            sql`coalesce(sum(${costEvents.knownDeltaAmount}) filter (where ${costEvents.kind} = 'known'), 0)`,
          ),
        )
        .limit(5),
    ]);

    const user: UserProfileIdentity = {
      id: userId,
      slug: canonicalSlug,
      name: row.name,
      email: row.email,
      image: row.image,
      membershipRole: row.membershipRole,
      membershipStatus: row.status,
      joinedAt: row.createdAt,
    };

    const payload: UserProfileResponse = {
      user,
      budgetCurrency: parseBudgetCurrency(companyAccounting.budgetCurrency),
      stats,
      daily,
      recentIssues: recentIssues.map((issue) => ({
        ...issue,
        boardPresentationStatus:
          issue.boardPresentationStatus as UserProfileResponse["recentIssues"][number]["boardPresentationStatus"],
        priority: issue.priority as UserProfileResponse["recentIssues"][number]["priority"],
      })),
      recentActivity,
      topAgents: topAgents.map((entry) => ({
        ...entry,
        knownCostAmount: trustedAmount(entry.knownCostAmount),
        pricedPromptCount: Number(entry.pricedPromptCount),
        unpricedPromptCount: Number(entry.unpricedPromptCount),
      })),
    };

    res.json(payload);
  });

  return router;
}
