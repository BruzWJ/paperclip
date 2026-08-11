import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import {
  PLUGIN_STATUSES,
  PLUGIN_CATEGORIES,
  PLUGIN_CAPABILITIES,
  PLUGIN_UI_SLOT_TYPES,
  PLUGIN_ENTITY_SCOPED_UI_SLOT_TYPES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS,
  PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS,
  PLUGIN_LAUNCHER_PLACEMENT_ZONES,
  PLUGIN_ENTITY_SCOPED_LAUNCHER_PLACEMENT_ZONES,
  PLUGIN_LAUNCHER_ACTIONS,
  PLUGIN_LAUNCHER_BOUNDS,
  PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS,
  PLUGIN_DATABASE_CORE_READ_TABLES,
  PLUGIN_API_ROUTE_METHODS,
  PLUGIN_LOG_LEVELS,
  TASK_PRIORITIES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  TASK_SURFACE_VISIBILITIES,
  MCP_TOOL_NAME_MAX_LENGTH,
  isMcpToolName,
  pluginAgentToolName,
} from "../constants.js";
import type {
  PluginCapability,
  PluginLauncherPlacementZone,
  PluginUiSlotType,
} from "../constants.js";
import type {
  PluginLauncherDeclaration,
  PluginUiSlotDeclaration,
} from "../types/plugin.js";
import { routineVariableSchema } from "./routine.js";

/** Exact npm package-name contract used by plugin installation and scaffolding. */
export const pluginPackageNameSchema = z.string()
  .min(1, "packageName must not be empty")
  .max(214, "packageName must not exceed 214 characters")
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    "packageName must be an exact npm registry package name",
  )
  .refine(
    (value) => value === value.trim(),
    "packageName must not have leading or trailing whitespace",
  );

const npmPluginVersionSchema = z.string()
  .min(1)
  .max(128)
  .regex(
    /^(?:v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?|[a-z][a-z0-9._-]*)$/,
    "version must be an exact semver or npm dist-tag when provided",
  )
  .refine(
    (value) => value === value.trim(),
    "version must not have leading or trailing whitespace",
  );

/** Exact instance-admin request accepted by the plugin installer. */
export const pluginInstallRequestSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("npm"),
    packageName: pluginPackageNameSchema,
    version: npmPluginVersionSchema.optional(),
  }).strict(),
  z.object({
    source: z.literal("local"),
    path: z.string().min(1)
      .refine(
        (value) => value === value.trim(),
        "path must not have leading or trailing whitespace",
      )
      .refine(
        (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value),
        "path must be absolute for a local plugin install",
      ),
  }).strict(),
]);

export type PluginInstallRequest = z.infer<typeof pluginInstallRequestSchema>;

/** Exact instance-admin request accepted by repo catalog installation. */
export const pluginCatalogInstallRequestSchema = z.object({
  packageName: pluginPackageNameSchema,
}).strict();

export type PluginCatalogInstallRequest = z.infer<
  typeof pluginCatalogInstallRequestSchema
>;

export const pluginUpgradeRequestSchema = z.object({
  version: npmPluginVersionSchema.optional(),
}).strict();

export const pluginDisableRequestSchema = z.object({
  reason: z.string().min(1).max(1_000).refine(
    (value) => value === value.trim(),
    "reason must not have leading or trailing whitespace",
  ).optional(),
}).strict();

const pluginResultLimitQueryValueSchema = z.string()
  .regex(/^[1-9][0-9]{0,2}$/, "limit must be an integer from 1 through 500")
  .refine(
    (value) => Number(value) <= 500,
    "limit must be an integer from 1 through 500",
  )
  .default("25");

export const pluginListQuerySchema = z.object({
  status: z.enum(PLUGIN_STATUSES).optional(),
}).strict();

export const pluginLogsQuerySchema = z.object({
  limit: pluginResultLimitQueryValueSchema,
  level: z.enum(PLUGIN_LOG_LEVELS).optional(),
  since: z.string().datetime({ offset: true }).optional(),
}).strict();

export const pluginJobRunsQuerySchema = z.object({
  limit: pluginResultLimitQueryValueSchema,
}).strict();

/** Exact instance-admin request accepted by config save and config test. */
export const pluginConfigRequestSchema = z.object({
  configJson: z.record(z.string(), z.unknown()),
}).strict();

/** Exact path-only body accepted by local-folder validate and configure. */
export const pluginLocalFolderPathRequestSchema = z.object({
  path: z.string().min(1).refine(
    (value) => value === value.trim(),
    "path must not have leading or trailing whitespace",
  ),
}).strict();

export type PluginLocalFolderPathRequest = z.infer<
  typeof pluginLocalFolderPathRequestSchema
>;

export const pluginLauncherRenderContextSnapshotSchema = z.object({
  environment: z.enum(PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS),
  launcherId: z.string().min(1),
  bounds: z.enum(PLUGIN_LAUNCHER_BOUNDS),
}).strict();

