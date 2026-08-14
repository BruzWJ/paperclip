import {
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  createRoutineSchema,
  isCanonicalUuid,
  updateDocumentAnnotationThreadSchema,
} from "@paperclipai/shared";
import { trackRoutineCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { getTelemetryClient } from "../telemetry.js";
import { assertCompanyAccess, getAccessibleResource, getBoardUserId } from "./authz.js";
import { assertExactQueryKeys, parseExactBooleanQuery, parseExactOptionalEnum } from "./exact-query.js";
import type { RoutineRouteContext } from "./routine-route-context.js";

const ANNOTATION_STATUSES = ["open", "resolved", "all"] as const;

type RoutineReadAnnotationRoutesContext = Pick<
  RoutineRouteContext,
  | "router"
  | "db"
  | "svc"
  | "documentAnnotationsSvc"
  | "routineDocumentKey"
  | "annotationActorInput"
  | "assertBoardRoutineAuthority"
  | "assertCanManageCompanyRoutine"
  | "getManageableRoutine"
  | "logRoutineRevisionCreated"
>;

export function registerRoutineReadAndAnnotationRoutes(context: RoutineReadAnnotationRoutesContext): void {
  const {
    router,
    db,
    svc,
    documentAnnotationsSvc,
    routineDocumentKey,
    annotationActorInput,
    assertBoardRoutineAuthority,
    assertCanManageCompanyRoutine,
    getManageableRoutine,
    logRoutineRevisionCreated,
  } = context;

  router.get("/companies/:companyId/routines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertExactQueryKeys(req.query, ["projectId"]);
    const projectId = req.query.projectId;
    if (projectId !== undefined && (typeof projectId !== "string" || !isCanonicalUuid(projectId))) {
      res.status(400).json({ error: "projectId must be an exact canonical UUID" });
      return;
    }
    const result = await svc.list(companyId, { projectId });
    res.json(result);
  });

  router.post("/companies/:companyId/routines", validate(createRoutineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardRoutineAuthority(req, companyId);
    assertCanManageCompanyRoutine(req, companyId, req.body.assigneeAgentId);
    const actorUserId = getBoardUserId(req);
    const created = await svc.create(companyId, req.body, {
      type: "user",
      userId: actorUserId,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "routine.created",
      entityType: "routine",
      entityId: created.id,
      details: {
        title: created.title,
        assigneeAgentId: created.assigneeAgentId,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackRoutineCreated(telemetryClient);
    }
    await logRoutineRevisionCreated(req, {
      companyId,
      routineId: created.id,
      revisionId: created.latestRevisionId,
      revisionNumber: created.latestRevisionNumber,
      changeSummary: "Created routine",
      triggerCount: 0,
    });
    res.status(201).json(created);
  });

  router.get("/routines/:id", async (req, res) => {
    const detail = await getAccessibleResource(
      req,
      res,
      svc.getDetail(req.params.id as string),
      "Routine not found",
    );
    if (!detail) return;
    res.json(detail);
  });

  router.get("/routines/:id/revisions", async (req, res) => {
    const routine = await getManageableRoutine(req, res, req.params.id as string);
    if (!routine) return;
    const revisions = await svc.listRevisions(routine.id);
    res.json(revisions);
  });

  router.get("/routines/:id/description/annotations", async (req, res) => {
    const routine = await getManageableRoutine(req, res, req.params.id as string);
    if (!routine) return;
    assertExactQueryKeys(req.query, ["includeComments", "status"]);
    const status = parseExactOptionalEnum(req.query.status, "status", ANNOTATION_STATUSES) ?? "open";
    const threads = await documentAnnotationsSvc.listThreadsForRoutineDocument(
      routine.id,
      routineDocumentKey,
      {
        status,
        includeComments: parseExactBooleanQuery(req.query.includeComments, "includeComments"),
      },
    );
    res.json(threads);
  });

  router.get("/routines/:id/description/annotations/:threadId", async (req, res) => {
    const routine = await getManageableRoutine(req, res, req.params.id as string);
    if (!routine) return;
    const thread = await documentAnnotationsSvc.getThreadForRoutineDocument(
      routine.id,
      routineDocumentKey,
      req.params.threadId as string,
    );
    if (!thread) {
      res.status(404).json({ error: "Annotation thread not found" });
      return;
    }
    res.json(thread);
  });

  router.post(
    "/routines/:id/description/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res) => {
      const routine = await getManageableRoutine(req, res, req.params.id as string);
      if (!routine) return;
      const annotationActor = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.createRoutineThread(
        routine.id,
        routineDocumentKey,
        req.body,
        annotationActor,
      );
      const firstComment = thread.comments[0];
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: "user",
        actorId: annotationActor.userId,
        action: "routine.document_annotation_thread_created",
        entityType: "routine",
        entityId: routine.id,
        details: {
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
        },
      });
      res.status(201).json(thread);
    },
  );

  router.post(
    "/routines/:id/description/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res) => {
      const routine = await getManageableRoutine(req, res, req.params.id as string);
      if (!routine) return;
      const annotationActor = annotationActorInput(req);
      const comment = await documentAnnotationsSvc.addRoutineComment(
        routine.id,
        routineDocumentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: "user",
        actorId: annotationActor.userId,
        action: "routine.document_annotation_comment_added",
        entityType: "routine",
        entityId: routine.id,
        details: {
          documentKey: routineDocumentKey,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
        },
      });
      res.status(201).json(comment);
    },
  );

  router.patch(
    "/routines/:id/description/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res) => {
      const routine = await getManageableRoutine(req, res, req.params.id as string);
      if (!routine) return;
      const annotationActor = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateRoutineThread(
        routine.id,
        routineDocumentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: "user",
        actorId: annotationActor.userId,
        action:
          thread.status === "resolved"
            ? "routine.document_annotation_thread_resolved"
            : "routine.document_annotation_thread_reopened",
        entityType: "routine",
        entityId: routine.id,
        details: {
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          status: thread.status,
        },
      });
      res.json(thread);
    },
  );
}
