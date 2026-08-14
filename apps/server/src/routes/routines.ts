import type { Db } from "@paperclipai/db";
import { registerRoutineReadAndAnnotationRoutes } from "./routine-read-annotation-routes.js";
import {
  createRoutineRouteContext,
  type RoutineRouteOptions,
  type RoutineRouteContext,
} from "./routine-route-context.js";

import {
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { getBoardUserId, getAccessibleResource } from "./authz.js";

import { assertExactQueryKeys, parseExactPositiveIntegerQuery } from "./exact-query.js";

const ANNOTATION_STATUSES = ["open", "resolved", "all"] as const;

type RoutineManagementRoutesContext = Pick<
  RoutineRouteContext,
  | "router"
  | "db"
  | "svc"
  | "remapRoutineDescriptionAnnotations"
  | "assertBoardRoutineAuthority"
  | "getManageableRoutine"
  | "logRoutineRevisionCreated"
>;

export function registerRoutineManagementRoutes(context: RoutineManagementRoutesContext): void {
  const {
    router,
    db,
    svc,
    remapRoutineDescriptionAnnotations,
    assertBoardRoutineAuthority,
    getManageableRoutine,
    logRoutineRevisionCreated,
  } = context;

  router.patch("/routines/:id", validate(updateRoutineSchema), async (req, res) => {
    const routine = await getManageableRoutine(req, res, req.params.id as string);
    if (!routine) return;
    const assigneeWillChange =
      req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== routine.assigneeAgentId;
    if (assigneeWillChange) {
      await assertBoardRoutineAuthority(req, routine.companyId);
    }
    const statusWillActivate =
      req.body.status !== undefined && req.body.status === "active" && routine.status !== "active";
    if (statusWillActivate) {
      await assertBoardRoutineAuthority(req, routine.companyId);
    }
    const updated = await svc.update(routine.id, req.body, {
      type: "user",
      userId: getBoardUserId(req),
    });
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: "user",
      actorId: getBoardUserId(req),
      action: "routine.updated",
      entityType: "routine",
      entityId: routine.id,
      details: { title: updated?.title ?? routine.title },
    });
    if (updated && updated.latestRevisionId !== routine.latestRevisionId) {
      await remapRoutineDescriptionAnnotations(req, routine.id);
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: updated.latestRevisionId,
        revisionNumber: updated.latestRevisionNumber,
        changeSummary: "Updated routine",
        triggerCount: null,
      });
    }
    res.json(updated);
  });

  router.post("/routines/:id/revisions/:revisionId/restore", async (req, res) => {
    const routine = await getManageableRoutine(req, res, req.params.id as string);
    if (!routine) return;
    await assertBoardRoutineAuthority(req, routine.companyId);
    const result = await svc.restoreRevision(routine.id, req.params.revisionId as string, {
      type: "user",
      userId: getBoardUserId(req),
    });
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: "user",
      actorId: getBoardUserId(req),
      action: "routine.revision_restored",
      entityType: "routine",
      entityId: routine.id,
      details: {
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        restoredFromRevisionId: result.restoredFromRevisionId,
        restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        triggerCount: result.revision.snapshot.triggers.length,
      },
    });
    await remapRoutineDescriptionAnnotations(req, routine.id);
    res.json(result);
  });

  router.get("/routines/:id/runs", async (req, res) => {
    const routine = await getAccessibleResource(
      req,
      res,
      svc.get(req.params.id as string),
      "Routine not found",
    );
    if (!routine) return;
    assertExactQueryKeys(req.query, ["limit"]);
    const limit = parseExactPositiveIntegerQuery(req.query.limit, "limit", {
      defaultValue: 50,
      max: 200,
    });
    const result = await svc.listRuns(routine.id, limit);
    res.json(result);
  });

  router.post("/routines/:id/triggers", validate(createRoutineTriggerSchema), async (req, res) => {
    const routine = await getManageableRoutine(req, res, req.params.id as string);
    if (!routine) return;
    await assertBoardRoutineAuthority(req, routine.companyId);
    const created = await svc.createTrigger(routine.id, req.body, {
      type: "user",
      userId: getBoardUserId(req),
    });
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: "user",
      actorId: getBoardUserId(req),
      action: "routine.trigger_created",
      entityType: "routine_trigger",
      entityId: created.trigger.id,
      details: { routineId: routine.id, kind: created.trigger.kind },
    });
    await logRoutineRevisionCreated(req, {
      companyId: routine.companyId,
      routineId: routine.id,
      revisionId: created.revision.id,
      revisionNumber: created.revision.revisionNumber,
      changeSummary: created.revision.changeSummary,
      triggerCount: created.revision.snapshot.triggers.length,
    });
    res.status(201).json(created);
  });

  router.patch("/routine-triggers/:id", validate(updateRoutineTriggerSchema), async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const routine = await getManageableRoutine(req, res, trigger.routineId, "Routine trigger not found");
    if (!routine) return;
    await assertBoardRoutineAuthority(req, routine.companyId);
    const updated = await svc.updateTrigger(trigger.id, req.body, {
      type: "user",
      userId: getBoardUserId(req),
    });
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: "user",
      actorId: getBoardUserId(req),
      action: "routine.trigger_updated",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: {
        routineId: routine.id,
        kind: updated?.trigger.kind ?? trigger.kind,
      },
    });
    if (updated) {
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: updated.revision.id,
        revisionNumber: updated.revision.revisionNumber,
        changeSummary: updated.revision.changeSummary,
        triggerCount: updated.revision.snapshot.triggers.length,
      });
    }
    res.json(updated?.trigger ?? null);
  });
}

