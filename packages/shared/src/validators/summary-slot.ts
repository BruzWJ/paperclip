import { z } from "zod";
import {
  SUMMARY_SLOT_KEYS,
  SUMMARY_SLOT_SCOPE_KINDS,
  SUMMARY_SLOT_STATUSES,
} from "../constants.js";

const optionalScopeIdSchema = z.string().uuid().optional().nullable();

export const summarySlotScopeKindSchema = z.enum(SUMMARY_SLOT_SCOPE_KINDS);
export const summarySlotKeySchema = z.enum(SUMMARY_SLOT_KEYS);
export const summarySlotStatusSchema = z.enum(SUMMARY_SLOT_STATUSES);

export const summarySlotScopeSelectorSchema = z
  .object({
    scopeKind: summarySlotScopeKindSchema,
    scopeId: optionalScopeIdSchema,
    slotKey: summarySlotKeySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasScopeId = typeof value.scopeId === "string";
    if (value.scopeKind === "workspaces_overview") {
      if (hasScopeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspaces_overview summary slots must not include scopeId",
          path: ["scopeId"],
        });
      }
      return;
    }
    if (!hasScopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.scopeKind} summary slots require scopeId`,
        path: ["scopeId"],
      });
    }
  });

export const summarySlotQuerySchema = z
  .object({
    scopeId: optionalScopeIdSchema,
  })
  .strict();

export const refreshSummarySlotSchema = summarySlotQuerySchema.extend({
  // Required only while a board operator creates the slot's stable routine.
  // Once configured, refreshes use that routine's owner.
  ownerAgentId: z.string().uuid().optional(),
});

export type SummarySlotScopeSelectorInput = z.infer<typeof summarySlotScopeSelectorSchema>;
export type RefreshSummarySlotInput = z.infer<typeof refreshSummarySlotSchema>;
