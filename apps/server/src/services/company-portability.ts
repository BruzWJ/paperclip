import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agentAdapterConfigRevisions,
  companies as companyRows,
  taskCreateIdempotencyKeys,
  taskExecutionRefs,
  taskLabels,
  tasks as taskRows,
  labels as labelRows,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityAdapterOverride,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityEnvInput,
  CompanyPortabilityExport,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilityTaskCommentManifestEntry,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityProjectManifestEntry,
  CompanyPortabilityTaskRoutineManifestEntry,
  CompanyPortabilityTaskRoutineTriggerManifestEntry,
  CompanyPortabilityTaskManifestEntry,
  CompanyPortabilitySidebarOrder,
  CompanyPortabilitySkillManifestEntry,
  CompanySkill,
  AgentEnvConfig,
  PermissionKey,
  RoutineVariable,
  AgentVisibleTaskStatus,
  TaskDisposition,
  TaskStatus,
} from "@paperclipai/shared";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  PAPERCLIP_ACTION_KEYS,
  PROJECT_ICON_NAMES,
  PROJECT_STATUSES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  agentAdapterAcpConfigurationSchema,
  decodeTaskDisposition,
  deriveProjectUrlKey,
  envConfigSchema,
  taskCommentAuthorTypeSchema,
  taskCommentMetadataSchema,
  taskCommentPresentationSchema,
  isUuidLike,
  normalizeAgentUrlKey,
  parseBudgetCurrency,
  parseMoneyAmount,
  PERMISSION_KEYS,
  portabilityAgentManifestEntrySchema,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";
import type { StorageService } from "../storage/types.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { assetService } from "./assets.js";
import { generateReadme } from "./company-export-readme.js";
import { renderOrgChartPng, type OrgNode } from "../routes/org-chart-svg.js";
import { companySkillService } from "./company-skills.js";
import { companyService } from "./companies.js";
import { validateCron } from "./cron.js";
import { taskService } from "./tasks.js";
import type { OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import {
  appendCanonicalControlNotice,
  appendCanonicalUserComment,
} from "./task-session-producers.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";
import {
  requireSecretMutationActor,
  secretService,
  type SecretMutationActor,
} from "./secrets.js";
import { validateRegisteredAdapterRuntimeConfiguration } from "./agent-adapter-config-revisions.js";
import { createAgentAdapterConfigurationService } from "./agent-adapter-config-revisions.js";
import { createAgentOperationalConfigurationService } from "./agent-operational-configuration.js";
import { createRuntimeAgentConfigurationService } from "./runtime-agent-configuration.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import {
  PORTABLE_CATALOG_PROVENANCE_STRING_KEYS,
  readCatalogStringList,
  readPortableCatalogProvenance,
} from "./catalog-provenance.js";
import { normalizePortablePath } from "./portable-path.js";
import { persistCanonicalTaskAggregateInTx } from "./canonical-task-aggregate.js";
import {
  TaskExecutionWorkspaceReservationRejected,
} from "./execution-workspaces.js";
import {
  resolveInvokableTaskOwnerInTransaction,
} from "./agent-invokability.js";
import {
  createTaskSessionAdmissionService,
} from "./task-session/admission.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";

/** Build OrgNode tree from manifest agent list (slug + reportsToSlug). */
function buildOrgTreeFromManifest(agents: CompanyPortabilityManifest["agents"]): OrgNode[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const childrenOf = new Map<string | null, typeof agents>();
  for (const a of agents) {
    const parent = a.reportsToSlug ?? null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const build = (parentSlug: string | null): OrgNode[] => {
    const members = childrenOf.get(parentSlug) ?? [];
    return members.map((m) => ({
      id: m.slug,
      name: m.name,
      subtitle: m.title ?? "",
      status: "active",
      reports: build(m.slug),
    }));
  };
  // Find roots: agents whose reportsToSlug is null or points to a non-existent slug
  const roots = agents.filter((a) => !a.reportsToSlug || !bySlug.has(a.reportsToSlug));
  const rootSlugs = new Set(roots.map((r) => r.slug));
  // Start from null parent, but also include orphans
  const tree = build(null);
  for (const root of roots) {
    if (root.reportsToSlug && !bySlug.has(root.reportsToSlug)) {
      // Orphan root (parent slug doesn't exist)
      tree.push({
        id: root.slug,
        name: root.name,
        subtitle: root.title ?? "",
        status: "active",
        reports: build(root.slug),
      });
    }
  }
  return tree;
}

const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: false,
  tasks: false,
  skills: false,
};

const DEFAULT_COLLISION_STRATEGY: CompanyPortabilityCollisionStrategy = "rename";
const execFileAsync = promisify(execFile);
let bundledSkillsCommitPromise: Promise<string | null> | null = null;

function resolveImportMode(options?: ImportPreviewOptions): ImportMode {
  return options?.mode ?? "board_full";
}

function resolveSkillConflictStrategy(mode: ImportMode, collisionStrategy: CompanyPortabilityCollisionStrategy) {
  if (mode === "board_full") return "replace" as const;
  return collisionStrategy === "skip" ? "skip" as const : "rename" as const;
}

function collectAgentSafeImportPolicyErrors(
  manifest: CompanyPortabilityManifest,
  include: CompanyPortabilityInclude,
) {
  const errors: string[] = [];
  if (include.tasks) {
    for (const task of manifest.tasks) {
      const triggers = task.routine?.triggers ?? [];
      for (const trigger of triggers) {
        if (trigger.kind !== "schedule") {
          errors.push(`Safe import does not allow routine task ${task.slug} ${trigger.kind} triggers.`);
        }
      }
    }
  }
  return errors;
}

function classifyPortableFileKind(pathValue: string): CompanyPortabilityExportPreviewResult["fileInventory"][number]["kind"] {
  const normalized = normalizePortablePath(pathValue);
  if (normalized === "COMPANY.md") return "company";
  if (normalized === ".paperclip.yaml" || normalized === ".paperclip.yml") return "extension";
  if (normalized === "README.md") return "readme";
  if (normalized.startsWith("agents/")) return "agent";
  if (normalized.startsWith("skills/")) return "skill";
  if (normalized.startsWith("projects/")) return "project";
  if (normalized.startsWith("tasks/")) return "task";
  return "other";
}

function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value) ?? null : null;
}

function normalizeSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

function readSkillKey(frontmatter: Record<string, unknown>) {
  const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
  const paperclip = isPlainRecord(metadata?.paperclip) ? metadata?.paperclip as Record<string, unknown> : null;
  return normalizeSkillKey(
    asString(frontmatter.key)
    ?? asString(frontmatter.skillKey)
    ?? asString(metadata?.skillKey)
    ?? asString(metadata?.canonicalKey)
    ?? asString(metadata?.paperclipSkillKey)
    ?? asString(paperclip?.skillKey)
    ?? asString(paperclip?.key),
  );
}

function deriveManifestSkillKey(
  frontmatter: Record<string, unknown>,
  fallbackSlug: string,
  metadata: Record<string, unknown> | null,
  sourceType: string,
  sourceLocator: string | null,
) {
  const explicit = readSkillKey(frontmatter);
  if (explicit) return explicit;
  const slug = normalizeSkillSlug(asString(frontmatter.slug) ?? fallbackSlug) ?? "skill";
  const sourceKind = asString(metadata?.sourceKind);
  const owner = normalizeSkillSlug(asString(metadata?.owner));
  const repo = normalizeSkillSlug(asString(metadata?.repo));
  if ((sourceType === "github" || sourceType === "skills_sh" || sourceKind === "github" || sourceKind === "skills_sh") && owner && repo) {
    return `${owner}/${repo}/${slug}`;
  }
  if (sourceKind === "paperclip_bundled") {
    return `paperclipai/paperclip/${slug}`;
  }
  if (sourceType === "url" || sourceKind === "url") {
    try {
      const host = normalizeSkillSlug(sourceLocator ? new URL(sourceLocator).host : null) ?? "url";
      return `url/${host}/${slug}`;
    } catch {
      return `url/unknown/${slug}`;
    }
  }
  return slug;
}

function hashSkillValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function normalizeExportPathSegment(value: string | null | undefined, preserveCase = false) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  return preserveCase ? normalized : normalized.toLowerCase();
}

function readSkillSourceKind(skill: CompanySkill) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  return asString(metadata?.sourceKind);
}

function buildPortableCatalogProvenance(skill: CompanySkill) {
  if (skill.sourceType !== "catalog") return null;
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const provenance: Record<string, unknown> = {
    skillKey: skill.key,
  };

  const sourceRef = asString(skill.sourceRef) ?? asString(metadata?.originHash);
  if (sourceRef) provenance.sourceRef = sourceRef;

  for (const key of PORTABLE_CATALOG_PROVENANCE_STRING_KEYS) {
    if (key === "sourceRef") continue;
    const value = asString(metadata?.[key]);
    if (value) provenance[key] = value;
  }

  const auditCodes = readCatalogStringList(metadata?.auditCodes);
  if (auditCodes) provenance.auditCodes = auditCodes;

  return Object.keys(provenance).length > 1 ? provenance : null;
}

function deriveLocalExportNamespace(skill: CompanySkill, slug: string) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const candidates = [
    asString(metadata?.projectName),
    asString(metadata?.workspaceName),
  ];

  if (skill.sourceLocator) {
    const basename = path.basename(skill.sourceLocator);
    candidates.push(basename.toLowerCase() === "skill.md" ? path.basename(path.dirname(skill.sourceLocator)) : basename);
  }

  for (const value of candidates) {
    const normalized = normalizeSkillSlug(value);
    if (normalized && normalized !== slug) return normalized;
  }

  return null;
}

function derivePrimarySkillExportDir(
  skill: CompanySkill,
  slug: string,
  companyTaskPrefix: string | null | undefined,
) {
  const normalizedKey = normalizeSkillKey(skill.key);
  const keySegments = normalizedKey?.split("/") ?? [];
  const primaryNamespace = keySegments[0] ?? null;

  if (primaryNamespace === "company") {
    const companySegment = normalizeExportPathSegment(companyTaskPrefix, true)
      ?? normalizeExportPathSegment(keySegments[1], true)
      ?? "company";
    return `skills/company/${companySegment}/${slug}`;
  }

  if (primaryNamespace === "local") {
    const localNamespace = deriveLocalExportNamespace(skill, slug);
    return localNamespace
      ? `skills/local/${localNamespace}/${slug}`
      : `skills/local/${slug}`;
  }

  if (primaryNamespace === "url") {
    let derivedHost: string | null = keySegments[1] ?? null;
    if (!derivedHost) {
      try {
        derivedHost = normalizeSkillSlug(skill.sourceLocator ? new URL(skill.sourceLocator).host : null);
      } catch {
        derivedHost = null;
      }
    }
    const host = derivedHost ?? "url";
    return `skills/url/${host}/${slug}`;
  }

  if (keySegments.length > 1) {
    return `skills/${keySegments.join("/")}`;
  }

  return `skills/${slug}`;
}

function appendSkillExportDirSuffix(packageDir: string, suffix: string) {
  const lastSeparator = packageDir.lastIndexOf("/");
  if (lastSeparator < 0) return `${packageDir}--${suffix}`;
  return `${packageDir.slice(0, lastSeparator + 1)}${packageDir.slice(lastSeparator + 1)}--${suffix}`;
}

function deriveSkillExportDirCandidates(
  skill: CompanySkill,
  slug: string,
  companyTaskPrefix: string | null | undefined,
) {
  const primaryDir = derivePrimarySkillExportDir(skill, slug, companyTaskPrefix);
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const sourceKind = readSkillSourceKind(skill);
  const suffixes = new Set<string>();
  const pushSuffix = (value: string | null | undefined, preserveCase = false) => {
    const normalized = normalizeExportPathSegment(value, preserveCase);
    if (normalized && normalized !== slug) {
      suffixes.add(normalized);
    }
  };

  if (sourceKind === "paperclip_bundled") {
    pushSuffix("paperclip");
  }

  if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
    pushSuffix(asString(metadata?.repo));
    pushSuffix(asString(metadata?.owner));
    pushSuffix(skill.sourceType === "skills_sh" ? "skills_sh" : "github");
  } else if (skill.sourceType === "url") {
    try {
      pushSuffix(skill.sourceLocator ? new URL(skill.sourceLocator).host : null);
    } catch {
      // Ignore URL parse failures and fall through to generic suffixes.
    }
    pushSuffix("url");
  } else if (skill.sourceType === "local_path") {
    pushSuffix(asString(metadata?.projectName));
    pushSuffix(asString(metadata?.workspaceName));
    pushSuffix(deriveLocalExportNamespace(skill, slug));
    if (sourceKind === "managed_local") pushSuffix("company");
    if (sourceKind === "project_scan") pushSuffix("project");
    pushSuffix("local");
  } else {
    pushSuffix(sourceKind);
    pushSuffix("skill");
  }

  return [primaryDir, ...Array.from(suffixes, (suffix) => appendSkillExportDirSuffix(primaryDir, suffix))];
}

function buildSkillExportDirMap(skills: CompanySkill[], companyTaskPrefix: string | null | undefined) {
  const usedDirs = new Set<string>();
  const keyToDir = new Map<string, string>();
  const orderedSkills = [...skills].sort((left, right) => left.key.localeCompare(right.key));
  for (const skill of orderedSkills) {
    const slug = normalizeSkillSlug(skill.slug) ?? "skill";
    const candidates = deriveSkillExportDirCandidates(skill, slug, companyTaskPrefix);

    let packageDir = candidates.find((candidate) => !usedDirs.has(candidate)) ?? null;
    if (!packageDir) {
      packageDir = appendSkillExportDirSuffix(candidates[0] ?? `skills/${slug}`, hashSkillValue(skill.key));
      while (usedDirs.has(packageDir)) {
        packageDir = appendSkillExportDirSuffix(
          candidates[0] ?? `skills/${slug}`,
          hashSkillValue(`${skill.key}:${packageDir}`),
        );
      }
    }

    usedDirs.add(packageDir);
    keyToDir.set(skill.key, packageDir);
  }

  return keyToDir;
}

function isSensitiveEnvKey(key: string) {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("api-key") ||
    normalized.includes("access_token") ||
    normalized.includes("access-token") ||
    normalized.includes("auth") ||
    normalized.includes("auth_token") ||
    normalized.includes("auth-token") ||
    normalized.includes("authorization") ||
    normalized.includes("bearer") ||
    normalized.includes("secret") ||
    normalized.includes("passwd") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("jwt") ||
    normalized.includes("privatekey") ||
    normalized.includes("private_key") ||
    normalized.includes("private-key") ||
    normalized.includes("cookie") ||
    normalized.includes("connectionstring")
  );
}

function normalizePortableProjectEnv(value: unknown): AgentEnvConfig | null {
  const parsed = envConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeProjectIconName(value: string | null | undefined): string | null {
  return value && PROJECT_ICON_NAMES.includes(value as typeof PROJECT_ICON_NAMES[number]) ? value : null;
}

function extractPortableProjectEnvInputs(
  projectSlug: string,
  envValue: unknown,
  warnings: string[],
): CompanyPortabilityEnvInput[] {
  if (!isPlainRecord(envValue)) return [];
  const env = envValue as Record<string, unknown>;
  const inputs: CompanyPortabilityEnvInput[] = [];

  for (const [key, binding] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      warnings.push(`Project ${projectSlug} PATH override was omitted from export because it is system-dependent.`);
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "secret_ref") {
      inputs.push({
        key,
        description: `Provide ${key} for project ${projectSlug}`,
        projectSlug,
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      });
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "plain") {
      const defaultValue = asString(binding.value);
      const isSensitive = isSensitiveEnvKey(key);
      const portability = defaultValue && isAbsoluteCommand(defaultValue)
        ? "system_dependent"
        : "portable";
      if (portability === "system_dependent") {
        warnings.push(`Project ${projectSlug} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on project ${projectSlug}`,
        projectSlug,
        kind: isSensitive ? "secret" : "plain",
        requirement: "optional",
        defaultValue: isSensitive ? "" : defaultValue ?? "",
        portability,
      });
      continue;
    }
  }

  return inputs;
}

type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  warnings: string[];
};

type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

type CompanyPackageIncludeEntry = {
  path: string;
};

type PaperclipExtensionDoc = {
  schema?: string;
  company?: Record<string, unknown> | null;
  agents?: Record<string, Record<string, unknown>> | null;
  projects?: Record<string, Record<string, unknown>> | null;
  tasks?: Record<string, Record<string, unknown>> | null;
  routines?: Record<string, Record<string, unknown>> | null;
};

const PAPERCLIP_EXTENSION_KEYS = [
  "schema",
  "company",
  "sidebar",
  "agents",
  "projects",
  "tasks",
  "routines",
] as const;

const PORTABLE_AGENT_EXTENSION_KEYS = [
  "icon",
  "capabilities",
  "adapterRevision",
  "contextGrants",
  "actionGrants",
  "mentionReachGrants",
  "permissionGrants",
  "budgetMonthlyAmount",
  "reportsTo",
  "reportsToExistingAgentId",
  "reportsToExistingAgentSlug",
] as const;
const PORTABLE_AGENT_FRONTMATTER_KEYS = [
  "name",
  "title",
  "slug",
  "kind",
  "reportsTo",
  "skills",
] as const;

const PORTABLE_TASK_EXTENSION_KEYS = [
  "identifier",
  "lifecycleStatus",
  "disposition",
  "boardPresentationStatus",
  "priority",
  "labelIds",
  "billingCode",
  "comments",
  "metadata",
] as const;
const PORTABLE_TASK_FRONTMATTER_KEYS = [
  "name",
  "title",
  "slug",
  "kind",
  "project",
  "owner",
  "recurring",
] as const;

type ProjectLike = {
  id: string;
  name: string;
  description: string | null;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  icon: string | null;
  status: string;
  env: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

type TaskLike = {
  id: string;
  identifier: string | null;
  title: string | null;
  request: string | null;
  projectId: string | null;
  ownerAgentId: string | null;
  status: string;
  priority: string;
  labelIds?: string[];
  billingCode: string | null;
};

function taskDisplayLabel(task: Pick<TaskLike, "id" | "identifier" | "title" | "request">) {
  if (task.title) return task.title;
  if (task.identifier) return task.identifier;
  const request = task.request?.trim().replace(/\s+/g, " ");
  if (!request) return `Task ${task.id}`;
  return request.length <= 96 ? request : `${request.slice(0, 93).trimEnd()}...`;
}

function portableTaskDisplayLabel(task: CompanyPortabilityTaskManifestEntry) {
  if (task.title) return task.title;
  if (task.identifier) return task.identifier;
  const request = task.request.trim().replace(/\s+/g, " ");
  if (request) return request.length <= 96 ? request : `${request.slice(0, 93).trimEnd()}...`;
  return `Task ${task.slug}`;
}

type RoutineLike = NonNullable<Awaited<ReturnType<ReturnType<typeof routineService>["getDetail"]>>>;

type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
};