/** Exact shared body for plugin UI data and action bridge calls. */
export const pluginBridgeRequestSchema = z.object({
  companyId: z.string().uuid().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  renderEnvironment: pluginLauncherRenderContextSnapshotSchema.nullable().optional(),
}).strict();

// ---------------------------------------------------------------------------
// JSON Schema declaration shape
// ---------------------------------------------------------------------------

/**
 * Structural validator for JSON Schema declarations. Accepts any `Record<string, unknown>`
 * that contains at least a `type`, `$ref`, or composition keyword (`oneOf`/`anyOf`/`allOf`).
 * Empty objects are also accepted.
 *
 * Used for the shared manifest shape only. Host admission separately compiles
 * every declared input schema with Ajv before accepting the plugin.
 *
 * @see PLUGIN_SPEC.md §10.1 — Manifest shape
 */
export const jsonSchemaSchema = z.record(z.string(), z.unknown()).refine(
  (val) => {
    // Must have a "type" field if non-empty, or be a valid JSON Schema object
    if (Object.keys(val).length === 0) return true;
    return typeof val.type === "string" || val.$ref !== undefined || val.oneOf !== undefined || val.anyOf !== undefined || val.allOf !== undefined;
  },
  { message: "JSON Schema declarations require at least a 'type', '$ref', or composition keyword" },
);

function containsSecretRefFormat(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretRefFormat);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      (key === "format" && nested === "secret-ref") || containsSecretRefFormat(nested),
  );
}

const UI_SLOT_CAPABILITIES: Record<PluginUiSlotType, PluginCapability> = {
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
  settingsPage: "instance.settings.register",
  companySettingsPage: "instance.settings.register",
  routeSidebar: "ui.sidebar.register",
};

const LAUNCHER_PLACEMENT_CAPABILITIES: Record<
  PluginLauncherPlacementZone,
  PluginCapability
> = {
  sidebar: "ui.sidebar.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
};

// ---------------------------------------------------------------------------
// Manifest sub-type schemas
// ---------------------------------------------------------------------------

/**
 * Validates a {@link PluginJobDeclaration} — a scheduled job declared in the
 * plugin manifest. Requires `jobKey`, `displayName`, and a five-field cron
 * `schedule`; only `description` is optional.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 */
/**
 * Validates a cron expression has exactly 5 whitespace-separated fields,
 * each containing valid, in-range cron tokens.
 */
function isValidCronField(token: string, min: number, max: number): boolean {
  return token.split(",").every((part) => {
    const stepParts = part.split("/");
    if (stepParts.length > 2) return false;
    const [base, stepText] = stepParts;
    if (!base) return false;
    if (
      stepText !== undefined &&
      (!/^[0-9]+$/.test(stepText) || Number(stepText) <= 0)
    ) {
      return false;
    }
    if (base === "*") return true;

    const rangeParts = base.split("-");
    if (rangeParts.length > 2 || rangeParts.some((value) => !/^[0-9]+$/.test(value))) {
      return false;
    }
    const start = Number(rangeParts[0]);
    const end = Number(rangeParts[1] ?? rangeParts[0]);
    return start >= min && end <= max && start <= end;
  });
}

const CRON_FIELD_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

function isValidCronExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const [min, max] = CRON_FIELD_BOUNDS[index]!;
    return isValidCronField(field, min, max);
  });
}

export const pluginJobDeclarationSchema = z.object({
  jobKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  schedule: z.string().refine(
    (val) => isValidCronExpression(val),
    { message: "schedule must be a valid 5-field cron expression (e.g. '*/15 * * * *')" },
  ),
}).strict();

/**
 * Validates a {@link PluginWebhookDeclaration} — a webhook endpoint declared
 * in the plugin manifest. Requires `endpointKey` and `displayName`.
 *
 * @see PLUGIN_SPEC.md §18 — Webhooks
 */
export const pluginWebhookDeclarationSchema = z.object({
  endpointKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
}).strict();

/**
 * Validates a {@link PluginToolDeclaration} — an agent tool contributed by the
 * plugin. Requires `name`, `displayName`, `description`, and a valid
 * `parametersSchema`. Requires the `agent.tools.register` capability.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 */
export const pluginToolDeclarationSchema = z.object({
  name: z.string()
    .max(MCP_TOOL_NAME_MAX_LENGTH)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
      message: "tool name must start with an alphanumeric and contain only letters, digits, dots, underscores, or hyphens",
    })
    .refine((name) => !name.includes("__"), {
      message: "tool name must not contain the reserved plugin namespace separator '__'",
    }),
  displayName: z.string().min(1),
  description: z.string().min(1),
  parametersSchema: jsonSchemaSchema,
  bootstrapEnabled: z.boolean().optional(),
}).strict();

