import type {
  PluginStatus,
  PluginCategory,
  PluginCapability,
  PluginUiSlotType,
  PluginUiSlotEntityType,
  PluginStateScopeKind,
  PluginLauncherPlacementZone,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
  PluginApiRouteMethod,
  PluginDatabaseCoreReadTable,
  PluginDatabaseMigrationStatus,
  PluginJobStatus,
  PluginJobRunStatus,
  PluginJobRunTrigger,
  PluginWebhookDeliveryStatus,
  IssuePriority,
  ProjectStatus,
  RoutineCatchUpPolicy,
  RoutineConcurrencyPolicy,
  RoutineStatus,
  IssueSurfaceVisibility,
} from "../constants.js";
import type { Agent } from "./agent.js";
import type { CompanySkill } from "./company-skill.js";
import type { Project } from "./project.js";
import type { Routine, RoutineTrigger, RoutineVariable } from "./routine.js";
import type { ContextAccess } from "../issue-runtime.js";

// ---------------------------------------------------------------------------
// JSON Schema placeholder – plugins declare config schemas as JSON Schema
// ---------------------------------------------------------------------------

/**
 * A JSON Schema object used for plugin config schemas and tool parameter schemas.
 * Plugins provide these as plain JSON Schema compatible objects.
 *
 * The Paperclip extension keywords below are recognised by the Paperclip UI
 * but are otherwise ignored by standard JSON Schema validators.
 */
export type JsonSchema = {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /**
   * When true, the Paperclip config UI hides this property behind an
   * "Advanced options" disclosure. Defaults to false (always visible).
   */
  "x-paperclip-advanced"?: boolean;
  /**
   * Optional sub-section heading used to group advanced properties inside
   * the disclosure (e.g. "SSH access", "VM resources"). Ignored when
   * `x-paperclip-advanced` is not true.
   */
  "x-paperclip-group"?: string;
  [key: string]: unknown;
};

