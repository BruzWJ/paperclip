import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import { addValidationDetail } from "../validation-details.js";

export const inboxAgentPolicyModeSchema = z.enum(["open", "allowlist", "disabled"]);

export const updateInboxAgentPolicySchema = z.object({
  mode: inboxAgentPolicyModeSchema,
  allowedAgentIds: z.array(canonicalUuidSchema).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.mode !== "allowlist" && value.allowedAgentIds.length > 0) {
    addValidationDetail(ctx, {
      code: "custom",
      message: "allowedAgentIds must be empty when mode is not \"allowlist\"",
      path: ["allowedAgentIds"],
    });
  }
});

export type UpdateInboxAgentPolicy = z.infer<typeof updateInboxAgentPolicySchema>;
