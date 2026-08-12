import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import {
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_PRESET_VERSION,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  TRUST_PRESETS,
} from "../trust-policy.js";

export const trustPresetSchema = z.enum(TRUST_PRESETS);

export const lowTrustOutputPromotionTargetSchema = z.object({
  type: z.literal("task"),
  taskId: canonicalUuidSchema,
}).strict();

export const lowTrustBoundarySchema = z.object({
  mode: z.literal(LOW_TRUST_REVIEW_PRESET),
  companyId: canonicalUuidSchema.optional(),
  projectIds: z.array(canonicalUuidSchema).optional(),
  rootTaskId: canonicalUuidSchema.optional(),
  taskIds: z.array(canonicalUuidSchema).optional(),
  allowedAgentIds: z.array(canonicalUuidSchema).optional(),
  allowedSecretBindingIds: z.array(canonicalUuidSchema).optional(),
  allowedToolClasses: z.array(z.string().trim().min(1)).optional(),
  outputPromotionTarget: lowTrustOutputPromotionTargetSchema.optional(),
}).strict();

export const lowTrustReviewPresetPolicySchema = z.object({
  id: z.literal(LOW_TRUST_REVIEW_PRESET),
  version: z.literal(LOW_TRUST_REVIEW_PRESET_VERSION),
  rawOutputDisposition: z.literal(LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION),
}).strict();

export const trustAuthorizationPolicySchema = z.object({
  trustBoundary: lowTrustBoundarySchema.optional(),
}).catchall(z.unknown()).superRefine((value, ctx) => {
  for (const retiredKey of ["trustPreset", "reviewPreset"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, retiredKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${retiredKey} is not an authorization-policy field`,
        path: [retiredKey],
      });
    }
  }
});

export const sourceTrustArtifactKindSchema = z.enum(["task", "comment", "document", "work_product"]);

export const sourceTrustMetadataSchema = z.object({
  preset: trustPresetSchema,
  disposition: z.enum(["quarantined", "promoted"]),
  sourceTaskId: canonicalUuidSchema.nullable().optional(),
  sourceRunId: canonicalUuidSchema.nullable().optional(),
  sourceAgentId: canonicalUuidSchema.nullable().optional(),
  promotedFrom: z.object({
    artifactKind: sourceTrustArtifactKindSchema,
    artifactId: canonicalUuidSchema,
    taskId: canonicalUuidSchema.nullable().optional(),
  }).strict().nullable().optional(),
  promotedByActorType: z.enum(["agent", "user", "system"]).nullable().optional(),
  promotedByActorId: z.string().trim().min(1).nullable().optional(),
  promotedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export type TrustPresetInput = z.infer<typeof trustPresetSchema>;
export type LowTrustBoundaryInput = z.infer<typeof lowTrustBoundarySchema>;
export type TrustAuthorizationPolicyInput = z.infer<typeof trustAuthorizationPolicySchema>;
export type SourceTrustMetadataInput = z.infer<typeof sourceTrustMetadataSchema>;