export type {
  PluginDatabaseCoreReadTable,
  PluginDatabaseMigrationStatus,
  PluginDatabaseNamespaceStatus,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Manifest sub-types — nested declarations within PaperclipPluginManifestV1
// ---------------------------------------------------------------------------

/**
 * Declares a scheduled job a plugin can run.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 */
export interface PluginJobDeclaration {
  /** Stable identifier for this job, unique within the plugin. */
  jobKey: string;
  /** Human-readable name shown in the operator UI. */
  displayName: string;
  /** Optional description of what the job does. */
  description?: string;
  /** Cron expression for the schedule (e.g. "star/15 star star star star" or "0 * * * *"). */
  schedule: string;
}

/**
 * Declares a webhook endpoint the plugin can receive.
 * Route: `POST /api/plugins/:pluginId/webhooks/:endpointKey`
 *
 * @see PLUGIN_SPEC.md §18 — Webhooks
 */
export interface PluginWebhookDeclaration {
  /** Stable identifier for this endpoint, unique within the plugin. */
  endpointKey: string;
  /** Human-readable name shown in the operator UI. */
  displayName: string;
  /** Optional description of what this webhook handles. */
  description?: string;
}

/**
 * Declares an agent tool contributed by the plugin. Tools are namespaced
 * by plugin ID at runtime (e.g. `linear__search-issues`).
 *
 * Requires the `agent.tools.register` capability.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 */
export interface PluginToolDeclaration {
  /** Tool name, unique within the plugin. Namespaced by plugin ID at runtime. */
  name: string;
  /** Human-readable name shown to agents and in the UI. */
  displayName: string;
  /** Description provided to the agent so it knows when to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: JsonSchema;
  /** Whether this ready plugin tool may execute during an agent role bootstrap. */
  bootstrapEnabled?: boolean;
}

/**
 * Declares an environment runtime driver contributed by the plugin.
 *
 * Requires the `environment.drivers.register` capability.
 */
export interface PluginEnvironmentTemplateConfigBinding {
  /** Top-level provider config field that should receive the captured template ref. */
  field: string;
  /** Top-level provider config fields to remove when the captured template ref is applied. */
  unsetFields?: string[];
}

export interface PluginEnvironmentDriverDeclaration {
  /** Stable driver key, unique within the plugin. Namespaced by plugin ID at runtime. */
  driverKey: string;
  /**
   * Driver classification.
   *
   * `environment_driver` is used by core `driver: "plugin"` environments.
   * `sandbox_provider` is used by core `driver: "sandbox"` environments whose
   * provider key is implemented by a plugin.
   */
  kind?: "environment_driver" | "sandbox_provider";
  /** Human-readable name shown in environment configuration UI. */
  displayName: string;
  /** Optional description for operator-facing docs or UI affordances. */
  description?: string;
  /**
   * Sandbox providers must opt in before the host retains and resumes provider
   * leases across runs. Providers without this flag keep per-run acquire/release
   * behavior even if their config schema exposes a reuse-like setting.
   */
  supportsReusableLeases?: boolean;
  /** Provider can keep a temporary setup sandbox alive for user-driven sandbox customization and capture. */
  supportsInteractiveSetup?: boolean;
  /** Connection types the setup sandbox can expose. Initially `ssh`; providers may add custom values. */
  interactiveSetupConnectionTypes?: string[];
  /** Provider can capture a reusable template from a live setup sandbox. */
  supportsTemplateCapture?: boolean;
  /** Kind of template reference returned by the provider's capture hook. */
  templateRefKind?: "snapshot" | "image" | "provider_template" | "unknown" | (string & {});
  /**
   * How Paperclip should apply a captured template ref back into this provider's
   * runtime config. Omit to use the standard key for `templateRefKind`.
   */
  templateConfigBinding?: PluginEnvironmentTemplateConfigBinding;
  /**
   * Config paths (dot notation) that scope where captured templates live for
   * this provider, such as an API endpoint. When one of these changes on a
   * saved environment, captured templates cannot be re-linked to the updated
   * config and a fresh capture is required.
   */
  templateIdentityPaths?: string[];
  /** Provider supports best-effort deletion/cleanup of captured templates. */
  supportsTemplateDelete?: boolean;
  /** JSON Schema describing the driver's provider-specific configuration. */
  configSchema: JsonSchema;
}

/**
 * Declares a normal Paperclip agent that a plugin can provision and later
 * resolve by stable key within each company.
 */
export interface PluginManagedAgentDeclaration {
  /** Stable identifier for this managed agent, unique within the plugin. */
  agentKey: string;
  /** Suggested visible agent name. */
  displayName: string;
  /** Optional suggested title shown in agent surfaces. */
  title?: string | null;
  /** Suggested capability summary for the agent. */
  capabilities?: string | null;
}

/**
 * Declares a company-scoped local folder a trusted plugin wants the operator
 * to configure. The host treats this as a generic filesystem root: plugin
 * code may request required relative folders/files, then use SDK helpers for
 * path-safe reads and atomic writes under that root.
 */
export interface PluginLocalFolderDeclaration {
  /** Stable identifier for this folder, unique within the plugin. */
  folderKey: string;
  /** Human-readable name shown in plugin settings. */
  displayName: string;
  /** Optional operator-facing description. */
  description?: string;
  /** Access level requested by the plugin. Defaults to `readWrite`. */
  access?: "read" | "readWrite";
  /** Relative directories expected to exist under the configured root. */
  requiredDirectories?: string[];
  /** Relative files expected to exist under the configured root. */
  requiredFiles?: string[];
}

/** A single problem the host found while validating a configured local folder. */
export interface PluginLocalFolderProblem {
  code:
    | "not_configured"
    | "not_absolute"
    | "missing"
    | "not_directory"
    | "not_readable"
    | "not_writable"
    | "missing_directory"
    | "missing_file"
    | "path_traversal"
    | "symlink_escape"
    | "atomic_write_failed";
  message: string;
  path?: string;
}

/** Host-computed health snapshot for a configured plugin local folder. */
export interface PluginLocalFolderStatus {
  folderKey: string;
  configured: boolean;
  path: string | null;
  realPath: string | null;
  access: "read" | "readWrite";
  readable: boolean;
  writable: boolean;
  requiredDirectories: string[];
  requiredFiles: string[];
  missingDirectories: string[];
  missingFiles: string[];
  healthy: boolean;
  problems: PluginLocalFolderProblem[];
  checkedAt: string;
}

/**
 * Declares a normal Paperclip project that a plugin can provision and later
 * resolve by stable key within each company.
 */
export interface PluginManagedProjectDeclaration {
  /** Stable identifier for this managed project, unique within the plugin. */
  projectKey: string;
  /** Suggested visible project name. */
  displayName: string;
  /** Suggested project description. */
  description?: string | null;
  /** Suggested starting status. Defaults to `in_progress`. */
  status?: ProjectStatus;
  /** Suggested project color. Defaults to the normal project palette. */
  color?: string | null;
  /** Optional plugin-specific defaults retained for reset/reconcile UI. */
  settings?: Record<string, unknown>;
}

export interface PluginManagedSkillFileDeclaration {
  /** Relative path inside the skill folder, for example `references/guide.md`. */
  path: string;
  /** File contents written when the skill is installed or reset. */
  content: string;
}

/**
 * Declares a company skill that a plugin can install into each company's
 * skills library and later resolve by stable key.
 */
export interface PluginManagedSkillDeclaration {
  /** Stable identifier for this managed skill, unique within the plugin. */
  skillKey: string;
  /** Suggested visible skill name. */
  displayName: string;
  /** Suggested skill slug. Defaults to `skillKey`. */
  slug?: string;
  /** Suggested skill description. */
  description?: string | null;
  /** Full `SKILL.md` contents. Defaults to generated markdown from display metadata. */
  markdown?: string;
  /** Additional files installed with the skill. */
  files?: PluginManagedSkillFileDeclaration[];
}

export type PluginManagedResourceKind = "agent" | "project" | "routine" | "skill";

export interface PluginManagedResourceRef {
  pluginKey?: string;
  resourceKind: PluginManagedResourceKind;
  resourceKey: string;
}

export interface PluginManagedRoutineDeclaration {
  /** Stable identifier for this managed routine, unique within the plugin. */
  routineKey: string;
  /** Suggested routine title template. */
  title: string;
  /** Suggested routine description template. */
  description?: string | null;
  /** Stable managed agent reference for the default assignee. */
  assigneeRef?: PluginManagedResourceRef | null;
  /** Stable managed project reference for routine-created issues. */
  projectRef?: PluginManagedResourceRef | null;
  /** Optional goal id to set on the routine in this company. */
  goalId?: string | null;
  /** Suggested starting status. Defaults to `paused` when no assignee is resolved, otherwise `active`. */
  status?: RoutineStatus;
  /** Suggested issue priority. Defaults to `medium`. */
  priority?: IssuePriority;
  /** Suggested concurrency behavior. Defaults to core routine default. */
  concurrencyPolicy?: RoutineConcurrencyPolicy;
  /** Suggested missed-trigger behavior. Defaults to core routine default. */
  catchUpPolicy?: RoutineCatchUpPolicy;
  /** Suggested routine variables. Labels and default values are optional. */
  variables?: Array<
    Omit<RoutineVariable, "label" | "defaultValue">
    & Partial<Pick<RoutineVariable, "label" | "defaultValue">>
  >;
  /** Suggested triggers created when the routine is first reconciled. */
  triggers?: Array<
    Pick<RoutineTrigger, "kind">
    & Partial<Pick<RoutineTrigger, "label" | "enabled" | "cronExpression" | "timezone" | "signingMode" | "replayWindowSec">>
  >;
  /** Defaults for issues created by this routine. */
  issueTemplate?: {
    surfaceVisibility?: IssueSurfaceVisibility;
    originId?: string | null;
    billingCode?: string | null;
    contextAccessMask?: ContextAccess | null;
  };
}

export interface PluginManagedAgentResolution {
  pluginKey: string;
  resourceKind: "agent";
  resourceKey: string;
  companyId: string;
  agentId: string | null;
  agent: Agent | null;
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
  approvalId?: string | null;
}

export interface PluginManagedProjectResolution {
  pluginKey: string;
  resourceKind: "project";
  resourceKey: string;
  companyId: string;
  projectId: string | null;
  project: Project | null;
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
}

export interface PluginManagedRoutineResolution {
  pluginKey: string;
  resourceKind: "routine";
  resourceKey: string;
  companyId: string;
  routineId: string | null;
  routine: Routine | null;
  status: "missing" | "missing_refs" | "resolved" | "created" | "relinked" | "reset";
  missingRefs?: PluginManagedResourceRef[];
}

export interface PluginManagedSkillResolution {
  pluginKey: string;
  resourceKind: "skill";
  resourceKey: string;
  companyId: string;
  skillId: string | null;
  skill: CompanySkill | null;
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
  defaultDrift?: {
    changedFiles: string[];
  } | null;
}

/**
 * Declares a UI extension slot the plugin fills with a React component.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
interface PluginUiSlotDeclarationBase {
  /** Unique slot identifier within the plugin. */
  id: string;
  /** Human-readable name shown in navigation or tab labels. */
  displayName: string;
  /** Which export name in the UI bundle provides this component. */
  exportName: string;
  /**
   * Optional ordering hint within a slot surface. Lower numbers appear first.
   * Defaults to host-defined ordering if omitted.
   */
  order?: number;
}

