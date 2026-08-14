import { documents, taskComments, tasks as taskRows, taskWorkProducts } from "@paperclipai/db";
import { createTaskWorkProductSchema, updateTaskWorkProductSchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { buildPromotedSourceTrust, isLowTrustQuarantined } from "../services/source-trust.js";
import { assertBoard, getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskWorkProductRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "router"
  | "svc"
  | "workProductsSvc"
  | "lookupLowTrustSourceArtifact"
  | "canonicalizePaperclipArtifactMetadata"
  | "assertTaskReadAllowed"
  | "assertBoardTaskMutationAllowed"
  | "resolveWorkProductCreatedByRunId"
  | "promoteLowTrustOutputSchema"
  | "requiresPaperclipAttachmentMetadata"
>;

export function registerTaskWorkProductRoutes(context: TaskWorkProductRoutesContext): void {
  const {
    db,
    router,
    svc,
    workProductsSvc,
    lookupLowTrustSourceArtifact,
    canonicalizePaperclipArtifactMetadata,
    assertTaskReadAllowed,
    assertBoardTaskMutationAllowed,
    resolveWorkProductCreatedByRunId,
    promoteLowTrustOutputSchema,
    requiresPaperclipAttachmentMetadata,
  } = context;

  router.post("/tasks/:id/work-products", validate(createTaskWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    assertBoard(req);
    const createInput = {
      ...req.body,
      projectId: req.body.projectId ?? task.projectId ?? null,
    };
    const createdByRunId = await resolveWorkProductCreatedByRunId(res, task.companyId, req.body, "create");
    if (createdByRunId === undefined) return;
    createInput.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(createInput)) {
      createInput.metadata = await canonicalizePaperclipArtifactMetadata({
        task,
        metadata: req.body.metadata ?? null,
      });
    }
    const product = await workProductsSvc.createForTask(task.id, task.companyId, createInput);
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.work_product_created",
      entityType: "task",
      entityId: task.id,
      details: {
        workProductId: product.id,
        type: product.type,
        provider: product.provider,
      },
    });
    res.status(201).json(product);
  });

  router.post("/tasks/:id/low-trust/promotions", validate(promoteLowTrustOutputSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    assertBoard(req);
    const sourceTrust = await lookupLowTrustSourceArtifact({
      taskId: task.id,
      artifactKind: req.body.sourceArtifactKind,
      artifactId: req.body.sourceArtifactId,
    });
    if (!sourceTrust) {
      res.status(404).json({ error: "Low-trust source artifact not found" });
      return;
    }
    if (!isLowTrustQuarantined(sourceTrust)) {
      res.status(422).json({
        error: "Source artifact is not quarantined low-trust output",
      });
      return;
    }

    const promotedAt = new Date();
    const promotionTrust = buildPromotedSourceTrust({
      sourceTaskId: task.id,
      sourceArtifactKind: req.body.sourceArtifactKind,
      sourceArtifactId: req.body.sourceArtifactId,
      promotedByActorType: "user",
      promotedByActorId: req.actor.userId,
      promotedAt,
    });
    const product = await db.transaction(async (tx) => {
      const markPromoted = {
        sourceTrust: promotionTrust,
        updatedAt: promotedAt,
      };
      const updatedSource = await (async () => {
        if (req.body.sourceArtifactKind === "task") {
          return tx
            .update(taskRows)
            .set(markPromoted)
            .where(and(eq(taskRows.id, req.body.sourceArtifactId), eq(taskRows.sourceTrust, sourceTrust)))
            .returning({ id: taskRows.id });
        }
        if (req.body.sourceArtifactKind === "comment") {
          return tx
            .select({ id: taskComments.id })
            .from(taskComments)
            .where(
              and(
                eq(taskComments.id, req.body.sourceArtifactId),
                eq(taskComments.taskId, task.id),
                eq(taskComments.sourceTrust, sourceTrust),
              ),
            )
            .limit(1);
        }
        if (req.body.sourceArtifactKind === "document") {
          return tx
            .update(documents)
            .set(markPromoted)
            .where(and(eq(documents.id, req.body.sourceArtifactId), eq(documents.sourceTrust, sourceTrust)))
            .returning({ id: documents.id });
        }
        return tx
          .update(taskWorkProducts)
          .set(markPromoted)
          .where(
            and(
              eq(taskWorkProducts.id, req.body.sourceArtifactId),
              eq(taskWorkProducts.taskId, task.id),
              eq(taskWorkProducts.sourceTrust, sourceTrust),
            ),
          )
          .returning({ id: taskWorkProducts.id });
      })();
      if (!updatedSource[0]) return null;

      return tx
        .insert(taskWorkProducts)
        .values({
          companyId: task.companyId,
          taskId: task.id,
          projectId: task.projectId ?? null,
          type: "artifact",
          provider: "paperclip",
          externalId: req.body.sourceArtifactId,
          title: req.body.title,
          status: "approved",
          reviewState: "approved",
          isPrimary: false,
          healthStatus: "unknown",
          summary: req.body.summary,
          metadata: {
            promotion: {
              sourceArtifactKind: req.body.sourceArtifactKind,
              sourceArtifactId: req.body.sourceArtifactId,
            },
          },
          sourceTrust: promotionTrust,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
    });
    if (!product) {
      res.status(422).json({
        error: "Source artifact is not quarantined low-trust output",
      });
      return;
    }

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.low_trust_output_promoted",
      entityType: "task",
      entityId: task.id,
      details: {
        sourceArtifacts: [
          {
            artifactKind: req.body.sourceArtifactKind,
            artifactId: req.body.sourceArtifactId,
          },
        ],
        reviewerPrincipal: {
          actorType: "user",
          actorId: req.actor.userId,
        },
        targetTaskId: task.id,
        promotedWorkProductId: product.id,
        decision: "promoted",
      },
    });

    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateTaskWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      workProductsSvc.getById(id),
      "Work product not found",
    );
    if (!existing) return;
    const task = await svc.getById(existing.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    assertBoard(req);
    const patch = { ...req.body };
    const createdByRunId = await resolveWorkProductCreatedByRunId(
      res,
      existing.companyId,
      req.body,
      "update",
    );
    if (createdByRunId === undefined && Object.prototype.hasOwnProperty.call(req.body, "createdByRunId"))
      return;
    if (createdByRunId !== undefined) patch.createdByRunId = createdByRunId;
    if (requiresPaperclipAttachmentMetadata(patch, existing)) {
      if (patch.metadata !== undefined) {
        patch.metadata = await canonicalizePaperclipArtifactMetadata({
          task,
          metadata: patch.metadata ?? null,
        });
      } else if (!requiresPaperclipAttachmentMetadata(existing)) {
        res.status(422).json({ error: "Attachment-backed artifact metadata is required" });
        return;
      }
    }
    const product = await workProductsSvc.update(id, patch);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.work_product_updated",
      entityType: "task",
      entityId: existing.taskId,
      details: {
        workProductId: product.id,
        changedKeys: Object.keys(req.body).sort(),
      },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      workProductsSvc.getById(id),
      "Work product not found",
    );
    if (!existing) return;
    const task = await svc.getById(existing.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertBoard(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.work_product_deleted",
      entityType: "task",
      entityId: existing.taskId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });
}