type ImportMode = "board_full" | "agent_safe";

type ImportPreviewOptions = {
  mode?: ImportMode;
  sourceCompanyId?: string | null;
  authorizationActor?: AuthorizationActor;
};

type ImportApplyOptions = ImportPreviewOptions & {
  secretMutationActor: SecretMutationActor;
};

type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown> | null;
};

type EnvInputRecord = {
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  default?: string | null;
  description?: string | null;
  portability?: "portable" | "system_dependent";
};

const COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
};

const COMPANY_LOGO_FILE_NAME = "company-logo";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function portableBudgetCurrency(value: unknown, subject: string) {
  try {
    return parseBudgetCurrency(value);
  } catch {
    throw unprocessable(`${subject} must be an exact supported budget currency`);
  }
}

function portableMoneyAmount(value: unknown, subject: string) {
  try {
    return parseMoneyAmount(value);
  } catch {
    throw unprocessable(`${subject} must be a canonical decimal string`);
  }
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizePortableDisposition(
  value: unknown,
  lifecycleStatus: CompanyPortabilityTaskManifestEntry["lifecycleStatus"],
  subjectLabel: string,
) {
  const terminal =
    lifecycleStatus === "done" ||
    lifecycleStatus === "cancelled";
  if (value == null) {
    if (terminal) {
      throw unprocessable(
        `${subjectLabel} requires a disposition when lifecycleStatus is terminal`,
      );
    }
    return null;
  }
  if (!terminal) {
    throw unprocessable(
      `${subjectLabel} cannot carry a disposition while lifecycleStatus is nonterminal`,
    );
  }
  try {
    return decodeTaskDisposition(value);
  } catch {
    throw unprocessable(
      `${subjectLabel} disposition must contain only a non-empty message and optional structuredResult`,
    );
  }
}

function deterministicPortableUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stablePortableSessionId(key: string): string {
  return `ses_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

async function withPortableWorkspaceReservationErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaskExecutionWorkspaceReservationRejected) {
      throw unprocessable(error.message, { code: error.reason });
    }
    throw error;
  }
}

function canonicalPortableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPortableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalPortableJson(record[key])}`,
    )
    .join(",")}}`;
}

interface PortableCanonicalTaskCreateInput {
  companyId: string;
  slug: string;
  request: string;
  title: string | null;
  ownerAgentId: string;
  creatorUserId: string;
  projectId: string | null;
  lifecycleStatus: AgentVisibleTaskStatus;
  boardPresentationStatus: TaskStatus;
  disposition: TaskDisposition | null;
  priority: "critical" | "high" | "medium" | "low";
  labelIds: string[];
  billingCode: string | null;
}

async function createPortableCanonicalTask(
  db: Db,
  input: PortableCanonicalTaskCreateInput,
) {
  const rawIdempotencyKey =
    `company-portability:${input.companyId}:${input.slug}`;
  const aggregateKey =
    `ordinary-task-create:${input.companyId}:${rawIdempotencyKey}`;
  const taskId = deterministicPortableUuid(
    "ordinary-task",
    aggregateKey,
  );
  const sessionId = stablePortableSessionId(aggregateKey);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${aggregateKey}, 0))`,
    );
    const existing = await tx
      .select({ task: taskRows })
      .from(taskCreateIdempotencyKeys)
      .innerJoin(
        taskRows,
        eq(taskRows.id, taskCreateIdempotencyKeys.taskId),
      )
      .where(
        and(
          eq(taskCreateIdempotencyKeys.companyId, input.companyId),
          eq(
            taskCreateIdempotencyKeys.idempotencyKey,
            aggregateKey,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]?.task ?? null);
    if (existing) {
      const existingLabels = await tx
        .select({ labelId: taskLabels.labelId })
        .from(taskLabels)
        .where(eq(taskLabels.taskId, existing.id));
      const requestedLabels = [...new Set(input.labelIds)].sort();
      const persistedLabels = existingLabels
        .map((entry) => entry.labelId)
        .sort();
      if (
        existing.id !== taskId ||
        existing.request !== input.request ||
        existing.title !== (input.title?.trim() || null) ||
        existing.ownerKind !== "agent" ||
        existing.ownerAgentId !== input.ownerAgentId ||
        existing.creatorKind !== "user/board" ||
        existing.creatorUserId !== input.creatorUserId ||
        existing.projectId !== input.projectId ||
        existing.lifecycleStatus !== input.lifecycleStatus ||
        existing.boardPresentationStatus !==
          input.boardPresentationStatus ||
        canonicalPortableJson(existing.disposition) !==
          canonicalPortableJson(input.disposition) ||
        existing.priority !== input.priority ||
        existing.billingCode !== input.billingCode ||
        canonicalPortableJson(persistedLabels) !==
          canonicalPortableJson(requestedLabels)
      ) {
        throw unprocessable(
          `Task ${input.slug} import idempotency changed immutable input`,
        );
      }
      const ref =
        input.lifecycleStatus === "open"
          ? await tx
              .select()
              .from(taskExecutionRefs)
              .where(
                and(
                  eq(taskExecutionRefs.companyId, input.companyId),
                  eq(
                    taskExecutionRefs.deliveryIdempotencyKey,
                    aggregateKey,
                  ),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
      if (input.lifecycleStatus === "open" && !ref) {
        throw unprocessable(
          `Task ${input.slug} import is missing its canonical execution ref`,
        );
      }
      return { task: existing, ref, retried: true };
    }

    const company = await tx
      .select()
      .from(companyRows)
      .where(eq(companyRows.id, input.companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !company ||
      company.status !== "active" ||
      company.sessionIntegrityState !== "ready" ||
      company.hardDeleteFencedAt !== null
    ) {
      throw unprocessable(
        "Target company Session lifecycle is not ready for task import",
      );
    }

    const { owner, revisionId } =
      await resolveInvokableTaskOwnerInTransaction(tx, {
        companyId: input.companyId,
        ownerAgentId: input.ownerAgentId,
      });
    const uniqueLabelIds = [...new Set(input.labelIds)];
    if (uniqueLabelIds.length > 0) {
      const labels = await tx
        .select({ id: labelRows.id })
        .from(labelRows)
        .where(
          and(
            eq(labelRows.companyId, input.companyId),
            inArray(labelRows.id, uniqueLabelIds),
          ),
        );
      if (labels.length !== uniqueLabelIds.length) {
        throw unprocessable(
          `Task ${input.slug} contains labels outside the target company`,
        );
      }
    }

    const now = new Date();
    const maxTaskNumber = await tx
      .select({
        value: sql<number>`coalesce(max(${taskRows.taskNumber}), 0)`,
      })
      .from(taskRows)
      .where(eq(taskRows.companyId, input.companyId))
      .then((rows) => rows[0]?.value ?? 0);
    const taskNumber =
      Math.max(company.taskCounter, maxTaskNumber) + 1;
    await tx
      .update(companyRows)
      .set({ taskCounter: taskNumber, updatedAt: now })
      .where(eq(companyRows.id, input.companyId));
    const identifier = `${company.taskPrefix}-${taskNumber}`;
    const title = input.title?.trim() || null;
    const authorityId = deterministicPortableUuid(
      "task-execution-authority",
      `${taskId}:1:${owner.id}`,
    );
    const aggregate = await withPortableWorkspaceReservationErrors(() =>
      persistCanonicalTaskAggregateInTx(tx, {
      task: {
        id: taskId,
        companyId: input.companyId,
        projectId: input.projectId,
        goalId: null,
        parentId: null,
        title,
        request: input.request,
        boardPresentationStatus: input.boardPresentationStatus,
        lifecycleStatus: input.lifecycleStatus,
        disposition: input.disposition,
        workMode: "standard",
        harnessKind: null,
        priority: input.priority,
        ownerKind: "agent",
        ownerAgentId: owner.id,
        ownerUserId: null,
        ownerAssignmentSource: null,
        ownershipEpoch: 1,
        creatorKind: "user/board",
        creatorUserId: input.creatorUserId,
        responsibleUserId: null,
        taskNumber,
        identifier,
        originKind: "manual",
        originId: null,
        originRunId: null,
        originFingerprint: aggregateKey,
        billingCode: input.billingCode,
        requestDepth: 0,
        completedAt:
          input.lifecycleStatus === "done" ? now : null,
        cancelledAt:
          input.lifecycleStatus === "cancelled" ? now : null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: sessionId,
        parentSessionId: null,
        now,
      },
      workspaceReservation: {
        provenance: {
          agentId: null,
          userId: input.creatorUserId,
        },
      },
      authority: {
        id: authorityId,
        agentId: owner.id,
        auditAdapterConfigRevisionId: revisionId,
        createdAt: now,
      },
      idempotency: { key: aggregateKey },
      }),
    );
    const admission =
      input.lifecycleStatus === "open"
        ? await admitTaskExecutionInTransaction({
            sessionAdmission: createTaskSessionAdmissionService(db),
            transaction: tx,
            work: {
              companyId: aggregate.task.companyId,
              taskId: aggregate.task.id,
              sessionId,
              ownershipEpoch: 1,
              targetAgentId: owner.id,
              taskExecutionAuthorityId: authorityId,
              consultExecutionId: null,
              adapterConfigRevisionId: revisionId,
              contextEpoch:
                aggregate.sessionRoot.contextEpoch.generation,
              mode: "owner",
              sourceKind: "task_request",
              actor: {
                kind: "user/board",
                userId: input.creatorUserId,
              },
              immutableSourceKey: aggregateKey,
              sourceRecordId: aggregate.task.id,
              exactText: input.request,
              comment: {
                author: {
                  kind: "user",
                  userId: input.creatorUserId,
                },
                producingRun: null,
              },
              idempotencyKey: aggregateKey,
            },
          })
        : null;
    if (input.lifecycleStatus === "open" && !admission?.ref) {
      throw unprocessable(
        `Task ${input.slug} import did not persist its canonical execution ref`,
      );
    }
    if (uniqueLabelIds.length > 0) {
      await tx.insert(taskLabels).values(
        uniqueLabelIds.map((labelId) => ({
          taskId: aggregate.task.id,
          labelId,
          companyId: input.companyId,
        })),
      );
    }
    return {
      task: aggregate.task,
      ref: admission?.ref ?? null,
      retried: false,
    };
  });
}

type PortableAgentPermissionGrant = CompanyPortabilityAgentManifestEntry["permissionGrants"][number];

const VALID_PERMISSION_KEYS = new Set<PermissionKey>(PERMISSION_KEYS);

function normalizePortablePermissionGrants(value: unknown): PortableAgentPermissionGrant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PortableAgentPermissionGrant[] => {
    if (!isPlainRecord(entry)) return [];
    const permissionKey = asString(entry.permissionKey);
    if (!permissionKey || !VALID_PERMISSION_KEYS.has(permissionKey as PermissionKey)) return [];
    return [{
      permissionKey: permissionKey as PermissionKey,
      scope: isPlainRecord(entry.scope) ? entry.scope : null,
    }];
  });
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertExactPortableKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record)
    .filter((key) => !allowedSet.has(key))
    .sort();
  if (unknown.length > 0) {
    throw unprocessable(
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
    );
  }
}

function parseExactPortableBooleanMap<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, boolean> {
  if (!isPlainRecord(value)) {
    throw unprocessable(`${label} must be an object`);
  }
  assertExactPortableKeys(value, keys, label);
  const missing = keys.filter((key) => !hasOwn(value, key));
  if (missing.length > 0) {
    throw unprocessable(
      `${label} is missing required fields: ${missing.join(", ")}`,
    );
  }
  const result = {} as Record<Key, boolean>;
  for (const key of keys) {
    if (typeof value[key] !== "boolean") {
      throw unprocessable(`${label}.${key} must be boolean`);
    }
    result[key] = value[key] as boolean;
  }
  return result;
}

function materializePortableBooleanMap<Key extends string>(
  keys: readonly Key[],
  value: Partial<Record<Key, boolean>>,
): Record<Key, boolean> {
  return Object.fromEntries(
    keys.map((key) => [key, value[key] === true]),
  ) as Record<Key, boolean>;
}

function derivePortableCommentAuthorType(value: Record<string, unknown>) {
  const explicit = taskCommentAuthorTypeSchema.safeParse(value.authorType);
  if (explicit.success) return explicit.data;
  return asString(value.authorAgentSlug) ? "agent" : asString(value.authorUserId) ? "user" : "system";
}

function readPortableTaskComments(
  value: unknown,
  warnings: string[],
  sourceLabel: string,
): CompanyPortabilityTaskCommentManifestEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${sourceLabel} comments were ignored because they are not an array.`);
    return [];
  }

  const comments: CompanyPortabilityTaskCommentManifestEntry[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainRecord(entry)) {
      warnings.push(`${sourceLabel} comment ${index + 1} was ignored because it is not an object.`);
      continue;
    }
    const body = asString(entry.body);
    if (!body) {
      warnings.push(`${sourceLabel} comment ${index + 1} was ignored because it has no body.`);
      continue;
    }
    const presentation = entry.presentation == null ? null : taskCommentPresentationSchema.safeParse(entry.presentation);
    if (presentation && !presentation.success) {
      warnings.push(`${sourceLabel} comment ${index + 1} has invalid presentation metadata and was ignored.`);
      continue;
    }
    const metadata = entry.metadata == null ? null : taskCommentMetadataSchema.safeParse(entry.metadata);
    if (metadata && !metadata.success) {
      warnings.push(`${sourceLabel} comment ${index + 1} has invalid hidden metadata and was ignored.`);
      continue;
    }
    const createdAt = asString(entry.createdAt);
    comments.push({
      body,
      authorType: derivePortableCommentAuthorType(entry),
      authorAgentSlug: asString(entry.authorAgentSlug),
      authorUserId: asString(entry.authorUserId),
      presentation: presentation ? presentation.data : null,
      metadata: metadata ? metadata.data : null,
      createdAt: createdAt && Number.isNaN(Date.parse(createdAt)) ? null : createdAt,
    });
  }
  return comments;
}

function normalizeRoutineTriggerExtension(value: unknown): CompanyPortabilityTaskRoutineTriggerManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const kind = asString(value.kind);
  if (!kind) return null;
  return {
    kind,
    label: asString(value.label),
    enabled: asBoolean(value.enabled) ?? true,
    cronExpression: asString(value.cronExpression),
    timezone: asString(value.timezone),
    signingMode: asString(value.signingMode),
    replayWindowSec: asInteger(value.replayWindowSec),
  };
}

function normalizeRoutineVariableExtension(value: unknown): RoutineVariable | null {
  if (!isPlainRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  const type = asString(value.type) ?? "text";
  if (!["text", "textarea", "number", "boolean", "select"].includes(type)) return null;
  const options = Array.isArray(value.options)
    ? value.options.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  const defaultValue =
    typeof value.defaultValue === "string" || typeof value.defaultValue === "number" || typeof value.defaultValue === "boolean"
      ? value.defaultValue
      : null;
  return {
    name,
    label: asString(value.label),
    type: type as RoutineVariable["type"],
    defaultValue,
    required: asBoolean(value.required) ?? true,
    options,
  };
}

function normalizeRoutineExtension(value: unknown): CompanyPortabilityTaskRoutineManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  if (hasOwn(value, "contextAccessMask")) {
    throw unprocessable(
      "Routine manifest contains unsupported fields: contextAccessMask",
    );
  }
  const triggers = Array.isArray(value.triggers)
    ? value.triggers
      .map((entry) => normalizeRoutineTriggerExtension(entry))
      .filter((entry): entry is CompanyPortabilityTaskRoutineTriggerManifestEntry => entry !== null)
    : [];
  const variables = Array.isArray(value.variables)
    ? value.variables
      .map((entry) => normalizeRoutineVariableExtension(entry))
      .filter((entry): entry is RoutineVariable => entry !== null)
    : null;
  const routine = {
    concurrencyPolicy: asString(value.concurrencyPolicy),
    catchUpPolicy: asString(value.catchUpPolicy),
    variables,
    triggers,
  };
  return stripEmptyValues(routine) ? routine : null;
}

function clonePortableRecord(value: unknown) {
  if (!isPlainRecord(value)) return null;
  return structuredClone(value) as Record<string, unknown>;
}

function normalizeImportedRuntimeConfig(runtimeConfig: unknown) {
  return clonePortableRecord(runtimeConfig) ?? {};
}

function resolvePortableRoutineDefinition(
  task: Pick<
    CompanyPortabilityTaskManifestEntry,
    "slug" | "recurring" | "routine"
  >,
) {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!task.recurring) {
    return { routine: null, warnings, errors };
  }

  const routine = task.routine
    ? {
      concurrencyPolicy: task.routine.concurrencyPolicy,
      catchUpPolicy: task.routine.catchUpPolicy,
      variables: task.routine.variables ?? null,
      triggers: [...task.routine.triggers],
    }
    : {
      concurrencyPolicy: null,
      catchUpPolicy: null,
      variables: null,
      triggers: [] as CompanyPortabilityTaskRoutineTriggerManifestEntry[],
    };

  if (routine.concurrencyPolicy && !ROUTINE_CONCURRENCY_POLICIES.includes(routine.concurrencyPolicy as any)) {
    errors.push(`Recurring task ${task.slug} uses unsupported routine concurrencyPolicy "${routine.concurrencyPolicy}".`);
  }
  if (routine.catchUpPolicy && !ROUTINE_CATCH_UP_POLICIES.includes(routine.catchUpPolicy as any)) {
    errors.push(`Recurring task ${task.slug} uses unsupported routine catchUpPolicy "${routine.catchUpPolicy}".`);
  }

  for (const trigger of routine.triggers) {
    if (!ROUTINE_TRIGGER_KINDS.includes(trigger.kind as any)) {
      errors.push(`Recurring task ${task.slug} uses unsupported trigger kind "${trigger.kind}".`);
      continue;
    }
    if (trigger.kind === "schedule") {
      if (!trigger.cronExpression || !trigger.timezone) {
        errors.push(`Recurring task ${task.slug} has a schedule trigger missing cronExpression/timezone.`);
        continue;
      }
      const cronError = validateCron(trigger.cronExpression);
      if (cronError) {
        errors.push(`Recurring task ${task.slug} has an invalid schedule trigger: ${cronError}`);
      }
      continue;
    }
    if (trigger.kind === "webhook" && trigger.signingMode && !ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)) {
      errors.push(`Recurring task ${task.slug} uses unsupported webhook signingMode "${trigger.signingMode}".`);
    }
  }

  if (routine.triggers.length === 0) {
    errors.push(
      `Recurring task ${task.slug} requires at least one canonical routine trigger.`,
    );
  }

  return { routine, warnings, errors };
}

function toSafeSlug(input: string, fallback: string) {
  return normalizeAgentUrlKey(input) ?? fallback;
}

function uniqueSlug(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let idx = 2;
  while (true) {
    const candidate = `${base}-${idx}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

