import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import { PERMISSION_KEYS, PROJECT_ICON_NAMES } from "../constants.js";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  AGENT_VISIBLE_TASK_STATUSES,
  PAPERCLIP_ACTION_KEYS,
} from "../task-runtime.js";
import { MAX_COMPANY_ATTACHMENT_MAX_BYTES } from "../constants.js";
import {
  taskCommentAuthorTypeSchema,
  taskCommentMetadataSchema,
  taskCommentPresentationSchema,
  taskDispositionSchema,
} from "./task.js";
import { routineVariableSchema } from "./routine.js";
import { envConfigSchema } from "./secret.js";
import { agentAdapterAcpConfigurationSchema } from "./agent-adapter-revision.js";
import { adapterConfigSchema } from "./agent.js";
import { budgetCurrencySchema, moneyAmountSchema } from "../money.js";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import { parseCanonicalGithubImportSourceUrl } from "../company-portability-source.js";
import { portableRelativePathSchema } from "../portable-path.js";

const portableSlugSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value,
    "Portable slugs must use their exact package spelling",
  );

function uniqueNonEmptySelectorArray<T extends z.ZodTypeAny>(schema: T) {
  return z
    .array(schema)
    .min(1)
    .refine((values) => new Set(values).size === values.length, {
      message: "Selectors must be unique",
    });
}

export const portabilityIncludeSchema = z
  .object({
    company: z.boolean().optional(),
    agents: z.boolean().optional(),
    projects: z.boolean().optional(),
    tasks: z.boolean().optional(),
  })
  .partial();

export const portabilityEnvInputSchema = z
  .object({
    key: z.string().min(1),
    description: z.string().nullable(),
    projectSlug: z.string().min(1).nullable(),
    kind: z.enum(["secret", "plain"]),
    requirement: z.enum(["required", "optional"]),
    defaultValue: z.string().nullable(),
    portability: z.enum(["portable", "system_dependent"]),
  })
  .strict();

export const portabilityFileEntrySchema = z.union([
  z.string(),
  z
    .object({
      encoding: z.literal("base64"),
      data: z.string(),
      contentType: z.string().min(1).optional().nullable(),
    })
    .strict(),
]);

export const portabilityCompanyManifestEntrySchema = z
  .object({
    path: portableRelativePathSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    brandColor: z.string().nullable(),
    logoPath: portableRelativePathSchema.nullable(),
    budgetCurrency: budgetCurrencySchema,
    budgetMonthlyAmount: moneyAmountSchema,
    attachmentMaxBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMPANY_ATTACHMENT_MAX_BYTES)
      .nullable()
      .default(null),
    requireBoardApprovalForNewAgents: z.boolean(),
  })
  .strict();

export const portabilitySidebarOrderSchema = z
  .object({
    agents: z.array(portableSlugSchema).default([]),
    projects: z.array(portableSlugSchema).default([]),
  })
  .strict();

function exactBooleanMap<const Key extends readonly [string, ...string[]]>(
  keys: Key,
) {
  return z
    .object(
      Object.fromEntries(keys.map((key) => [key, z.boolean()])) as Record<
        Key[number],
        z.ZodBoolean
      >,
    )
    .strict();
}

export const portabilityAgentManifestEntrySchema = z
  .object({
    slug: portableSlugSchema,
    name: z.string().min(1),
    path: portableRelativePathSchema,
    title: z.string().nullable(),
    icon: z.string().nullable(),
    capabilities: z.string().nullable(),
    reportsToSlug: portableSlugSchema.nullable(),
    adapterRevision: z
      .object({
        sourceRevisionId: canonicalUuidSchema,
        acpConfiguration: agentAdapterAcpConfigurationSchema,
      })
      .strict(),
    contextGrants: exactBooleanMap(AGENT_CONTEXT_GRANT_KEYS),
    actionGrants: exactBooleanMap(PAPERCLIP_ACTION_KEYS),
    mentionReachGrants: exactBooleanMap(AGENT_MENTION_REACH_GRANT_KEYS),
    permissionGrants: z.array(
      z
        .object({
          permissionKey: z.enum(PERMISSION_KEYS),
          scope: z.record(z.string(), z.unknown()).nullable().default(null),
        })
        .strict(),
    ),
    budgetMonthlyAmount: moneyAmountSchema,
  })
  .strict();

