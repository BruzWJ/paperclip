import { z } from "zod";

const exactNonBlankString = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "must not contain leading or trailing whitespace",
  });

/**
 * One declarative agent-harness ("adapter") entry. Governs picker availability
 * and, for sandboxed (Kubernetes) runs, the runtime wiring.
 *
 * This plugin is standalone-installable, so it owns its boundary parser rather
 * than importing workspace packages. It consumes the common registry fields
 * but deliberately narrows runtimeImage from optional to required: a
 * Kubernetes execution cannot infer or fall back to a provider image.
 */
export const adapterRegistryEntrySchema = z
  .object({
    adapterType: exactNonBlankString,
    enabled: z.boolean().default(true),
    runtimeImage: exactNonBlankString,
    allowFqdns: z.array(z.string()).optional(),
    probeCommand: z.array(z.string()).optional(),
  })
  .strict();

export const adapterRegistrySchema = z.array(adapterRegistryEntrySchema);

export type AdapterRegistryEntry = z.infer<typeof adapterRegistryEntrySchema>;
