import { z } from "zod";

const exactNonBlankString = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "must not contain leading or trailing whitespace",
  });

/**
 * One target-local runtime mapping keyed by an ACPX agent name. It supplies
 * Kubernetes wiring only; it cannot govern picker availability or add an
 * agent to Paperclip's ACPX-supplied catalog.
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
