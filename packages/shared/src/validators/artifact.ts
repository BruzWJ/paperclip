import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import { parseTaskIdentifier } from "../task-identifier.js";
import { MAX_TASK_NUMBER } from "../task-number.js";

export const COMPANY_ARTIFACTS_DEFAULT_LIMIT = 30;
export const COMPANY_ARTIFACTS_MAX_LIMIT = 100;
export const COMPANY_ARTIFACTS_MAX_QUERY_LENGTH = 160;

export const companyArtifactSourceSchema = z.enum([
  "document",
  "attachment",
  "work_product",
]);

export const companyArtifactMediaKindSchema = z.enum([
  "image",
  "video",
  "text",
  "document",
  "file",
  "empty",
]);

export const companyArtifactGroupBySchema = z.enum([
  "none",
  "task",
  "parent_task",
]);

const exactOptionalArtifactQuery = z
  .string()
  .min(1)
  .max(COMPANY_ARTIFACTS_MAX_QUERY_LENGTH)
  .refine((value) => value.trim() === value, {
    message: "Query values must not contain surrounding whitespace",
  });

const exactArtifactLimitSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(COMPANY_ARTIFACTS_MAX_LIMIT));

export const companyArtifactsQuerySchema = z
  .object({
    kind: z
      .enum(["image", "video", "text", "document", "file", "all"])
      .optional()
      .default("all"),
    projectId: canonicalUuidSchema.optional(),
    q: exactOptionalArtifactQuery.optional(),
    groupBy: companyArtifactGroupBySchema.optional().default("none"),
    groupTaskId: canonicalUuidSchema.optional(),
    limit: z.preprocess(
      (value) =>
        value === undefined ? String(COMPANY_ARTIFACTS_DEFAULT_LIMIT) : value,
      exactArtifactLimitSchema,
    ),
    cursor: exactOptionalArtifactQuery.optional(),
  })
  .strict();

export const companyArtifactSchema = z.object({
  id: z.string().min(1),
  source: companyArtifactSourceSchema,
  mediaKind: companyArtifactMediaKindSchema,
  title: z.string(),
  previewText: z.string().nullable(),
  contentType: z.string().nullable(),
  contentPath: z.string().nullable(),
  openPath: z.string().nullable(),
  downloadPath: z.string().nullable(),
  task: z.object({
    id: canonicalUuidSchema,
    taskNumber: z.number().int().positive().max(MAX_TASK_NUMBER),
    identifier: z
      .string()
      .max(80)
      .refine(
        (value) => parseTaskIdentifier(value) !== null,
        "identifier must use its exact display form",
      ),
    title: z.string().nullable(),
  }),
  project: z
    .object({
      id: canonicalUuidSchema,
      name: z.string(),
    })
    .nullable(),
  createdByAgent: z
    .object({
      id: canonicalUuidSchema,
      name: z.string(),
    })
    .nullable(),
  updatedAt: z.string().datetime(),
  taskFragment: z
    .string()
    .min(1)
    .refine(
      (value) => value.trim() === value,
      "taskFragment must use its exact non-blank form",
    ),
});

export const companyArtifactGroupSchema = z.object({
  id: z.string().min(1),
  groupBy: companyArtifactGroupBySchema.exclude(["none"]),
  task: z.object({
    id: canonicalUuidSchema,
    taskNumber: z.number().int().positive().max(MAX_TASK_NUMBER),
    identifier: z
      .string()
      .max(80)
      .refine(
        (value) => parseTaskIdentifier(value) !== null,
        "identifier must use its exact display form",
      ),
    title: z.string().nullable(),
  }),
  title: z.string(),
  count: z.number().int().min(0),
  mediaKinds: z.array(companyArtifactMediaKindSchema),
  previewArtifacts: z.array(companyArtifactSchema),
  updatedAt: z.string().datetime(),
});

export const companyArtifactsResponseSchema = z.object({
  artifacts: z.array(companyArtifactSchema),
  groups: z.array(companyArtifactGroupSchema).optional(),
  selectedGroup: companyArtifactGroupSchema.nullable().optional(),
  nextCursor: z.string().nullable(),
});

export type CompanyArtifactsQuery = z.infer<typeof companyArtifactsQuerySchema>;
