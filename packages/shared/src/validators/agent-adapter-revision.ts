import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import {
  companySkillPinsSchema,
} from "./company-skill-pins.js";

const exactNonemptyStringSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "Value must already be an exact nonblank string",
  );

const acpSessionConfigValueSchema = z.union([
  exactNonemptyStringSchema,
  z.boolean(),
]);

const acpSessionConfigSelectionSchema = z
  .object({
    configId: exactNonemptyStringSchema,
    value: acpSessionConfigValueSchema,
  })
  .strict();

const acpSessionConfigSelectionsSchema = z
  .array(acpSessionConfigSelectionSchema)
  .superRefine((selections, ctx) => {
    for (let index = 0; index < selections.length; index += 1) {
      const current = selections[index]!;
      const previous = selections[index - 1];
      if (previous && previous.configId >= current.configId) {
        addValidationDetail(ctx, {
          message:
            "ACP session configuration ids must be unique and code-unit sorted",
          path: [index, "configId"],
        });
      }
    }
  });

const acpModelLimitsSchema = z
  .object({
    contextTokenLimit: z.number().int().positive(),
    inputTokenLimit: z.number().int().positive().optional(),
    outputTokenLimit: z.number().int().positive(),
  })
  .strict()
  .superRefine((limits, ctx) => {
    if (limits.outputTokenLimit > limits.contextTokenLimit) {
      addValidationDetail(ctx, {
        message: "outputTokenLimit cannot exceed contextTokenLimit",
        path: ["outputTokenLimit"],
      });
    }
    if (
      limits.inputTokenLimit !== undefined &&
      limits.inputTokenLimit > limits.contextTokenLimit
    ) {
      addValidationDetail(ctx, {
        message: "inputTokenLimit cannot exceed contextTokenLimit",
        path: ["inputTokenLimit"],
      });
    }
  });

const canonicalCompanySkillPinsSchema = companySkillPinsSchema.superRefine(
  (pins, ctx) => {
    for (let index = 1; index < pins.length; index += 1) {
      if (pins[index - 1]!.key >= pins[index]!.key) {
        addValidationDetail(ctx, {
          message: "Company skill pins must be code-unit sorted by key",
          path: [index, "key"],
        });
      }
    }
  },
);

/**
 * The sole immutable, non-secret ACP execution configuration persisted by an
 * agent adapter revision. Provider credentials and CLI-native state have no
 * field in this closed contract.
 */
export const agentAdapterAcpConfigurationSchema = z
  .object({
    contractVersion: z.literal("acpx-runtime/v1"),
    launchProfile: z
      .object({
        registryName: exactNonemptyStringSchema,
      })
      .strict(),
    sessionConfigSelections: acpSessionConfigSelectionsSchema,
    model: z
      .object({
        id: exactNonemptyStringSchema,
        label: exactNonemptyStringSchema,
        value: exactNonemptyStringSchema,
        limits: acpModelLimitsSchema.nullable(),
      })
      .strict()
      .nullable(),
    workspaceSelector: z
      .object({
        kind: z.literal("task_execution_workspace"),
      })
      .strict(),
    companySkillPins: canonicalCompanySkillPinsSchema,
  })
  .strict();

export type AgentAdapterAcpConfigurationInput = z.infer<
  typeof agentAdapterAcpConfigurationSchema
>;

/**
 * Board-facing projection of a persisted ACP revision. The workspace selector
 * is internal execution authority, not operator config.
 */
export const publicAgentAdapterAcpConfigurationSchema =
  agentAdapterAcpConfigurationSchema.omit({
    workspaceSelector: true,
  });

export type PublicAgentAdapterAcpConfigurationInput = z.infer<
  typeof publicAgentAdapterAcpConfigurationSchema
>;

export function projectAgentAdapterAcpConfiguration(
  input: unknown,
): PublicAgentAdapterAcpConfigurationInput {
  const {
    workspaceSelector: _workspaceSelector,
    ...publicConfiguration
  } = agentAdapterAcpConfigurationSchema.parse(input);
  return publicAgentAdapterAcpConfigurationSchema.parse(publicConfiguration);
}
