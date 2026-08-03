import { z } from "zod";

const exactAdapterTypeSchema = z.string().refine(
  (value) => value.length > 0 && value === value.trim(),
  "Adapter type must be an exact non-blank string",
);

export const adapterRegistryEntrySchema = z
  .object({
    adapterType: exactAdapterTypeSchema,
    enabled: z.boolean().default(true),
    runtimeImage: z.string().optional(),
    allowFqdns: z.array(z.string()).optional(),
    probeCommand: z.array(z.string()).optional(),
  })
  .strict();

export const adapterRegistrySchema = z.array(adapterRegistryEntrySchema);

export type AdapterRegistryEntryParsed = z.infer<typeof adapterRegistryEntrySchema>;
