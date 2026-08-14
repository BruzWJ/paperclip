import { restoreTaskDocumentRevisionSchema, upsertTaskDocumentSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskDocumentRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "router"
  | "svc"
  | "documentsSvc"
  | "documentAnnotationsSvc"
  | "taskReferencesSvc"
  | "parseTaskDocumentKeyParam"
  | "assertTaskReadAllowed"
  | "assertBoardTaskMutationAllowed"
  | "summarizeTaskRelationForActivity"
  | "summarizeTaskReferenceActivityDetails"
>;

export function registerTaskDocumentRoutes(context: TaskDocumentRoutesContext): void {
  const {
    db,
    router,
    svc,
    documentsSvc,
    documentAnnotationsSvc,
    taskReferencesSvc,
    parseTaskDocumentKeyParam,
    assertTaskReadAllowed,
    assertBoardTaskMutationAllowed,
    summarizeTaskRelationForActivity,
    summarizeTaskReferenceActivityDetails,
  } = context;

  router.put("/tasks/:id/documents/:key", validate(upsertTaskDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;

    assertBoard(req);
    const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const result = await documentsSvc.upsertTaskDocument({
      taskId: task.id,
      key: documentKey,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByUserId: req.actor.userId,
      lockedDocumentStrategy: "conflict",
    });
    const doc = result.document;
    const redirectedFromLockedDocument =
      "redirectedFromLockedDocument" in result ? result.redirectedFromLockedDocument : null;
    const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
      referenceSummaryBefore,
      referenceSummaryAfter,
    );
    const remappedAnnotations = result.created
      ? []
      : await documentAnnotationsSvc.remapOpenThreadsForDocument({
          taskId: task.id,
          key: doc.key,
          documentId: doc.id,
          nextRevisionId: doc.latestRevisionId,
          nextRevisionNumber: doc.latestRevisionNumber,
          nextBody: doc.body,
        });

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: result.created ? "task.document_created" : "task.document_updated",
      entityType: "task",
      entityId: task.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        redirectedFromLockedDocument,
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });

    for (const remap of remappedAnnotations) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_annotation_remapped",
        entityType: "task",
        entityId: task.id,
        details: {
          key: doc.key,
          documentId: doc.id,
          threadId: remap.thread.id,
          revisionNumber: doc.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.post("/tasks/:id/documents/:key/lock", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;

    assertBoard(req);
    const result = await documentsSvc.lockTaskDocument({
      taskId: task.id,
      key: documentKey,
      lockedByUserId: req.actor.userId,
    });

    if (result.changed) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_locked",
        entityType: "task",
        entityId: task.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          lockedAt: result.document.lockedAt,
        },
      });
    }

    res.json(result.document);
  });

  router.post("/tasks/:id/documents/:key/unlock", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;

    assertBoard(req);
    const result = await documentsSvc.unlockTaskDocument(task.id, documentKey);

    if (result.changed) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_unlocked",
        entityType: "task",
        entityId: task.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
        },
      });
    }

    res.json(result.document);
  });

  router.get("/tasks/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;
    const revisions = await documentsSvc.listTaskDocumentRevisions(task.id, documentKey);
    res.json(revisions);
  });

  router.post(
    "/tasks/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreTaskDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const documentKey = parseTaskDocumentKeyParam(req, res);
      if (!documentKey) return;

      assertBoard(req);
      const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const result = await documentsSvc.restoreTaskDocumentRevision({
        taskId: task.id,
        key: documentKey,
        revisionId,
        createdByUserId: req.actor.userId,
      });
      const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
        referenceSummaryBefore,
        referenceSummaryAfter,
      );
      const remappedAnnotations = await documentAnnotationsSvc.remapOpenThreadsForDocument({
        taskId: task.id,
        key: result.document.key,
        documentId: result.document.id,
        nextRevisionId: result.document.latestRevisionId,
        nextRevisionNumber: result.document.latestRevisionNumber,
        nextBody: result.document.body,
      });

      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.document_restored",
        entityType: "task",
        entityId: task.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
          ...summarizeTaskReferenceActivityDetails({
            addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
            removedReferencedTasks: referenceDiff.removedReferencedTasks.map(
              summarizeTaskRelationForActivity,
            ),
            currentReferencedTasks: referenceDiff.currentReferencedTasks.map(
              summarizeTaskRelationForActivity,
            ),
          }),
        },
      });

      for (const remap of remappedAnnotations) {
        await logActivity(db, {
          companyId: task.companyId,
          actorType: "user",
          actorId: req.actor.userId,
          action: "task.document_annotation_remapped",
          entityType: "task",
          entityId: task.id,
          details: {
            key: result.document.key,
            documentId: result.document.id,
            threadId: remap.thread.id,
            revisionNumber: result.document.latestRevisionNumber,
            anchorState: remap.thread.anchorState,
            anchorConfidence: remap.thread.anchorConfidence,
            snapshotId: remap.snapshot.id,
          },
        });
      }

      res.json(result.document);
    },
  );

  router.delete("/tasks/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;
    const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const removed = await documentsSvc.deleteTaskDocument(task.id, documentKey);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
    const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
      referenceSummaryBefore,
      referenceSummaryAfter,
    );
    assertBoard(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.document_deleted",
      entityType: "task",
      entityId: task.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeTaskReferenceActivityDetails({
          addedReferencedTasks: referenceDiff.addedReferencedTasks.map(summarizeTaskRelationForActivity),
          removedReferencedTasks: referenceDiff.removedReferencedTasks.map(summarizeTaskRelationForActivity),
          currentReferencedTasks: referenceDiff.currentReferencedTasks.map(summarizeTaskRelationForActivity),
        }),
      },
    });
    res.json({ ok: true });
  });
}
