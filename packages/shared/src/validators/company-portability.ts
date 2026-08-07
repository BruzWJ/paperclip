import { z } from "zod";
import { PERMISSION_KEYS } from "../constants.js";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  AGENT_VISIBLE_ISSUE_STATUSES,
  PAPERCLIP_ACTION_KEYS,
} from "../issue-runtime.js";
import { MAX_COMPANY_ATTACHMENT_MAX_BYTES } from "../constants.js";
import {
  issueCommentAuthorTypeSchema,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
  issueCreationContextAccessSchema,
  issueDispositionSchema,
} from "./issue.js";
import { routineVariableSchema } from "./routine.js";
import {
  agentRuntimeConfigSchema,
} from "./agent.js";
import { companySkillChannelSchema } from "./company-skill-pins.js";
import { budgetCurrencySchema, moneyAmountSchema } from "../money.js";

export const portabilityIncludeSchema = z
  .object({
    company: z.boolean().optional(),
    agents: z.boolean().optional(),
    projects: z.boolean().optional(),
    issues: z.boolean().optional(),
    skills: z.boolean().optional(),
  })
  .partial();

export const portabilityEnvInputSchema = z.object({
  key: z.string().min(1),
  description: z.string().nullable(),
  projectSlug: z.string().min(1).nullable(),
  kind: z.enum(["secret", "plain"]),
  requirement: z.enum(["required", "optional"]),
  defaultValue: z.string().nullable(),
  portability: z.enum(["portable", "system_dependent"]),
}).strict();

export const portabilityFileEntrySchema = z.union([
  z.string(),
  z.object({
    encoding: z.literal("base64"),
    data: z.string(),
    contentType: z.string().min(1).optional().nullable(),
  }).strict(),
]);

export const portabilityCompanyManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    brandColor: z.string().nullable(),
    logoPath: z.string().nullable(),
    budgetCurrency: budgetCurrencySchema,
    budgetMonthlyAmount: moneyAmountSchema,
    attachmentMaxBytes: z.number().int().min(1).max(MAX_COMPANY_ATTACHMENT_MAX_BYTES).nullable().default(null),
    requireBoardApprovalForNewAgents: z.boolean(),
    // Accept older company export bundles while keeping the retired fields out
    // of the current manifest contract.
    feedbackDataSharingEnabled: z.boolean().optional(),
    feedbackDataSharingConsentAt: z.string().datetime().nullable().optional(),
    feedbackDataSharingConsentByUserId: z.string().nullable().optional(),
    feedbackDataSharingTermsVersion: z.string().nullable().optional(),
  })
  .strict()
  .transform(({
    feedbackDataSharingEnabled: _feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: _feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId: _feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: _feedbackDataSharingTermsVersion,
    ...company
  }) => company);

export const portabilitySidebarOrderSchema = z.object({
  agents: z.array(z.string().min(1)).default([]),
  projects: z.array(z.string().min(1)).default([]),
}).strict();

function exactBooleanMap<const Key extends readonly [string, ...string[]]>(
  keys: Key,
) {
  return z.object(
    Object.fromEntries(
      keys.map((key) => [key, z.boolean()]),
    ) as Record<Key[number], z.ZodBoolean>,
  ).strict();
}

const RETIRED_PORTABILITY_ADAPTER_CONFIG_KEYS = new Set([
  "apikey",
  "apitoken",
  "args",
  "auth",
  "authorization",
  "bearer",
  "command",
  "credential",
  "credentials",
  "env",
  "envbindings",
  "envvars",
  "extraargs",
  "maxturnsperrun",
  "password",
  "payloadtemplatejson",
  "provider",
  "secret",
  "thinkingeffort",
  "token",
  "url",
]);

function normalizedPortabilityAdapterConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rejectRetiredPortabilityAdapterConfig(
  value: unknown,
  context: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectRetiredPortabilityAdapterConfig(entry, context, [...path, index]),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const record = value as Record<string, unknown>;
  if (record.type === "secret_ref" || record.type === "user_secret_ref") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Portable ACP adapter configuration cannot contain secret bindings",
      path,
    });
    return;
  }

  for (const [key, entry] of Object.entries(record)) {
    const entryPath = [...path, key];
    if (
      RETIRED_PORTABILITY_ADAPTER_CONFIG_KEYS.has(
        normalizedPortabilityAdapterConfigKey(key),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Portable ACP adapter configuration cannot contain retired provider field: ${key}`,
        path: entryPath,
      });
      continue;
    }
    rejectRetiredPortabilityAdapterConfig(entry, context, entryPath);
  }
}

const portabilityAgentAdapterConfigSchema = z
  .record(z.string(), z.unknown())
  .superRefine(rejectRetiredPortabilityAdapterConfig);

const portabilityAgentRuntimeConfigSchema = agentRuntimeConfigSchema;

export const portabilityAgentManifestEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  skills: z.array(z.string().min(1)).default([]),
  title: z.string().nullable(),
  icon: z.string().nullable(),
  capabilities: z.string().nullable(),
  reportsToSlug: z.string().min(1).nullable(),
  adapterRevision: z.object({
    sourceRevisionId: z.string().uuid(),
    adapterType: z.string().min(1),
    adapterConfig: portabilityAgentAdapterConfigSchema,
    runtimeConfig: portabilityAgentRuntimeConfigSchema,
    skillChannel: companySkillChannelSchema,
  }).strict(),
  contextGrants: exactBooleanMap(AGENT_CONTEXT_GRANT_KEYS),
  actionGrants: exactBooleanMap(PAPERCLIP_ACTION_KEYS),
  mentionReachGrants: exactBooleanMap(
    AGENT_MENTION_REACH_GRANT_KEYS,
  ),
  permissionGrants: z.array(z.object({
    permissionKey: z.enum(PERMISSION_KEYS),
    scope: z.record(z.string(), z.unknown()).nullable().default(null),
  }).strict()),
  budgetMonthlyAmount: moneyAmountSchema,
}).strict();

export const portabilitySkillManifestEntrySchema = z.object({
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().nullable(),
  sourceType: z.string().min(1),
  sourceLocator: z.string().nullable(),
  sourceRef: z.string().nullable(),
  trustLevel: z.string().nullable(),
  compatibility: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  fileInventory: z.array(z.object({
    path: z.string().min(1),
    kind: z.string().min(1),
  }).strict()),
}).strict();

export const portabilityProjectManifestEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().nullable(),
  ownerAgentSlug: z.string().min(1).nullable(),
  leadAgentSlug: z.string().min(1).nullable(),
  targetDate: z.string().nullable(),
  color: z.string().nullable(),
  status: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
}).strict();

export const portabilityIssueRoutineTriggerManifestEntrySchema = z.object({
  kind: z.string().min(1),
  label: z.string().nullable(),
  enabled: z.boolean(),
  cronExpression: z.string().nullable(),
  timezone: z.string().nullable(),
  signingMode: z.string().nullable(),
  replayWindowSec: z.number().int().nullable(),
}).strict();

export const portabilityIssueRoutineManifestEntrySchema = z.object({
  concurrencyPolicy: z.string().nullable(),
  catchUpPolicy: z.string().nullable(),
  contextAccessMask: issueCreationContextAccessSchema.nullable(),
  variables: z.array(routineVariableSchema).nullable().optional(),
  triggers: z.array(portabilityIssueRoutineTriggerManifestEntrySchema),
}).strict();

export const portabilityIssueCommentManifestEntrySchema = z.object({
  body: z.string().min(1),
  authorType: issueCommentAuthorTypeSchema,
  authorAgentSlug: z.string().min(1).nullable(),
  authorUserId: z.string().nullable(),
  presentation: issueCommentPresentationSchema.nullable(),
  metadata: issueCommentMetadataSchema.nullable(),
  createdAt: z.string().datetime().nullable(),
}).strict();

export const portabilityIssueManifestEntrySchema = z.object({
  slug: z.string().min(1),
  identifier: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  path: z.string().min(1),
  projectSlug: z.string().min(1).nullable(),
  ownerAgentSlug: z.string().min(1),
  request: z.string().min(1),
  recurring: z.boolean(),
  routine: portabilityIssueRoutineManifestEntrySchema.nullable(),
  lifecycleStatus: z.enum(AGENT_VISIBLE_ISSUE_STATUSES),
  disposition: issueDispositionSchema.nullable(),
  contextAccessMask: issueCreationContextAccessSchema.nullable(),
  boardPresentationStatus: z.string().min(1),
  priority: z.string().nullable(),
  labelIds: z.array(z.string().min(1)),
  billingCode: z.string().nullable(),
  comments: z.array(portabilityIssueCommentManifestEntrySchema),
  metadata: z.record(z.string(), z.unknown()).nullable(),
})
  .strict()
  .superRefine((issue, context) => {
    const terminal =
      issue.lifecycleStatus === "done" ||
      issue.lifecycleStatus === "cancelled";
    if (terminal !== (issue.disposition !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disposition"],
        message:
          "Terminal issues require a disposition and nonterminal issues must omit it",
      });
    }
  });

export const portabilityManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  source: z
    .object({
      companyId: z.string().uuid(),
      companyName: z.string().min(1),
    }).strict()
    .nullable(),
  includes: z.object({
    company: z.boolean(),
    agents: z.boolean(),
    projects: z.boolean(),
    issues: z.boolean(),
    skills: z.boolean(),
  }),
  company: portabilityCompanyManifestEntrySchema.nullable(),
  sidebar: portabilitySidebarOrderSchema.nullable(),
  agents: z.array(portabilityAgentManifestEntrySchema),
  skills: z.array(portabilitySkillManifestEntrySchema),
  projects: z.array(portabilityProjectManifestEntrySchema),
  issues: z.array(portabilityIssueManifestEntrySchema),
  envInputs: z.array(portabilityEnvInputSchema),
}).strict();

export const portabilitySourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
    rootPath: z.string().min(1).optional().nullable(),
    files: z.record(z.string(), portabilityFileEntrySchema),
  }),
  z.object({
    type: z.literal("github"),
    url: z.string().url(),
  }),
]);

export const portabilityTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("new_company"),
    newCompanyName: z.string().min(1).optional().nullable(),
  }),
  z.object({
    mode: z.literal("existing_company"),
    companyId: z.string().uuid(),
  }),
]);

export const portabilityAgentSelectionSchema = z.union([
  z.literal("all"),
  z.array(z.string().min(1)),
]);

export const portabilityCollisionStrategySchema = z.enum(["rename", "skip", "replace"]);

export const companyPortabilityExportSchema = z.object({
  include: portabilityIncludeSchema.optional(),
  agents: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  projects: z.array(z.string().min(1)).optional(),
  issues: z.array(z.string().min(1)).optional(),
  projectIssues: z.array(z.string().min(1)).optional(),
  selectedFiles: z.array(z.string().min(1)).optional(),
  expandReferencedSkills: z.boolean().optional(),
  sidebarOrder: portabilitySidebarOrderSchema.partial().optional(),
});

export type CompanyPortabilityExport = z.infer<typeof companyPortabilityExportSchema>;

export const portabilityAdapterOverrideSchema = z.object({
  adapterType: z.string().min(1),
  adapterConfig: portabilityAgentAdapterConfigSchema,
  skillChannel: companySkillChannelSchema,
}).strict();

export const companyPortabilityPreviewSchema = z.object({
  source: portabilitySourceSchema,
  include: portabilityIncludeSchema.optional(),
  target: portabilityTargetSchema,
  agents: portabilityAgentSelectionSchema.optional(),
  collisionStrategy: portabilityCollisionStrategySchema.optional(),
  nameOverrides: z.record(z.string().min(1), z.string().min(1)).optional(),
  selectedFiles: z.array(z.string().min(1)).optional(),
  adapterOverrides: z.record(z.string().min(1), portabilityAdapterOverrideSchema).optional(),
});

export type CompanyPortabilityPreview = z.infer<typeof companyPortabilityPreviewSchema>;

export const companyPortabilityImportSchema = companyPortabilityPreviewSchema.extend({
  secretValues: z.record(z.string().min(1), z.string()).optional(),
});

export type CompanyPortabilityImport = z.infer<typeof companyPortabilityImportSchema>;