type PluginRoutedUiSlotDeclaration = {
  type: "page" | "routeSidebar" | "companySettingsPage";
  /** Canonical company-scoped route segment owned by this slot. */
  routePath: string;
  entityTypes?: never;
};

type PluginEntityUiSlotDeclaration =
  | {
      type: "detailTab";
      entityTypes: PluginUiSlotEntityType[];
      routePath?: never;
    }
  | {
      type: "issueDetailView";
      entityTypes: Array<Extract<PluginUiSlotEntityType, "issue">>;
      routePath?: never;
    }
  | {
      type: "projectSidebarItem";
      entityTypes: Array<Extract<PluginUiSlotEntityType, "project">>;
      routePath?: never;
    }
  | {
      type: "toolbarButton";
      entityTypes: Array<Extract<PluginUiSlotEntityType, "project" | "issue">>;
      routePath?: never;
    };

type PluginGlobalUiSlotDeclaration = {
  type: Exclude<
    PluginUiSlotType,
    PluginRoutedUiSlotDeclaration["type"] | PluginEntityUiSlotDeclaration["type"]
  >;
  entityTypes?: never;
  routePath?: never;
};

export type PluginUiSlotDeclaration = PluginUiSlotDeclarationBase & (
  | PluginRoutedUiSlotDeclaration
  | PluginEntityUiSlotDeclaration
  | PluginGlobalUiSlotDeclaration
);

