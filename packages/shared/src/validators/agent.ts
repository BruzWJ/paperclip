import { z } from "zod";

/**
 * Unsaved editor values for ACPX session options. The active discovered
 * adapter contract validates exact ids and allowed values before persistence.
 */
export const adapterConfigSchema = z.record(
  z.string(),
  z.union([z.string().min(1), z.boolean()]),
);
