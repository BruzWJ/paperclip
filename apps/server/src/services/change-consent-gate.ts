import { type Db, changeConsents } from "@paperclipai/db";
import { and, desc, eq, gt, inArray, isNull, lt, ne } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { isCanonicalUuid } from "@paperclipai/shared";
import { readTaskExecutionRun, resolveTaskExecutionRunIdentityById } from "./task-execution-run-service.js";

export const CHANGE_CONSENT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type ChangeConsentStatus = "pending" | "accepted" | "rejected" | "expired";

export function agentProfileChangeTargetKey(agentId: string) {
  return `agent:${agentId}:profile`;
}

export type ChangeConsentTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function readExactNonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function hasDisplayedDiff(value: string) {
  return /```diff\b/i.test(value) || /(^|\n)[+-][^\n]+/.test(value);
}

export async function consumeAcceptedChangeConsentInTransaction(
  tx: ChangeConsentTransaction,
  input: {
    companyId: string;
    actorAgentId: string | null | undefined;
    actorRunId: string | null | undefined;
    targetKeys: string[];
    displayedDiff: string;
    now?: Date;
  },
): Promise<boolean> {
  const actorAgentId = input.actorAgentId;
  if (!isCanonicalUuid(actorAgentId)) return false;

  const actorRunId = input.actorRunId;
  if (!isCanonicalUuid(actorRunId)) {
    throw forbidden("Agent mutations requiring change consent need a run id", {
      code: "change_consent_run_id_required",
    });
  }
  const targetKeys = [
    ...new Set(input.targetKeys.map(readExactNonEmptyString).filter((key): key is string => Boolean(key))),
  ];
  if (targetKeys.length === 0) {
    throw forbidden("Mutation target is not consent-gated", {
      code: "change_consent_target_required",
    });
  }
  const displayedDiff = readExactNonEmptyString(input.displayedDiff);
  if (!displayedDiff || !hasDisplayedDiff(displayedDiff)) {
    throw forbidden("Mutation requires the exact displayed change-consent diff", {
      code: "change_consent_diff_required",
    });
  }
  const now = input.now ?? new Date();
  const accepted = await tx
    .select({ id: changeConsents.id })
    .from(changeConsents)
    .where(
      and(
        eq(changeConsents.companyId, input.companyId),
        eq(changeConsents.requestedByAgentId, actorAgentId),
        inArray(changeConsents.targetKey, targetKeys),
        eq(changeConsents.displayedDiff, displayedDiff),
        eq(changeConsents.status, "accepted"),
        ne(changeConsents.sourceRunId, actorRunId),
        gt(changeConsents.expiresAt, now),
        isNull(changeConsents.consumedAt),
        isNull(changeConsents.consumedByRunId),
      ),
    )
    .orderBy(desc(changeConsents.decidedAt), desc(changeConsents.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!accepted) {
    throw forbidden(
      "Mutation requires unexpired board consent for the exact displayed diff from a previous run.",
      { code: "change_consent_required", targetKeys },
    );
  }

  const [consumed] = await tx
    .update(changeConsents)
    .set({
      consumedAt: now,
      consumedByRunId: actorRunId,
      updatedAt: now,
    })
    .where(
      and(
        eq(changeConsents.id, accepted.id),
        eq(changeConsents.companyId, input.companyId),
        eq(changeConsents.status, "accepted"),
        gt(changeConsents.expiresAt, now),
        isNull(changeConsents.consumedAt),
        isNull(changeConsents.consumedByRunId),
      ),
    )
    .returning({ id: changeConsents.id });
  if (!consumed) {
    throw forbidden(
      "Mutation requires unexpired board consent for the exact displayed diff from a previous run.",
      { code: "change_consent_required", targetKeys },
    );
  }
  return true;
}

export function changeConsentGateService(db: Db) {
  async function expirePending(companyId: string, now = new Date()) {
    await db
      .update(changeConsents)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(changeConsents.companyId, companyId),
          eq(changeConsents.status, "pending"),
          lt(changeConsents.expiresAt, now),
        ),
      );
  }

  return {
    request: async (input: {
      companyId: string;
      requestedByAgentId: string;
      sourceRunId: string;
      targetKey: string;
      displayedDiff: string;
      expiresAt: Date;
    }) => {
      if (
        !isCanonicalUuid(input.companyId) ||
        !isCanonicalUuid(input.requestedByAgentId) ||
        !isCanonicalUuid(input.sourceRunId)
      ) {
        throw badRequest("Change consent identity is invalid");
      }
      const targetKey = readExactNonEmptyString(input.targetKey);
      const displayedDiff = readExactNonEmptyString(input.displayedDiff);
      if (!targetKey) throw badRequest("Change consent target is required");
      if (!displayedDiff || !hasDisplayedDiff(displayedDiff)) {
        throw badRequest("Change consent requires the exact displayed diff");
      }
      const now = new Date();
      if (
        !(input.expiresAt instanceof Date) ||
        Number.isNaN(input.expiresAt.getTime()) ||
        input.expiresAt <= now
      ) {
        throw badRequest("Change consent expiry must be in the future");
      }
      const sourceIdentity = await resolveTaskExecutionRunIdentityById(db, input.sourceRunId);
      const sourceRun =
        sourceIdentity?.companyId === input.companyId ? await readTaskExecutionRun(db, sourceIdentity) : null;
      if (!sourceRun || sourceRun.targetAgentId !== input.requestedByAgentId) {
        throw badRequest("Change consent source run is invalid");
      }

      return db
        .insert(changeConsents)
        .values({
          companyId: input.companyId,
          requestedByAgentId: input.requestedByAgentId,
          sourceRunId: input.sourceRunId,
          targetKey,
          displayedDiff,
          expiresAt: input.expiresAt,
        })
        .returning()
        .then((rows) => rows[0]!);
    },

    list: async (companyId: string, status?: ChangeConsentStatus) => {
      await expirePending(companyId);
      return db
        .select()
        .from(changeConsents)
        .where(
          status
            ? and(eq(changeConsents.companyId, companyId), eq(changeConsents.status, status))
            : eq(changeConsents.companyId, companyId),
        )
        .orderBy(desc(changeConsents.createdAt));
    },

    decide: async (input: {
      companyId: string;
      consentId: string;
      decision: "accepted" | "rejected";
      decidedByBoardId: string;
      reason?: string | null;
    }) => {
      if (!isCanonicalUuid(input.companyId) || !isCanonicalUuid(input.consentId)) {
        throw notFound("Change consent not found");
      }
      const boardId = readExactNonEmptyString(input.decidedByBoardId);
      if (!boardId) throw badRequest("Board decision identity is required");
      const now = new Date();
      await expirePending(input.companyId, now);
      const [updated] = await db
        .update(changeConsents)
        .set({
          status: input.decision,
          decisionReason: input.reason === null || input.reason === undefined ? null : input.reason,
          decidedByBoardId: boardId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(changeConsents.id, input.consentId),
            eq(changeConsents.companyId, input.companyId),
            eq(changeConsents.status, "pending"),
            gt(changeConsents.expiresAt, now),
          ),
        )
        .returning();
      if (updated) return updated;

      const existing = await db
        .select({ status: changeConsents.status })
        .from(changeConsents)
        .where(and(eq(changeConsents.id, input.consentId), eq(changeConsents.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Change consent not found");
      throw conflict("Change consent is no longer pending", {
        status: existing.status,
      });
    },

    assertConsented: async (input: {
      companyId: string;
      actorAgentId: string | null | undefined;
      actorRunId: string | null | undefined;
      targetKeys: string[];
      displayedDiff: string;
    }): Promise<boolean> => {
      return db.transaction((tx) => consumeAcceptedChangeConsentInTransaction(tx, input));
    },
  };
}