/** Describes the exact action triggered by a plugin launcher surface. */
export type PluginLauncherActionDeclaration =
  | {
      /** Navigate within Paperclip. */
      type: "navigate";
      target: string;
      params?: never;
    }
  | {
      /** Open an absolute HTTP(S) URL in a new browser tab. */
      type: "deepLink";
      target: string;
      params?: never;
    }
  | {
      /** Invoke a plugin worker action. */
      type: "performAction";
      target: string;
      params?: Record<string, unknown>;
    }
  | {
      /** Render the named UI export in the corresponding host-owned overlay. */
      type: "openModal" | "openDrawer" | "openPopover";
      target: string;
      params?: never;
    };

/** Render metadata required by component-rendering launcher actions. */
export interface PluginLauncherRenderDeclaration {
  /** The concrete host-owned overlay container. */
  environment: PluginLauncherRenderEnvironment;
  /** Optional size hint for the destination surface. */
  bounds?: PluginLauncherBounds;
}

/**
 * Serializable runtime snapshot of the host launcher/container environment.
 */
export interface PluginLauncherRenderContextSnapshot {
  /** The concrete launcher/container environment selected by the host. */
  environment: PluginLauncherRenderEnvironment;
  /** Launcher id that opened this surface. */
  launcherId: string;
  /** Current host-applied bounds for the overlay. */
  bounds: PluginLauncherBounds;
}

