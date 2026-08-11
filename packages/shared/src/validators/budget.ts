import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import {
  BUDGET_INCIDENT_RESOLUTION_ACTIONS,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOW_KINDS,
} from "../constants.js";
import { moneyAmountSchema } from "../money.js";

export const upsertBudgetPolicySchema = z
  .object({
    scopeType: z.enum(BUDGET_SCOPE_TYPES),
    scopeId: z.string().uuid(),
    windowKind: z.enum(BUDGET_WINDOW_KINDS).optional(),
    limitAmount: moneyAmountSchema,
    warnPercent: z.number().int().min(1).max(99).optional().default(80),
    hardStopEnabled: z.boolean().optional().default(true),
    notifyEnabled: z.boolean().optional().default(true),
    isActive: z.boolean().optional().default(true),
  })
  .strict();

export type UpsertBudgetPolicy = z.infer<typeof upsertBudgetPolicySchema>;

export const resolveBudgetIncidentSchema = z
  .object({
    action: z.enum(BUDGET_INCIDENT_RESOLUTION_ACTIONS),
    limitAmount: moneyAmountSchema.optional(),
    decisionNote: z.string().optional().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.action === "raise_budget_and_resume" &&
      value.limitAmount === undefined
    ) {
      addValidationDetail(context, {
        message: "limitAmount is required when raising a budget",
        path: ["limitAmount"],
      });
    }
  });

export type ResolveBudgetIncident = z.infer<
  typeof resolveBudgetIncidentSchema
>;
