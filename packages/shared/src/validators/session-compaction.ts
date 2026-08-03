import { z } from "zod";

export const sessionCompactionSettingsSchema = z
  .object({
    auto: z.boolean().optional(),
    prune: z.boolean().optional(),
    reserved: z.number().int().min(0).optional(),
    tail_turns: z.number().int().min(0).optional(),
    preserve_recent_tokens: z.number().int().min(0).optional(),
    modelRef: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const updateSessionCompactionSettingsSchema =
  sessionCompactionSettingsSchema;

export type UpdateSessionCompactionSettings = z.infer<
  typeof updateSessionCompactionSettingsSchema
>;