/**
 * Declares a plugin launcher surface independent of the low-level slot
 * implementation that mounts it.
 */
interface PluginLauncherDeclarationBase {
  /** Stable identifier for this launcher, unique within the plugin. */
  id: string;
  /** Human-readable label shown for the launcher. */
  displayName: string;
  /** Optional operator-facing description. */
  description?: string;
  /** Optional ordering hint within the placement zone. */
  order?: number;
}

type PluginLauncherPlacementDeclaration =
  | {
      placementZone: "toolbarButton";
      entityTypes: Array<Extract<PluginUiSlotEntityType, "project" | "issue">>;
    }
  | {
      placementZone: Exclude<PluginLauncherPlacementZone, "toolbarButton">;
      entityTypes?: never;
    };

type PluginLauncherActionAndRenderDeclaration =
  | {
      action: Extract<
        PluginLauncherActionDeclaration,
        { type: "openModal" | "openDrawer" | "openPopover" }
      >;
      /** Required host-owned overlay metadata for component-rendering actions. */
      render: PluginLauncherRenderDeclaration;
    }
  | {
      action: Extract<
        PluginLauncherActionDeclaration,
        { type: "navigate" | "deepLink" | "performAction" }
      >;
      render?: never;
    };

export type PluginLauncherDeclaration = PluginLauncherDeclarationBase
  & PluginLauncherPlacementDeclaration
  & PluginLauncherActionAndRenderDeclaration;

/**
 * Groups plugin UI declarations that are served from the shared UI bundle
 * root declared in `entrypoints.ui`.
 */
export interface PluginUiDeclaration {
  /** UI extension slots this plugin fills. */
  slots?: PluginUiSlotDeclaration[];
  /** Declarative launcher metadata for host-mounted plugin entry points. */
  launchers?: PluginLauncherDeclaration[];
}

/**
 * Declares restricted database access for trusted orchestration plugins.
 *
 * Plugin-authored SQL uses the stable logical namespace derived from the key
 * and optional slug. The host compiles it to a physical namespace that also
 * includes the immutable installation identity, applies migrations before
 * worker startup, and gates runtime SQL through the
 * `database.namespace.*` capabilities.
 */
export interface PluginDatabaseDeclaration {
  /** Optional stable human-readable slug included in the host-derived namespace. */
  namespaceSlug?: string;
  /** SQL migration directory relative to the plugin package root. */
  migrationsDir: string;
  /** Public core tables this plugin may read or join at runtime. */
  coreReadTables?: PluginDatabaseCoreReadTable[];
}

export type PluginApiRouteCompanyResolution =
  | { from: "body"; key: string }
  | { from: "query"; key: string }
  | { from: "issue"; param: string };

export interface PluginApiRouteDeclaration {
  /** Stable plugin-defined route key passed to the worker. */
  routeKey: string;
  /** HTTP method accepted by this route. */
  method: PluginApiRouteMethod;
  /** Plugin-local path under `/api/plugins/:pluginId/api`, e.g. `/issues/:issueId/smoke`. */
  path: string;
  /** How the host resolves company access for this route. */
  companyResolution: PluginApiRouteCompanyResolution;
}

// ---------------------------------------------------------------------------
// Plugin Manifest V1
// ---------------------------------------------------------------------------

/**
 * The manifest shape every plugin package must export.
 * See PLUGIN_SPEC.md §10.1 for the normative definition.
 */
