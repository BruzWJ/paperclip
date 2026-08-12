import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import { addValidationDetail } from "../validation-details.js";

function attachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

export const taskWorkProductTypeSchema = z.enum([
  "preview_url",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
]);

export const taskWorkProductStatusSchema = z.enum([
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
  "draft",
]);

export const taskWorkProductReviewStateSchema = z.enum([
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
]);

export const attachmentArtifactWorkProductMetadataSchema = z.object({
  attachmentId: canonicalUuidSchema,
  contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  contentPath: z.string().min(1),
  openPath: z.string().min(1),
  downloadPath: z.string().min(1),
  originalFilename: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  const contentPath = attachmentContentPath(value.attachmentId);
  if (value.contentPath !== contentPath) {
    addValidationDetail(ctx, {
      path: ["contentPath"],
      message: "contentPath must point to the same-origin attachment content route",
    });
  }
  if (value.openPath !== contentPath) {
    addValidationDetail(ctx, {
      path: ["openPath"],
      message: "openPath must point to the same-origin attachment content route",
    });
  }
  if (value.downloadPath !== `${contentPath}?download=1`) {
    addValidationDetail(ctx, {
      path: ["downloadPath"],
      message: "downloadPath must point to the same-origin attachment download route",
    });
  }
});

export type AttachmentArtifactWorkProductMetadata = z.infer<typeof attachmentArtifactWorkProductMetadataSchema>;

export const taskWorkProductMetadataSchema = z
  .object({})
  .passthrough();

export type TaskWorkProductMetadata = z.infer<typeof taskWorkProductMetadataSchema>;

export const createTaskWorkProductSchema = z.object({
  projectId: canonicalUuidSchema.optional().nullable(),
  type: taskWorkProductTypeSchema,
  provider: z.string().min(1),
  externalId: z.string().optional().nullable(),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  status: taskWorkProductStatusSchema.default("active"),
  reviewState: taskWorkProductReviewStateSchema.optional().default("none"),
  isPrimary: z.boolean().optional().default(false),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]).optional().default("unknown"),
  summary: z.string().optional().nullable(),
  metadata: taskWorkProductMetadataSchema.optional().nullable(),
  createdByRunId: canonicalUuidSchema.optional().nullable(),
});

export type CreateTaskWorkProduct = z.infer<typeof createTaskWorkProductSchema>;

export const updateTaskWorkProductSchema = createTaskWorkProductSchema.partial();

export type UpdateTaskWorkProduct = z.infer<typeof updateTaskWorkProductSchema>;