export const pluginManagedAgentDeclarationSchema = z.object({
  agentKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "agentKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
  displayName: z.string().min(1).max(100),
  title: z.string().max(200).nullable().optional(),
  capabilities: z.string().max(2000).nullable().optional(),
}).strict();

export const pluginManagedProjectDeclarationSchema = z.object({
  projectKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "projectKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
  displayName: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["backlog", "planned", "in_progress", "completed", "cancelled"]).optional(),
  color: z.string().max(32).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict();

const pluginManagedResourceRefSchema = z.object({
  pluginKey: z.string().min(1).max(100).optional(),
  resourceKind: z.enum(["agent", "project", "routine", "skill"]),
  resourceKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "resourceKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
}).strict();

export const pluginManagedRoutineDeclarationSchema = z.object({
  routineKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "routineKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  assigneeRef: pluginManagedResourceRefSchema.extend({ resourceKind: z.literal("agent") }).nullable().optional(),
  projectRef: pluginManagedResourceRefSchema.extend({ resourceKind: z.literal("project") }).nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  status: z.enum(ROUTINE_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES).optional(),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES).optional(),
  variables: z.array(routineVariableSchema).min(1).optional(),
  triggers: z.array(z.object({
    kind: z.enum(ROUTINE_TRIGGER_KINDS),
    label: z.string().trim().max(120).nullable().optional(),
    enabled: z.boolean().optional(),
    cronExpression: z.string().trim().min(1).optional().nullable(),
    timezone: z.string().trim().min(1).optional().nullable(),
    signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().nullable(),
  }).strict()).min(1).max(20).optional(),
  taskTemplate: z.object({
    surfaceVisibility: z.enum(TASK_SURFACE_VISIBILITIES).optional(),
    originId: z.string().trim().max(255).nullable().optional(),
    billingCode: z.string().trim().max(200).nullable().optional(),
  }).strict().optional(),
}).strict();

const pluginLocalFolderRelativePathSchema = z.string().min(1).max(500).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "."),
  { message: "local folder paths must be relative paths without traversal, empty segments, or backslashes" },
);

export const pluginLocalFolderDeclarationSchema = z.object({
  folderKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "folderKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
  displayName: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  access: z.enum(["read", "readWrite"]).optional(),
  requiredDirectories: z.array(pluginLocalFolderRelativePathSchema).min(1).optional(),
  requiredFiles: z.array(pluginLocalFolderRelativePathSchema).min(1).optional(),
}).strict();

export const pluginManagedSkillFileDeclarationSchema = z.object({
  path: pluginLocalFolderRelativePathSchema.refine(
    (value) => value.toLowerCase() !== "skill.md",
    { message: "managed skill files cannot replace SKILL.md; use markdown for the main skill file" },
  ),
  content: z.string().max(200_000),
}).strict();

export const pluginManagedSkillDeclarationSchema = z.object({
  skillKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "skillKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
  displayName: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "slug must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
  }).optional(),
  description: z.string().max(2000).nullable().optional(),
  markdown: z.string().max(200_000).optional(),
  files: z.array(pluginManagedSkillFileDeclarationSchema).min(1).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const paths = (value.files ?? []).map((file) => file.path);
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
  if (duplicates.length > 0) {
    addValidationDetail(ctx, {
      message: `Duplicate managed skill file paths: ${[...new Set(duplicates)].join(", ")}`,
      path: ["files"],
    });
  }
});

