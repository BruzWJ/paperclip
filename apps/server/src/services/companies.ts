import { randomUUID } from "node:crypto";
import { and, count, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  assets,
  agents,
  issues,
  projects,
  goals,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { environmentService } from "./environments.js";
import { logActivity } from "./activity-log.js";
import {
  archiveCompanySessionGraphInTx,
  beginCompanyHardDeleteInTx,
  purgeCompanySessionGraphInTx,
  reactivateCompanySessionGraphInTx,
} from "./issue-session-lifecycle.js";
import {
  budgetService,
  type CanonicalCompanyCreation,
} from "./budgets.js";

export interface CompanyActivityActor {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

const SYSTEM_COMPANY_ACTOR: CompanyActivityActor = {
  actorType: "system",
  actorId: "system",
  agentId: null,
  runId: null,
};

export function companyService(db: Db) {
  const environmentsSvc = environmentService(db);
  const budgets = budgetService(db);

  type CompanyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function applyArchiveCascadeInTx(
    tx: CompanyTx,
    id: string,
    actor: CompanyActivityActor,
  ) {
    const lifecycle = await archiveCompanySessionGraphInTx(
      tx,
      id,
      randomUUID(),
      {
        actor: {
          requestedByAgentId:
            actor.actorType === "agent" ? actor.agentId ?? actor.actorId : null,
          requestedByUserId:
            actor.actorType === "user" ? actor.actorId : null,
        },
      },
    );
    if (!lifecycle) throw notFound("Company not found");
    const pausedAgentRows = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agents.companyId, id),
        notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
      ))
      .returning({ id: agents.id });

    return {
      agentsPaused: pausedAgentRows.length,
      lifecycleOperationId: lifecycle.operation.id,
      affectedRunCount: lifecycle.runs.length,
      cancellationIntentCount: lifecycle.intents.length,
    };
  }

  async function finalizeArchive(
    id: string,
    actor: CompanyActivityActor,
    cascade: {
      agentsPaused: number;
      lifecycleOperationId: string;
      affectedRunCount: number;
      cancellationIntentCount: number;
    },
  ) {
    await logActivity(db, {
      companyId: id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "company.archived",
      entityType: "company",
      entityId: id,
      details: {
        agentsPaused: cascade.agentsPaused,
        lifecycleOperationId: cascade.lifecycleOperationId,
        affectedRunCount: cascade.affectedRunCount,
        cancellationIntentCount: cascade.cancellationIntentCount,
      },
    });
  }

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    pauseReason: companies.pauseReason,
    pausedAt: companies.pausedAt,
    issuePrefix: companies.issuePrefix,
    issueCounter: companies.issueCounter,
    budgetCurrency: companies.budgetCurrency,
    budgetMonthlyAmount: companies.budgetMonthlyAmount,
    attachmentMaxBytes: companies.attachmentMaxBytes,
    defaultResponsibleUserId: companies.defaultResponsibleUserId,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    brandColor: companies.brandColor,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null,
    };
  }

  async function getMonthlySpendByCompanyIds(
    companyIds: string[],
  ) {
    return budgets.getCompanyMonthlyKnownSpend(companyIds);
  }

  async function hydrateCompanySpend<T extends { id: string }>(
    rows: T[],
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      ...row,
      knownSpendAmount: spendByCompanyId.get(row.id)!,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id));
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row]);
      return enrichCompany(hydrated);
    },

    create: async (
      data: CanonicalCompanyCreation,
      actorUserId: string | null = null,
    ) => {
      const created = await budgets.createCompany(data, actorUserId);
      await environmentsSvc.ensureLocalEnvironment(created.id);
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row]);
      return enrichCompany(hydrated);
    },

    update: async (
      id: string,
      data: Omit<
        Partial<typeof companies.$inferInsert>,
        "budgetCurrency" | "budgetMonthlyAmount"
      > & { logoAssetId?: string | null },
      actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR,
    ) => {
      const result = await db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, status: requestedStatus, ...companyPatch } = data;
        const willReactivate = existing.status !== "active" && requestedStatus === "active";
        const willArchive = existing.status !== "archived" && requestedStatus === "archived";

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.companyId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same company");
          }
        }

        const archiveCascade = willArchive
          ? await applyArchiveCascadeInTx(tx, id, actor)
          : null;
        if (willReactivate) {
          await reactivateCompanySessionGraphInTx(tx, { companyId: id });
        }

        const updated = await tx
          .update(companies)
          .set({ ...companyPatch, updatedAt: new Date() })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        let agentsRestored = 0;
        if (willReactivate) {
          const restoredRows = await tx
            .update(agents)
            .set({
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(agents.companyId, id),
              eq(agents.status, "paused"),
              eq(agents.pauseReason, "company_archived"),
            ))
            .returning({ id: agents.id });
          agentsRestored = restoredRows.length;
        }

        if (logoAssetId === null) {
          await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(companyLogos)
            .values({
              companyId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: companyLogos.companyId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }]);

        const shouldLogReactivation = willReactivate &&
          (existing.status === "archived" || agentsRestored > 0);

        return {
          company: enrichCompany(hydrated),
          reactivated: shouldLogReactivation ? { agentsRestored } : null,
          archiveCascade,
        };
      });
      if (!result) return null;
      if (result.reactivated) {
        await logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "company.reactivated",
          entityType: "company",
          entityId: id,
          details: { agentsRestored: result.reactivated.agentsRestored },
        });
      }
      if (result.archiveCascade) {
        await finalizeArchive(id, actor, result.archiveCascade);
      }
      return result.company;
    },

    archive: async (id: string, actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR) => {
      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const wasAlreadyArchived = existing.status === "archived";
        const cascade = wasAlreadyArchived
          ? null
          : await applyArchiveCascadeInTx(tx, id, actor);

        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row]);
        return {
          company: enrichCompany(hydrated),
          cascade,
        };
      });
      if (!result) return null;

      if (result.cascade) {
        await finalizeArchive(id, actor, result.cascade);
      }

      return result.company;
    },

    remove: async (
      id: string,
      actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR,
    ) => {
      const begin = await db.transaction((tx) =>
        beginCompanyHardDeleteInTx(tx, id, randomUUID(), {
          actor: {
            requestedByAgentId:
              actor.actorType === "agent" ? actor.agentId ?? actor.actorId : null,
            requestedByUserId:
              actor.actorType === "user" ? actor.actorId : null,
          },
        }),
      );
      if (!begin) {
        return {
          companyId: id,
          lifecycleOperationId: null,
          generation: null,
          status: "completed" as const,
          purged: true as const,
          alreadyAbsent: true as const,
        };
      }
      if (begin.operation.status !== "purge_ready") {
        return {
          companyId: id,
          lifecycleOperationId: begin.operation.id,
          generation: begin.operation.generation,
          status: begin.operation.status,
          cancellationIntentCount: begin.intents.length,
          purged: false as const,
          alreadyAbsent: false as const,
        };
      }
      const purged = await db.transaction((tx) =>
        purgeCompanySessionGraphInTx(tx, {
          companyId: id,
          lifecycleOperationId: begin.operation.id,
        }),
      );
      return {
        ...purged,
        lifecycleOperationId: begin.operation.id,
        status: "completed" as const,
        alreadyAbsent: false as const,
      };
    },

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
