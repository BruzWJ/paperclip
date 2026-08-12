import { Router, type Request } from "express";
import { and, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import {
  companyArtifactsQuerySchema,
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  canonicalUuidSchema,
  createCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  companyArtifactsService,
  companyPortabilityService,
  companyService,
  logActivity,
  workTimelineService,
} from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import type { OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertInstanceAdmin,
} from "./authz.js";
import { COMPANY_IMPORTS_ROUTE_PATH } from "./company-import-paths.js";
import type { SecretsRuntimeConfig } from "../secrets/types.js";

export function companyRoutes(
  db: Db,
  storage: StorageService | undefined,
  ordinaryTasks: OrdinaryTaskRuntime,
  secretsRuntime: SecretsRuntimeConfig,
) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = companyService(db);
  const portability = companyPortabilityService(
    db,
    storage,
    ordinaryTasks,
    secretsRuntime,
  );
  const access = accessService(db);
  const artifacts = companyArtifactsService(db, storage);

  function parseDateQuery(value: unknown, field: string) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
      throw badRequest(`Invalid ${field} query value`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return parsed;
  }

  function parseIntegerQuery(value: unknown, field: string) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
      throw badRequest(`Invalid ${field} query value`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw badRequest(`Invalid ${field} query value`);
    return parsed;
  }

  const timelineQuerySchema = z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      userId: z.string().min(1).refine((value) => value.trim() === value).optional(),
      goalId: canonicalUuidSchema.optional(),
      projectId: canonicalUuidSchema.optional(),
      taskId: canonicalUuidSchema.optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    })
    .strict();

  function assertImportTargetAccess(
    req: Request,
    target:
      { mode: "new_company" } | { mode: "existing_company"; companyId: string },
  ) {
    if (target.mode === "new_company") {
      assertInstanceAdmin(req);
      return;
    }
    assertCompanyAccess(req, target.companyId);
  }

  function assertBoardCompanyManagement(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(
      Object.entries(stats).filter(([companyId]) => allowed.has(companyId)),
    );
    res.json(filtered);
  });

  router.get("/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = companyArtifactsQuerySchema.parse(req.query);
    res.json(await artifacts.list(companyId, query));
  });

  router.get("/:companyId/timeline", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res
        .status(403)
        .json({
          error: "Timeline is outside this actor's authorization boundary",
        });
      return;
    }

    const query = timelineQuerySchema.parse(req.query);
    const timeline = workTimelineService(db);
    const result = await timeline.getTimeline({
      companyId,
      from: parseDateQuery(query.from, "from"),
      to: parseDateQuery(query.to, "to"),
      userId: query.userId,
      goalId: query.goalId,
      projectId: query.projectId,
      taskId: query.taskId,
      limit: parseIntegerQuery(query.limit, "limit"),
      offset: parseIntegerQuery(query.offset, "offset"),
      canReadTask: async (task) => {
        const decision = await access.decide({
          actor: req.actor,
          action: "task:read",
          resource: {
            type: "task",
            companyId: task.companyId,
            taskId: task.id,
            projectId: task.projectId,
            parentTaskId: task.parentId,
            ownerAgentId: task.ownerAgentId,
            ownerUserId: task.ownerUserId,
          },
          scope: {
            taskId: task.id,
            projectId: task.projectId,
            parentTaskId: task.parentId,
            ownerAgentId: task.ownerAgentId,
            ownerUserId: task.ownerUserId,
          },
        });
        return decision.allowed;
      },
    });
    res.json(result);
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/imports/preview", async (req, res) => {
    assertBoard(req);
    const body = companyPortabilityPreviewSchema.parse(req.body);
    assertImportTargetAccess(req, body.target);
    const preview = await portability.previewImport(body);
    res.json(preview);
  });

  router.post(COMPANY_IMPORTS_ROUTE_PATH, async (req, res) => {
    assertBoard(req);
    const rawImportBody: unknown = req.body;
    const importBody = companyPortabilityImportSchema.parse(rawImportBody);
    assertImportTargetAccess(req, importBody.target);
    const activity = importedCompanyActivityContext(
      req.actor.userId,
      importBody.include ?? null,
    );
    const result = await portability.importBundle(
      importBody,
      req.actor.userId,
      {
        authorizationActor: req.actor,
        secretMutationActor: {
          type: "user",
          userId: req.actor.userId,
        },
      },
    );
    await logImportedCompanyActivity(db, activity, result);
    res.json(result);
  });

  router.post("/:companyId/exports/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyManagement(req, companyId);
    const body = companyPortabilityExportSchema.parse(req.body);
    const preview = await portability.previewExport(companyId, body);
    res.json(preview);
  });

  router.post("/:companyId/exports", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyManagement(req, companyId);
    const body = companyPortabilityExportSchema.parse(req.body);
    const result = await portability.exportBundle(companyId, body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyManagement(req, companyId);
    const body = companyPortabilityPreviewSchema.parse(req.body);
    if (
      body.target.mode === "existing_company" &&
      body.target.companyId !== companyId
    ) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden(
        "Safe import route does not allow replace collision strategy",
      );
    }
    const preview = await portability.previewImport(body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyManagement(req, companyId);
    assertBoard(req);
    const body = companyPortabilityImportSchema.parse(req.body);
    if (
      body.target.mode === "existing_company" &&
      body.target.companyId !== companyId
    ) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden(
        "Safe import route does not allow replace collision strategy",
      );
    }
    const result = await portability.importBundle(body, req.actor.userId, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
      authorizationActor: req.actor,
      secretMutationActor: {
        type: "user",
        userId: req.actor.userId,
      },
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: "user",
      actorId: req.actor.userId,
      entityType: "company",
      entityId: result.company.id,
      action: "company.imported",
      details: {
        include: body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }
    if (!req.actor.userId) {
      throw forbidden("Authenticated user identity required");
    }
    const ownerPrincipalId = req.actor.userId;
    const company = await svc.create(
      {
        ...req.body,
        defaultResponsibleUserId:
          req.body.defaultResponsibleUserId ?? ownerPrincipalId,
      },
      req.actor.userId,
    );
    await access.ensureMembership(
      company.id,
      "user",
      ownerPrincipalId,
      "owner",
      "active",
    );
    await access.stampRoleGrants(
      company.id,
      ownerPrincipalId,
      "owner",
      req.actor.userId,
    );
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId,
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    res.status(201).json(company);
  });

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyManagement(req, companyId);
    assertBoard(req);

    const body = updateCompanySchema.parse(req.body);

    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const transitionsToArchived =
      body.status === "archived" && existingCompany.status !== "archived";
    const transitionsArchivedToActive =
      body.status === "active" && existingCompany.status === "archived";
    let transitionsPausedToActiveWithArchivePausedAgents = false;
    if (body.status === "active" && existingCompany.status === "paused") {
      const [archivedPausedCount] = await db
        .select({ value: countFn() })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.companyId, companyId),
            eq(agentsTable.status, "paused"),
            eq(agentsTable.pauseReason, "company_archived"),
          ),
        );
      transitionsPausedToActiveWithArchivePausedAgents =
        Number(archivedPausedCount?.value ?? 0) > 0;
    }
    const lifecycleEventEmittedByService =
      transitionsToArchived ||
      transitionsArchivedToActive ||
      transitionsPausedToActiveWithArchivePausedAgents;

    const company = await svc.update(companyId, body, {
      actorType: "user",
      actorId: req.actor.userId,
    });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (!lifecycleEventEmittedByService) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "company.updated",
        entityType: "company",
        entityId: companyId,
        details: body,
      });
    }
    res.json(company);
  });

  router.patch("/:companyId/branding", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompanyManagement(req, companyId);
    assertBoard(req);
    const body = updateCompanyBrandingSchema.parse(req.body);
    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.archive(companyId, {
      actorType: "user",
      actorId: req.actor.userId,
    });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await svc.remove(companyId, {
      actorType: "user",
      actorId: req.actor.userId,
    });
    res.status(result.purged ? 200 : 202).json({
      ok: result.purged,
      ...result,
    });
  });

  return router;
}

type CompanyImportResult = {
  company: { id: string; action: unknown };
  agents: unknown[];
  warnings: unknown[];
};

interface ImportedCompanyActivityContext {
  actorType: "user";
  actorId: string;
  include: unknown;
}

function importedCompanyActivityContext(
  userId: string,
  include: unknown,
): ImportedCompanyActivityContext {
  return {
    actorType: "user",
    actorId: userId,
    include,
  };
}

async function logImportedCompanyActivity(
  db: Db,
  activity: ImportedCompanyActivityContext,
  result: CompanyImportResult,
) {
  await logActivity(db, {
    companyId: result.company.id,
    actorType: activity.actorType,
    actorId: activity.actorId,
    action: "company.imported",
    entityType: "company",
    entityId: result.company.id,
    details: {
      include: activity.include,
      agentCount: result.agents.length,
      warningCount: result.warnings.length,
      companyAction: result.company.action,
    },
  });
}
