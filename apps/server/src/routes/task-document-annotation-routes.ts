import {
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  updateDocumentAnnotationThreadSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskDocumentAnnotationRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "router"
  | "svc"
  | "documentsSvc"
  | "documentAnnotationsSvc"
  | "taskReferencesSvc"
  | "parseBooleanQuery"
  | "shouldIncludeDocumentAnnotations"
  | "shouldIncludeDocumentAnnotationComments"
  | "parseTaskDocumentKeyParam"
  | "parseDocumentAnnotationStatus"
  | "annotationActorInput"
  | "assertTaskReadAllowed"
  | "assertBoardTaskMutationAllowed"
  | "summarizeTaskRelationForActivity"
  | "summarizeTaskReferenceActivityDetails"
>;

export function registerTaskDocumentAnnotationRoutes(context: TaskDocumentAnnotationRoutesContext): void {
  const {
    db,
    router,
    svc,
    documentsSvc,
    documentAnnotationsSvc,
    taskReferencesSvc,
    parseBooleanQuery,
    shouldIncludeDocumentAnnotations,
    shouldIncludeDocumentAnnotationComments,
    parseTaskDocumentKeyParam,
    parseDocumentAnnotationStatus,
    annotationActorInput,
    assertTaskReadAllowed,
    assertBoardTaskMutationAllowed,
    summarizeTaskRelationForActivity,
    summarizeTaskReferenceActivityDetails,
  } = context;

  router.get("/tasks/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;
    const doc = await documentsSvc.getTaskDocumentByKey(task.id, documentKey);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (!shouldIncludeDocumentAnnotations(req)) {
      res.json(doc);
      return;
    }
    const annotations = await documentAnnotationsSvc.listThreadsForTaskDocument(task.id, documentKey, {
      status: "open",
      includeComments: shouldIncludeDocumentAnnotationComments(req),
    });
    res.json({ ...doc, annotations });
  });

  router.get("/tasks/:id/documents/:key/annotations", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;
    const status = parseDocumentAnnotationStatus(req.query.status);
    const threads = await documentAnnotationsSvc.listThreadsForTaskDocument(task.id, documentKey, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments, "includeComments"),
    });
    res.json(threads);
  });

  router.post(
    "/tasks/:id/documents/:key/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const documentKey = parseTaskDocumentKeyParam(req, res);
      if (!documentKey) return;

      const { userId, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const thread = await documentAnnotationsSvc.createThread(
        task.id,
        documentKey,
        req.body,
        annotationActor,
      );
      const firstComment = thread.comments[0];
      const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
        referenceSummaryBefore,
        referenceSummaryAfter,
      );

      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: userId,
        action: "task.document_annotation_thread_created",
        entityType: "task",
        entityId: task.id,
        details: {
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
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

      res.status(201).json(thread);
    },
  );

  router.get("/tasks/:id/documents/:key/annotations/:threadId", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const documentKey = parseTaskDocumentKeyParam(req, res);
    if (!documentKey) return;
    const thread = await documentAnnotationsSvc.getThreadForTaskDocument(
      task.id,
      documentKey,
      req.params.threadId as string,
    );
    if (!thread) {
      res.status(404).json({ error: "Annotation thread not found" });
      return;
    }
    res.json(thread);
  });

  router.post(
    "/tasks/:id/documents/:key/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const documentKey = parseTaskDocumentKeyParam(req, res);
      if (!documentKey) return;

      const { userId, annotationActor } = annotationActorInput(req);
      const referenceSummaryBefore = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const comment = await documentAnnotationsSvc.addComment(
        task.id,
        documentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      const referenceSummaryAfter = await taskReferencesSvc.listTaskReferenceSummary(task.id);
      const referenceDiff = taskReferencesSvc.diffTaskReferenceSummary(
        referenceSummaryBefore,
        referenceSummaryAfter,
      );

      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: userId,
        action: "task.document_annotation_comment_added",
        entityType: "task",
        entityId: task.id,
        details: {
          documentKey,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
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

      res.status(201).json(comment);
    },
  );

  router.patch(
    "/tasks/:id/documents/:key/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!task) return;
      if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
      const documentKey = parseTaskDocumentKeyParam(req, res);
      if (!documentKey) return;
      const { userId, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateThread(
        task.id,
        documentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: userId,
        action:
          thread.status === "resolved"
            ? "task.document_annotation_thread_resolved"
            : "task.document_annotation_thread_reopened",
        entityType: "task",
        entityId: task.id,
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
