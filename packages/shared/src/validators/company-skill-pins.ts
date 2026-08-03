import { z } from "zod";

export const COMPANY_SKILL_CHANNELS = [
  "isolated_skills_home",
  "operator_native",
] as const;

export const companySkillChannelSchema = z.enum(COMPANY_SKILL_CHANNELS);

const canonicalCompanySkillKeySchema = z
  .string()
  .min(1)
  .refine(
    (key) => key === key.trim(),
    "Company skill keys must already be canonical",
  );

export const companySkillPinSchema = z
  .object({
    key: canonicalCompanySkillKeySchema,
    versionId: z.string().uuid(),
  })
  .strict();

export const companySkillPinsSchema = z
  .array(companySkillPinSchema)
  .superRefine((pins, ctx) => {
    const firstIndexByKey = new Map<string, number>();
    pins.forEach((pin, index) => {
      const firstIndex = firstIndexByKey.get(pin.key);
      if (firstIndex === undefined) {
        firstIndexByKey.set(pin.key, index);
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate company skill key (first supplied at index ${firstIndex})`,
        path: [index, "key"],
      });
    });
  });

export const agentCompanySkillPinsUpdateSchema = z
  .object({
    entries: companySkillPinsSchema,
    skillChannel: companySkillChannelSchema,
  })
  .strict();

export const agentCompanySkillPinsResponseSchema = z
  .object({
    entries: companySkillPinsSchema,
    skillChannel: companySkillChannelSchema,
  })
  .strict();

export type CompanySkillPin = z.infer<typeof companySkillPinSchema>;
export type CompanySkillChannel = z.infer<
  typeof companySkillChannelSchema
>;
export type AgentCompanySkillPinsUpdate = z.infer<
  typeof agentCompanySkillPinsUpdateSchema
>;
export type AgentCompanySkillPinsResponse = z.infer<
  typeof agentCompanySkillPinsResponseSchema
>;

export function parseCompanySkillPins(value: unknown): CompanySkillPin[] {
  return [...companySkillPinsSchema.parse(value)].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}