function uniqueNameBySlug(baseName: string, existingSlugs: Set<string>) {
  const baseSlug = normalizeAgentUrlKey(baseName) ?? "agent";
  if (!existingSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = normalizeAgentUrlKey(candidateName) ?? `agent-${idx}`;
    if (!existingSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function uniqueProjectName(baseName: string, existingProjectSlugs: Set<string>) {
  const baseSlug = deriveProjectUrlKey(baseName, baseName);
  if (!existingProjectSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = deriveProjectUrlKey(candidateName, candidateName);
    if (!existingProjectSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
    projects: input?.projects ?? DEFAULT_INCLUDE.projects,
    tasks: input?.tasks ?? DEFAULT_INCLUDE.tasks,
    skills: input?.skills ?? DEFAULT_INCLUDE.skills,
  };
}

function resolvePortablePath(fromPath: string, targetPath: string) {
  const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
  return normalizePortablePath(path.posix.join(baseDir, targetPath.replace(/\\/g, "/")));
}

function isPortableBinaryFile(
  value: CompanyPortabilityFileEntry,
): value is Extract<CompanyPortabilityFileEntry, { encoding: "base64" }> {
  return typeof value === "object" && value !== null && value.encoding === "base64" && typeof value.data === "string";
}

function readPortableTextFile(
  files: Record<string, CompanyPortabilityFileEntry>,
  filePath: string,
) {
  const value = files[filePath];
  return typeof value === "string" ? value : null;
}

function inferContentTypeFromPath(filePath: string) {
  const extension = path.posix.extname(filePath).toLowerCase();
  switch (extension) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function resolveCompanyLogoExtension(contentType: string | null | undefined, originalFilename: string | null | undefined) {
  const fromContentType = contentType ? COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase()] : null;
  if (fromContentType) return fromContentType;

  const extension = originalFilename ? path.extname(originalFilename).toLowerCase() : "";
  return extension || ".png";
}

function portableBinaryFileToBuffer(entry: Extract<CompanyPortabilityFileEntry, { encoding: "base64" }>) {
  return Buffer.from(entry.data, "base64");
}

function portableFileToBuffer(entry: CompanyPortabilityFileEntry, filePath: string) {
  if (typeof entry === "string") {
    return Buffer.from(entry, "utf8");
  }
  if (isPortableBinaryFile(entry)) {
    return portableBinaryFileToBuffer(entry);
  }
  throw unprocessable(`Unsupported file entry encoding for ${filePath}`);
}

function bufferToPortableBinaryFile(buffer: Buffer, contentType: string | null): CompanyPortabilityFileEntry {
  return {
    encoding: "base64",
    data: buffer.toString("base64"),
    contentType,
  };
}

async function streamToBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeFileMap(
  files: Record<string, CompanyPortabilityFileEntry>,
  rootPath?: string | null,
): Record<string, CompanyPortabilityFileEntry> {
  const normalizedRoot = rootPath ? normalizePortablePath(rootPath) : null;
  const out: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    let nextPath = normalizePortablePath(rawPath);
    if (normalizedRoot && nextPath === normalizedRoot) {
      continue;
    }
    if (normalizedRoot && nextPath.startsWith(`${normalizedRoot}/`)) {
      nextPath = nextPath.slice(normalizedRoot.length + 1);
    }
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

function pickTextFiles(files: Record<string, CompanyPortabilityFileEntry>) {
  const out: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (typeof content === "string") {
      out[filePath] = content;
    }
  }
  return out;
}

function collectSelectedExportSlugs(selectedFiles: Set<string>) {
  const agents = new Set<string>();
  const projects = new Set<string>();
  const tasks = new Set<string>();
  for (const filePath of selectedFiles) {
    const agentMatch = filePath.match(/^agents\/([^/]+)\//);
    if (agentMatch) agents.add(agentMatch[1]!);
    const projectMatch = filePath.match(/^projects\/([^/]+)\//);
    if (projectMatch) projects.add(projectMatch[1]!);
    const taskMatch = filePath.match(/^tasks\/([^/]+)\//);
    if (taskMatch) tasks.add(taskMatch[1]!);
  }
  return { agents, projects, tasks, routines: new Set(tasks) };
}

function normalizePortableSlugList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizePortableSidebarOrder(value: unknown): CompanyPortabilitySidebarOrder | null {
  if (!isPlainRecord(value)) return null;
  const sidebar = {
    agents: normalizePortableSlugList(value.agents),
    projects: normalizePortableSlugList(value.projects),
  };
  return sidebar.agents.length > 0 || sidebar.projects.length > 0 ? sidebar : null;
}

function sortAgentsBySidebarOrder<T extends { id: string; name: string; reportsTo: string | null }>(agents: T[]) {
  if (agents.length === 0) return [];

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenOf = new Map<string | null, T[]>();
  for (const agent of agents) {
    const parentId = agent.reportsTo && byId.has(agent.reportsTo) ? agent.reportsTo : null;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(agent);
    childrenOf.set(parentId, siblings);
  }

  for (const siblings of childrenOf.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }

  const sorted: T[] = [];
  const queue = [...(childrenOf.get(null) ?? [])];
  while (queue.length > 0) {
    const agent = queue.shift();
    if (!agent) continue;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }

  return sorted;
}

function filterPortableExtensionYaml(yaml: string, selectedFiles: Set<string>) {
  const selected = collectSelectedExportSlugs(selectedFiles);
  const parsed = parseYamlFile(yaml);
  for (const section of ["agents", "projects", "tasks", "routines"] as const) {
    const sectionValue = parsed[section];
    if (!isPlainRecord(sectionValue)) continue;
    const sectionSlugs = selected[section];
    const filteredEntries = Object.fromEntries(
      Object.entries(sectionValue).filter(([slug]) => sectionSlugs.has(slug)),
    );
    if (Object.keys(filteredEntries).length > 0) {
      parsed[section] = filteredEntries;
    } else {
      delete parsed[section];
    }
  }

  const companySection = parsed.company;
  if (isPlainRecord(companySection)) {
    const logoPath = asString(companySection.logoPath) ?? asString(companySection.logo);
    if (logoPath && !selectedFiles.has(logoPath)) {
      delete companySection.logoPath;
      delete companySection.logo;
    }
  }

  const sidebarOrder = normalizePortableSidebarOrder(parsed.sidebar);
  if (sidebarOrder) {
    const filteredSidebar = stripEmptyValues({
      agents: sidebarOrder.agents.filter((slug) => selected.agents.has(slug)),
      projects: sidebarOrder.projects.filter((slug) => selected.projects.has(slug)),
    });
    if (isPlainRecord(filteredSidebar)) {
      parsed.sidebar = filteredSidebar;
    } else {
      delete parsed.sidebar;
    }
  } else {
    delete parsed.sidebar;
  }

  return buildYamlFile(parsed, { preserveEmptyStrings: true });
}

function filterExportFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  selectedFilesInput: string[] | undefined,
  paperclipExtensionPath: string,
) {
  if (!selectedFilesInput || selectedFilesInput.length === 0) {
    return files;
  }

  const selectedFiles = new Set(
    selectedFilesInput
      .map((entry) => normalizePortablePath(entry))
      .filter((entry) => entry.length > 0),
  );
  const filtered: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (!selectedFiles.has(filePath)) continue;
    filtered[filePath] = content;
  }

  const extensionEntry = filtered[paperclipExtensionPath];
  if (selectedFiles.has(paperclipExtensionPath) && typeof extensionEntry === "string") {
    filtered[paperclipExtensionPath] = filterPortableExtensionYaml(extensionEntry, selectedFiles);
  }

  return filtered;
}

function findPaperclipExtensionPath(files: Record<string, CompanyPortabilityFileEntry>) {
  if (typeof files[".paperclip.yaml"] === "string") return ".paperclip.yaml";
  if (typeof files[".paperclip.yml"] === "string") return ".paperclip.yml";
  return Object.keys(files).find((entry) => entry.endsWith("/.paperclip.yaml") || entry.endsWith("/.paperclip.yml")) ?? null;
}

function ensureMarkdownPath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw unprocessable(`Manifest file path must end in .md: ${pathValue}`);
  }
  return normalized;
}

function isAbsoluteCommand(value: string) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPathDefault(pathSegments: string[], value: unknown, rules: Array<{ path: string[]; value: unknown }>) {
  return rules.some((rule) => jsonEqual(rule.path, pathSegments) && jsonEqual(rule.value, value));
}

function pruneDefaultLikeValue(
  value: unknown,
  opts: {
    dropFalseBooleans: boolean;
    path?: string[];
    defaultRules?: Array<{ path: string[]; value: unknown }>;
  },
): unknown {
  const pathSegments = opts.path ?? [];
  if (opts.defaultRules && isPathDefault(pathSegments, value, opts.defaultRules)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pruneDefaultLikeValue(entry, { ...opts, path: pathSegments }));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = pruneDefaultLikeValue(entry, {
        ...opts,
        path: [...pathSegments, key],
      });
      if (next === undefined) continue;
      out[key] = next;
    }
    return out;
  }
  if (value === undefined) return undefined;
  if (opts.dropFalseBooleans && value === false) return undefined;
  return value;
}

function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function isEmptyObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function stripEmptyValues(
  value: unknown,
  opts?: {
    preserveEmptyStrings?: boolean;
    preserveEmptyCollections?: boolean;
    preserveNullKeys?: readonly string[];
  },
): unknown {
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => stripEmptyValues(entry, opts))
      .filter((entry) => entry !== undefined);
    return next.length > 0 || opts?.preserveEmptyCollections
      ? next
      : undefined;
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        entry === null &&
        opts?.preserveNullKeys?.includes(key)
      ) {
        next[key] = null;
        continue;
      }
      const cleaned = stripEmptyValues(entry, opts);
      if (cleaned === undefined) continue;
      next[key] = cleaned;
    }
    return Object.keys(next).length > 0 ||
      opts?.preserveEmptyCollections
      ? next
      : undefined;
  }
  if (
    value === undefined ||
    value === null ||
    (!opts?.preserveEmptyStrings && value === "") ||
    (!opts?.preserveEmptyCollections &&
      (isEmptyArray(value) || isEmptyObject(value)))
  ) {
    return undefined;
  }
  return value;
}

const YAML_KEY_PRIORITY = [
  "name",
  "description",
  "title",
  "schema",
  "kind",
  "slug",
  "reportsTo",
  "reportsToExistingAgentId",
  "reportsToExistingAgentSlug",
  "skills",
  "owner",
  "assignee",
  "project",
  "schedule",
  "version",
  "license",
  "authors",
  "homepage",
  "tags",
  "includes",
  "requirements",
  "icon",
  "capabilities",
  "brandColor",
  "logoPath",
  "adapter",
  "runtime",
  "permissionGrants",
  "budgetCurrency",
  "budgetMonthlyAmount",
  "metadata",
] as const;

const YAML_KEY_PRIORITY_INDEX = new Map<string, number>(
  YAML_KEY_PRIORITY.map((key, index) => [key, index]),
);

function compareYamlKeys(left: string, right: string) {
  const leftPriority = YAML_KEY_PRIORITY_INDEX.get(left);
  const rightPriority = YAML_KEY_PRIORITY_INDEX.get(right);
  if (leftPriority !== undefined || rightPriority !== undefined) {
    if (leftPriority === undefined) return 1;
    if (rightPriority === undefined) return -1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  }
  return left.localeCompare(right);
}

function orderedYamlEntries(value: Record<string, unknown>) {
  return Object.entries(value).sort(([leftKey], [rightKey]) => compareYamlKeys(leftKey, rightKey));
}

function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = orderedYamlEntries(value);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${renderYamlScalar(value)}`];
}

function renderFrontmatter(frontmatter: Record<string, unknown>) {
  const lines: string[] = ["---"];
  for (const [key, value] of orderedYamlEntries(frontmatter)) {
    if (value === undefined) continue;
    const scalar =
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      Array.isArray(value) && value.length === 0 ||
      isEmptyObject(value);
    if (scalar) {
      lines.push(`${key}: ${renderYamlScalar(value)}`);
      continue;
    }
    lines.push(`${key}:`);
    lines.push(...renderYamlBlock(value, 1));
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function buildMarkdown(frontmatter: Record<string, unknown>, body: string) {
  const cleanBody = body.replace(/\r\n/g, "\n").trim();
  if (!cleanBody) {
    return `${renderFrontmatter(frontmatter)}\n`;
  }
  return `${renderFrontmatter(frontmatter)}\n${cleanBody}\n`;
}

function normalizeSelectedFiles(selectedFiles?: string[]) {
  if (!selectedFiles) return null;
  return new Set(
    selectedFiles
      .map((entry) => normalizePortablePath(entry))
      .filter((entry) => entry.length > 0),
  );
}

function filterCompanyMarkdownIncludes(
  companyPath: string,
  markdown: string,
  selectedFiles: Set<string>,
) {
  const parsed = parseFrontmatterMarkdown(markdown);
  const includeEntries = readIncludeEntries(parsed.frontmatter);
  const filteredIncludes = includeEntries.filter((entry) =>
    selectedFiles.has(resolvePortablePath(companyPath, entry.path)),
  );
  const nextFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  if (filteredIncludes.length > 0) {
    nextFrontmatter.includes = filteredIncludes.map((entry) => entry.path);
  } else {
    delete nextFrontmatter.includes;
  }
  return buildMarkdown(nextFrontmatter, parsed.body);
}

function applySelectedFilesToSource(source: ResolvedSource, selectedFiles?: string[]): ResolvedSource {
  const normalizedSelection = normalizeSelectedFiles(selectedFiles);
  if (!normalizedSelection) return source;

  const companyPath = source.manifest.company
    ? ensureMarkdownPath(source.manifest.company.path)
    : Object.keys(source.files).find((entry) => entry.endsWith("/COMPANY.md") || entry === "COMPANY.md") ?? null;
  if (!companyPath) {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const companyMarkdown = source.files[companyPath];
  if (typeof companyMarkdown !== "string") {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const effectiveFiles: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(source.files)) {
    const normalizedPath = normalizePortablePath(filePath);
    if (!normalizedSelection.has(normalizedPath)) continue;
    effectiveFiles[normalizedPath] = content;
  }

  effectiveFiles[companyPath] = filterCompanyMarkdownIncludes(
    companyPath,
    companyMarkdown,
    normalizedSelection,
  );
  const canonicalManifest = source.files[".paperclip.yaml"];
  if (canonicalManifest === undefined) {
    throw unprocessable(
      "Company package is missing the canonical .paperclip.yaml manifest",
    );
  }
  effectiveFiles[".paperclip.yaml"] = canonicalManifest;

  const filtered = buildManifestFromPackageFiles(effectiveFiles, {
    sourceLabel: source.manifest.source,
  });

  if (!normalizedSelection.has(companyPath)) {
    filtered.manifest.company = null;
  }

  filtered.manifest.includes = {
    company: filtered.manifest.company !== null,
    agents: filtered.manifest.agents.length > 0,
    projects: filtered.manifest.projects.length > 0,
    tasks: filtered.manifest.tasks.length > 0,
    skills: filtered.manifest.skills.length > 0,
  };

  return filtered;
}

async function resolveBundledSkillsCommit() {
  if (!bundledSkillsCommitPromise) {
    bundledSkillsCommitPromise = execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null);
  }
  return bundledSkillsCommitPromise;
}

async function buildSkillSourceEntry(skill: CompanySkill) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (asString(metadata?.sourceKind) === "paperclip_bundled") {
    const commit = await resolveBundledSkillsCommit();
    return {
      kind: "github-dir",
      repo: "paperclipai/paperclip",
      path: `skills/${skill.slug}`,
      commit,
      trackingRef: "master",
      url: `https://github.com/paperclipai/paperclip/tree/master/skills/${skill.slug}`,
    };
  }

  if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
    const owner = asString(metadata?.owner);
    const repo = asString(metadata?.repo);
    const repoSkillDir = asString(metadata?.repoSkillDir);
    if (!owner || !repo || !repoSkillDir) return null;
    return {
      kind: "github-dir",
      repo: `${owner}/${repo}`,
      path: repoSkillDir,
      commit: skill.sourceRef ?? null,
      trackingRef: asString(metadata?.trackingRef),
      url: skill.sourceLocator,
    };
  }

  if (skill.sourceType === "url" && skill.sourceLocator) {
    return {
      kind: "url",
      url: skill.sourceLocator,
    };
  }

  return null;
}

function shouldReferenceSkillOnExport(skill: CompanySkill, expandReferencedSkills: boolean) {
  if (expandReferencedSkills) return false;
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (asString(metadata?.sourceKind) === "paperclip_bundled") return true;
  return skill.sourceType === "github" || skill.sourceType === "skills_sh" || skill.sourceType === "url";
}

async function buildReferencedSkillMarkdown(skill: CompanySkill) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  const frontmatter: Record<string, unknown> = {
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    description: skill.description ?? null,
  };
  if (sourceEntry) {
    frontmatter.metadata = {
      sources: [sourceEntry],
    };
  }
  return buildMarkdown(frontmatter, "");
}

async function withSkillSourceMetadata(skill: CompanySkill, markdown: string) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  const parsed = parseFrontmatterMarkdown(markdown);
  const metadata = isPlainRecord(parsed.frontmatter.metadata)
    ? { ...parsed.frontmatter.metadata }
    : {};
  const existingSources = Array.isArray(metadata.sources)
    ? metadata.sources.filter((entry) => isPlainRecord(entry))
    : [];
  if (sourceEntry) {
    metadata.sources = [...existingSources, sourceEntry];
  }
  const catalogProvenance = buildPortableCatalogProvenance(skill);
  metadata.skillKey = skill.key;
  metadata.paperclipSkillKey = skill.key;
  metadata.paperclip = {
    ...(isPlainRecord(metadata.paperclip) ? metadata.paperclip : {}),
    skillKey: skill.key,
    slug: skill.slug,
    ...(catalogProvenance ? { catalog: catalogProvenance } : {}),
  };
  const frontmatter = {
    ...parsed.frontmatter,
    key: skill.key,
    slug: skill.slug,
    metadata,
  };
  return buildMarkdown(frontmatter, parsed.body);
}


function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    trimmed.startsWith("\"") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function prepareYamlLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim(),
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
}