/**
 * Validates a {@link PluginUiSlotDeclaration} — a UI extension slot the plugin
 * fills with a React component. Includes `superRefine` checks for slot-specific
 * requirements such as `entityTypes` for context-sensitive slots.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export const pluginUiSlotDeclarationSchema = z.object({
  type: z.enum(PLUGIN_UI_SLOT_TYPES),
  id: z.string().min(1),
  displayName: z.string().min(1),
  exportName: z.string().min(1),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).min(1).optional(),
  routePath: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "routePath must be a lowercase single-segment slug (letters, numbers, hyphens)",
  }).optional(),
  order: z.number().int().optional(),
}).strict().superRefine((value, ctx) => {
  // context-sensitive slots require explicit entity targeting.
  if (
    PLUGIN_ENTITY_SCOPED_UI_SLOT_TYPES.some((type) => type === value.type)
    && (!value.entityTypes || value.entityTypes.length === 0)
  ) {
    addValidationDetail(ctx, {
      message: `${value.type} slots require at least one entityType`,
      path: ["entityTypes"],
    });
  }
  const allowedEntityTypes = value.type === "detailTab"
    ? PLUGIN_UI_SLOT_ENTITY_TYPES
    : value.type === "taskDetailView"
      ? ["task"] as const
      : value.type === "projectSidebarItem"
        ? ["project"] as const
        : value.type === "toolbarButton"
          ? ["project", "task"] as const
          : null;
  if (
    allowedEntityTypes
    && value.entityTypes?.some((entityType) =>
      !(allowedEntityTypes as readonly string[]).includes(entityType)
    )
  ) {
    addValidationDetail(ctx, {
      message: `${value.type} supports only these mounted entityTypes: ${allowedEntityTypes.join(", ")}`,
      path: ["entityTypes"],
    });
  }
  if (!allowedEntityTypes && value.entityTypes) {
    addValidationDetail(ctx, {
      message: "entityTypes is only supported for entity-scoped slots",
      path: ["entityTypes"],
    });
  }
  const routedSlot = value.type === "page"
    || value.type === "routeSidebar"
    || value.type === "companySettingsPage";
  if (value.routePath && !routedSlot) {
    addValidationDetail(ctx, {
      message: "routePath is only supported for page, routeSidebar, and companySettingsPage slots",
      path: ["routePath"],
    });
  }
  if (routedSlot && !value.routePath) {
    addValidationDetail(ctx, {
      message: `${value.type} slots require routePath`,
      path: ["routePath"],
    });
  }
  if (
    (value.type === "page" || value.type === "routeSidebar")
    && value.routePath
    && PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS.includes(value.routePath as (typeof PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS)[number])
  ) {
    addValidationDetail(ctx, {
      message: `routePath "${value.routePath}" is reserved by the host`,
      path: ["routePath"],
    });
  }
  if (
    value.type === "companySettingsPage"
    && value.routePath
    && PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS.includes(value.routePath as (typeof PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS)[number])
  ) {
    addValidationDetail(ctx, {
      message: `company settings routePath "${value.routePath}" is reserved by the host`,
      path: ["routePath"],
    });
  }
}).transform((value): PluginUiSlotDeclaration => value as PluginUiSlotDeclaration) as z.ZodType<
  PluginUiSlotDeclaration,
  z.ZodTypeDef,
  unknown
>;

/**
 * Validates the action payload for a declarative plugin launcher.
 */
export const pluginLauncherActionDeclarationSchema = z.object({
  type: z.enum(PLUGIN_LAUNCHER_ACTIONS),
  target: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type !== "performAction" && value.params) {
    addValidationDetail(ctx, {
      message: "params is supported only for performAction launchers",
      path: ["params"],
    });
  }

  if (value.type === "performAction" && value.target.includes("/")) {
    addValidationDetail(ctx, {
      message: "performAction launchers must target an action key, not a route or URL",
      path: ["target"],
    });
  }

  if (
    value.type === "navigate"
    && (/^[a-z][a-z\d+.-]*:/i.test(value.target) || value.target.startsWith("//"))
  ) {
    addValidationDetail(ctx, {
      message: "navigate launchers must target a Paperclip route, not an absolute URL",
      path: ["target"],
    });
  }

  if (value.type === "deepLink" && !/^https?:\/\//.test(value.target)) {
    addValidationDetail(ctx, {
      message: "deepLink launchers must target an absolute HTTP(S) URL",
      path: ["target"],
    });
  }
});

/**
 * Validates optional render hints for a plugin launcher destination.
 */
export const pluginLauncherRenderDeclarationSchema = z.object({
  environment: z.enum(PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS),
  bounds: z.enum(PLUGIN_LAUNCHER_BOUNDS).optional(),
}).strict();

/**
 * Validates declarative launcher metadata in a plugin manifest.
 */
export const pluginLauncherDeclarationSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  placementZone: z.enum(PLUGIN_LAUNCHER_PLACEMENT_ZONES),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).min(1).optional(),
  order: z.number().int().optional(),
  action: pluginLauncherActionDeclarationSchema,
  render: pluginLauncherRenderDeclarationSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (
    PLUGIN_ENTITY_SCOPED_LAUNCHER_PLACEMENT_ZONES.some(
      (zone) => zone === value.placementZone,
    )
    && (!value.entityTypes || value.entityTypes.length === 0)
  ) {
    addValidationDetail(ctx, {
      message: `${value.placementZone} launchers require at least one entityType`,
      path: ["entityTypes"],
    });
  }

  if (value.placementZone !== "toolbarButton" && value.entityTypes) {
    addValidationDetail(ctx, {
      message: "entityTypes is only supported for entity-scoped launcher placements",
      path: ["entityTypes"],
    });
  }

  if (
    value.placementZone === "toolbarButton"
    && value.entityTypes?.some((entityType) => entityType !== "project" && entityType !== "task")
  ) {
    addValidationDetail(ctx, {
      message: "toolbarButton launchers support only these mounted entityTypes: project, task",
      path: ["entityTypes"],
    });
  }

  const opensOverlay = value.action.type === "openModal"
    || value.action.type === "openDrawer"
    || value.action.type === "openPopover";

  if (!opensOverlay && value.render) {
    addValidationDetail(ctx, {
      message: "render metadata is supported only for overlay launchers",
      path: ["render"],
    });
  }

  if (opensOverlay && !value.render) {
    addValidationDetail(ctx, {
      message: `${value.action.type} launchers require render metadata`,
      path: ["render"],
    });
  }
}).transform((value): PluginLauncherDeclaration => value as PluginLauncherDeclaration) as z.ZodType<
  PluginLauncherDeclaration,
  z.ZodTypeDef,
  unknown
