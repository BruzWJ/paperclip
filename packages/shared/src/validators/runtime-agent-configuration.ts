import { z } from "zod";
import { moneyAmountSchema } from "../money.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { AGENT_ICON_NAMES } from "../constants.js";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "../issue-runtime.js";
import {
  adapterConfigSchema,
  agentRuntimeConfigSchema,
} from "./agent.js";
import {
  companySkillChannelSchema,
  companySkillPinsSchema,
} from "./company-skill-pins.js";

function requiredBooleanShape<Key extends string>(
  keys: readonly Key[],
): Record<Key, z.ZodBoolean> {
  return Object.fromEntries(
    keys.map((key) => [key, z.boolean()]),
  ) as Record<Key, z.ZodBoolean>;
}

function nonemptyPatch<Schema extends z.AnyZodObject>(
  schema: Schema,
  label: string,
) {
  return schema
    .partial()
    .strict()
    .refine(
      (value) => Object.keys(value).length > 0,
      `At least one ${label} field is required`,
    );
}

export const agentContextGrantMapSchema = z
  .object(requiredBooleanShape(AGENT_CONTEXT_GRANT_KEYS))
  .strict();

export const paperclipActionGrantMapSchema = z
  .object(requiredBooleanShape(PAPERCLIP_ACTION_KEYS))
  .strict();

export const agentMentionReachGrantMapSchema = z
  .object(requiredBooleanShape(AGENT_MENTION_REACH_GRANT_KEYS))
  .strict();

const companyToolIdsSchema = z
  .array(z.string().uuid())
  .superRefine((ids, ctx) => {
    const firstIndexById = new Map<string, number>();
    ids.forEach((id, index) => {
      const firstIndex = firstIndexById.get(id);
      if (firstIndex === undefined) {
        firstIndexById.set(id, index);
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate company tool id (first supplied at index ${firstIndex})`,
        path: [index],
      });
    });
  });

function companyToolIdsSchemaForOptions(
  companyToolIds: readonly string[],
) {
  const ids = Array.from(new Set(companyToolIds)).sort();
  const itemSchema =
    ids.length > 0
      ? z.enum(ids as [string, ...string[]])
      : z.string().uuid();
  const schema =
    ids.length > 0
      ? z.array(itemSchema)
      : z.array(itemSchema).length(0);
  return schema.superRefine((values, ctx) => {
    const firstIndexById = new Map<string, number>();
    values.forEach((id, index) => {
      const firstIndex = firstIndexById.get(id);
      if (firstIndex === undefined) {
        firstIndexById.set(id, index);
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate company tool id (first supplied at index ${firstIndex})`,
        path: [index],
      });
    });
  });
}

const runtimeAgentConfigurationFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    title: z.string().max(240).nullable(),
    capabilities: z.string().max(8_000).nullable(),
    reportsTo: z.string().uuid().nullable(),
    contextGrants: agentContextGrantMapSchema,
    actionGrants: paperclipActionGrantMapSchema,
    mentionReachGrants: agentMentionReachGrantMapSchema,
    companyToolIds: companyToolIdsSchema,
  })
  .strict();

/**
 * A provider-side hire has the same complete configuration contract as an
 * ordinary create, except that its reporting edge is never provider input.
 * The runtime server stamps that edge from the authenticated caller.
 */
export const runtimeAgentHireConfigurationSchema =
  runtimeAgentConfigurationFieldsSchema
    .omit({ reportsTo: true })
    .strict();

/**
 * Builds the provider-side hire contract for the exact create-eligible
 * company-tool catalog compiled for one run. An empty live catalog accepts
 * only `companyToolIds: []`.
 */
export function runtimeAgentHireConfigurationSchemaForCompanyTools(
  companyToolIds: readonly string[],
) {
  return runtimeAgentConfigurationFieldsSchema
    .omit({ reportsTo: true, companyToolIds: true })
    .extend({
      companyToolIds: companyToolIdsSchemaForOptions(companyToolIds),
    })
    .strict();
}

export const runtimeAgentCompanyToolOptionSchema = z
  .object({
    catalogEntryId: z.string().uuid(),
    connectionId: z.string().uuid(),
    connectionName: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    catalogVersionHash: z.string().min(1),
  })
  .strict();

export const runtimeAgentCompanyToolOptionsSchema = z
  .array(runtimeAgentCompanyToolOptionSchema);

/**
 * The complete ordinary runtime-agent configuration.
 *
 * Creation is intentionally explicit: callers supply every identity field,
 * every dial cell, and both tool-selection sets. No adapter, provider, or
 * board-operational field is accepted at this boundary.
 */
export const runtimeAgentCreateConfigurationSchema =
  runtimeAgentConfigurationFieldsSchema;

/**
 * A nonempty update over the same closed runtime-agent field set.
 *
 * Grant maps remain complete when supplied so a write cannot accidentally
 * depend on an omitted-cell default.
 */
export const runtimeAgentUpdateConfigurationSchema = nonemptyPatch(
  runtimeAgentConfigurationFieldsSchema,
  "runtime-agent configuration",
);

function runtimeAgentConfigureActionSchemaForTarget(
  targetAgentIdSchema: z.ZodType<string>,
) {
  return runtimeAgentConfigurationFieldsSchema
    .partial()
    .extend({ agentId: targetAgentIdSchema })
    .strict()
    .refine(
      (value) => Object.keys(value).some((key) => key !== "agentId"),
      "At least one runtime-agent configuration field is required",
    );
}

