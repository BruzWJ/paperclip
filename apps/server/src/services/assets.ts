import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets } from "@paperclipai/db";
import { isCanonicalUuid } from "@paperclipai/shared";

export function assetService(db: Db) {
  return {
    create: (companyId: string, data: Omit<typeof assets.$inferInsert, "companyId">) =>
      db
        .insert(assets)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    getById: (id: string) => {
      if (!isCanonicalUuid(id)) return Promise.resolve(null);
      return db
        .select()
        .from(assets)
        .where(eq(assets.id, id))
        .then((rows) => rows[0] ?? null);
    },
  };
}
