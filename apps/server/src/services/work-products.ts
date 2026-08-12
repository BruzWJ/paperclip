import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { taskWorkProducts } from "@paperclipai/db";
import { isCanonicalUuid, type TaskWorkProduct } from "@paperclipai/shared";

type TaskWorkProductRow = typeof taskWorkProducts.$inferSelect;

function toTaskWorkProduct(row: TaskWorkProductRow): TaskWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    taskId: row.taskId,
    type: row.type as TaskWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as TaskWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as TaskWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    sourceTrust: row.sourceTrust ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  return {
    listForTask: async (taskId: string) => {
      const rows = await db
        .select()
        .from(taskWorkProducts)
        .where(eq(taskWorkProducts.taskId, taskId))
        .orderBy(desc(taskWorkProducts.isPrimary), desc(taskWorkProducts.updatedAt));
      return rows.map(toTaskWorkProduct);
    },

    getById: async (id: string) => {
      if (!isCanonicalUuid(id)) return null;
      const row = await db
        .select()
        .from(taskWorkProducts)
        .where(eq(taskWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toTaskWorkProduct(row) : null;
    },

    createForTask: async (taskId: string, companyId: string, data: Omit<typeof taskWorkProducts.$inferInsert, "taskId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(taskWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(taskWorkProducts.companyId, companyId),
                eq(taskWorkProducts.taskId, taskId),
                eq(taskWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(taskWorkProducts)
          .values({
            ...data,
            companyId,
            taskId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toTaskWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof taskWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(taskWorkProducts)
          .where(eq(taskWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(taskWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(taskWorkProducts.companyId, existing.companyId),
                eq(taskWorkProducts.taskId, existing.taskId),
                eq(taskWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(taskWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(taskWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toTaskWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(taskWorkProducts)
        .where(eq(taskWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toTaskWorkProduct(row) : null;
    },
  };
}

export { toTaskWorkProduct };
