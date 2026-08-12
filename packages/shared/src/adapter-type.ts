import { z } from "zod";

export const agentAdapterTypeSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "ACPX registry agent name must already be an exact nonblank string",
  )
  .describe("Exact ACPX registry agent name; availability is checked dynamically by the server.");

export const optionalAgentAdapterTypeSchema = agentAdapterTypeSchema.optional();
