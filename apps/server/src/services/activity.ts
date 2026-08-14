import { and, desc, eq, or, sql } from "drizzle-orm";
import { type Db, activityLog, tasks } from "@paperclipai/db";
import { visibleTaskCondition } from "./task-visibility.js";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 100;

export function activityService(db: Db) {
  const taskIdAsText = sql<string>`${tasks.id}::text`;

  return {
    list: (filters: ActivityFilters) => {
      const conditions = [eq(activityLog.companyId, filters.companyId)];
      const limit = filters.limit ?? DEFAULT_ACTIVITY_LIMIT;

      if (filters.agentId) {
        conditions.push(eq(activityLog.agentId, filters.agentId));
      }
      if (filters.entityType) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }

      return db
        .select({ activityLog })
        .from(activityLog)
        .leftJoin(tasks, and(eq(activityLog.entityType, sql`'task'`), eq(activityLog.entityId, taskIdAsText)))
        .where(and(...conditions, or(sql`${activityLog.entityType} != 'task'`, visibleTaskCondition())))
        .orderBy(desc(activityLog.createdAt))
        .limit(limit)
        .then((rows) => rows.map((row) => row.activityLog));
    },

    forTask: (taskId: string) =>
      db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityType, "task"), eq(activityLog.entityId, taskId)))
        .orderBy(desc(activityLog.createdAt)),
  };
}
