import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import { addValidationDetail } from "../validation-details.js";
import { PROJECT_STATUSES, PROJECT_ICON_NAMES } from "../constants.js";
import {
  isAbsoluteProjectFolder,
  isCanonicalProjectRepositoryUrl,
} from "../project-codebase.js";
import { envConfigSchema } from "./secret.js";

const absoluteProjectFolderSchema = z
  .string()
  .min(1)
  .refine(
    isAbsoluteProjectFolder,
    "Local folder must be an exact absolute path without surrounding whitespace.",
  );

const projectRepositoryUrlSchema = z
  .string()
  .url()
  .refine(isCanonicalProjectRepositoryUrl, {
    message:
      "Repository URL must use its exact canonical HTTPS serialization and include an owner and repository.",
  });

export const projectCodebaseInputSchema = z
  .object({
    localFolder: absoluteProjectFolderSchema.optional().nullable(),
    repoUrl: projectRepositoryUrlSchema.optional().nullable(),
  })
  .strict();

export const updateProjectCodebaseSchema =
  projectCodebaseInputSchema.superRefine((value, ctx) => {
    if (value.localFolder === undefined && value.repoUrl === undefined) {
      addValidationDetail(ctx, {
        message: "Codebase update requires localFolder or repoUrl.",
      });
    }
  });

export type ProjectCodebaseInput = z.infer<typeof projectCodebaseInputSchema>;
export type UpdateProjectCodebase = z.infer<typeof updateProjectCodebaseSchema>;

export const projectCodebaseSchema = z
  .object({
    workspaceId: canonicalUuidSchema.nullable(),
    repoUrl: projectRepositoryUrlSchema.nullable(),
    localFolder: absoluteProjectFolderSchema.nullable(),
  })
  .strict();

const projectFields = {
  goalIds: z.array(canonicalUuidSchema).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: canonicalUuidSchema.optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z
    .string()
    .regex(
      /^#[0-9a-f]{6}$/,
      "Color must be an exact lowercase six-digit hex value",
    )
    .optional()
    .nullable(),
  icon: z.enum(PROJECT_ICON_NAMES).optional().nullable(),
  env: envConfigSchema.optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
};

export const createProjectSchema = z
  .object({
    ...projectFields,
    codebase: projectCodebaseInputSchema.optional(),
  })
  .strict();

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object(projectFields).partial().strict();

export type UpdateProject = z.infer<typeof updateProjectSchema>;
