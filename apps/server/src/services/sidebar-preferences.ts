import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyUserSidebarPreferences,
  userSidebarPreferences,
} from "@paperclipai/db";
import type { SidebarOrderPreference } from "@paperclipai/shared";
import { upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";

function requireOrderedIds(value: unknown): string[] {
  return upsertSidebarOrderPreferenceSchema.shape.orderedIds.parse(value);
}

function toPreference(orderedIds: unknown, updatedAt: Date | null): SidebarOrderPreference {
  return {
    orderedIds: requireOrderedIds(orderedIds),
    updatedAt,
  };
}

export function sidebarPreferenceService(db: Db) {
  return {
    async getCompanyOrder(userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.userSidebarPreferences.findFirst({
        where: eq(userSidebarPreferences.userId, userId),
      });
      return toPreference(row?.companyOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertCompanyOrder(userId: string, orderedIds: string[]): Promise<SidebarOrderPreference> {
      const now = new Date();
      const exactOrderedIds = requireOrderedIds(orderedIds);
      const [row] = await db
        .insert(userSidebarPreferences)
        .values({
          userId,
          companyOrder: exactOrderedIds,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userSidebarPreferences.userId],
          set: {
            companyOrder: exactOrderedIds,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(row?.companyOrder ?? exactOrderedIds, row?.updatedAt ?? now);
    },

    async getProjectOrder(companyId: string, userId: string): Promise<SidebarOrderPreference> {
      const row = await db.query.companyUserSidebarPreferences.findFirst({
        where: and(
          eq(companyUserSidebarPreferences.companyId, companyId),
          eq(companyUserSidebarPreferences.userId, userId),
        ),
      });
      return toPreference(row?.projectOrder ?? [], row?.updatedAt ?? null);
    },

    async upsertProjectOrder(
      companyId: string,
      userId: string,
      orderedIds: string[],
    ): Promise<SidebarOrderPreference> {
      const now = new Date();
      const exactOrderedIds = requireOrderedIds(orderedIds);
      const [row] = await db
        .insert(companyUserSidebarPreferences)
        .values({
          companyId,
          userId,
          projectOrder: exactOrderedIds,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [companyUserSidebarPreferences.companyId, companyUserSidebarPreferences.userId],
          set: {
            projectOrder: exactOrderedIds,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(row?.projectOrder ?? exactOrderedIds, row?.updatedAt ?? now);
    },
  };
}
