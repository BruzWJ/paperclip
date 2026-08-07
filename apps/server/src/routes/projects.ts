import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectSchema,
  isUuidLike,
  updateProjectSchema,
} from "@paperclipai/shared";
import { trackProjectCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { accessService, projectService, logActivity, toPublicProject } from "../services/index.js";
import { conflict } from "../errors.js";

import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";
import { secretService } from "../services/secrets.js";

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const access = accessService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function resolveCompanyIdForProjectReference(req: Request) {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    return null;
  }

  async function normalizeProjectReference(req: Request, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const companyId = await resolveCompanyIdForProjectReference(req);
    if (!companyId) return rawId;
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    return resolved.project?.id ?? rawId;
  }

  async function assertProjectReadAllowed(req: Request, res: Response, project: { id: string; companyId: string }) {
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Project is outside this actor's authorization boundary" });
    return false;
  }

  async function filterProjectsForActor<T extends { id: string; companyId: string }>(req: Request, rows: T[]) {
    const decisions = await Promise.all(rows.map((project) =>
      access.decide({
        actor: req.actor,
        action: "project:read",
        resource: { type: "project", companyId: project.companyId, projectId: project.id },
      })
    ));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeProjectReference(req, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/projects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json((await filterProjectsForActor(req, result)).map(toPublicProject));
  });

  router.get("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const project = await getAccessibleResource(req, res, svc.getById(id), "Project not found");
    if (!project) return;
    if (!(await assertProjectReadAllowed(req, res, project))) return;
    res.json(toPublicProject(project));
  });

  router.post("/companies/:companyId/projects", validate(createProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectData = req.body as Parameters<typeof svc.create>[1];
    if (projectData.env !== undefined) {
      projectData.env = await secretsSvc.normalizeEnvBindingsForPersistence(
        companyId,
        projectData.env,
        { strictMode: strictSecretsMode, fieldPath: "env" },
      );
    }
    const project = await svc.create(companyId, projectData);
    if (project.env) {
      await secretsSvc.syncEnvBindingsForTarget(
        companyId,
        { targetType: "project", targetId: project.id },
        project.env,
        { actor: { type: "user", userId: req.actor.userId } },
      );
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
        envKeys: project.env ? Object.keys(project.env).sort() : [],
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackProjectCreated(telemetryClient);
    }
    res.status(201).json(toPublicProject(project));
  });

  router.patch("/projects/:id", validate(updateProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Project not found");
    if (!existing) return;
    assertBoard(req);
    const body = { ...req.body } as Record<string, unknown>;
    if (typeof body.archivedAt === "string") {
      body.archivedAt = new Date(body.archivedAt);
    }
    if (body.env !== undefined) {
      body.env = await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, body.env, {
        strictMode: strictSecretsMode,
        fieldPath: "env",
      });
    }
    const project = await svc.update(id, body as Parameters<typeof svc.update>[1]);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (body.env !== undefined) {
      await secretsSvc.syncEnvBindingsForTarget(
        project.companyId,
        { targetType: "project", targetId: project.id },
        project.env,
        { actor: { type: "user", userId: req.actor.userId } },
      );
    }

    await logActivity(db, {
      companyId: project.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        envKeys:
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? Object.keys(body.env as Record<string, unknown>).sort()
            : undefined,
      },
    });

    res.json(toPublicProject(project));
  });

  router.delete("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Project not found");
    if (!existing) return;
    assertBoard(req);
    const project = await svc.remove(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await logActivity(db, {
      companyId: project.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(toPublicProject(project));
  });

  return router;
}