export interface PaperclipPluginManifestV1 {
  /** Globally unique plugin identifier (e.g. `"acme.linear-sync"`). Must be lowercase alphanumeric with dots, hyphens, or underscores. */
  id: string;
  /** Plugin API version. Must be `1` for the current spec. */
  apiVersion: 1;
  /** Semver version of the plugin package (e.g. `"1.2.0"`). */
  version: string;
  /** Human-readable name (max 100 chars). */
  displayName: string;
  /** Short description (max 500 chars). */
  description: string;
  /** Author name (max 200 chars). May include email in angle brackets, e.g. `"Jane Doe <jane@example.com>"`. */
  author: string;
  /** One or more categories classifying this plugin. */
  categories: PluginCategory[];
  /**
   * Minimum host version required (semver lower bound).
   * The host rejects installation when its running version is lower.
   */
  minimumHostVersion?: string;
  /** Capabilities this plugin requires from the host. Enforced at runtime. */
  capabilities: PluginCapability[];
  /** Entrypoint paths relative to the package root. */
  entrypoints: {
    /** Path to the worker entrypoint (required). */
    worker: string;
    /** Path to the UI bundle directory (present exactly when the manifest contributes UI). */
    ui?: string;
  };
  /** JSON Schema for operator-editable instance configuration. */
  instanceConfigSchema?: JsonSchema;
  /** Scheduled jobs this plugin declares. Requires `jobs.schedule` capability. */
  jobs?: PluginJobDeclaration[];
  /** Webhook endpoints this plugin declares. Requires `webhooks.receive` capability. */
  webhooks?: PluginWebhookDeclaration[];
  /** Agent tools this plugin contributes. Requires `agent.tools.register` capability. */
  tools?: PluginToolDeclaration[];
  /** Restricted plugin-owned database namespace declaration. */
  database?: PluginDatabaseDeclaration;
  /** Scoped JSON API routes mounted under `/api/plugins/:pluginId/api/*`. */
  apiRoutes?: PluginApiRouteDeclaration[];
  /** Environment drivers this plugin contributes. Requires `environment.drivers.register` capability. */
  environmentDrivers?: PluginEnvironmentDriverDeclaration[];
  /** Suggested company-scoped agents this plugin can provision and resolve by stable key. */
  agents?: PluginManagedAgentDeclaration[];
  /** Suggested company-scoped projects this plugin can provision and resolve by stable key. */
  projects?: PluginManagedProjectDeclaration[];
  /** Suggested company-scoped routines this plugin can provision and resolve by stable key. */
  routines?: PluginManagedRoutineDeclaration[];
  /** Suggested company skills this plugin can install and resolve by stable key. */
  skills?: PluginManagedSkillDeclaration[];
  /** Trusted local folders this plugin can configure and access by stable key. */
  localFolders?: PluginLocalFolderDeclaration[];
  /** Non-empty UI declarations. Present exactly when `entrypoints.ui` is declared. */
  ui?: PluginUiDeclaration;
}

// ---------------------------------------------------------------------------
// Plugin Record – represents a row in the `plugins` table
// ---------------------------------------------------------------------------

/** Explicit origin of one plugin installation. */
export type PluginInstallSource = "npm" | "local";

/**
 * Domain type for an installed plugin as persisted in the `plugins` table.
 * See PLUGIN_SPEC.md §21.3 for the schema definition.
 */
export interface PluginRecord {
  /** UUID primary key. */
  id: string;
  /** Unique key derived from `manifest.id`. Used for lookups. */
  pluginKey: string;
  /** npm package name (e.g. `"@acme/plugin-linear"`). */
  packageName: string;
  /** Explicit installation origin; never inferred from the package path. */
  source: PluginInstallSource;
  /** Full manifest snapshot persisted at install/upgrade time. */
  manifestJson: PaperclipPluginManifestV1;
  /** Current lifecycle status. */
  status: PluginStatus;
  /** Deterministic load order assigned when the installation row is created. */
  installOrder: number;
  /** Canonical resolved package root for this installation. */
  packagePath: string;
  /** Most recent lifecycle or runtime error message. */
  lastError: string | null;
  /** Timestamp when the plugin was first installed. */
  installedAt: Date;
  /** Timestamp of the most recent status or metadata change. */
  updatedAt: Date;
}

/** One ready plugin's normalized host-rendered UI declarations. */
export interface PluginUiContribution {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
}

/** Runtime states exposed by the plugin worker supervisor. */
export type PluginWorkerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "backoff";

/** Installation health snapshot returned by the plugin dashboard. */
export interface PluginHealthCheckResult {
  pluginId: string;
  status: PluginStatus;
  healthy: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
  lastError?: string;
}