>;

export const pluginDatabaseDeclarationSchema = z.object({
  namespaceSlug: z.string().regex(/^[a-z0-9][a-z0-9_]*$/, {
    message: "namespaceSlug must be lowercase letters, digits, or underscores and start with a letter or digit",
  }).max(40).optional(),
  migrationsDir: z.string().min(1).refine(
    (value) => !value.startsWith("/") && !value.includes("..") && !/[\\]/.test(value),
    { message: "migrationsDir must be a relative package path without '..' or backslashes" },
  ),
  coreReadTables: z.array(z.enum(PLUGIN_DATABASE_CORE_READ_TABLES)).min(1).optional(),
}).strict();

export const pluginApiRouteDeclarationSchema = z.object({
  routeKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message: "routeKey must be lowercase letters, digits, dots, colons, underscores, or hyphens",
  }),
  method: z.enum(PLUGIN_API_ROUTE_METHODS),
  path: z.string().min(1).regex(/^\/[a-zA-Z0-9:_./-]*$/, {
    message: "path must start with / and contain only path-safe literal or :param segments",
  }).refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      value !== "/api" &&
      !value.startsWith("/api/") &&
      value !== "/plugins" &&
      !value.startsWith("/plugins/"),
    { message: "path must stay inside the plugin api namespace" },
  ),
  companyResolution: z.discriminatedUnion("from", [
    z.object({ from: z.literal("body"), key: z.string().min(1) }).strict(),
    z.object({ from: z.literal("query"), key: z.string().min(1) }).strict(),
    z.object({ from: z.literal("task"), param: z.string().min(1) }).strict(),
  ]),
}).strict().superRefine((route, ctx) => {
  if (route.method === "GET" && route.companyResolution.from === "body") {
    addValidationDetail(ctx, {
      message: "GET routes cannot resolve company access from a request body",
      path: ["companyResolution", "from"],
    });
  }
  if (
    route.companyResolution.from === "task"
    && !route.path.split("/").includes(`:${route.companyResolution.param}`)
  ) {
    addValidationDetail(ctx, {
      message: "task companyResolution.param must name a path parameter declared by path",
      path: ["companyResolution", "param"],
    });
  }
});

const pluginPackageEntrypointSchema = z.string().min(1).refine(
  (value) =>
    !value.startsWith("/")
    && !/^[A-Za-z]:\//.test(value)
    && !value.includes("\\")
    && !value.split("/").includes(".."),
  {
    message: "Plugin entrypoints must be relative package paths without '..' or backslashes",
  },
);

// ---------------------------------------------------------------------------
// Plugin Manifest V1 schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the canonical {@link PaperclipPluginManifestV1} structure and
 * cross-field contract. Host installation additionally compiles every declared
 * JSON Schema before admitting the manifest.
 *
 * Field-level constraints (see PLUGIN_SPEC.md §10.1 for the normative rules):
 *
 * | Field                    | Type       | Constraints                                  |
 * |--------------------------|------------|----------------------------------------------|
 * | `id`                     | string     | `^[a-z0-9][a-z0-9._-]*$`                    |
 * | `apiVersion`             | literal 1  | must equal `PLUGIN_API_VERSION`              |
 * | `version`                | string     | semver (`\d+\.\d+\.\d+`)                    |
 * | `displayName`            | string     | 1–100 chars                                  |
 * | `description`            | string     | 1–500 chars                                  |
 * | `author`                 | string     | 1–200 chars                                  |
 * | `categories`             | enum[]     | at least one; values from PLUGIN_CATEGORIES  |
 * | `minimumHostVersion`     | string?    | semver lower bound if present, no leading `v`|
 * | `capabilities`           | enum[]     | at least one; values from PLUGIN_CAPABILITIES|
 * | `entrypoints.worker`     | string     | min 1 char                                   |
 * | `entrypoints.ui`         | string?    | required when `ui.slots` is declared         |
 *
 * Cross-field rules enforced via `superRefine`:
 * - `entrypoints.ui` and a non-empty `ui` declaration require each other
 * - `agent.tools.register` capability required when `tools` declared
 * - `jobs.schedule` capability required when `jobs` declared
 * - `webhooks.receive` capability required when `webhooks` declared
 * - duplicate `jobs[].jobKey` values are rejected
 * - duplicate `webhooks[].endpointKey` values are rejected
 * - duplicate `tools[].name` values are rejected
 * - duplicate `ui.slots[].id` values are rejected
 *
 * @see PLUGIN_SPEC.md §10.1 — Manifest shape
 * @see {@link PaperclipPluginManifestV1} — the inferred TypeScript type
 */