export const portabilityProjectManifestEntrySchema = z
  .object({
    slug: portableSlugSchema,
    name: z.string().min(1),
    path: portableRelativePathSchema,
    description: z.string().nullable(),
    ownerAgentSlug: portableSlugSchema.nullable(),
    leadAgentSlug: portableSlugSchema.nullable(),
    targetDate: z.string().nullable(),
    color: z.string().nullable(),
    icon: z.enum(PROJECT_ICON_NAMES).nullable(),
    status: z.string().nullable(),
    env: envConfigSchema.nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export const portabilityTaskRoutineTriggerManifestEntrySchema = z
  .object({
    kind: z.string().min(1),
    label: z.string().nullable(),
    enabled: z.boolean(),
    cronExpression: z.string().nullable(),
    timezone: z.string().nullable(),
    signingMode: z.string().nullable(),
    replayWindowSec: z.number().int().nullable(),
  })
  .strict();

export const portabilityTaskRoutineManifestEntrySchema = z
  .object({
    concurrencyPolicy: z.string().nullable(),
    catchUpPolicy: z.string().nullable(),
    variables: z.array(routineVariableSchema).nullable().optional(),
    triggers: z.array(portabilityTaskRoutineTriggerManifestEntrySchema),
  })
  .strict();

export const portabilityTaskCommentManifestEntrySchema = z
  .object({
    body: z.string().min(1),
    authorType: taskCommentAuthorTypeSchema,
    authorAgentSlug: z.string().min(1).nullable(),
    authorUserId: z.string().nullable(),
    presentation: taskCommentPresentationSchema.nullable(),
    metadata: taskCommentMetadataSchema.nullable(),
    createdAt: z.string().datetime().nullable(),
  })
  .strict();

export const portabilityTaskManifestEntrySchema = z
  .object({
    slug: portableSlugSchema,
    title: z.string().min(1).nullable(),
    path: portableRelativePathSchema,
    projectSlug: z.string().min(1).nullable(),
    ownerAgentSlug: z.string().min(1),
    request: z.string().min(1),
    recurring: z.boolean(),
    routine: portabilityTaskRoutineManifestEntrySchema.nullable(),
    lifecycleStatus: z.enum(AGENT_VISIBLE_TASK_STATUSES),
    disposition: taskDispositionSchema.nullable(),
    boardPresentationStatus: z.string().min(1),
    priority: z.string().nullable(),
    labelIds: z.array(z.string().min(1)),
    billingCode: z.string().nullable(),
    comments: z.array(portabilityTaskCommentManifestEntrySchema),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .superRefine((task, context) => {
    const terminal =
      task.lifecycleStatus === "done" || task.lifecycleStatus === "cancelled";
    if (terminal !== (task.disposition !== null)) {
      addValidationDetail(context, {
        path: ["disposition"],
        message:
          "Terminal tasks require a disposition and nonterminal tasks must omit it",
      });
    }
  });

export const portabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(5),
    generatedAt: z.string().datetime(),
    source: z
      .object({
        companyId: canonicalUuidSchema,
        companyName: z.string().min(1),
      })
      .strict()
      .nullable(),
    includes: z.object({
      company: z.boolean(),
      agents: z.boolean(),
      projects: z.boolean(),
      tasks: z.boolean(),
    }),
    company: portabilityCompanyManifestEntrySchema.nullable(),
    sidebar: portabilitySidebarOrderSchema.nullable(),
    agents: z.array(portabilityAgentManifestEntrySchema),
    projects: z.array(portabilityProjectManifestEntrySchema),
    tasks: z.array(portabilityTaskManifestEntrySchema),
    envInputs: z.array(portabilityEnvInputSchema),
  })
  .strict();

export const portabilitySourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("inline"),
      rootPath: portableRelativePathSchema.optional().nullable(),
      files: z.record(portableRelativePathSchema, portabilityFileEntrySchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("github"),
      url: z.string().superRefine((value, ctx) => {
        try {
          parseCanonicalGithubImportSourceUrl(value);
        } catch (error) {
          addValidationDetail(ctx, {
            message:
              error instanceof Error
                ? error.message
                : "Invalid canonical GitHub import source URL.",
          });
        }
      }),
    })
    .strict(),
]);

export const portabilityTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("new_company"),
    newCompanyName: z.string().min(1).optional().nullable(),
  }),
  z.object({
    mode: z.literal("existing_company"),
    companyId: canonicalUuidSchema,
  }),
]);

export const portabilityAgentSelectionSchema = z.union([
  z.literal("all"),
  uniqueNonEmptySelectorArray(portableSlugSchema),
]);

export const portabilityCollisionStrategySchema = z.enum([
  "rename",
  "skip",
  "replace",
]);

export const portabilityExportSidebarOrderSchema = z
  .object({
    agents: z.array(canonicalUuidSchema).optional(),
    projects: z.array(canonicalUuidSchema).optional(),
  })
  .strict();

export const companyPortabilityExportSchema = z.object({
  include: portabilityIncludeSchema.optional(),
  agents: uniqueNonEmptySelectorArray(canonicalUuidSchema).optional(),
  projects: uniqueNonEmptySelectorArray(canonicalUuidSchema).optional(),
  tasks: uniqueNonEmptySelectorArray(canonicalUuidSchema).optional(),
  projectTasks: uniqueNonEmptySelectorArray(canonicalUuidSchema).optional(),
  selectedFiles: uniqueNonEmptySelectorArray(
    portableRelativePathSchema,
  ).optional(),
  sidebarOrder: portabilityExportSidebarOrderSchema.optional(),
});

export type CompanyPortabilityExport = z.infer<
  typeof companyPortabilityExportSchema
>;

export const portabilityAdapterOverrideSchema = z
  .object({
    adapterType: z.string().min(1),
    adapterConfig: adapterConfigSchema,
  })
  .strict();

export const companyPortabilityPreviewSchema = z
  .object({
    source: portabilitySourceSchema,
    include: portabilityIncludeSchema.optional(),
    target: portabilityTargetSchema,
    agents: portabilityAgentSelectionSchema.optional(),
    collisionStrategy: portabilityCollisionStrategySchema.optional(),
    nameOverrides: z.record(z.string().min(1), z.string().min(1)).optional(),
    selectedFiles: uniqueNonEmptySelectorArray(
      portableRelativePathSchema,
    ).optional(),
    adapterOverrides: z
      .record(z.string().min(1), portabilityAdapterOverrideSchema)
      .optional(),
  })
  .strict();

export type CompanyPortabilityPreview = z.infer<
  typeof companyPortabilityPreviewSchema
>;

export const companyPortabilityImportSchema =
  companyPortabilityPreviewSchema.extend({
    secretValues: z.record(z.string().min(1), z.string()).optional(),
  });

export type CompanyPortabilityImport = z.infer<
  typeof companyPortabilityImportSchema
>;
