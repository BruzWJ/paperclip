import { z } from "zod";

export const createAssetImageMetadataSchema = z.object({
  namespace: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9/_-]+$/)
    .refine(
      (value) => value === value.trim() && !value.includes("//"),
      "namespace must be exact and may not contain empty segments",
    )
    .optional(),
});

export type CreateAssetImageMetadata = z.infer<typeof createAssetImageMetadataSchema>;
