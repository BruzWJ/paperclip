import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import { FINANCE_DIRECTIONS, FINANCE_EVENT_KINDS, FINANCE_UNITS } from "../constants.js";
import { moneyAmountSchema } from "../money.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";

export const createFinanceEventSchema = z.object({
  agentId: canonicalUuidSchema.optional().nullable(),
  taskId: canonicalUuidSchema.optional().nullable(),
  projectId: canonicalUuidSchema.optional().nullable(),
  goalId: canonicalUuidSchema.optional().nullable(),
  billingCode: z.string().optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  eventKind: z.enum(FINANCE_EVENT_KINDS),
  direction: z.enum(FINANCE_DIRECTIONS).optional().default("debit"),
  biller: z.string().min(1),
  provider: z.string().min(1).optional().nullable(),
  executionAdapterType: agentAdapterTypeSchema.optional().nullable(),
  pricingTier: z.string().min(1).optional().nullable(),
  region: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional().nullable(),
  quantity: z.number().int().nonnegative().optional().nullable(),
  unit: z.enum(FINANCE_UNITS).optional().nullable(),
  amount: moneyAmountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  estimated: z.boolean().optional().default(false),
  externalInvoiceId: z.string().optional().nullable(),
  metadataJson: z.record(z.string(), z.unknown()).optional().nullable(),
  occurredAt: z.string().datetime(),
}).strict();

export type CreateFinanceEvent = z.infer<typeof createFinanceEventSchema>;
