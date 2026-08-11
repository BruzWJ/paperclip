import { z } from "zod";
import { PROJECT_STATUSES, PROJECT_ICON_NAMES } from "../constants.js";
import { envConfigSchema } from "./secret.js";

const absoluteProjectFolderSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      /^\\\\/.test(value),
    "Local folder must be an absolute path.",
  );

const projectRepositoryUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && url.pathname.split("/").filter(Boolean).length >= 2;
    } catch {
      return false;
    }
  }, {
    message: "Repository URL must use HTTPS and include an owner and repository.",
  });

export const projectCodebaseInputSchema = z
  .object({
    localFolder: absoluteProjectFolderSchema.optional().nullable(),
    repoUrl: projectRepositoryUrlSchema.optional().nullable(),
  })
  .strict();

export const updateProjectCodebaseSchema = projectCodebaseInputSchema.superRefine(
  (value, ctx) => {
    if (value.localFolder === undefined && value.repoUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Codebase update requires localFolder or repoUrl.",
      });
    }
  },
);

export type ProjectCodebaseInput = z.infer<typeof projectCodebaseInputSchema>;
export type UpdateProjectCodebase = z.infer<typeof updateProjectCodebaseSchema>;

export const projectCodebaseSchema = z.object({
  workspaceId: z.string().uuid().nullable(),
  repoUrl: z.string().nullable(),
  localFolder: z.string().nullable(),
}).strict();

const projectFields = {
  goalIds: z.array(z.string().uuid()).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: z.string().uuid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  icon: z.enum(PROJECT_ICON_NAMES).optional().nullable(),
  env: envConfigSchema.optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
};

export const createProjectSchema = z.object({
  ...projectFields,
  codebase: projectCodebaseInputSchema.optional(),
}).strict();

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object(projectFields).partial().strict();

export type UpdateProject = z.infer<typeof updateProjectSchema>;
