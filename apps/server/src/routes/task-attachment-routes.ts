import { createTaskAttachmentMetadataSchema, validationDetails } from "@paperclipai/shared";
import { type Request } from "express";
import multer from "multer";
import {
  isInlineAttachmentContentType,
  normalizeTaskAttachmentMaxBytes,
  normalizeUploadAttachmentContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskAttachmentRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "storage"
  | "router"
  | "svc"
  | "companiesSvc"
  | "withContentPath"
  | "parseAttachmentRangeHeader"
  | "parseAttachmentDownloadQuery"
  | "runSingleFileUpload"
  | "assertTaskReadAllowed"
  | "assertBoardTaskMutationAllowed"
  | "resolveAttachmentResponseContentType"
>;

export function registerTaskAttachmentRoutes(context: TaskAttachmentRoutesContext): void {
  const {
    db,
    storage,
    router,
    svc,
    companiesSvc,
    withContentPath,
    parseAttachmentRangeHeader,
    parseAttachmentDownloadQuery,
    runSingleFileUpload,
    assertTaskReadAllowed,
    assertBoardTaskMutationAllowed,
    resolveAttachmentResponseContentType,
  } = context;

  router.get("/tasks/:id/attachments", async (req, res) => {
    const taskId = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(taskId), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const attachments = await svc.listAttachments(taskId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/tasks/:taskId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskId = req.params.taskId as string;
    assertCompanyAccess(req, companyId);
    const task = await svc.getById(taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.companyId !== companyId) {
      res.status(422).json({ error: "Task does not belong to company" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeTaskAttachmentMaxBytes(company?.attachmentMaxBytes);

    try {
      await runSingleFileUpload(req, res, attachmentMaxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({
            error: `Attachment exceeds ${attachmentMaxBytes} bytes`,
          });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (
      req as Request & {
        file?: { mimetype: string; buffer: Buffer; originalname: string };
      }
    ).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeUploadAttachmentContentType({
      contentType: file.mimetype,
      originalFilename: file.originalname,
    });
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createTaskAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({
        error: "Invalid attachment metadata",
        details: validationDetails(parsedMeta.error),
      });
      return;
    }

    assertBoard(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `tasks/${taskId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      taskId,
      taskCommentId: parsedMeta.data.taskCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByUserId: req.actor.userId,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.attachment_added",
      entityType: "task",
      entityId: taskId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await getAccessibleResource(
      req,
      res,
      svc.getAttachmentById(attachmentId),
      "Attachment not found",
    );
    if (!attachment) return;
    const task = await svc.getById(attachment.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const forceDownload = parseAttachmentDownloadQuery(req.query.download);

    const contentLength = attachment.byteSize;
    const range = parseAttachmentRangeHeader(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
      contentLength,
    );
    res.setHeader("Accept-Ranges", "bytes");
    if (range.kind === "invalid") {
      res.setHeader("Content-Range", `bytes */${contentLength}`);
      res.status(416).end();
      return;
    }

    const object = await storage.getObject(
      attachment.companyId,
      attachment.objectKey,
      range.kind === "range" ? { range: { start: range.start, end: range.end } } : undefined,
    );
    const responseContentType = resolveAttachmentResponseContentType({
      storedContentType: attachment.contentType,
      objectContentType: object.contentType,
      originalFilename: attachment.originalFilename,
    });
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      );
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = forceDownload
      ? "attachment"
      : isInlineAttachmentContentType(responseContentType)
        ? "inline"
        : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll('"', "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    if (range.kind === "range") {
      const rangeLength = range.end - range.start + 1;
      res.status(206);
      res.setHeader("Content-Length", String(rangeLength));
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${contentLength}`);
      object.stream.pipe(res);
      return;
    }

    res.setHeader("Content-Length", String(contentLength || object.contentLength || 0));
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await getAccessibleResource(
      req,
      res,
      svc.getAttachmentById(attachmentId),
      "Attachment not found",
    );
    if (!attachment) return;
    const task = await svc.getById(attachment.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    assertBoard(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.attachment_removed",
      entityType: "task",
      entityId: removed.taskId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });
}