function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) {
    index += 1;
  }
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  const isArray = lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-");
  if (isArray) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent < indentLevel) break;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;
      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }
      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0 &&
        !remainder.startsWith("\"") &&
        !remainder.startsWith("{") &&
        !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
        continue;
      }
      values.push(parseYamlScalar(remainder));
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }
    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      index += 1;
      continue;
    }
    const key = line.content.slice(0, separatorIndex).trim();
    const remainder = line.content.slice(separatorIndex + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    record[key] = parseYamlScalar(remainder);
  }

  return { value: record, nextIndex: index };
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  if (prepared.length === 0) return {};
  const parsed = parseYamlBlock(prepared, 0, prepared[0]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

function parseYamlFile(raw: string): Record<string, unknown> {
  return parseYamlFrontmatter(raw);
}

function buildYamlFile(
  value: Record<string, unknown>,
  opts?: {
    preserveEmptyStrings?: boolean;
    preserveEmptyCollections?: boolean;
    preserveNullKeys?: readonly string[];
  },
) {
  const cleaned = stripEmptyValues(value, opts);
  if (!isPlainRecord(cleaned)) return "{}\n";
  return renderYamlBlock(cleaned, 0).join("\n") + "\n";
}

function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
  };
}

async function fetchText(url: string) {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchOptionalText(url: string) {
  const response = await ghFetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchBinary(url: string) {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await ghFetch(url, {
    headers: {
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function dedupeEnvInputs(values: CompanyPortabilityManifest["envInputs"]) {
  const seen = new Set<string>();
  const out: CompanyPortabilityManifest["envInputs"] = [];
  for (const value of values) {
    const key = `${value.projectSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function buildEnvInputMap(inputs: CompanyPortabilityEnvInput[]) {
  const env: Record<string, Record<string, unknown>> = {};
  for (const input of inputs) {
    const entry: Record<string, unknown> = {
      kind: input.kind,
      requirement: input.requirement,
    };
    if (input.defaultValue !== null) entry.default = input.defaultValue;
    if (input.description) entry.description = input.description;
    if (input.portability === "system_dependent") entry.portability = "system_dependent";
    env[input.key] = entry;
  }
  return env;
}

function envInputScopedKey(input: CompanyPortabilityEnvInput) {
  if (input.projectSlug) return `project:${input.projectSlug}:${input.key}`;
  return input.key;
}

function envInputValue(input: CompanyPortabilityEnvInput, values: Record<string, string> | null | undefined) {
  if (!values) return null;
  const scopedKey = envInputScopedKey(input);
  if (Object.prototype.hasOwnProperty.call(values, scopedKey)) return values[scopedKey];
  if (Object.prototype.hasOwnProperty.call(values, input.key)) return values[input.key];
  return null;
}

function importSecretLabel(input: CompanyPortabilityEnvInput) {
  const scope = input.projectSlug
    ? `project ${input.projectSlug}`
    : "company import";
  return `${scope} ${input.key}`;
}

function importSecretKey(input: CompanyPortabilityEnvInput, suffix: string) {
  const scope = input.projectSlug
    ? `project-${input.projectSlug}`
    : "company";
  return `import-${scope}-${input.key}-${suffix}`;
}

function writeManifestEnvBinding(
  manifest: CompanyPortabilityManifest,
  input: CompanyPortabilityEnvInput,
  binding: AgentEnvConfig[string],
) {
  if (input.projectSlug) {
    const project = manifest.projects.find((entry) => entry.slug === input.projectSlug);
    if (!project) return;
    project.env = {
      ...(project.env ?? {}),
      [input.key]: binding,
    };
  }
}

function readCompanyApprovalDefault(_frontmatter: Record<string, unknown>) {
  return false;
}

function readIncludeEntries(frontmatter: Record<string, unknown>): CompanyPackageIncludeEntry[] {
  const includes = frontmatter.includes;
  if (!Array.isArray(includes)) return [];
  return includes.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ path: entry }];
    }
    if (isPlainRecord(entry)) {
      const pathValue = asString(entry.path);
      return pathValue ? [{ path: pathValue }] : [];
    }
    return [];
  });
}

function readProjectEnvInputs(
  extension: Record<string, unknown>,
  projectSlug: string,
): CompanyPortabilityManifest["envInputs"] {
  const inputs = isPlainRecord(extension.inputs) ? extension.inputs : null;
  const env = inputs && isPlainRecord(inputs.env) ? inputs.env : null;
  if (!env) return [];

  return Object.entries(env).flatMap(([key, value]) => {
    if (!isPlainRecord(value)) return [];
    const record = value as EnvInputRecord;
    return [{
      key,
      description: asString(record.description) ?? null,
      projectSlug,
      kind: record.kind === "plain" ? "plain" : "secret",
      requirement: record.requirement === "required" ? "required" : "optional",
      defaultValue: typeof record.default === "string" ? record.default : null,
      portability: record.portability === "system_dependent" ? "system_dependent" : "portable",
    }];
  });
}

function readAgentSkillRefs(frontmatter: Record<string, unknown>) {
  const skills = frontmatter.skills;
  if (!Array.isArray(skills)) return [];
  return Array.from(new Set(
    skills
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeSkillKey(entry) ?? entry.trim())
      .filter(Boolean),
  ));
}

function buildManifestFromPackageFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  opts?: { sourceLabel?: { companyId: string; companyName: string } | null },
): ResolvedSource {
  const normalizedFiles = normalizeFileMap(files);
  const companyPath = typeof normalizedFiles["COMPANY.md"] === "string"
    ? normalizedFiles["COMPANY.md"]
    : undefined;
  const resolvedCompanyPath = companyPath !== undefined
    ? "COMPANY.md"
    : Object.keys(normalizedFiles).find((entry) => entry.endsWith("/COMPANY.md") || entry === "COMPANY.md");
  if (!resolvedCompanyPath) {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const companyMarkdown = readPortableTextFile(normalizedFiles, resolvedCompanyPath);
  if (typeof companyMarkdown !== "string") {
    throw unprocessable(`Company package file is not readable as text: ${resolvedCompanyPath}`);
  }
  const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
  const companyFrontmatter = companyDoc.frontmatter;
  const paperclipExtensionPath = findPaperclipExtensionPath(normalizedFiles);
  if (!paperclipExtensionPath) {
    throw unprocessable(
      "Company package is missing the canonical .paperclip.yaml manifest",
    );
  }
  const paperclipExtension = parseYamlFile(
    readPortableTextFile(
      normalizedFiles,
      paperclipExtensionPath,
    ) ?? "",
  );
  assertExactPortableKeys(
    paperclipExtension,
    PAPERCLIP_EXTENSION_KEYS,
    "Paperclip manifest",
  );
  if (paperclipExtension.schema !== "paperclip/v1") {
    throw unprocessable(
      "Paperclip manifest schema must be exactly paperclip/v1",
    );
  }
  const paperclipCompany = isPlainRecord(paperclipExtension.company) ? paperclipExtension.company : {};
  const paperclipSidebar = normalizePortableSidebarOrder(paperclipExtension.sidebar);
  const paperclipAgents = isPlainRecord(paperclipExtension.agents) ? paperclipExtension.agents : {};
  const paperclipProjects = isPlainRecord(paperclipExtension.projects) ? paperclipExtension.projects : {};
  const paperclipTasks = isPlainRecord(paperclipExtension.tasks) ? paperclipExtension.tasks : {};
  const paperclipRoutines = isPlainRecord(paperclipExtension.routines) ? paperclipExtension.routines : {};
  const companyName =
    asString(companyFrontmatter.name)
    ?? opts?.sourceLabel?.companyName
    ?? "Imported Company";
  const companySlug =
    asString(companyFrontmatter.slug)
    ?? normalizeAgentUrlKey(companyName)
    ?? "company";

  const includeEntries = readIncludeEntries(companyFrontmatter);
  const referencedAgentPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md");
  const referencedProjectPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md");
  const referencedTaskPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/TASK.md") || entry === "TASK.md");
  const referencedSkillPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md");
  const discoveredAgentPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md",
  );
  const discoveredProjectPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md",
  );
  const discoveredTaskPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/TASK.md") || entry === "TASK.md",
  );
  const discoveredSkillPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md",
  );
  const agentPaths = Array.from(new Set([...referencedAgentPaths, ...discoveredAgentPaths])).sort();
  const projectPaths = Array.from(new Set([...referencedProjectPaths, ...discoveredProjectPaths])).sort();
  const taskPaths = Array.from(new Set([...referencedTaskPaths, ...discoveredTaskPaths])).sort();
  const skillPaths = Array.from(new Set([...referencedSkillPaths, ...discoveredSkillPaths])).sort();

  const manifest: CompanyPortabilityManifest = {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    source: opts?.sourceLabel ?? null,
    includes: {
      company: true,
      agents: true,
      projects: projectPaths.length > 0,
      tasks: taskPaths.length > 0,
      skills: skillPaths.length > 0,
    },
    company: {
      path: resolvedCompanyPath,
      name: companyName,
      description: asString(companyFrontmatter.description),
      brandColor: asString(paperclipCompany.brandColor),
      logoPath: asString(paperclipCompany.logoPath) ?? asString(paperclipCompany.logo),
      budgetCurrency: portableBudgetCurrency(
        paperclipCompany.budgetCurrency,
        "Company budgetCurrency",
      ),
      budgetMonthlyAmount: portableMoneyAmount(
        paperclipCompany.budgetMonthlyAmount,
        "Company budgetMonthlyAmount",
      ),
      attachmentMaxBytes:
        typeof paperclipCompany.attachmentMaxBytes === "number" && Number.isFinite(paperclipCompany.attachmentMaxBytes)
          ? Math.max(1, Math.floor(paperclipCompany.attachmentMaxBytes))
          : null,
      requireBoardApprovalForNewAgents:
        typeof paperclipCompany.requireBoardApprovalForNewAgents === "boolean"
          ? paperclipCompany.requireBoardApprovalForNewAgents
          : readCompanyApprovalDefault(companyFrontmatter),
    },
    sidebar: paperclipSidebar,
    agents: [],
    skills: [],
    projects: [],
    tasks: [],
    envInputs: [],
  };

  const warnings: string[] = [];
  if (manifest.company?.logoPath && !normalizedFiles[manifest.company.logoPath]) {
    warnings.push(`Referenced company logo file is missing from package: ${manifest.company.logoPath}`);
  }
  for (const agentPath of agentPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, agentPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced agent file is missing from package: ${agentPath}`);
      continue;
    }
    const agentDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = agentDoc.frontmatter;
    assertExactPortableKeys(
      frontmatter,
      PORTABLE_AGENT_FRONTMATTER_KEYS,
      `Agent file ${agentPath}`,
    );
    if (agentDoc.body.trim().length > 0) {
      throw unprocessable(
        `Agent file ${agentPath} contains retired instruction content`,
      );
    }
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(agentPath))) ?? "agent";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipAgents[slug]) ? paperclipAgents[slug] : {};
    assertExactPortableKeys(
      extension,
      PORTABLE_AGENT_EXTENSION_KEYS,
      `Agent ${slug} manifest`,
    );
    if (!hasOwn(frontmatter, "reportsTo")) {
      throw unprocessable(
        `Agent ${slug} must declare reportsTo explicitly, using null for a root agent`,
      );
    }
    if (!Array.isArray(frontmatter.skills)) {
      throw unprocessable(
        `Agent ${slug} must declare skills explicitly as an array`,
      );
    }
    const rawAdapterRevision = extension.adapterRevision;
    if (!isPlainRecord(rawAdapterRevision)) {
      throw unprocessable(
        `Agent ${slug} requires an explicit adapterRevision`,
      );
    }
    assertExactPortableKeys(
      rawAdapterRevision,
      [
        "sourceRevisionId",
        "adapterType",
        "adapterConfig",
        "runtimeConfig",
      ],
      `Agent ${slug} adapterRevision`,
    );
    const sourceRevisionId = asString(
      rawAdapterRevision.sourceRevisionId,
    );
    const adapterType = asString(rawAdapterRevision.adapterType);
    if (!sourceRevisionId || !isUuidLike(sourceRevisionId)) {
      throw unprocessable(
        `Agent ${slug} adapterRevision.sourceRevisionId must be a UUID`,
      );
    }
    if (!adapterType) {
      throw unprocessable(
        `Agent ${slug} adapterRevision.adapterType is required`,
      );
    }
    if (!isPlainRecord(rawAdapterRevision.adapterConfig)) {
      throw unprocessable(
        `Agent ${slug} adapterRevision.adapterConfig must be an object`,
      );
    }
    const parsedAdapterConfig =
      portabilityAgentManifestEntrySchema.shape.adapterRevision.shape.adapterConfig.safeParse(
        rawAdapterRevision.adapterConfig,
      );
    if (!parsedAdapterConfig.success) {
      throw unprocessable(
        `Agent ${slug} adapterRevision.adapterConfig contains retired or invalid fields`,
      );
    }
    if (!isPlainRecord(rawAdapterRevision.runtimeConfig)) {
      throw unprocessable(
        `Agent ${slug} adapterRevision.runtimeConfig must be an object`,
      );
    }
    const extensionPermissionGrants = normalizePortablePermissionGrants(extension.permissionGrants);
    const title = asString(frontmatter.title);

    manifest.agents.push({
      slug,
      name: asString(frontmatter.name) ?? title ?? slug,
      path: agentPath,
      skills: readAgentSkillRefs(frontmatter),
      title,
      icon: asString(extension.icon),
      capabilities: asString(extension.capabilities),
      reportsToSlug: asString(frontmatter.reportsTo) ?? asString(extension.reportsTo),
      reportsToExistingAgentId: asString(extension.reportsToExistingAgentId),
      reportsToExistingAgentSlug: asString(extension.reportsToExistingAgentSlug),
      adapterRevision: {
        sourceRevisionId,
        adapterType,
        adapterConfig: {
          ...parsedAdapterConfig.data,
        },
        runtimeConfig: {
          ...rawAdapterRevision.runtimeConfig,
        },
      },
      contextGrants: parseExactPortableBooleanMap(
        extension.contextGrants,
        AGENT_CONTEXT_GRANT_KEYS,
        `Agent ${slug} contextGrants`,
      ),
      actionGrants: parseExactPortableBooleanMap(
        extension.actionGrants,
        PAPERCLIP_ACTION_KEYS,
        `Agent ${slug} actionGrants`,
      ),
      mentionReachGrants: parseExactPortableBooleanMap(
        extension.mentionReachGrants,
        AGENT_MENTION_REACH_GRANT_KEYS,
        `Agent ${slug} mentionReachGrants`,
      ),
      permissionGrants: extensionPermissionGrants,
      budgetMonthlyAmount: portableMoneyAmount(
        extension.budgetMonthlyAmount,
        `Agent ${slug} budgetMonthlyAmount`,
      ),
    });

    if (frontmatter.kind && frontmatter.kind !== "agent") {
      warnings.push(`Agent markdown ${agentPath} does not declare kind: agent in frontmatter.`);
    }
  }

  for (const skillPath of skillPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, skillPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced skill file is missing from package: ${skillPath}`);
      continue;
    }
    const skillDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = skillDoc.frontmatter;
    const skillDir = path.posix.dirname(skillPath);
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(skillDir)) ?? "skill";
    const slug = asString(frontmatter.slug) ?? normalizeAgentUrlKey(asString(frontmatter.name) ?? "") ?? fallbackSlug;
    const inventory = Object.keys(normalizedFiles)
      .filter((entry) => entry === skillPath || entry.startsWith(`${skillDir}/`))
      .map((entry) => ({
        path: entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
        kind: entry === skillPath
          ? "skill"
          : entry.startsWith(`${skillDir}/references/`)
            ? "reference"
            : entry.startsWith(`${skillDir}/scripts/`)
              ? "script"
              : entry.startsWith(`${skillDir}/assets/`)
                ? "asset"
                : entry.endsWith(".md")
                  ? "markdown"
                  : "other",
      }));
    const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
    const sources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
    const primarySource = sources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
    const sourceKind = asString(primarySource?.kind);
    let sourceType = "catalog";
    let sourceLocator: string | null = null;
    let sourceRef: string | null = null;
    let normalizedMetadata: Record<string, unknown> | null = null;

    if (sourceKind === "github-dir" || sourceKind === "github-file") {
      const repo = asString(primarySource?.repo);
      const repoPath = asString(primarySource?.path);
      const commit = asString(primarySource?.commit);
      const trackingRef = asString(primarySource?.trackingRef);
      const sourceHostname = asString(primarySource?.hostname) || "github.com";
      const [owner, repoName] = (repo ?? "").split("/");
      const canonicalKey = readSkillKey(frontmatter);
      const normalizedSourceKind = owner === "paperclipai"
        && repoName === "paperclip"
        && canonicalKey?.startsWith("paperclipai/paperclip/")
        ? "paperclip_bundled"
        : "github";
      sourceType = "github";
      sourceLocator = asString(primarySource?.url)
        ?? (repo ? `https://${sourceHostname}/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}` : null);
      sourceRef = commit;
      normalizedMetadata = owner && repoName
        ? {
            sourceKind: normalizedSourceKind,
            ...(sourceHostname !== "github.com" ? { hostname: sourceHostname } : {}),
            owner,
            repo: repoName,
            ref: commit,
            trackingRef,
            repoSkillDir: repoPath ?? `skills/${slug}`,
          }
        : null;
    } else if (sourceKind === "url") {
      sourceType = "url";
      sourceLocator = asString(primarySource?.url) ?? asString(primarySource?.rawUrl);
      normalizedMetadata = {
        sourceKind: "url",
      };
    } else {
      const catalogProvenance = readPortableCatalogProvenance(metadata);
      if (catalogProvenance) {
        sourceType = "catalog";
        sourceRef = catalogProvenance.sourceRef;
        normalizedMetadata = catalogProvenance.metadata;
      } else if (metadata) {
        normalizedMetadata = {
          sourceKind: "catalog",
        };
      }
    }
    const key = deriveManifestSkillKey(frontmatter, slug, normalizedMetadata, sourceType, sourceLocator);

    manifest.skills.push({
      key,
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: skillPath,
      description: asString(frontmatter.description),
      sourceType,
      sourceLocator,
      sourceRef,
      trustLevel: null,
      compatibility: "compatible",
      metadata: normalizedMetadata,
      fileInventory: inventory,
    });
  }

  for (const projectPath of projectPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, projectPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced project file is missing from package: ${projectPath}`);
      continue;
    }
    const projectDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = projectDoc.frontmatter;
    const fallbackSlug = deriveProjectUrlKey(
      asString(frontmatter.name) ?? path.posix.basename(path.posix.dirname(projectPath)) ?? "project",
      projectPath,
    );
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipProjects[slug]) ? paperclipProjects[slug] : {};
    manifest.projects.push({
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: projectPath,
      description: asString(frontmatter.description),
      ownerAgentSlug: asString(frontmatter.owner),
      leadAgentSlug: asString(extension.leadAgentSlug),
      targetDate: asString(extension.targetDate),
      color: asString(extension.color),
      icon: asString(extension.icon),
      status: asString(extension.status),
      env: normalizePortableProjectEnv(extension.env),
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    manifest.envInputs.push(...readProjectEnvInputs(extension, slug));
    if (frontmatter.kind && frontmatter.kind !== "project") {
      warnings.push(`Project markdown ${projectPath} does not declare kind: project in frontmatter.`);
    }
  }

  for (const taskPath of taskPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, taskPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced task file is missing from package: ${taskPath}`);
      continue;
    }
    const taskDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = taskDoc.frontmatter;
    assertExactPortableKeys(
      frontmatter,
      PORTABLE_TASK_FRONTMATTER_KEYS,
      `Task file ${taskPath}`,
    );
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(taskPath))) ?? "task";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipTasks[slug]) ? paperclipTasks[slug] : {};
    assertExactPortableKeys(
      extension,
      PORTABLE_TASK_EXTENSION_KEYS,
      `Task ${slug} manifest`,
    );
    const routineExtension = normalizeRoutineExtension(paperclipRoutines[slug]);
    const recurring =
      asBoolean(frontmatter.recurring) === true
      || routineExtension !== null;
    const ownerAgentSlug = asString(frontmatter.owner);
    if (!ownerAgentSlug) {
      throw unprocessable(
        `Task ${slug} requires an explicit owner`,
      );
    }
    const lifecycleStatus = asString(extension.lifecycleStatus);
    if (
      !lifecycleStatus ||
      !["open", "blocked", "done", "cancelled"].includes(
        lifecycleStatus,
      )
    ) {
      throw unprocessable(
        `Task ${slug} requires lifecycleStatus open, blocked, done, or cancelled`,
      );
    }
    const boardPresentationStatus = asString(
      extension.boardPresentationStatus,
    );
    if (!boardPresentationStatus) {
      throw unprocessable(
        `Task ${slug} requires boardPresentationStatus`,
      );
    }
    manifest.tasks.push({
      slug,
      identifier: asString(extension.identifier),
      title: asString(frontmatter.name) ?? asString(frontmatter.title) ?? slug,
      path: taskPath,
      projectSlug: asString(frontmatter.project),
      ownerAgentSlug,
      request: taskDoc.body,
      recurring,
      routine: routineExtension,
      lifecycleStatus:
        lifecycleStatus as CompanyPortabilityTaskManifestEntry["lifecycleStatus"],
      disposition: normalizePortableDisposition(
        extension.disposition,
        lifecycleStatus as CompanyPortabilityTaskManifestEntry["lifecycleStatus"],
        `Task ${slug}`,
      ),
      boardPresentationStatus,
      priority: asString(extension.priority),
      labelIds: Array.isArray(extension.labelIds)
        ? extension.labelIds.filter((entry): entry is string => typeof entry === "string")
        : [],
      billingCode: asString(extension.billingCode),
      comments: readPortableTaskComments(extension.comments, warnings, `Task ${slug}`),
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    if (frontmatter.kind && frontmatter.kind !== "task") {
      warnings.push(`Task markdown ${taskPath} does not declare kind: task in frontmatter.`);
    }
  }

  manifest.envInputs = dedupeEnvInputs(manifest.envInputs);
  return {
    manifest,
    files: normalizedFiles,
    warnings,
  };
}


