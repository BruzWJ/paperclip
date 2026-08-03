import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { inboxDismissals } from "@paperclipai/db";
import type { InboxDismissalKind } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

const AGENT_LIVENESS_DISMISSAL_PREFIX = "attention:agent-liveness:";

function assertDismissibleItemKey(itemKey: string): void {
  if (itemKey.startsWith(AGENT_LIVENESS_DISMISSAL_PREFIX)) {
    throw badRequest(
      "Agent-liveness Attention items remain until an explicit issue action advances the issue",
    );
  }
}

export function inboxDismissalService(db: Db) {
  async function upsert(
    companyId: string,
    userId: string,
    itemKey: string,
    input: { kind: InboxDismissalKind; dismissedAt?: Date; snoozedUntil?: Date | null },
  ) {
    assertDismissibleItemKey(itemKey);
    const now = new Date();
    const dismissedAt = input.dismissedAt ?? now;
    const snoozedUntil = input.kind === "snooze" ? input.snoozedUntil ?? null : null;
    const [row] = await db
      .insert(inboxDismissals)
      .values({
        companyId,
        userId,
        itemKey,
        kind: input.kind,
        dismissedAt,
        snoozedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [inboxDismissals.companyId, inboxDismissals.userId, inboxDismissals.itemKey],
        set: {
          kind: input.kind,
          dismissedAt,
          snoozedUntil,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  return {
    list: async (companyId: string, userId: string) =>
      db
        .select()
        .from(inboxDismissals)
        .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)))
        .orderBy(desc(inboxDismissals.updatedAt)),

    dismiss: async (
      companyId: string,
      userId: string,
      itemKey: string,
      dismissedAt: Date = new Date(),
    ) => upsert(companyId, userId, itemKey, { kind: "dismiss", dismissedAt }),

    snooze: async (
      companyId: string,
      userId: string,
      itemKey: string,
      snoozedUntil: Date,
      dismissedAt: Date = new Date(),
    ) => upsert(companyId, userId, itemKey, { kind: "snooze", dismissedAt, snoozedUntil }),

    restore: async (companyId: string, userId: string, itemKey: string) => {
      assertDismissibleItemKey(itemKey);
      const [row] = await db
        .delete(inboxDismissals)
        .where(and(
          eq(inboxDismissals.companyId, companyId),
          eq(inboxDismissals.userId, userId),
          eq(inboxDismissals.itemKey, itemKey),
        ))
        .returning();
      return row ?? null;
    },
  };
}
