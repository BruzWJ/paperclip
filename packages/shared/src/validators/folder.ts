import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";

export const folderKindSchema = z.literal("routine");
export const folderSlugSchema = z.string().min(1).max(120).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "Folder slug must contain only lowercase letters, numbers, and single hyphens",
);

export const folderSchema = z.object({
  id: canonicalUuidSchema,
  companyId: canonicalUuidSchema,
  kind: folderKindSchema,
  parentId: canonicalUuidSchema.nullable(),
  name: z.string().min(1),
  slug: folderSlugSchema,
  systemKey: z.string().nullable(),
  path: z.string().min(1),
  depth: z.number().int().min(1),
  color: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const folderListItemSchema = folderSchema.extend({
  itemCount: z.number().int().nonnegative(),
});

export const folderListResultSchema = z.object({
  kind: folderKindSchema,
  folders: z.array(folderListItemSchema),
  allCount: z.number().int().nonnegative(),
  unfiledCount: z.number().int().nonnegative(),
});

const exactFolderText = (max: number) => z.string().min(1).max(max).refine(
  (value) => value.trim() === value,
  "Folder values must not contain surrounding whitespace",
);

export const createFolderSchema = z.object({
  kind: folderKindSchema,
  parentId: canonicalUuidSchema.optional().nullable(),
  name: exactFolderText(120),
  slug: folderSlugSchema.optional().nullable(),
  color: exactFolderText(80).optional().nullable(),
  position: z.number().int().min(0).optional().nullable(),
});

export const updateFolderSchema = z.object({
  name: exactFolderText(120).optional(),
  slug: folderSlugSchema.optional(),
  color: exactFolderText(80).optional().nullable(),
  position: z.number().int().min(0).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one folder field is required",
});

export const moveFolderSchema = z.object({
  parentId: canonicalUuidSchema.optional().nullable(),
  position: z.number().int().min(0),
});

export const moveFolderItemSchema = z.object({
  kind: folderKindSchema,
  itemId: canonicalUuidSchema,
  folderId: canonicalUuidSchema.optional().nullable(),
});

export type CreateFolder = z.infer<typeof createFolderSchema>;
export type UpdateFolder = z.infer<typeof updateFolderSchema>;
export type MoveFolder = z.infer<typeof moveFolderSchema>;
export type MoveFolderItem = z.infer<typeof moveFolderItemSchema>;