function normalizeGitHubSourcePath(value: string | null | undefined) {
  if (!value) return "";
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function parseGitHubSourceUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw unprocessable("GitHub source URL must use HTTPS");
  }
  const hostname = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  const queryRef = url.searchParams.get("ref")?.trim();
  const queryPath = normalizeGitHubSourcePath(url.searchParams.get("path"));
  const queryCompanyPath = normalizeGitHubSourcePath(url.searchParams.get("companyPath"));
  if (queryRef || queryPath || queryCompanyPath) {
    const companyPath = queryCompanyPath || [queryPath, "COMPANY.md"].filter(Boolean).join("/") || "COMPANY.md";
    let basePath = queryPath;
    if (!basePath && companyPath !== "COMPANY.md") {
      basePath = path.posix.dirname(companyPath);
      if (basePath === ".") basePath = "";
    }
    return {
      hostname,
      owner,
      repo,
      ref: queryRef || "main",
      basePath,
      companyPath,
    };
  }
  let ref = "main";
  let basePath = "";
  let companyPath = "COMPANY.md";
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    const blobPath = parts.slice(4).join("/");
    if (!blobPath) {
      throw unprocessable("Invalid GitHub blob URL");
    }
    companyPath = blobPath;
    basePath = path.posix.dirname(blobPath);
    if (basePath === ".") basePath = "";
  }
  return { hostname, owner, repo, ref, basePath, companyPath };
}