/**
 * The static runtime action envelope. It is used at the execution boundary
 * after the compiled descriptor has already constrained the target catalog.
 */
export const runtimeAgentConfigureActionSchema =
  runtimeAgentConfigureActionSchemaForTarget(z.string().uuid());

/**
 * Builds the dynamic provider descriptor contract for the exact target
 * catalog compiled for one run. The enum intentionally contains ids only:
 * configuring an agent is a control-plane operation, not an identity surface.
 */
export function runtimeAgentConfigureActionSchemaForTargets(
  targetAgentIds: readonly string[],
) {
  const ids = Array.from(
    new Set(targetAgentIds.filter((id) => id.length > 0)),
  );
  if (ids.length === 0) {
    throw new Error(
      "A runtime-agent configure descriptor requires at least one target id",
    );
  }
  return runtimeAgentConfigureActionSchemaForTarget(
    z.enum(ids as [string, ...string[]]),
  );
}

/**
 * The separately owned, immutable adapter/provider execution revision input.
 */
export const agentAdapterRevisionConfigurationSchema = z
  .object({
    adapterType: agentAdapterTypeSchema,
    adapterConfig: adapterConfigSchema,
    defaultEnvironmentId: z.string().uuid(),
    runtimeConfig: agentRuntimeConfigSchema,
    companySkillPins: companySkillPinsSchema,
    skillChannel: companySkillChannelSchema,
  })
  .strict();

/**
 * Unsaved adapter configuration accepted by the disposable ACPX test. The
 * adapter identity stays in the route so this body cannot disagree with it.
 * Execution-environment and workspace claims are deliberately absent: the
 * test proves only that ACPX can initialize the selected local agent and
 * apply its generic session configuration.
 */
export const agentAdapterConfigurationTestInputSchema = z
  .object({
    adapterConfig: adapterConfigSchema,
  })
  .strict();

export const AGENT_ADAPTER_CONFIGURATION_TEST_FAILURE_REASONS = [
  "acp_initialization_failed",
  "acp_capability_incompatible",
  "acp_cleanup_failed",
] as const;

const agentAdapterConfigurationTestReadySchema = z
  .object({
    status: z.literal("ready"),
    adapterType: agentAdapterTypeSchema,
    runtimeControls: z.array(z.string().min(1)),
    testedAt: z.string().datetime(),
  })
  .strict();

const agentAdapterConfigurationTestFailedSchema = z
  .object({
    status: z.literal("failed"),
    adapterType: agentAdapterTypeSchema,
    reason: z.enum(
      AGENT_ADAPTER_CONFIGURATION_TEST_FAILURE_REASONS,
    ),
    message: z.string().min(1),
    testedAt: z.string().datetime(),
  })
  .strict();

export const agentAdapterConfigurationTestResultSchema =
  z.discriminatedUnion("status", [
    agentAdapterConfigurationTestReadySchema,
    agentAdapterConfigurationTestFailedSchema,
  ]);

const agentOperationalConfigurationFieldsSchema = z
  .object({
    icon: z.enum(AGENT_ICON_NAMES).nullable(),
    budgetMonthlyAmount: moneyAmountSchema,
  })
  .strict();

/**
 * Board-only display/operational updates. Lifecycle, spend, telemetry,
 * runtime-agent identity/grants, and adapter/provider configuration are
 * structurally outside this contract.
 */
export const agentOperationalConfigurationUpdateSchema = nonemptyPatch(
  agentOperationalConfigurationFieldsSchema,
  "agent operational configuration",
);

export type AgentContextGrantMapInput = z.infer<
  typeof agentContextGrantMapSchema
>;
export type PaperclipActionGrantMapInput = z.infer<
  typeof paperclipActionGrantMapSchema
>;
export type AgentMentionReachGrantMapInput = z.infer<
  typeof agentMentionReachGrantMapSchema
>;
export type RuntimeAgentCreateConfigurationInput = z.infer<
  typeof runtimeAgentCreateConfigurationSchema
>;
export type RuntimeAgentHireConfigurationInput = z.infer<
  typeof runtimeAgentHireConfigurationSchema
>;
export type RuntimeAgentCompanyToolOption = z.infer<
  typeof runtimeAgentCompanyToolOptionSchema
>;
export type RuntimeAgentUpdateConfigurationInput = z.infer<
  typeof runtimeAgentUpdateConfigurationSchema
>;
export type RuntimeAgentConfigureActionInput = z.infer<
  typeof runtimeAgentConfigureActionSchema
>;
export type AgentAdapterRevisionConfigurationInput = z.infer<
  typeof agentAdapterRevisionConfigurationSchema
>;
export type AgentAdapterConfigurationTestInput = z.infer<
  typeof agentAdapterConfigurationTestInputSchema
>;
export type AgentAdapterConfigurationTestFailureReason =
  (typeof AGENT_ADAPTER_CONFIGURATION_TEST_FAILURE_REASONS)[number];
export type AgentAdapterConfigurationTestResult = z.infer<
  typeof agentAdapterConfigurationTestResultSchema
>;
export type AgentOperationalConfigurationUpdateInput = z.infer<
  typeof agentOperationalConfigurationUpdateSchema
>;