export const pluginManifestV1Schema = z.object({
  id: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Plugin id must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores",
  ).refine((id) => !id.includes("__"), {
    message: "Plugin id must not contain the reserved tool namespace separator '__'",
  }),
  apiVersion: z.literal(1),
  version: z.string().min(1).regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "Version must follow semver (e.g. 1.0.0 or 1.0.0-beta.1)",
  ),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  author: z.string().min(1).max(200),
  categories: z.array(z.enum(PLUGIN_CATEGORIES)).min(1),
  minimumHostVersion: z.string().regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "minimumHostVersion must follow semver (e.g. 1.0.0)",
  ).optional(),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1),
  entrypoints: z.object({
    worker: pluginPackageEntrypointSchema,
    ui: pluginPackageEntrypointSchema.optional(),
  }).strict(),
  instanceConfigSchema: jsonSchemaSchema.optional(),
  jobs: z.array(pluginJobDeclarationSchema).min(1).optional(),
  webhooks: z.array(pluginWebhookDeclarationSchema).min(1).optional(),
  tools: z.array(pluginToolDeclarationSchema).min(1).optional(),
  database: pluginDatabaseDeclarationSchema.optional(),
  apiRoutes: z.array(pluginApiRouteDeclarationSchema).min(1).optional(),
  agents: z.array(pluginManagedAgentDeclarationSchema).min(1).optional(),
  projects: z.array(pluginManagedProjectDeclarationSchema).min(1).optional(),
  routines: z.array(pluginManagedRoutineDeclarationSchema).min(1).optional(),
  skills: z.array(pluginManagedSkillDeclarationSchema).min(1).optional(),
  localFolders: z.array(pluginLocalFolderDeclarationSchema).min(1).optional(),
  ui: z.object({
    slots: z.array(pluginUiSlotDeclarationSchema).min(1).optional(),
    launchers: z.array(pluginLauncherDeclarationSchema).min(1).optional(),
  }).strict().refine(
    (ui) => Boolean(ui.slots?.length || ui.launchers?.length),
    { message: "ui must declare at least one slot or launcher" },
  ).optional(),
}).strict().superRefine((manifest, ctx) => {
  if (
    manifest.instanceConfigSchema
    && containsSecretRefFormat(manifest.instanceConfigSchema)
  ) {
    addValidationDetail(ctx, {
      message: "instanceConfigSchema must store plugin credentials as ordinary configuration values",
      path: ["instanceConfigSchema"],
    });
  }

  // ── Entrypoint ↔ UI slot consistency ──────────────────────────────────
  // Plugins that declare UI slots must also declare a UI entrypoint so the
  // host knows where to load the bundle from (PLUGIN_SPEC.md §10.1).
  const hasUiSlots = (manifest.ui?.slots?.length ?? 0) > 0;
  const hasUiLaunchers = (manifest.ui?.launchers?.length ?? 0) > 0;
  if ((hasUiSlots || hasUiLaunchers) && !manifest.entrypoints.ui) {
    addValidationDetail(ctx, {
      message: "entrypoints.ui is required when ui.slots or ui.launchers are declared",
      path: ["entrypoints", "ui"],
    });
  }
  if (manifest.entrypoints.ui && !hasUiSlots && !hasUiLaunchers) {
    addValidationDetail(ctx, {
      message: "entrypoints.ui requires at least one ui slot or launcher",
      path: ["entrypoints", "ui"],
    });
  }

  const duplicateCategories = manifest.categories.filter(
    (category, index) => manifest.categories.indexOf(category) !== index,
  );
  if (duplicateCategories.length > 0) {
    addValidationDetail(ctx, {
      message: `Duplicate plugin categories: ${[...new Set(duplicateCategories)].join(", ")}`,
      path: ["categories"],
    });
  }

  const duplicateCapabilities = manifest.capabilities.filter(
    (capability, index) => manifest.capabilities.indexOf(capability) !== index,
  );
  if (duplicateCapabilities.length > 0) {
    addValidationDetail(ctx, {
      message: `Duplicate plugin capabilities: ${[...new Set(duplicateCapabilities)].join(", ")}`,
      path: ["capabilities"],
    });
  }

  // ── Capability ↔ feature declaration consistency ───────────────────────
  // The host enforces capabilities at install and runtime. A plugin must
  // declare every capability it needs up-front; silently having more features
  // than capabilities would cause runtime rejections.

  // tools require agent.tools.register (PLUGIN_SPEC.md §11)
  if (manifest.tools && manifest.tools.length > 0) {
    if (!manifest.capabilities.includes("agent.tools.register")) {
      addValidationDetail(ctx, {
        message: "Capability 'agent.tools.register' is required when tools are declared",
        path: ["capabilities"],
      });
    }
  }

  if (
    manifest.capabilities.includes("http.private-network")
    && !manifest.capabilities.includes("http.outbound")
  ) {
    addValidationDetail(ctx, {
      message: "Capability 'http.outbound' is required when 'http.private-network' is declared",
      path: ["capabilities"],
    });
  }

  if (manifest.agents && manifest.agents.length > 0) {
    if (!manifest.capabilities.includes("agents.managed")) {
      addValidationDetail(ctx, {
        message: "Capability 'agents.managed' is required when managed agents are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.projects && manifest.projects.length > 0) {
    if (!manifest.capabilities.includes("projects.managed")) {
      addValidationDetail(ctx, {
        message: "Capability 'projects.managed' is required when managed projects are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.routines && manifest.routines.length > 0) {
    if (!manifest.capabilities.includes("routines.managed")) {
      addValidationDetail(ctx, {
        message: "Capability 'routines.managed' is required when managed routines are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.skills && manifest.skills.length > 0) {
    if (!manifest.capabilities.includes("skills.managed")) {
      addValidationDetail(ctx, {
        message: "Capability 'skills.managed' is required when managed skills are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.localFolders && manifest.localFolders.length > 0) {
    if (!manifest.capabilities.includes("local.folders")) {
      addValidationDetail(ctx, {
        message: "Capability 'local.folders' is required when local folders are declared",
        path: ["capabilities"],
      });
    }
  }

  // jobs require jobs.schedule (PLUGIN_SPEC.md §17)
  if (manifest.jobs && manifest.jobs.length > 0) {
    if (!manifest.capabilities.includes("jobs.schedule")) {
      addValidationDetail(ctx, {
        message: "Capability 'jobs.schedule' is required when jobs are declared",
        path: ["capabilities"],
      });
    }
  }

  // webhooks require webhooks.receive (PLUGIN_SPEC.md §18)
  if (manifest.webhooks && manifest.webhooks.length > 0) {
    if (!manifest.capabilities.includes("webhooks.receive")) {
      addValidationDetail(ctx, {
        message: "Capability 'webhooks.receive' is required when webhooks are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.apiRoutes && manifest.apiRoutes.length > 0) {
    if (!manifest.capabilities.includes("api.routes.register")) {
      addValidationDetail(ctx, {
        message: "Capability 'api.routes.register' is required when apiRoutes are declared",
        path: ["capabilities"],
      });
    }
  }

  const requiredUiCapabilities = new Set<PluginCapability>();
  for (const slot of manifest.ui?.slots ?? []) {
    requiredUiCapabilities.add(UI_SLOT_CAPABILITIES[slot.type]);
  }
  for (const launcher of manifest.ui?.launchers ?? []) {
    requiredUiCapabilities.add(
      LAUNCHER_PLACEMENT_CAPABILITIES[launcher.placementZone],
    );
  }
  for (const capability of requiredUiCapabilities) {
    if (!manifest.capabilities.includes(capability)) {
      addValidationDetail(ctx, {
        message: `Capability '${capability}' is required by the declared UI slots or launchers`,
        path: ["capabilities"],
      });
    }
  }

  if (manifest.database) {
    const requiredCapabilities = [
      "database.namespace.migrate",
      "database.namespace.read",
    ] as const;
    for (const capability of requiredCapabilities) {
      if (!manifest.capabilities.includes(capability)) {
        addValidationDetail(ctx, {
          message: `Capability '${capability}' is required when database migrations are declared`,
          path: ["capabilities"],
        });
      }
    }

    const coreReadTables = manifest.database.coreReadTables ?? [];
    const duplicates = coreReadTables.filter((table, i) => coreReadTables.indexOf(table) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate database coreReadTables: ${[...new Set(duplicates)].join(", ")}`,
        path: ["database", "coreReadTables"],
      });
    }
  }

  // ── Uniqueness checks ──────────────────────────────────────────────────
  // Duplicate keys within a plugin's own manifest are always a bug. The host
  // would not know which declaration takes precedence, so we reject early.

  // job keys must be unique within the plugin (used as identifiers in the DB)
  if (manifest.jobs) {
    const jobKeys = manifest.jobs.map((j) => j.jobKey);
    const duplicates = jobKeys.filter((key, i) => jobKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate job keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["jobs"],
      });
    }
  }

  // webhook endpoint keys must be unique within the plugin (used in routes)
  if (manifest.webhooks) {
    const endpointKeys = manifest.webhooks.map((w) => w.endpointKey);
    const duplicates = endpointKeys.filter((key, i) => endpointKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate webhook endpoint keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["webhooks"],
      });
    }
  }

  if (manifest.apiRoutes) {
    const routeKeys = manifest.apiRoutes.map((route) => route.routeKey);
    const duplicateKeys = routeKeys.filter((key, i) => routeKeys.indexOf(key) !== i);
    if (duplicateKeys.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate api route keys: ${[...new Set(duplicateKeys)].join(", ")}`,
        path: ["apiRoutes"],
      });
    }
    const routeSignatures = manifest.apiRoutes.map((route) => `${route.method} ${route.path}`);
    const duplicateRoutes = routeSignatures.filter((sig, i) => routeSignatures.indexOf(sig) !== i);
    if (duplicateRoutes.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate api routes: ${[...new Set(duplicateRoutes)].join(", ")}`,
        path: ["apiRoutes"],
      });
    }
  }

  // tool names must be unique within the plugin (namespaced at runtime)
  if (manifest.tools) {
    const toolNames = manifest.tools.map((t) => t.name);
    const duplicates = toolNames.filter((name, i) => toolNames.indexOf(name) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate tool names: ${[...new Set(duplicates)].join(", ")}`,
        path: ["tools"],
      });
    }
    for (const [index, tool] of manifest.tools.entries()) {
      if (!isMcpToolName(pluginAgentToolName(manifest.id, tool.name))) {
        addValidationDetail(ctx, {
          message: `Provider-visible plugin tool name must satisfy the MCP name contract and not exceed ${MCP_TOOL_NAME_MAX_LENGTH} characters`,
          path: ["tools", index, "name"],
        });
      }
    }
  }

  if (manifest.localFolders) {
    const folderKeys = manifest.localFolders.map((folder) => folder.folderKey);
    const duplicates = folderKeys.filter((key, i) => folderKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate local folder keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["localFolders"],
      });
    }
  }

  if (manifest.agents) {
    const agentKeys = manifest.agents.map((agent) => agent.agentKey);
    const duplicates = agentKeys.filter((key, i) => agentKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate managed agent keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["agents"],
      });
    }
  }

  if (manifest.projects) {
    const projectKeys = manifest.projects.map((project) => project.projectKey);
    const duplicates = projectKeys.filter((key, i) => projectKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate managed project keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["projects"],
      });
    }
  }

  if (manifest.routines) {
    const routineKeys = manifest.routines.map((routine) => routine.routineKey);
    const duplicates = routineKeys.filter((key, i) => routineKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate managed routine keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["routines"],
      });
    }
  }

  if (manifest.skills) {
    const skillKeys = manifest.skills.map((skill) => skill.skillKey);
    const duplicates = skillKeys.filter((key, i) => skillKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate managed skill keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["skills"],
      });
    }
  }

  // UI slot ids must be unique within the plugin (namespaced at runtime)
  if (manifest.ui) {
    if (manifest.ui.slots) {
      const slots = manifest.ui.slots;
      const slotIds = slots.map((s) => s.id);
      const duplicates = slotIds.filter((id, i) => slotIds.indexOf(id) !== i);
      if (duplicates.length > 0) {
        addValidationDetail(ctx, {
          message: `Duplicate UI slot ids: ${[...new Set(duplicates)].join(", ")}`,
          path: ["ui", "slots"],
        });
      }

      for (const routeType of ["page", "companySettingsPage"] as const) {
        const routePaths = slots
          .filter((slot) => slot.type === routeType)
          .map((slot) => slot.routePath!);
        const duplicatePaths = routePaths.filter(
          (routePath, index) => routePaths.indexOf(routePath) !== index,
        );
        if (duplicatePaths.length > 0) {
          addValidationDetail(ctx, {
            message: `Duplicate ${routeType} routePath values: ${[...new Set(duplicatePaths)].join(", ")}`,
            path: ["ui", "slots"],
          });
        }
      }

      for (const [index, sidebar] of slots.entries()) {
        if (sidebar.type !== "routeSidebar") continue;
        const matchingPages = slots.filter(
          (slot) => slot.type === "page" && slot.routePath === sidebar.routePath,
        );
        const matchingSidebars = slots.filter(
          (slot) => slot.type === "routeSidebar" && slot.routePath === sidebar.routePath,
        );
        if (matchingPages.length !== 1 || matchingSidebars.length !== 1) {
          addValidationDetail(ctx, {
            message: "routeSidebar must be the sole sidebar paired with one page of the same routePath",
            path: ["ui", "slots", index, "routePath"],
          });
        }
      }
    }
  }

  // launcher ids must be unique within the plugin
  const allLaunchers = manifest.ui?.launchers ?? [];
  if (allLaunchers.length > 0) {
    const launcherIds = allLaunchers.map((launcher) => launcher.id);
    const duplicates = launcherIds.filter((id, i) => launcherIds.indexOf(id) !== i);
    if (duplicates.length > 0) {
      addValidationDetail(ctx, {
        message: `Duplicate launcher ids: ${[...new Set(duplicates)].join(", ")}`,
        path: ["ui", "launchers"],
      });
    }
  }
});
