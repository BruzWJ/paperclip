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
  taskComments,
  tasks,
} from "@paperclipai/db";
import type {
  UserProfileDailyPoint,
  UserProfileIdentity,
  UserProfileResponse,
  UserProfileWindowStats,
} from "@paperclipai/shared";
import {
  authUserIdSchema,
  canonicalizeMoneyAmount,
  parseBudgetCurrency,
  parseMoneyAmount,
  type MoneyAmount,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { visibleTaskCondition } from "../services/task-visibility.js";
import { requireUserRole } from "../services/company-member-roles.js";
import { assertCompanyAccess } from "./authz.js";

type CompanyUserRow = {
  userId: string;
  status: string;
  membershipRole: string | null;
  createdAt: Date;
  name: string | null;
  email: string | null;
  image: string | null;
};

const PROFILE_WINDOWS = [
  { key: "last7", label: "Last 7 days", days: 7 },
  { key: "last30", label: "Last 30 days", days: 30 },
  { key: "all", label: "All time", days: null },
] as const;

async function getCompanyUserById(
  db: Db,
  companyId: string,
  userId: string,
): Promise<CompanyUserRow | null> {
  return db
    .select({
      userId: authUsers.id,
      status: companyMemberships.status,
      membershipRole: companyMemberships.membershipRole,
      createdAt: companyMemberships.createdAt,
      name: authUsers.name,
      email: authUsers.email,
      image: authUsers.image,
    })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalUserId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalUserId, userId),
        eq(authUsers.id, userId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

function userTaskInvolvementSql(companyId: string, userId: string) {
  return sql<boolean>`
    (
      (${tasks.creatorKind} = 'user/board' AND ${tasks.creatorUserId} = ${userId})
      OR ${tasks.ownerUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${taskComments}
        WHERE ${taskComments.companyId} = ${companyId}
          AND ${taskComments.taskId} = ${tasks.id}
          AND ${taskComments.authorUserId} = ${userId}
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
  const involvement = userTaskInvolvementSql(companyId, userId);
  const openStatuses = ["backlog", "todo", "in_progress", "in_review", "blocked"];
  const fromIso = from?.toISOString();

  const [taskStats] = await db
    .select({
      touchedTasks: sql<number>`count(distinct case when ${involvement} ${fromIso ? sql`and ${tasks.updatedAt} >= ${fromIso}` : sql``} then ${tasks.id} end)::int`,
      createdTasks: sql<number>`count(distinct case when ${tasks.creatorKind} = 'user/board' and ${tasks.creatorUserId} = ${userId} ${fromIso ? sql`and ${tasks.createdAt} >= ${fromIso}` : sql``} then ${tasks.id} end)::int`,
      completedTasks: sql<number>`count(distinct case when ${involvement} and ${tasks.boardPresentationStatus} = 'done' ${fromIso ? sql`and ${tasks.completedAt} >= ${fromIso}` : sql``} then ${tasks.id} end)::int`,
      assignedOpenTasks: sql<number>`count(distinct case when ${tasks.ownerUserId} = ${userId} and ${tasks.boardPresentationStatus} in (${sql.join(openStatuses.map((status) => sql`${status}`), sql`, `)}) then ${tasks.id} end)::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), visibleTaskCondition()));

  const commentConditions = [
    eq(taskComments.companyId, companyId),
    eq(taskComments.authorUserId, userId),
  ];
  if (from) commentConditions.push(gte(taskComments.createdAt, from));
  const [commentStats] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskComments)
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
    userTaskInvolvementSql(companyId, userId),
  ];
  if (from) costConditions.push(gte(costEvents.occurredAt, from));
  const [costStats] = await db
    .select({
      ...costAggregateSelection(),
    })
    .from(costEvents)
    .innerJoin(tasks, and(eq(tasks.id, costEvents.taskId), eq(tasks.companyId, costEvents.companyId)))
    .where(and(...costConditions));

  return {
    key,
    label,
    touchedTasks: Number(taskStats?.touchedTasks ?? 0),
    createdTasks: Number(taskStats?.createdTasks ?? 0),
    completedTasks: Number(taskStats?.completedTasks ?? 0),
    assignedOpenTasks: Number(taskStats?.assignedOpenTasks ?? 0),
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
      completedTasks: 0,
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

  const completedDay = dayKeyExpr(sql`${tasks.completedAt}`);
  const completedRows = await db
    .select({
      date: completedDay,
      count: sql<number>`count(distinct ${tasks.id})::int`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, companyId),
        visibleTaskCondition(),
        eq(tasks.boardPresentationStatus, "done"),
        gte(tasks.completedAt, firstDay),
        userTaskInvolvementSql(companyId, userId),
      ),
    )
    .groupBy(completedDay);

  for (const row of completedRows) {
    const point = points.get(row.date);
    if (point) point.completedTasks = Number(row.count);
  }

  const costDay = dayKeyExpr(sql`${costEvents.occurredAt}`);
  const costRows = await db
    .select({
      date: costDay,
      ...costAggregateSelection(),
    })
    .from(costEvents)
    .innerJoin(tasks, and(eq(tasks.id, costEvents.taskId), eq(tasks.companyId, costEvents.companyId)))
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, firstDay),
        userTaskInvolvementSql(companyId, userId),
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
  const router = Router({ caseSensitive: true, strict: true });

  router.get("/companies/:companyId/users/:userId/profile", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsedUserId = authUserIdSchema.safeParse(req.params.userId);
    if (!parsedUserId.success) {
      throw badRequest(
        "User ID must be an exact non-empty value without surrounding whitespace",
      );
    }
    const userId = parsedUserId.data;

    const row = await getCompanyUserById(db, companyId, userId);
    if (!row) throw notFound("User not found");
    const companyAccounting = await db
      .select({ budgetCurrency: companies.budgetCurrency })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!companyAccounting) throw notFound("Company not found");

    const [stats, daily, recentTasks, recentActivity, topAgents] = await Promise.all([
      Promise.all(
        PROFILE_WINDOWS.map((entry) =>
          loadWindowStats(db, companyId, userId, entry.key, entry.label, windowStart(entry.days)),
        ),
      ),
      loadDailyStats(db, companyId, userId),
      db
        .select({
          id: tasks.id,
          taskNumber: tasks.taskNumber,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          priority: tasks.priority,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
          updatedAt: tasks.updatedAt,
          completedAt: tasks.completedAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            visibleTaskCondition(),
            userTaskInvolvementSql(companyId, userId),
          ),
        )
        .orderBy(desc(tasks.updatedAt))
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
        .innerJoin(tasks, and(eq(tasks.id, costEvents.taskId), eq(tasks.companyId, costEvents.companyId)))
        .leftJoin(agents, eq(agents.id, costEvents.agentId))
        .where(and(eq(costEvents.companyId, companyId), userTaskInvolvementSql(companyId, userId)))
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
      name: row.name,
      email: row.email,
      image: row.image,
      membershipRole: requireUserRole(row.membershipRole),
      membershipStatus: row.status,
      joinedAt: row.createdAt,
    };

    const payload: UserProfileResponse = {
      user,
      budgetCurrency: parseBudgetCurrency(companyAccounting.budgetCurrency),
      stats,
      daily,
      recentTasks: recentTasks.map((task) => ({
        ...task,
        boardPresentationStatus:
          task.boardPresentationStatus as UserProfileResponse["recentTasks"][number]["boardPresentationStatus"],
        priority: task.priority as UserProfileResponse["recentTasks"][number]["priority"],
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
