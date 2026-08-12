import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";

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
        value: exactNonemptyStringSchema,
        label: exactNonemptyStringSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type AgentAdapterAcpConfigurationInput = z.infer<
  typeof agentAdapterAcpConfigurationSchema
>;