/** Worker-process diagnostics returned by the plugin dashboard. */
export interface PluginWorkerDiagnostics {
  status: PluginWorkerStatus;
  pid: number | null;
  uptime: number | null;
  consecutiveCrashes: number;
  totalCrashes: number;
  pendingRequests: number;
  lastCrashAt: number | null;
  nextRestartAt: number | null;
}

/** Serialized recent job execution returned by the plugin dashboard. */
export interface PluginDashboardJobRun {
  id: string;
  jobId: string;
  jobKey: string;
  trigger: PluginJobRunTrigger;
  status: PluginJobRunStatus;
  durationMs: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Serialized recent webhook execution returned by the plugin dashboard. */
export interface PluginDashboardWebhookDelivery {
  id: string;
  webhookKey: string;
  status: PluginWebhookDeliveryStatus;
  durationMs: number | null;
  error: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Canonical aggregate returned by the plugin dashboard endpoint. */
export interface PluginDashboardData {
  pluginId: string;
  worker: PluginWorkerDiagnostics | null;
  recentJobRuns: PluginDashboardJobRun[];
  recentWebhookDeliveries: PluginDashboardWebhookDelivery[];
  health: PluginHealthCheckResult;
  checkedAt: string;
}

export interface PluginMigrationRecord {
  id: string;
  pluginId: string;
  pluginKey: string;
  namespaceName: string;
  migrationKey: string;
  checksum: string;
  pluginVersion: string;
  status: PluginDatabaseMigrationStatus;
  startedAt: Date;
  appliedAt: Date | null;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Plugin Config – represents a row in the `plugin_config` table
// ---------------------------------------------------------------------------

/**
 * Domain type for an installed plugin's instance-scoped configuration as persisted in the
 * `plugin_config` table.
 * See PLUGIN_SPEC.md §21.3 for the schema definition.
 */
export interface PluginConfig {
  /** UUID primary key. */
  id: string;
  /** FK to `plugins.id`. Unique for the installed plugin. */
  pluginId: string;
  /** Operator-provided configuration values (validated against `instanceConfigSchema`). */
  configJson: Record<string, unknown>;
  /** Timestamp when the config row was created. */
  createdAt: Date;
  /** Timestamp of the most recent config update. */
  updatedAt: Date;
}

/**
 * Company-scoped plugin settings row. This is intentionally generic; plugin
 * features such as local folders live inside `settingsJson` under namespaced
 * keys instead of requiring feature-specific database columns.
 */
export interface PluginCompanySettings {
  id: string;
  companyId: string;
  pluginId: string;
  settingsJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Plugin Job – represents a row in the `plugin_jobs` table
// ---------------------------------------------------------------------------

/**
 * Domain type for a registered plugin job as persisted in the `plugin_jobs` table.
 */
export interface PluginJobRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `plugins.id`. */
  pluginId: string;
  /** Job key matching the manifest declaration. */
  jobKey: string;
  /** Cron expression for the schedule. */
  schedule: string;
  /** Current job status. */
  status: PluginJobStatus;
  /** Next scheduled execution time. */
  nextRunAt: Date | null;
  /** ISO 8601 creation timestamp. */
  createdAt: Date;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Plugin Job Run – represents a row in the `plugin_job_runs` table
// ---------------------------------------------------------------------------

/**
 * Domain type for a job execution history record.
 */
export interface PluginJobRunRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `plugin_jobs.id`. */
  jobId: string;
  /** FK to `plugins.id`. */
  pluginId: string;
  /** What triggered this run. */
  trigger: PluginJobRunTrigger;
  /** Current run status. */
  status: PluginJobRunStatus;
  /** Run duration in milliseconds. */
  durationMs: number | null;
  /** Error message if the run failed. */
  error: string | null;
  /** ISO 8601 start timestamp. */
  startedAt: Date | null;
  /** ISO 8601 finish timestamp. */
  finishedAt: Date | null;
  /** ISO 8601 creation timestamp. */
  createdAt: Date;
}
