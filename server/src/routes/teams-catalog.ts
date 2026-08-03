import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  catalogTeamInstallSchema,
  catalogTeamListQuerySchema,
  catalogTeamPreviewSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/index.js";
import {
  getCatalogTeamOrThrow,
  listCatalogTeams,
  readCatalogTeamFile,
  teamsCatalogService,
} from "../services/teams-catalog.js";
import { forbidden } from "../errors.js";
import type { OrdinaryIssueRuntime } from "../services/ordinary-issue-runtime.js";
import {
  assertAuthenticated,
  assertBoard,
  assertCompanyAccess,
} from "./authz.js";

export function teamsCatalogRoutes(
  db: Db,
  ordinaryIssues: OrdinaryIssueRuntime,
) {
  const router = Router();
  const access = accessService(db);
  const svc = teamsCatalogService(db, ordinaryIssues);

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  async function assertCanConfigureCatalogTeam(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
    if (!allowed) throw forbidden("Missing permission: agents:create");
  }

  router.get("/teams/catalog", async (req, res) => {
    assertAuthenticated(req);
    const query = catalogTeamListQuerySchema.parse({
      kind: firstQueryString(req.query.kind),
      category: firstQueryString(req.query.category),
      q: firstQueryString(req.query.q),
    });
    res.json(await listCatalogTeams(query));
  });

  router.get("/teams/catalog/:catalogId/files", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    const relativePath = firstQueryString(req.query.path) ?? "TEAM.md";
    res.json(await readCatalogTeamFile(catalogRef, relativePath));
  });

  router.get("/teams/catalog/:catalogId", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    res.json(await getCatalogTeamOrThrow(catalogRef));
  });

  router.get("/companies/:companyId/teams/catalog/installed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listInstalledCatalogTeams(companyId));
  });

  router.post(
    "/companies/:companyId/teams/catalog/:catalogId/preview",
    validate(catalogTeamPreviewSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
      await assertCanConfigureCatalogTeam(req, companyId);
      const result = await svc.previewCatalogTeamImport(companyId, catalogRef, {
        ...req.body,
        actor: {
          actorType: "user",
          actorId: req.actor.userId,
          userId: req.actor.userId,
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/teams/catalog/:catalogId/install",
    validate(catalogTeamInstallSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
      await assertCanConfigureCatalogTeam(req, companyId);
      const result = await svc.installCatalogTeam(companyId, catalogRef, {
        ...req.body,
        actor: {
          actorType: "user",
          actorId: req.actor.userId,
          userId: req.actor.userId,
        },
        authorizationActor: req.actor,
      });
      res.status(201).json(result);
    },
  );

  return router;
}
