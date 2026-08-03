import { z } from "zod";
import {
  COMPANY_STATUSES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "../constants.js";
import { budgetCurrencySchema, moneyAmountSchema } from "../money.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const feedbackDataSharingTermsVersionSchema = z.string().min(1).nullable().optional();
const attachmentMaxBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_COMPANY_ATTACHMENT_MAX_BYTES);

export const createCompanySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional().nullable(),
    budgetCurrency: budgetCurrencySchema.optional(),
    budgetMonthlyAmount: moneyAmountSchema.optional(),
    attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
    defaultResponsibleUserId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    status: z.enum(COMPANY_STATUSES).optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    feedbackDataSharingEnabled: z.boolean().optional(),
    feedbackDataSharingConsentAt: z.coerce.date().nullable().optional(),
    feedbackDataSharingConsentByUserId: z.string().min(1).nullable().optional(),
    feedbackDataSharingTermsVersion: feedbackDataSharingTermsVersionSchema,
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
    attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
    defaultResponsibleUserId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

export const updateCompanyBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;