export function companyPortabilityService(
  db: Db,
  storage: StorageService | undefined,
  ordinaryTasks: OrdinaryTaskRuntime,
) {
  const companies = companyService(db);
  const agents = agentService(db);
  const assetRecords = assetService(db);
  const access = accessService(db);
  const projects = projectService(db);
  const tasks = taskService(db);
  const companySkills = companySkillService(db);
  const secrets = secretService(db);
  const runtimeAgentConfigurations = createRuntimeAgentConfigurationService(db);
  const adapterConfigurations = createAgentAdapterConfigurationService(db);
  const operationalConfigurations =
    createAgentOperationalConfigurationService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";
  const defaultSecretProvider = getConfiguredSecretProvider();

  async function applyImportedAgentPermissionGrants(
    companyId: string,
    agentId: string,
    permissionGrants: PortableAgentPermissionGrant[],
    grantedByUserId: string | null,
  ) {
    if (permissionGrants.length === 0) return;
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");
    for (const grant of permissionGrants) {
      await access.setPrincipalPermission(
        companyId,
        "agent",
        agentId,
        grant.permissionKey,
        true,
        grantedByUserId,
        grant.scope ?? null,
      );
    }
  }

  function assertKnownImportAdapterType(type: string | null | undefined): string {
    if (
      typeof type !== "string"
      || type.length === 0
      || type !== type.trim()
    ) {
      throw unprocessable("Adapter type must be an exact non-blank string");
    }
    return type;
  }

  async function prepareImportedAgentAdapter(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    const effectiveAdapterType = assertKnownImportAdapterType(adapterType);
    const parsedAdapterConfig =
      portabilityAgentManifestEntrySchema.shape.adapterRevision.shape.adapterConfig.safeParse(
        adapterConfig,
      );
    if (!parsedAdapterConfig.success) {
      throw unprocessable(
        "Imported ACP adapter configuration contains retired provider, environment, or authentication fields",
      );
    }
    const explicitAdapterConfig = { ...parsedAdapterConfig.data };
    await validateRegisteredAdapterRuntimeConfiguration({
      adapterType: effectiveAdapterType,
      adapterConfig: explicitAdapterConfig,
    });
    return {
      adapterType: effectiveAdapterType,
      adapterConfig: explicitAdapterConfig,
    };
  }

  async function materializeImportEnvInputValues(
    companyId: string,
    manifest: CompanyPortabilityManifest,
    envInputs: CompanyPortabilityEnvInput[],
    secretValues: Record<string, string> | null | undefined,
    actor: SecretMutationActor,
    createdSecretIds: string[] = [],
  ) {
    requireSecretMutationActor(actor);
    if (envInputs.length === 0) return;
    const missingRequired = envInputs.filter((input) => {
      if (input.requirement !== "required") return false;
      const value = envInputValue(input, secretValues);
      return value === null || value.trim().length === 0;
    });
    if (missingRequired.length > 0) {
      throw unprocessable(`Required environment values are missing: ${missingRequired.map(envInputScopedKey).join(", ")}`);
    }

    for (const input of envInputs) {
      const value = envInputValue(input, secretValues);
      if (value === null || value.trim().length === 0) continue;

      if (input.kind === "plain") {
        writeManifestEnvBinding(manifest, input, {
          type: "plain",
          value,
        });
        continue;
      }

      const suffix = randomUUID().slice(0, 8);
      const label = importSecretLabel(input);
      const secret = await secrets.create(
        companyId,
        {
          name: `Imported ${label} ${suffix}`,
          key: importSecretKey(input, suffix),
          provider: defaultSecretProvider,
          value,
          description: input.description ?? `Imported ${input.key} for ${label}.`,
        },
        actor,
      );
      createdSecretIds.push(secret.id);
      writeManifestEnvBinding(manifest, input, {
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      });
    }
  }

  function resolveImportedOwnerAgentId(
    ownerSlug: string | null | undefined,
    importedSlugToAgentId: Map<string, string>,
    existingSlugToAgentId: Map<string, string>,
    agentStatusById: Map<string, string | null | undefined>,
    warnings: string[],
    subjectLabel: string,
  ) {
    if (!ownerSlug) return null;
    const ownerAgentId =
      importedSlugToAgentId.get(ownerSlug)
      ?? existingSlugToAgentId.get(ownerSlug)
      ?? null;
    if (!ownerAgentId) return null;
    const ownerStatus = agentStatusById.get(ownerAgentId) ?? null;
    if (ownerStatus === "pending_approval" || ownerStatus === "terminated") {
      warnings.push(
        `${subjectLabel} owner ${ownerSlug} is ${ownerStatus}; imported work was left without an owner.`,
      );
      return null;
    }
    return ownerAgentId;
  }

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return buildManifestFromPackageFiles(
        normalizeFileMap(source.files, source.rootPath),
      );
    }

    const parsed = parseGitHubSourceUrl(source.url);
    let ref = parsed.ref;
    const warnings: string[] = [];
    const companyRelativePath = parsed.companyPath === "COMPANY.md"
      ? [parsed.basePath, "COMPANY.md"].filter(Boolean).join("/")
      : parsed.companyPath;
    let companyMarkdown: string | null = null;
    try {
      companyMarkdown = await fetchOptionalText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, companyRelativePath),
      );
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push("GitHub ref main not found; falling back to master.");
        companyMarkdown = await fetchOptionalText(
          resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, companyRelativePath),
        );
      } else {
        throw err;
      }
    }
    if (!companyMarkdown) {
      throw unprocessable("GitHub company package is missing COMPANY.md");
    }

    const companyPath = parsed.companyPath === "COMPANY.md"
      ? "COMPANY.md"
      : normalizePortablePath(path.posix.relative(parsed.basePath || ".", parsed.companyPath));
    const files: Record<string, CompanyPortabilityFileEntry> = {
      [companyPath]: companyMarkdown,
    };
    const apiBase = gitHubApiBase(parsed.hostname);
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => ({ tree: [] }));
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const candidatePaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => {
        if (basePrefix && !entry.startsWith(basePrefix)) return false;
        const relative = basePrefix ? entry.slice(basePrefix.length) : entry;
        return (
          relative.endsWith(".md") ||
          relative.startsWith("skills/") ||
          relative === ".paperclip.yaml" ||
          relative === ".paperclip.yml"
        );
      });
    for (const repoPath of candidatePaths) {
      const relativePath = basePrefix ? repoPath.slice(basePrefix.length) : repoPath;
      if (files[relativePath] !== undefined) continue;
      files[normalizePortablePath(relativePath)] = await fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }
    const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
    const includeEntries = readIncludeEntries(companyDoc.frontmatter);
    for (const includeEntry of includeEntries) {
      const repoPath = [parsed.basePath, includeEntry.path].filter(Boolean).join("/");
      const relativePath = normalizePortablePath(includeEntry.path);
      if (files[relativePath] !== undefined) continue;
      if (!(repoPath.endsWith(".md") || repoPath.endsWith(".yaml") || repoPath.endsWith(".yml"))) continue;
      files[relativePath] = await fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }

    const resolved = buildManifestFromPackageFiles(files);
    const companyLogoPath = resolved.manifest.company?.logoPath;
    if (companyLogoPath && !resolved.files[companyLogoPath]) {
      const repoPath = [parsed.basePath, companyLogoPath].filter(Boolean).join("/");
      try {
        const binary = await fetchBinary(
          resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
        );
        resolved.files[companyLogoPath] = bufferToPortableBinaryFile(binary, inferContentTypeFromPath(companyLogoPath));
      } catch (err) {
        warnings.push(`Failed to fetch company logo ${companyLogoPath} from GitHub: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resolved.warnings.unshift(...warnings);
    return resolved;
  }

  async function exportBundle(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportResult> {
    const include = normalizeInclude({
      ...input.include,
      agents: input.agents && input.agents.length > 0 ? true : input.include?.agents,
      projects: input.projects && input.projects.length > 0 ? true : input.include?.projects,
      tasks:
        (input.tasks && input.tasks.length > 0) || (input.projectTasks && input.projectTasks.length > 0)
          ? true
          : input.include?.tasks,
      skills: input.skills && input.skills.length > 0 ? true : input.include?.skills,
    });
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const files: Record<string, CompanyPortabilityFileEntry> = {};
    const warnings: string[] = [];
    const envInputs: CompanyPortabilityManifest["envInputs"] = [];
    const requestedSidebarOrder = normalizePortableSidebarOrder(input.sidebarOrder);
    const rootPath = normalizeAgentUrlKey(company.name) ?? "company-package";
    let companyLogoPath: string | null = null;

    const allAgentRows =
      include.agents || include.projects || include.tasks
        ? await agents.list(companyId, { includeTerminated: true })
        : [];
    const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    const companySkillRows = include.skills || include.agents ? await companySkills.listFull(companyId) : [];
    if (include.agents) {
      const skipped = allAgentRows.length - liveAgentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const agentByReference = new Map<string, typeof liveAgentRows[number]>();
    const addAgentReferences = (map: Map<string, typeof liveAgentRows[number]>, agent: typeof liveAgentRows[number]) => {
      map.set(agent.id, agent);
      map.set(agent.name, agent);
      const normalizedName = normalizeAgentUrlKey(agent.name);
      if (normalizedName) {
        map.set(normalizedName, agent);
      }
    };
    for (const agent of liveAgentRows) {
      addAgentReferences(agentByReference, agent);
    }

    const selectedAgents = new Map<string, typeof liveAgentRows[number]>();
    for (const selector of input.agents ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeAgentUrlKey(trimmed) ?? trimmed;
      const match = agentByReference.get(trimmed) ?? agentByReference.get(normalized);
      if (!match) {
        warnings.push(`Agent selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedAgents.set(match.id, match);
    }

    if (include.agents && selectedAgents.size === 0) {
      for (const agent of liveAgentRows) {
        selectedAgents.set(agent.id, agent);
      }
    }

    const agentRows = Array.from(selectedAgents.values())
      .sort((left, right) => left.name.localeCompare(right.name));

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of [...liveAgentRows].sort((left, right) => left.name.localeCompare(right.name))) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }
    const agentPermissionGrantRows = agentRows.length > 0 && typeof (db as { select?: unknown }).select === "function"
      ? await db
        .select({
          principalId: principalPermissionGrants.principalAgentId,
          permissionKey: principalPermissionGrants.permissionKey,
          scope: principalPermissionGrants.scope,
        })
        .from(principalPermissionGrants)
        .where(and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          inArray(principalPermissionGrants.principalAgentId, agentRows.map((agent) => agent.id)),
        ))
      : [];
    const permissionGrantsByAgentId = new Map<string, PortableAgentPermissionGrant[]>();
    for (const row of agentPermissionGrantRows) {
      if (!row.principalId) {
        throw new Error("Agent permission grant is missing its typed agent principal id");
      }
      if (!VALID_PERMISSION_KEYS.has(row.permissionKey as PermissionKey)) continue;
      const grants = permissionGrantsByAgentId.get(row.principalId) ?? [];
      grants.push({
        permissionKey: row.permissionKey as PermissionKey,
        scope: isPlainRecord(row.scope) ? row.scope : null,
      });
      permissionGrantsByAgentId.set(row.principalId, grants);
    }
    for (const grants of permissionGrantsByAgentId.values()) {
      grants.sort((left, right) => left.permissionKey.localeCompare(right.permissionKey));
    }

    const projectsSvc = projectService(db);
    const tasksSvc = taskService(db);
    const routinesSvc = routineService(db, { ordinaryTasks });
    const allProjectsRaw = include.projects || include.tasks ? await projectsSvc.list(companyId) : [];
    const allProjects = allProjectsRaw.filter((project) => !project.archivedAt);
    const allRoutinesRaw = include.tasks ? await routinesSvc.list(companyId) : [];
    const allRoutines = allRoutinesRaw;
    const projectById = new Map(allProjects.map((project) => [project.id, project]));
    const projectByReference = new Map<string, typeof allProjects[number]>();
    for (const project of allProjects) {
      projectByReference.set(project.id, project);
      projectByReference.set(project.urlKey, project);
    }

    const selectedProjects = new Map<string, typeof allProjects[number]>();
    const normalizeProjectSelector = (selector: string) => selector.trim().toLowerCase();
    for (const selector of input.projects ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
    }

    type SelectedTaskRow =
      | NonNullable<Awaited<ReturnType<typeof tasksSvc.getById>>>
      | Awaited<ReturnType<typeof tasksSvc.list>>[number];
    const selectedTasks = new Map<string, SelectedTaskRow>();
    const selectedRoutines = new Map<string, typeof allRoutines[number]>();
    const routineById = new Map(allRoutines.map((routine) => [routine.id, routine]));
    const resolveTaskBySelector = async (selector: string) => {
      const trimmed = selector.trim();
      if (!trimmed) return null;
      return trimmed.includes("-")
        ? tasksSvc.getByIdentifier(trimmed)
        : tasksSvc.getById(trimmed);
    };
    for (const selector of input.tasks ?? []) {
      const task = await resolveTaskBySelector(selector);
      if (!task || task.companyId !== companyId) {
        const routine = routineById.get(selector.trim());
        if (routine) {
          selectedRoutines.set(routine.id, routine);
          if (routine.projectId) {
            const parentProject = projectById.get(routine.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
          continue;
        }
        warnings.push(`Task selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedTasks.set(task.id, task);
      if (task.projectId) {
        const parentProject = projectById.get(task.projectId);
        if (parentProject) selectedProjects.set(parentProject.id, parentProject);
      }
    }

    for (const selector of input.projectTasks ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project-tasks selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
      const projectTasks = await tasksSvc.list(companyId, { projectId: match.id });
      for (const task of projectTasks) {
        selectedTasks.set(task.id, task);
      }
      for (const routine of allRoutines.filter((entry) => entry.projectId === match.id)) {
        selectedRoutines.set(routine.id, routine);
      }
    }

    if (include.projects && selectedProjects.size === 0) {
      for (const project of allProjects) {
        selectedProjects.set(project.id, project);
      }
    }

    if (include.tasks && selectedTasks.size === 0) {
      const allTasks = await tasksSvc.list(companyId);
      for (const task of allTasks) {
        selectedTasks.set(task.id, task);
        if (task.projectId) {
          const parentProject = projectById.get(task.projectId);
          if (parentProject) selectedProjects.set(parentProject.id, parentProject);
        }
      }
      if (selectedRoutines.size === 0) {
        for (const routine of allRoutines) {
          selectedRoutines.set(routine.id, routine);
          if (routine.projectId) {
            const parentProject = projectById.get(routine.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
        }
      }
    }

    const selectedProjectRows = Array.from(selectedProjects.values())
      .sort((left, right) => left.name.localeCompare(right.name));
    const selectedTaskRows = Array.from(selectedTasks.values())
      .filter((task): task is NonNullable<typeof task> => task != null)
      .sort((left, right) => taskDisplayLabel(left).localeCompare(taskDisplayLabel(right)));
    const selectedRoutineSummaries = Array.from(selectedRoutines.values())
      .sort((left, right) => left.title.localeCompare(right.title));
    const selectedRoutineRows = (
      await Promise.all(selectedRoutineSummaries.map((routine) => routinesSvc.getDetail(routine.id)))
    ).filter((routine): routine is RoutineLike => routine !== null);

    const taskSlugByTaskId = new Map<string, string>();
    const taskSlugByRoutineId = new Map<string, string>();
    const usedTaskSlugs = new Set<string>();
    for (const task of selectedTaskRows) {
      const baseSlug = normalizeAgentUrlKey(taskDisplayLabel(task)) ?? "task";
      taskSlugByTaskId.set(task.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }
    for (const routine of selectedRoutineRows) {
      const baseSlug = normalizeAgentUrlKey(routine.title) ?? "task";
      taskSlugByRoutineId.set(routine.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }

    const projectSlugById = new Map<string, string>();
    const usedProjectSlugs = new Set<string>();
    for (const project of selectedProjectRows) {
      const baseSlug = deriveProjectUrlKey(project.name, project.name);
      projectSlugById.set(project.id, uniqueSlug(baseSlug, usedProjectSlugs));
    }
    const sidebarOrder = requestedSidebarOrder ?? stripEmptyValues({
      agents: sortAgentsBySidebarOrder(Array.from(selectedAgents.values()))
        .map((agent) => idToSlug.get(agent.id))
        .filter((slug): slug is string => Boolean(slug)),
      projects: selectedProjectRows
        .map((project) => projectSlugById.get(project.id))
        .filter((slug): slug is string => Boolean(slug)),
    });

    const companyPath = "COMPANY.md";
    files[companyPath] = buildMarkdown(
      {
        name: company.name,
        description: company.description ?? null,
        schema: "agentcompanies/v1",
        slug: rootPath,
      },
      "",
    );

    if (include.company && company.logoAssetId) {
      if (!storage) {
        warnings.push("Skipped company logo from export because storage is unavailable.");
      } else {
        const logoAsset = await assetRecords.getById(company.logoAssetId);
        if (!logoAsset) {
          warnings.push(`Skipped company logo ${company.logoAssetId} because the asset record was not found.`);
        } else {
          try {
            const object = await storage.getObject(company.id, logoAsset.objectKey);
            const body = await streamToBuffer(object.stream);
            companyLogoPath = `images/${COMPANY_LOGO_FILE_NAME}${resolveCompanyLogoExtension(logoAsset.contentType, logoAsset.originalFilename)}`;
            files[companyLogoPath] = bufferToPortableBinaryFile(body, logoAsset.contentType);
          } catch (err) {
            warnings.push(`Failed to export company logo ${company.logoAssetId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    const paperclipAgentsOut: Record<string, Record<string, unknown>> = {};
    const paperclipProjectsOut: Record<string, Record<string, unknown>> = {};
    const paperclipTasksOut: Record<string, Record<string, unknown>> = {};
    const paperclipRoutinesOut: Record<string, Record<string, unknown>> = {};
    const runtimeConfigurationByAgentId = new Map(
      await Promise.all(
        agentRows.map(async (agent) => [
          agent.id,
          await runtimeAgentConfigurations.get({
            companyId,
            targetAgentId: agent.id,
          }),
        ] as const),
      ),
    );
    const currentAdapterRevisionIds = agentRows.flatMap((agent) =>
      agent.currentAdapterConfigRevisionId
        ? [agent.currentAdapterConfigRevisionId]
        : [],
    );
    const currentAdapterRevisionRows =
      currentAdapterRevisionIds.length === 0
        ? []
        : await db
            .select()
            .from(agentAdapterConfigRevisions)
            .where(
              and(
                eq(agentAdapterConfigRevisions.companyId, companyId),
                inArray(
                  agentAdapterConfigRevisions.id,
                  currentAdapterRevisionIds,
                ),
              ),
            );
    const currentAdapterRevisionByAgentId = new Map(
      currentAdapterRevisionRows.map((revision) => [
        revision.agentId,
        revision,
      ]),
    );

    const skillByReference = new Map<string, typeof companySkillRows[number]>();
    for (const skill of companySkillRows) {
      skillByReference.set(skill.id, skill);
      skillByReference.set(skill.key, skill);
      skillByReference.set(skill.slug, skill);
      skillByReference.set(skill.name, skill);
    }
    const selectedSkills = new Map<string, typeof companySkillRows[number]>();
    for (const selector of input.skills ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeSkillKey(trimmed) ?? normalizeSkillSlug(trimmed) ?? trimmed;
      const match = skillByReference.get(trimmed) ?? skillByReference.get(normalized);
      if (!match) {
        warnings.push(`Skill selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedSkills.set(match.id, match);
    }
    if (selectedSkills.size === 0) {
      for (const skill of companySkillRows) {
        selectedSkills.set(skill.id, skill);
      }
    }
    const selectedSkillRows = Array.from(selectedSkills.values())
      .sort((left, right) => left.key.localeCompare(right.key));

    const skillExportDirs = buildSkillExportDirMap(selectedSkillRows, company.taskPrefix);
    for (const skill of selectedSkillRows) {
      const packageDir = skillExportDirs.get(skill.key) ?? `skills/${normalizeSkillSlug(skill.slug) ?? "skill"}`;
      if (shouldReferenceSkillOnExport(skill, Boolean(input.expandReferencedSkills))) {
        files[`${packageDir}/SKILL.md`] = await buildReferencedSkillMarkdown(skill);
        continue;
      }

      for (const inventoryEntry of skill.fileInventory) {
        const fileDetail = await companySkills.readFile(companyId, skill.id, inventoryEntry.path).catch(() => null);
        if (!fileDetail) continue;
        const filePath = `${packageDir}/${inventoryEntry.path}`;
        files[filePath] = inventoryEntry.path === "SKILL.md"
          ? await withSkillSourceMetadata(skill, fileDetail.content)
          : fileDetail.content;
      }
    }

    if (include.agents) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const currentAdapterRevision =
          currentAdapterRevisionByAgentId.get(agent.id) ?? null;
        if (
          !agent.currentAdapterConfigRevisionId ||
          !currentAdapterRevision ||
          currentAdapterRevision.id !==
            agent.currentAdapterConfigRevisionId
        ) {
          throw unprocessable(
            `Agent ${slug} has no complete canonical adapter revision and cannot be exported.`,
          );
        }
        const adapterType = currentAdapterRevision.adapterType;
        const configuredAdapterConfig =
          currentAdapterRevision.normalizedConfig;
        const currentAcpConfiguration =
          agentAdapterAcpConfigurationSchema.parse(
            currentAdapterRevision.acpConfiguration,
          );
        const runtimeConfiguration =
          runtimeConfigurationByAgentId.get(agent.id);
        if (!runtimeConfiguration) {
          throw unprocessable(
            `Agent ${slug} has no canonical runtime configuration and cannot be exported.`,
          );
        }

        const selectedCompanySkillKeys =
          currentAcpConfiguration.companySkillPins.map(
            (selection) => selection.key,
          );
        const parsedPortableAdapterConfig =
          portabilityAgentManifestEntrySchema.shape.adapterRevision.shape.adapterConfig.safeParse(
            configuredAdapterConfig,
          );
        if (!parsedPortableAdapterConfig.success) {
          throw unprocessable(
            `Agent ${slug} has non-portable provider configuration in its canonical adapter revision.`,
          );
        }
        const portableAdapterConfig = {
          ...parsedPortableAdapterConfig.data,
        };
        const portableRuntimeConfig =
          (pruneDefaultLikeValue(
            { ...currentAdapterRevision.runtimeConfig },
            {
              dropFalseBooleans: true,
            },
          ) as Record<string, unknown> | undefined) ?? {};
        const portablePermissionGrants = permissionGrantsByAgentId.get(agent.id) ?? [];
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;
        files[`agents/${slug}/AGENTS.md`] = buildMarkdown(
          {
            name: agent.name,
            title: agent.title ?? null,
            reportsTo: reportsToSlug,
            skills: selectedCompanySkillKeys,
          },
          "",
        );

        const optionalExtension = stripEmptyValues({
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          permissionGrants: portablePermissionGrants.length > 0 ? portablePermissionGrants : undefined,
          budgetMonthlyAmount: agent.budgetMonthlyAmount,
        });
        const extension: Record<string, unknown> = {
          ...(isPlainRecord(optionalExtension)
            ? optionalExtension
            : {}),
          capabilities: agent.capabilities ?? null,
          adapterRevision: {
            sourceRevisionId:
              agent.currentAdapterConfigRevisionId,
            adapterType,
            adapterConfig: portableAdapterConfig,
            runtimeConfig: portableRuntimeConfig,
          },
          contextGrants: materializePortableBooleanMap(
            AGENT_CONTEXT_GRANT_KEYS,
            runtimeConfiguration.contextGrants,
          ),
          actionGrants: materializePortableBooleanMap(
            PAPERCLIP_ACTION_KEYS,
            runtimeConfiguration.actionGrants,
          ),
          mentionReachGrants:
            materializePortableBooleanMap(
              AGENT_MENTION_REACH_GRANT_KEYS,
              runtimeConfiguration.mentionReachGrants,
            ),
        };
        paperclipAgentsOut[slug] = isPlainRecord(extension) ? extension : {};
      }
    }

    for (const project of selectedProjectRows) {
      const slug = projectSlugById.get(project.id)!;
      const projectPath = `projects/${slug}/PROJECT.md`;
      const envInputsStart = envInputs.length;
      const exportedEnvInputs = extractPortableProjectEnvInputs(slug, project.env, warnings);
      envInputs.push(...exportedEnvInputs);
      const projectEnvInputs = dedupeEnvInputs(
        envInputs
          .slice(envInputsStart)
          .filter((inputValue) => inputValue.projectSlug === slug),
      );
      files[projectPath] = buildMarkdown(
        {
          name: project.name,
          description: project.description ?? null,
          owner: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        },
        project.description ?? "",
      );
      const extension = stripEmptyValues({
        leadAgentSlug: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        targetDate: project.targetDate ?? null,
        color: project.color ?? null,
        icon: project.icon ?? null,
        status: project.status,
      });
      if (isPlainRecord(extension) && projectEnvInputs.length > 0) {
        extension.inputs = {
          env: buildEnvInputMap(projectEnvInputs),
        };
      }
      paperclipProjectsOut[slug] = isPlainRecord(extension) ? extension : {};
    }

    for (const task of selectedTaskRows) {
      if (!task.request?.trim()) {
        throw unprocessable(
          `Task ${task.identifier ?? task.id} has no canonical immutable request and cannot be exported`,
        );
      }
      const taskSlug = taskSlugByTaskId.get(task.id)!;
      const projectSlug = task.projectId ? (projectSlugById.get(task.projectId) ?? null) : null;
      // All tasks go in top-level tasks/ folder, never nested under projects/
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const ownerSlug = task.ownerAgentId ? (idToSlug.get(task.ownerAgentId) ?? null) : null;
      if (!ownerSlug) {
        throw unprocessable(
          `Task ${task.identifier ?? task.id} has no portable agent owner and cannot be exported`,
        );
      }
      const comments = await tasksSvc.listComments(task.id, { order: "asc" });
      files[taskPath] = buildMarkdown(
        {
          name: task.title,
          project: projectSlug,
          owner: ownerSlug,
        },
        task.request,
      );
      const extension = stripEmptyValues({
        identifier: task.identifier,
        lifecycleStatus: task.lifecycleStatus,
        boardPresentationStatus: task.boardPresentationStatus,
        priority: task.priority,
        labelIds: task.labelIds ?? undefined,
        billingCode: task.billingCode ?? null,
        comments: comments.length > 0
          ? comments.map((comment) => ({
              body: comment.body,
              authorType: comment.authorType,
              authorAgentSlug: comment.authorAgentId ? (idToSlug.get(comment.authorAgentId) ?? null) : null,
              // Portable bundles preserve author kind, but not raw board user ids.
              authorUserId: null,
              presentation: comment.presentation,
              metadata: comment.metadata,
              createdAt: comment.createdAt instanceof Date
                ? comment.createdAt.toISOString()
                : new Date(comment.createdAt).toISOString(),
            }))
          : undefined,
      });
      if (isPlainRecord(extension) && task.disposition != null) {
        extension.disposition = decodeTaskDisposition(task.disposition);
      }
      paperclipTasksOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    for (const routine of selectedRoutineRows) {
      const taskSlug = taskSlugByRoutineId.get(routine.id)!;
      const projectSlug = routine.projectId ? (projectSlugById.get(routine.projectId) ?? null) : null;
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const ownerSlug = routine.assigneeAgentId ? (idToSlug.get(routine.assigneeAgentId) ?? null) : null;
      if (!ownerSlug) {
        throw unprocessable(
          `Routine ${routine.title} has no portable agent owner and cannot be exported`,
        );
      }
      files[taskPath] = buildMarkdown(
        {
          name: routine.title,
          project: projectSlug,
          owner: ownerSlug,
          recurring: true,
        },
        routine.description ?? "",
      );
      const taskExtension = stripEmptyValues({
        lifecycleStatus: "open",
        boardPresentationStatus: routine.status,
        priority: routine.priority !== "medium" ? routine.priority : undefined,
      });
      const routineExtension = stripEmptyValues({
        concurrencyPolicy: routine.concurrencyPolicy !== "coalesce_if_active" ? routine.concurrencyPolicy : undefined,
        catchUpPolicy: routine.catchUpPolicy !== "skip_missed" ? routine.catchUpPolicy : undefined,
        variables: (routine.variables ?? []).length > 0 ? routine.variables : undefined,
        triggers: routine.triggers.map((trigger) => stripEmptyValues({
          kind: trigger.kind,
          label: trigger.label ?? null,
          enabled: trigger.enabled ? undefined : false,
          cronExpression: trigger.kind === "schedule" ? trigger.cronExpression ?? null : undefined,
          timezone: trigger.kind === "schedule" ? trigger.timezone ?? null : undefined,
          signingMode: trigger.kind === "webhook" && trigger.signingMode !== "bearer" ? trigger.signingMode ?? null : undefined,
          replayWindowSec: trigger.kind === "webhook" && trigger.replayWindowSec !== 300
            ? trigger.replayWindowSec ?? null
            : undefined,
        })),
      });
      paperclipTasksOut[taskSlug] = isPlainRecord(taskExtension)
        ? taskExtension
        : {};
      paperclipRoutinesOut[taskSlug] = isPlainRecord(
        routineExtension,
      )
        ? routineExtension
        : {};
    }

    const paperclipExtensionPath = ".paperclip.yaml";
    const paperclipAgents = Object.fromEntries(
      Object.entries(paperclipAgentsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipProjects = Object.fromEntries(
      Object.entries(paperclipProjectsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipTasks = Object.fromEntries(
      Object.entries(paperclipTasksOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipRoutines = Object.fromEntries(
      Object.entries(paperclipRoutinesOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    files[paperclipExtensionPath] = buildYamlFile(
      {
        schema: "paperclip/v1",
        company: stripEmptyValues({
          brandColor: company.brandColor ?? null,
          logoPath: companyLogoPath,
          budgetCurrency: company.budgetCurrency,
          budgetMonthlyAmount: company.budgetMonthlyAmount,
          attachmentMaxBytes: company.attachmentMaxBytes,
          requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents ? true : undefined,
        }),
        sidebar: stripEmptyValues(sidebarOrder),
        agents: Object.keys(paperclipAgents).length > 0 ? paperclipAgents : undefined,
        projects: Object.keys(paperclipProjects).length > 0 ? paperclipProjects : undefined,
        tasks: Object.keys(paperclipTasks).length > 0 ? paperclipTasks : undefined,
        routines: Object.keys(paperclipRoutines).length > 0 ? paperclipRoutines : undefined,
      },
      {
        preserveEmptyStrings: true,
        preserveEmptyCollections: true,
        preserveNullKeys: ["structuredResult"],
      },
    );

    let finalFiles = filterExportFiles(files, input.selectedFiles, paperclipExtensionPath);
    let resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        companyId: company.id,
        companyName: company.name,
      },
    });
    resolved.manifest.includes = {
      company: resolved.manifest.company !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      tasks: resolved.manifest.tasks.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);

    // Generate org chart PNG from manifest agents
    if (resolved.manifest.agents.length > 0) {
      try {
        const orgNodes = buildOrgTreeFromManifest(resolved.manifest.agents);
        const pngBuffer = await renderOrgChartPng(orgNodes);
        finalFiles["images/org-chart.png"] = bufferToPortableBinaryFile(pngBuffer, "image/png");
      } catch {
        // Non-fatal: export still works without the org chart image
      }
    }

    if (!input.selectedFiles || input.selectedFiles.some((entry) => normalizePortablePath(entry) === "README.md")) {
      finalFiles["README.md"] = generateReadme(resolved.manifest, {
        companyName: company.name,
        companyDescription: company.description ?? null,
      });
    }

    resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        companyId: company.id,
        companyName: company.name,
      },
    });
    resolved.manifest.includes = {
      company: resolved.manifest.company !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      tasks: resolved.manifest.tasks.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);

    return {
      rootPath,
      manifest: resolved.manifest,
      files: finalFiles,
      warnings: resolved.warnings,
      paperclipExtensionPath,
    };
  }

  async function previewExport(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportPreviewResult> {
    const previewInput: CompanyPortabilityExport = {
      ...input,
      include: {
        ...input.include,
        tasks:
          input.include?.tasks
          ?? Boolean((input.tasks && input.tasks.length > 0) || (input.projectTasks && input.projectTasks.length > 0))
          ?? false,
      },
    };
    if (previewInput.include && previewInput.include.tasks === undefined) {
      previewInput.include.tasks = false;
    }
    const exported = await exportBundle(companyId, previewInput);
    return {
      ...exported,
      fileInventory: Object.keys(exported.files)
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => ({
          path: filePath,
          kind: classifyPortableFileKind(filePath),
        })),
      counts: {
        files: Object.keys(exported.files).length,
        agents: exported.manifest.agents.length,
        skills: exported.manifest.skills.length,
        projects: exported.manifest.projects.length,
        tasks: exported.manifest.tasks.length,
      },
    };
  }

  async function buildPreview(
    input: CompanyPortabilityPreview,
    options?: ImportPreviewOptions,
  ): Promise<ImportPlanInternal> {
    const mode = resolveImportMode(options);
    const requestedInclude = normalizeInclude(input.include);
    const source = applySelectedFilesToSource(await resolveSource(input.source), input.selectedFiles);
    const manifest = source.manifest;
    const include: CompanyPortabilityInclude = {
      company: requestedInclude.company && manifest.company !== null,
      agents: requestedInclude.agents && manifest.agents.length > 0,
      projects: requestedInclude.projects && manifest.projects.length > 0,
      tasks: requestedInclude.tasks && manifest.tasks.length > 0,
      skills: requestedInclude.skills && manifest.skills.length > 0,
    };
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    if (mode === "agent_safe" && collisionStrategy === "replace") {
      throw unprocessable("Safe import routes do not allow replace collision strategy.");
    }
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.company && !manifest.company) {
      errors.push("Manifest does not include company metadata.");
    }
    if (mode === "agent_safe") {
      errors.push(...collectAgentSafeImportPolicyErrors(manifest, include));
    }

    const selectedSlugs = include.agents
      ? (
          input.agents && input.agents !== "all"
            ? Array.from(new Set(input.agents))
            : manifest.agents.map((agent) => agent.slug)
        )
      : [];

    const selectedAgents = include.agents
      ? manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug))
      : [];
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }

    const adapterOverrides = input.adapterOverrides ?? {};
    for (const slug of Object.keys(adapterOverrides)) {
      if (!selectedAgents.some((agent) => agent.slug === slug)) {
        errors.push(
          `Adapter configuration targets an agent not selected for import: ${slug}.`,
        );
      }
    }
    for (const selectedAgent of selectedAgents) {
      const slug = selectedAgent.slug;
      const sourceRevision = selectedAgent.adapterRevision;
      const sourceAdapterType = asString(
        sourceRevision.adapterType,
      );
      const sourceAdapterConfig = isPlainRecord(
        sourceRevision.adapterConfig,
      )
        ? sourceRevision.adapterConfig
        : null;
      if (
        !isUuidLike(sourceRevision.sourceRevisionId) ||
        !sourceAdapterType ||
        !sourceAdapterConfig ||
        !isPlainRecord(sourceRevision.runtimeConfig)
      ) {
        errors.push(
          `Selected imported agent ${slug} has an incomplete canonical adapter revision.`,
        );
        continue;
      }
      const override = adapterOverrides[slug];
      if (!override) {
        errors.push(
          `Selected imported agent ${slug} requires an explicit target adapter override.`,
        );
        continue;
      }
      const effectiveAdapterConfig = { ...override.adapterConfig };
      const parsedAdapterConfig =
        portabilityAgentManifestEntrySchema.shape.adapterRevision.shape.adapterConfig.safeParse(
          effectiveAdapterConfig,
        );
      if (!parsedAdapterConfig.success) {
        errors.push(
          `Invalid adapter configuration for imported agent ${slug}: retired provider, environment, or authentication fields are forbidden.`,
        );
        continue;
      }
      try {
        await validateRegisteredAdapterRuntimeConfiguration({
          adapterType: override.adapterType,
          adapterConfig: parsedAdapterConfig.data,
        });
      } catch (error) {
        errors.push(
          `Invalid adapter configuration for imported agent ${slug}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (include.agents && selectedAgents.length === 0) {
      warnings.push("No agents selected for import.");
    }

    const availableSkillKeys = new Set(source.manifest.skills.map((skill) => skill.key));
    const availableSkillSlugs = new Map<string, CompanyPortabilitySkillManifestEntry[]>();
    for (const skill of source.manifest.skills) {
      const existing = availableSkillSlugs.get(skill.slug) ?? [];
      existing.push(skill);
      availableSkillSlugs.set(skill.slug, existing);
    }

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = readPortableTextFile(source.files, filePath);
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "agent") {
        warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
      }
      for (const skillRef of agent.skills) {
        const slugMatches = availableSkillSlugs.get(skillRef) ?? [];
        if (!availableSkillKeys.has(skillRef) && slugMatches.length !== 1) {
          warnings.push(`Agent ${agent.slug} references skill ${skillRef}, but that skill is not present in the package.`);
        }
      }
    }

    if (include.projects) {
      for (const project of manifest.projects) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(project.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for project ${project.slug}: ${project.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "project") {
          warnings.push(`Project markdown ${project.path} does not declare kind: project in frontmatter.`);
        }
      }
    }

    if (include.tasks) {
      for (const task of manifest.tasks) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(task.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for task ${task.slug}: ${task.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "task") {
          warnings.push(`Task markdown ${task.path} does not declare kind: task in frontmatter.`);
        }
        if (task.recurring) {
          if (!task.projectSlug) {
            errors.push(`Recurring task ${task.slug} must declare a project to import as a routine.`);
          }
          if (!task.ownerAgentSlug) {
            errors.push(`Recurring task ${task.slug} must declare an owner to import as a routine.`);
          }
          const resolvedRoutine =
            resolvePortableRoutineDefinition(task);
          warnings.push(...resolvedRoutine.warnings);
          errors.push(...resolvedRoutine.errors);
          if (
            task.lifecycleStatus !== "open" ||
            !ROUTINE_STATUSES.includes(
              task.boardPresentationStatus as (typeof ROUTINE_STATUSES)[number],
            )
          ) {
            errors.push(
              `Recurring task ${task.slug} requires lifecycleStatus=open and a canonical routine boardPresentationStatus.`,
            );
          }
        } else if (
          !TASK_STATUSES.includes(
            task.boardPresentationStatus as TaskStatus,
          )
        ) {
          errors.push(
            `Task ${task.slug} requires a canonical task boardPresentationStatus.`,
          );
        }
      }
    }

    for (const envInput of manifest.envInputs) {
      if (envInput.portability === "system_dependent") {
        const scope = envInput.projectSlug
          ? ` for project ${envInput.projectSlug}`
          : "";
        warnings.push(`Environment input ${envInput.key}${scope} is system-dependent and may need manual adjustment after import.`);
      }
    }

    let targetCompanyId: string | null = null;
    let targetCompanyName: string | null = null;

    if (input.target.mode === "existing_company") {
      const targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      targetCompanyId = targetCompany.id;
      targetCompanyName = targetCompany.name;
    }
    if (mode === "agent_safe" && include.projects && targetCompanyId) {
      for (const project of manifest.projects) {
        if (!project.env) continue;
        try {
          await secrets.normalizeEnvBindingsForPersistence(
            targetCompanyId,
            project.env,
            {
              strictMode: strictSecretsMode,
              fieldPath: `projects.${project.slug}.env`,
            },
          );
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    const agentPlans: CompanyPortabilityPreviewAgentPlan[] = [];
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingAgentIds = new Set<string>();
    const existingSlugs = new Set<string>();
    const projectPlans: CompanyPortabilityPreviewResult["plan"]["projectPlans"] = [];
    const taskPlans: CompanyPortabilityPreviewResult["plan"]["taskPlans"] = [];
    const existingProjectSlugToProject = new Map<string, { id: string; name: string }>();
    const existingProjectSlugs = new Set<string>();

    if (input.target.mode === "existing_company") {
      const existingAgents = await agents.list(input.target.companyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingAgentIds.add(existing.id);
        existingSlugs.add(slug);
      }
      const existingProjects = await projects.list(input.target.companyId);
      for (const existing of existingProjects) {
        if (!existingProjectSlugToProject.has(existing.urlKey)) {
          existingProjectSlugToProject.set(existing.urlKey, { id: existing.id, name: existing.name });
        }
        existingProjectSlugs.add(existing.urlKey);
      }

      const existingSkills = await companySkills.listFull(input.target.companyId);
      const existingSkillKeys = new Set(existingSkills.map((skill) => skill.key));
      const existingSkillSlugs = new Set(existingSkills.map((skill) => normalizeSkillSlug(skill.slug) ?? skill.slug));
      for (const skill of manifest.skills) {
        const skillSlug = normalizeSkillSlug(skill.slug) ?? skill.slug;
        if (existingSkillKeys.has(skill.key) || existingSkillSlugs.has(skillSlug)) {
          if (mode === "agent_safe") {
            warnings.push(`Existing skill "${skill.slug}" matched during safe import and will ${collisionStrategy === "skip" ? "be skipped" : "be renamed"} instead of overwritten.`);
          } else if (collisionStrategy === "replace") {
            warnings.push(`Existing skill "${skill.slug}" (${skill.key}) will be overwritten by import.`);
          }
        }
      }
    }

    for (const manifestAgent of selectedAgents) {
      if (
        manifestAgent.reportsToExistingAgentId
        && !existingAgentIds.has(manifestAgent.reportsToExistingAgentId)
      ) {
        errors.push(
          `Agent ${manifestAgent.slug} references existing manager id ${manifestAgent.reportsToExistingAgentId}, but that agent is not present in the target company.`,
        );
      }
      if (
        manifestAgent.reportsToExistingAgentSlug
        && !existingSlugToAgent.has(manifestAgent.reportsToExistingAgentSlug)
      ) {
        errors.push(
          `Agent ${manifestAgent.slug} references existing manager slug ${manifestAgent.reportsToExistingAgentSlug}, but that agent is not present in the target company.`,
        );
      }
      if (
        manifestAgent.reportsToSlug &&
        !selectedAgents.some(
          (candidate) =>
            candidate.slug === manifestAgent.reportsToSlug,
        ) &&
        !existingSlugToAgent.has(
          manifestAgent.reportsToSlug,
        )
      ) {
        errors.push(
          `Agent ${manifestAgent.slug} references unresolved manager ${manifestAgent.reportsToSlug}.`,
        );
      }
      const existing = existingSlugToAgent.get(manifestAgent.slug) ?? null;
      if (!existing) {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "create",
          plannedName: manifestAgent.name,
          existingAgentId: null,
          reason: null,
        });
        continue;
      }

      if (mode === "board_full" && collisionStrategy === "replace") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "update",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }

      if (collisionStrategy === "skip") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "skip",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }

      const renamed = uniqueNameBySlug(manifestAgent.name, existingSlugs);
      existingSlugs.add(normalizeAgentUrlKey(renamed) ?? manifestAgent.slug);
      agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: renamed,
        existingAgentId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }

    if (include.projects) {
      for (const manifestProject of manifest.projects) {
        const existing = existingProjectSlugToProject.get(manifestProject.slug) ?? null;
        if (!existing) {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "create",
            plannedName: manifestProject.name,
            existingProjectId: null,
            reason: null,
          });
          continue;
        }
        if (mode === "board_full" && collisionStrategy === "replace") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "update",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "skip",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; skip strategy.",
          });
          continue;
        }
        const renamed = uniqueProjectName(manifestProject.name, existingProjectSlugs);
        existingProjectSlugs.add(deriveProjectUrlKey(renamed, renamed));
        projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing slug matched; rename strategy.",
        });
      }
    }

    // Apply user-specified name overrides (keyed by slug)
    if (input.nameOverrides) {
      for (const ap of agentPlans) {
        const override = input.nameOverrides[ap.slug];
        if (override) {
          ap.plannedName = override;
        }
      }
      for (const pp of projectPlans) {
        const override = input.nameOverrides[pp.slug];
        if (override) {
          pp.plannedName = override;
        }
      }
      for (const ip of taskPlans) {
        const override = input.nameOverrides[ip.slug];
        if (override) {
          ip.plannedTitle = override;
        }
      }
    }

    // Warn about agents that will be overwritten/updated
    for (const ap of agentPlans) {
      if (ap.action === "update") {
        warnings.push(`Existing agent "${ap.plannedName}" (${ap.slug}) will be overwritten by import.`);
      }
    }

    // Warn about projects that will be overwritten/updated
    for (const pp of projectPlans) {
      if (pp.action === "update") {
        warnings.push(`Existing project "${pp.plannedName}" (${pp.slug}) will be overwritten by import.`);
      }
    }

    if (include.tasks) {
      for (const manifestTask of manifest.tasks) {
        taskPlans.push({
          slug: manifestTask.slug,
          action: "create",
          plannedTitle: portableTaskDisplayLabel(manifestTask),
          reason: manifestTask.recurring ? "Recurring task will be imported as a routine." : null,
        });
      }
    }

    const preview: CompanyPortabilityPreviewResult = {
      include,
      targetCompanyId,
      targetCompanyName,
      collisionStrategy,
      selectedAgentSlugs: selectedAgents.map((agent) => agent.slug),
      plan: {
        companyAction: input.target.mode === "new_company"
          ? "create"
          : include.company && mode === "board_full"
            ? "update"
            : "none",
        agentPlans,
        projectPlans,
        taskPlans,
      },
      manifest,
      files: source.files,
      envInputs: manifest.envInputs ?? [],
      warnings,
      errors,
    };

    return {
      preview,
      source,
      include,
      collisionStrategy,
      selectedAgents,
    };
  }

  async function previewImport(
    input: CompanyPortabilityPreview,
    options?: ImportPreviewOptions,
  ): Promise<CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(input, options);
    return plan.preview;
  }

  async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
    options: ImportApplyOptions,
  ): Promise<CompanyPortabilityImportResult> {
    const secretMutationActor = options.secretMutationActor;
    requireSecretMutationActor(secretMutationActor);
    const mode = resolveImportMode(options);
    const plan = await buildPreview(input, options);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }
    if (
      mode === "agent_safe"
      && (
        plan.preview.plan.companyAction === "update"
        || plan.preview.plan.agentPlans.some((entry) => entry.action === "update")
        || plan.preview.plan.projectPlans.some((entry) => entry.action === "update")
      )
    ) {
      throw unprocessable("Safe import routes only allow create or skip actions.");
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;
    const boardAuthorization =
      options.authorizationActor?.type === "board"
        ? options.authorizationActor
        : null;
    if (include.agents && !boardAuthorization) {
      throw unprocessable(
        "Importing agents requires board authorization context.",
      );
    }
    const boardActor = boardAuthorization
      ? {
          kind: "board" as const,
          actorId:
            asString(actorUserId)
            ?? asString(boardAuthorization.userId)
            ?? "board",
          authorization: boardAuthorization,
        }
      : null;

    let targetCompany: {
      id: string;
      name: string;
      requireBoardApprovalForNewAgents?: boolean | null;
      attachmentMaxBytes?: number | null;
    } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_company") {
      if (mode === "agent_safe" && !options?.sourceCompanyId) {
        throw unprocessable("Safe new-company imports require a source company context.");
      }
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        const sourceMemberships = await access.listActiveUserMemberships(options.sourceCompanyId);
        if (sourceMemberships.length === 0) {
          throw unprocessable("Safe new-company import requires at least one active user membership on the source company.");
        }
      }
      const companyName =
        asString(input.target.newCompanyName) ??
        sourceManifest.company?.name ??
        sourceManifest.source?.companyName ??
        "Imported Company";
      const created = await companies.create({
        name: companyName,
        description: include.company ? (sourceManifest.company?.description ?? null) : null,
        budgetCurrency: include.company
          ? sourceManifest.company?.budgetCurrency
          : undefined,
        budgetMonthlyAmount: include.company
          ? sourceManifest.company?.budgetMonthlyAmount
          : undefined,
        brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
        attachmentMaxBytes: include.company
          ? (sourceManifest.company?.attachmentMaxBytes ?? undefined)
          : undefined,
        requireBoardApprovalForNewAgents: include.company
          ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? false)
          : false,
      }, actorUserId ?? null);
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        await access.copyActiveUserMemberships(options.sourceCompanyId, created.id);
      } else {
        const ownerPrincipalId = actorUserId ?? "board";
        await access.ensureMembership(created.id, "user", ownerPrincipalId, "owner", "active");
        await access.stampRoleGrants(
          created.id,
          ownerPrincipalId,
          "owner",
          actorUserId ?? null,
        );
      }
      targetCompany = created;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company && mode === "board_full") {
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          brandColor: sourceManifest.company.brandColor,
          attachmentMaxBytes: sourceManifest.company.attachmentMaxBytes ?? undefined,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    const importedProjectEnvSlugs = new Set(
      plan.preview.plan.projectPlans
        .filter((entry) => entry.action !== "skip")
        .map((entry) => entry.slug),
    );
    const importEnvInputs = (sourceManifest.envInputs ?? []).filter((inputValue) => {
      if (inputValue.projectSlug) {
        return include.projects && importedProjectEnvSlugs.has(inputValue.projectSlug);
      }
      return true;
    });
    const createdImportSecretIds: string[] = [];
    try {
      await materializeImportEnvInputValues(
        targetCompany.id,
        sourceManifest,
        importEnvInputs,
        input.secretValues,
        secretMutationActor,
        createdImportSecretIds,
      );

      if (include.company) {
        const logoPath = sourceManifest.company?.logoPath ?? null;
        if (!logoPath) {
          const cleared = await companies.update(targetCompany.id, { logoAssetId: null });
          targetCompany = cleared ?? targetCompany;
        } else {
          const logoFile = plan.source.files[logoPath];
          if (!logoFile) {
            warnings.push(`Skipped company logo import because ${logoPath} is missing from the package.`);
          } else if (!storage) {
            warnings.push("Skipped company logo import because storage is unavailable.");
          } else {
            const contentType = isPortableBinaryFile(logoFile)
              ? (logoFile.contentType ?? inferContentTypeFromPath(logoPath))
              : inferContentTypeFromPath(logoPath);
            if (!contentType || !COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType]) {
              warnings.push(`Skipped company logo import for ${logoPath} because the file type is unsupported.`);
            } else {
              try {
                const body = portableFileToBuffer(logoFile, logoPath);
                const stored = await storage.putFile({
                  companyId: targetCompany.id,
                  namespace: "assets/companies",
                  originalFilename: path.posix.basename(logoPath),
                  contentType,
                  body,
                });
                const createdAsset = await assetRecords.create(targetCompany.id, {
                  provider: stored.provider,
                  objectKey: stored.objectKey,
                  contentType: stored.contentType,
                  byteSize: stored.byteSize,
                  sha256: stored.sha256,
                  originalFilename: stored.originalFilename,
                  createdByAgentId: null,
                  createdByUserId: actorUserId ?? null,
                });
                const updated = await companies.update(targetCompany.id, {
                  logoAssetId: createdAsset.id,
                });
                targetCompany = updated ?? targetCompany;
              } catch (err) {
                warnings.push(`Failed to import company logo ${logoPath}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      }

      const resultAgents: CompanyPortabilityImportResult["agents"] = [];
      const resultProjects: CompanyPortabilityImportResult["projects"] = [];
      const importedSlugToAgentId = new Map<string, string>();
      const existingSlugToAgentId = new Map<string, string>();
      const preImportExistingSlugToAgentId = new Map<string, string>();
      const preImportExistingAgentIds = new Set<string>();
      const agentStatusById = new Map<string, string | null | undefined>();
      const existingAgents = await agents.list(targetCompany.id);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        existingSlugToAgentId.set(slug, existing.id);
        preImportExistingSlugToAgentId.set(slug, existing.id);
        preImportExistingAgentIds.add(existing.id);
        agentStatusById.set(existing.id, existing.status);
      }
      const importedSlugToProjectId = new Map<string, string>();
      const existingProjectSlugToId = new Map<string, string>();
      const existingProjects = await projects.list(targetCompany.id);
      for (const existing of existingProjects) {
        existingProjectSlugToId.set(existing.urlKey, existing.id);
      }

      const importedSkills = include.skills || include.agents
        ? await companySkills.importPackageFiles(targetCompany.id, pickTextFiles(plan.source.files), {
            onConflict: resolveSkillConflictStrategy(mode, plan.collisionStrategy),
          })
        : [];
      const selectedCompanySkillRefMap = new Map<string, string>();
      for (const importedSkill of importedSkills) {
        selectedCompanySkillRefMap.set(
          importedSkill.originalKey,
          importedSkill.skill.key,
        );
        selectedCompanySkillRefMap.set(
          importedSkill.originalSlug,
          importedSkill.skill.key,
        );
        if (importedSkill.action === "skipped") {
          warnings.push(`Skipped skill ${importedSkill.originalSlug}; existing skill ${importedSkill.skill.slug} was kept.`);
        } else if (importedSkill.originalKey !== importedSkill.skill.key) {
          warnings.push(`Imported skill ${importedSkill.originalSlug} as ${importedSkill.skill.slug} to avoid overwriting an existing skill.`);
        }
      }

      if (include.agents) {
        for (const planAgent of plan.preview.plan.agentPlans) {
          const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
          if (!manifestAgent) continue;
          if (planAgent.action === "skip") {
            resultAgents.push({
              slug: planAgent.slug,
              id: planAgent.existingAgentId,
              action: "skipped",
              name: planAgent.plannedName,
              reason: planAgent.reason,
            });
            continue;
          }

          const adapterOverride = input.adapterOverrides?.[planAgent.slug];
          if (!adapterOverride) {
            throw unprocessable(
              `Selected imported agent ${planAgent.slug} requires an explicit target adapter override.`,
            );
          }

          const selectedCompanySkillKeys = (manifestAgent.skills ?? []).map(
            (skillRef) =>
              selectedCompanySkillRefMap.get(skillRef) ?? skillRef,
          );
          const selectedCompanySkillEntries = (
            await companySkills.resolveRequestedSkillEntries(
              targetCompany.id,
              selectedCompanySkillKeys,
            )
          ).resolved;
          const normalizedAdapter = adapterOverride
            ? await prepareImportedAgentAdapter(
              adapterOverride.adapterType,
              { ...adapterOverride.adapterConfig },
            )
            : null;
          if (!boardActor) {
            throw unprocessable(
              "Importing agents requires board authorization context.",
            );
          }

          let importedAgentId: string;
          let importedAction: "created" | "updated";
          if (
            planAgent.action === "update"
            && planAgent.existingAgentId
          ) {
            await runtimeAgentConfigurations.update({
              companyId: targetCompany.id,
              targetAgentId: planAgent.existingAgentId,
              actor: boardActor,
              source: "board",
              configuration: {
                name: planAgent.plannedName,
                title: manifestAgent.title,
                capabilities: manifestAgent.capabilities,
                reportsTo: null,
                contextGrants: manifestAgent.contextGrants,
                actionGrants: manifestAgent.actionGrants,
                mentionReachGrants:
                  manifestAgent.mentionReachGrants,
              },
            });
            importedAgentId = planAgent.existingAgentId;
            importedAction = "updated";
          } else {
            const identity =
              await runtimeAgentConfigurations.create({
                companyId: targetCompany.id,
                actor: boardActor,
                source: "board",
                configuration: {
                  name: planAgent.plannedName,
                  title: manifestAgent.title,
                  capabilities: manifestAgent.capabilities,
                  reportsTo: null,
                  contextGrants: manifestAgent.contextGrants,
                  actionGrants: manifestAgent.actionGrants,
                  mentionReachGrants:
                    manifestAgent.mentionReachGrants,
                },
              });
            importedAgentId = identity.agentId;
            importedAction = "created";
          }

          await operationalConfigurations.update({
            companyId: targetCompany.id,
            agentId: importedAgentId,
            actorUserId: actorUserId ?? null,
            configuration: {
              icon: manifestAgent.icon,
              budgetMonthlyAmount:
                manifestAgent.budgetMonthlyAmount,
            },
          });
          if (normalizedAdapter && adapterOverride) {
            const importedPins =
              selectedCompanySkillEntries.map((entry) => ({
                key: entry.key,
                versionId: entry.versionId,
              }));
            await adapterConfigurations.createRevision({
              companyId: targetCompany.id,
              agentId: importedAgentId,
              configuration: {
                adapterType: normalizedAdapter.adapterType,
                adapterConfig: normalizedAdapter.adapterConfig,
                runtimeConfig:
                  normalizeImportedRuntimeConfig(
                    manifestAgent.adapterRevision
                      .runtimeConfig,
                  ),
                companySkillPins: importedPins,
              },
              actor: secretMutationActor,
            });
          }
          const importedAgent =
            await agents.getById(importedAgentId);
          if (!importedAgent) {
            throw unprocessable(
              `Imported agent ${planAgent.slug} could not be loaded after configuration.`,
            );
          }
          await access.ensureMembership(
            targetCompany.id,
            "agent",
            importedAgent.id,
            "member",
            "active",
          );
          await applyImportedAgentPermissionGrants(
            targetCompany.id,
            importedAgent.id,
            manifestAgent.permissionGrants ?? [],
            actorUserId ?? null,
          );
          agentStatusById.set(
            importedAgent.id,
            importedAgent.status ?? "idle",
          );
          importedSlugToAgentId.set(
            planAgent.slug,
            importedAgent.id,
          );
          existingSlugToAgentId.set(
            normalizeAgentUrlKey(importedAgent.name)
              ?? importedAgent.id,
            importedAgent.id,
          );
          resultAgents.push({
            slug: planAgent.slug,
            id: importedAgent.id,
            action: importedAction,
            name: importedAgent.name,
            reason: planAgent.reason,
          });
        }

        // Apply reporting links once all imported agent ids are available.
        for (const manifestAgent of plan.selectedAgents) {
          const agentId = importedSlugToAgentId.get(manifestAgent.slug);
          if (!agentId) continue;
          const managerSlug = manifestAgent.reportsToSlug;
          let existingManagerId: string | null = null;
          if (
            manifestAgent.reportsToExistingAgentId
            && preImportExistingAgentIds.has(manifestAgent.reportsToExistingAgentId)
          ) {
            existingManagerId = manifestAgent.reportsToExistingAgentId;
          } else if (manifestAgent.reportsToExistingAgentSlug) {
            existingManagerId =
              preImportExistingSlugToAgentId.get(manifestAgent.reportsToExistingAgentSlug) ?? null;
          }
          if (!managerSlug && !existingManagerId) continue;
          const managerId =
            existingManagerId
            ?? (managerSlug
              ? importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null
              : null);
          if (!managerId || managerId === agentId) continue;
          try {
            if (!boardActor) {
              throw unprocessable(
                "Importing agent reporting lines requires board authorization context.",
              );
            }
            await runtimeAgentConfigurations.update({
              companyId: targetCompany.id,
              targetAgentId: agentId,
              actor: boardActor,
              source: "board",
              configuration: { reportsTo: managerId },
            });
          } catch (error) {
            const managerRef =
              managerSlug
              ?? manifestAgent.reportsToExistingAgentSlug
              ?? manifestAgent.reportsToExistingAgentId;
            throw unprocessable(
              `Could not assign manager ${managerRef} for imported agent ${manifestAgent.slug}: ${
                error instanceof Error
                  ? error.message
                  : String(error)
              }`,
            );
          }
        }
      }

      if (include.projects) {
        for (const planProject of plan.preview.plan.projectPlans) {
          const manifestProject = sourceManifest.projects.find((project) => project.slug === planProject.slug);
          if (!manifestProject) continue;
          if (planProject.action === "skip") {
            resultProjects.push({
              slug: planProject.slug,
              id: planProject.existingProjectId,
              action: "skipped",
              name: planProject.plannedName,
              reason: planProject.reason,
            });
            continue;
          }

          const projectLeadAgentId = manifestProject.leadAgentSlug
            ? importedSlugToAgentId.get(manifestProject.leadAgentSlug)
              ?? existingSlugToAgentId.get(manifestProject.leadAgentSlug)
              ?? null
            : null;
          const normalizedProjectEnv = manifestProject.env
            ? await secrets.normalizeEnvBindingsForPersistence(
                targetCompany.id,
                manifestProject.env,
                {
                  strictMode: strictSecretsMode,
                  fieldPath: `projects.${manifestProject.slug}.env`,
                },
              )
            : null;
          const projectPatch = {
            name: planProject.plannedName,
            description: manifestProject.description,
            leadAgentId: projectLeadAgentId,
            targetDate: manifestProject.targetDate,
            color: manifestProject.color,
            icon: normalizeProjectIconName(manifestProject.icon),
            status: manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
              ? manifestProject.status as typeof PROJECT_STATUSES[number]
              : "backlog",
            env: normalizedProjectEnv,
          };

          let projectId: string | null = null;
          if (planProject.action === "update" && planProject.existingProjectId) {
            const updated = await projects.update(planProject.existingProjectId, projectPatch);
            if (!updated) {
              warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
              resultProjects.push({
                slug: planProject.slug,
                id: null,
                action: "skipped",
                name: planProject.plannedName,
                reason: "Existing target project not found.",
              });
              continue;
            }
            projectId = updated.id;
            importedSlugToProjectId.set(planProject.slug, updated.id);
            existingProjectSlugToId.set(updated.urlKey, updated.id);
            resultProjects.push({
              slug: planProject.slug,
              id: updated.id,
              action: "updated",
              name: updated.name,
              reason: planProject.reason,
            });
          } else {
            const created = await projects.create(targetCompany.id, projectPatch);
            projectId = created.id;
            importedSlugToProjectId.set(planProject.slug, created.id);
            existingProjectSlugToId.set(created.urlKey, created.id);
            resultProjects.push({
              slug: planProject.slug,
              id: created.id,
              action: "created",
              name: created.name,
              reason: planProject.reason,
            });
          }

          if (!projectId) continue;

          await secrets.syncEnvBindingsForTarget(
            targetCompany.id,
            { targetType: "project", targetId: projectId },
            normalizedProjectEnv ?? {},
            { actor: secretMutationActor },
          );
        }
      }

      if (include.tasks) {
        const routines = routineService(db, { ordinaryTasks });
        for (const manifestTask of sourceManifest.tasks) {
          const markdownRaw = readPortableTextFile(plan.source.files, manifestTask.path);
          const parsed = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : null;
          const request = parsed?.body || manifestTask.request;
          const ownerAgentId = resolveImportedOwnerAgentId(
            manifestTask.ownerAgentSlug,
            importedSlugToAgentId,
            existingSlugToAgentId,
            agentStatusById,
            warnings,
            `Task ${manifestTask.slug}`,
          );
          const projectId = manifestTask.projectSlug
            ? importedSlugToProjectId.get(manifestTask.projectSlug)
              ?? existingProjectSlugToId.get(manifestTask.projectSlug)
              ?? null
            : null;
          if (manifestTask.recurring) {
            if (!projectId) {
              throw unprocessable(`Recurring task ${manifestTask.slug} is missing the project required to create a routine.`);
            }
            const resolvedRoutine =
              resolvePortableRoutineDefinition(manifestTask);
            if (resolvedRoutine.errors.length > 0) {
              throw unprocessable(`Recurring task ${manifestTask.slug} could not be imported as a routine: ${resolvedRoutine.errors.join("; ")}`);
            }
            warnings.push(...resolvedRoutine.warnings);
            const routineDefinition = resolvedRoutine.routine ?? {
              concurrencyPolicy: null,
              catchUpPolicy: null,
              variables: null,
              triggers: [],
            };
            const createdRoutine = await routines.create(targetCompany.id, {
              projectId,
              goalId: null,
              parentTaskId: null,
              title: portableTaskDisplayLabel(manifestTask),
              description: request,
              assigneeAgentId: ownerAgentId,
              priority: manifestTask.priority && TASK_PRIORITIES.includes(manifestTask.priority as any)
                ? manifestTask.priority as typeof TASK_PRIORITIES[number]
                : "medium",
              status: manifestTask
                .boardPresentationStatus as (typeof ROUTINE_STATUSES)[number],
              concurrencyPolicy:
                routineDefinition.concurrencyPolicy && ROUTINE_CONCURRENCY_POLICIES.includes(routineDefinition.concurrencyPolicy as any)
                  ? routineDefinition.concurrencyPolicy as typeof ROUTINE_CONCURRENCY_POLICIES[number]
                  : "coalesce_if_active",
              catchUpPolicy:
                routineDefinition.catchUpPolicy && ROUTINE_CATCH_UP_POLICIES.includes(routineDefinition.catchUpPolicy as any)
                  ? routineDefinition.catchUpPolicy as typeof ROUTINE_CATCH_UP_POLICIES[number]
                  : "skip_missed",
              variables: routineDefinition.variables ?? [],
            }, secretMutationActor);
            for (const trigger of routineDefinition.triggers) {
              if (trigger.kind === "schedule") {
                await routines.createTrigger(createdRoutine.id, {
                  kind: "schedule",
                  label: trigger.label,
                  enabled: trigger.enabled,
                  cronExpression: trigger.cronExpression!,
                  timezone: trigger.timezone!,
                }, secretMutationActor);
                continue;
              }
              if (trigger.kind === "webhook") {
                await routines.createTrigger(createdRoutine.id, {
                  kind: "webhook",
                  label: trigger.label,
                  enabled: trigger.enabled,
                  signingMode:
                    trigger.signingMode && ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)
                      ? trigger.signingMode as typeof ROUTINE_TRIGGER_SIGNING_MODES[number]
                      : "bearer",
                  replayWindowSec: trigger.replayWindowSec ?? 300,
                }, secretMutationActor);
                continue;
              }
              await routines.createTrigger(createdRoutine.id, {
                kind: "api",
                label: trigger.label,
                enabled: trigger.enabled,
              }, secretMutationActor);
            }
            continue;
          }
          if (!actorUserId) {
            throw unprocessable(
              `Task ${manifestTask.slug} requires a named importing board user`,
            );
          }
          if (!ownerAgentId) {
            throw unprocessable(
              `Task ${manifestTask.slug} requires an invokable owner that exists in the target company`,
            );
          }
          const priority =
            manifestTask.priority &&
            TASK_PRIORITIES.includes(manifestTask.priority as any)
              ? manifestTask.priority as typeof TASK_PRIORITIES[number]
              : "medium";
          if (
            !TASK_STATUSES.includes(
              manifestTask.boardPresentationStatus as TaskStatus,
            )
          ) {
            throw unprocessable(
              `Task ${manifestTask.slug} requires a canonical task boardPresentationStatus`,
            );
          }
          const boardPresentationStatus =
            manifestTask.boardPresentationStatus as TaskStatus;
          const createdTaskResult =
            manifestTask.lifecycleStatus === "open" &&
            boardPresentationStatus === "todo"
              ? await ordinaryTasks.create({
                  companyId: targetCompany.id,
                  request,
                  ownerAgentId,
                  creator: {
                    kind: "user/board",
                    userId: actorUserId,
                  },
                  idempotencyKey:
                    `company-portability:${targetCompany.id}:${manifestTask.slug}`,
                  sourceKind: "task_request",
                  projectId,
                  title: manifestTask.title,
                  priority,
                  labelIds: manifestTask.labelIds ?? [],
                  billingCode: manifestTask.billingCode,
                })
              : await createPortableCanonicalTask(db, {
                  companyId: targetCompany.id,
                  slug: manifestTask.slug,
                  request,
                  title: manifestTask.title,
                  ownerAgentId,
                  creatorUserId: actorUserId,
                  projectId,
                  lifecycleStatus: manifestTask.lifecycleStatus,
                  boardPresentationStatus,
                  disposition: manifestTask.disposition,
                  priority,
                  labelIds: manifestTask.labelIds ?? [],
                  billingCode: manifestTask.billingCode,
                });
          const createdTask = createdTaskResult.task;
          for (const [commentIndex, comment] of (manifestTask.comments ?? []).entries()) {
            if (comment.authorType === "agent") {
              warnings.push(
                `Comment on task ${manifestTask.slug} from agent ${comment.authorAgentSlug ?? "<unknown>"} was imported with system provenance because the portable comment does not include the producing run and adapter revision required for canonical agent attribution.`,
              );
            }
            if (comment.authorType === "user" && !actorUserId) {
              warnings.push(`Comment on task ${manifestTask.slug} was imported as a system comment because no importing user was available.`);
            }
            const authorType =
              comment.authorType === "user" && actorUserId
                ? "user"
                : "system";
            const sourceKey = createHash("sha256")
              .update(JSON.stringify({
                taskSlug: manifestTask.slug,
                commentIndex,
                body: comment.body,
                authorType,
                authorAgentSlug:
                  comment.authorType === "agent"
                    ? comment.authorAgentSlug
                    : null,
                userId: authorType === "user" ? actorUserId : null,
                createdAt: comment.createdAt,
              }))
              .digest("hex");
            if (authorType === "user" && actorUserId) {
              await appendCanonicalUserComment(db, {
                companyId: targetCompany.id,
                taskId: createdTask.id,
                sourceKind: "company_portability_import",
                immutableSourceKey: sourceKey,
                sourceRecordId: sourceKey,
                exactText: comment.body,
                userId: actorUserId,
                occurredAt: comment.createdAt,
              });
            } else {
              await appendCanonicalControlNotice(db, {
                companyId: targetCompany.id,
                taskId: createdTask.id,
                sourceKind: "company_portability_import",
                immutableSourceKey: sourceKey,
                sourceRecordId: sourceKey,
                exactText: comment.body,
                comment: {
                  author: { kind: "system", source: "control" },
                  producingRun: null,
                },
                occurredAt: comment.createdAt,
                allowTerminal: true,
              });
            }
          }
        }
      }

      return {
        company: {
          id: targetCompany.id,
          name: targetCompany.name,
          action: companyAction,
        },
        agents: resultAgents,
        projects: resultProjects,
        envInputs: sourceManifest.envInputs ?? [],
        warnings,
      };
    } catch (error) {
      for (const secretId of createdImportSecretIds) {
        await secrets.remove(secretId, secretMutationActor).catch(() => undefined);
      }
      throw error;
    }
  }

  return {
    exportBundle,
    previewExport,
    previewImport,
    importBundle,
  };
}