type RoutineTriggerRoutesContext = Pick<
  RoutineRouteContext,
  | "router"
  | "db"
  | "svc"
  | "assertBoardRoutineAuthority"
  | "getManageableRoutine"
  | "logRoutineRevisionCreated"
>;

export function registerRoutineTriggerRoutes(context: RoutineTriggerRoutesContext): void {
  const { router, db, svc, assertBoardRoutineAuthority, getManageableRoutine, logRoutineRevisionCreated } =
    context;

  router.delete("/routine-triggers/:id", async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const routine = await getManageableRoutine(req, res, trigger.routineId, "Routine trigger not found");
    if (!routine) return;
    const deleted = await svc.deleteTrigger(trigger.id, {
      type: "user",
      userId: getBoardUserId(req),
    });
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: "user",
      actorId: getBoardUserId(req),
      action: "routine.trigger_deleted",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: { routineId: routine.id, kind: trigger.kind },
    });
    if (deleted.revision) {
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: deleted.revision.id,
        revisionNumber: deleted.revision.revisionNumber,
        changeSummary: deleted.revision.changeSummary,
        triggerCount: deleted.revision.snapshot.triggers.length,
      });
    }
    res.status(204).end();
  });

  router.post(
    "/routine-triggers/:id/rotate-secret",
    validate(rotateRoutineTriggerSecretSchema),
    async (req, res) => {
      const trigger = await svc.getTrigger(req.params.id as string);
      if (!trigger) {
        res.status(404).json({ error: "Routine trigger not found" });
        return;
      }
      const routine = await getManageableRoutine(req, res, trigger.routineId, "Routine trigger not found");
      if (!routine) return;
      const rotated = await svc.rotateTriggerSecret(trigger.id, {
        type: "user",
        userId: getBoardUserId(req),
      });
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: "user",
        actorId: getBoardUserId(req),
        action: "routine.trigger_secret_rotated",
        entityType: "routine_trigger",
        entityId: trigger.id,
        details: { routineId: routine.id },
      });
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: rotated.revision.id,
        revisionNumber: rotated.revision.revisionNumber,
        changeSummary: rotated.revision.changeSummary,
        triggerCount: rotated.revision.snapshot.triggers.length,
      });
      res.json(rotated);
    },
  );

  router.post("/routines/:id/run", validate(runRoutineSchema), async (req, res) => {
    const routine = await getManageableRoutine(req, res, req.params.id as string);
    if (!routine) return;
    await assertBoardRoutineAuthority(req, routine.companyId);
    const run = await svc.runRoutine(routine.id, req.body, {
      type: "user",
      userId: getBoardUserId(req),
    });
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: "user",
      actorId: getBoardUserId(req),
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: {
        routineId: routine.id,
        source: run.source,
        status: run.status,
      },
    });
    res.status(202).json(run);
  });

  router.post("/routine-triggers/public/:publicId/fire", async (req, res) => {
    const result = await svc.firePublicTrigger(req.params.publicId as string, {
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-paperclip-signature"),
      timestampHeader: req.header("x-paperclip-timestamp"),
      idempotencyKey: req.header("idempotency-key"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      payload:
        typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : null,
    });
    res.status(202).json(result);
  });
}

export function routineRoutes(db: Db, options: RoutineRouteOptions) {
  const context = createRoutineRouteContext(db, options);
  registerRoutineReadAndAnnotationRoutes(context);
  registerRoutineManagementRoutes(context);
  registerRoutineTriggerRoutes(context);
  return context.router;
}
