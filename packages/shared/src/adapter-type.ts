import { z } from "zod";

export const agentAdapterTypeSchema = z
  .string()
  .trim()
  .min(1)
  .describe("Exact ACPX registry agent name; availability is checked dynamically by the server.");

export const optionalAgentAdapterTypeSchema = z
  .string()
  .trim()
  .min(1)
  .optional();
