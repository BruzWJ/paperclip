import {
  PROJECT_ICON_NAMES,
  envConfigSchema,
  type AgentEnvConfig,
  type CompanyPortabilityAgentManifestEntry,
  type CompanyPortabilityCollisionStrategy,
  type CompanyPortabilityEnvInput,
  type CompanyPortabilityExportPreviewResult,
  type CompanyPortabilityFileEntry,
  type CompanyPortabilityInclude,
  type CompanyPortabilityManifest,
  type CompanyPortabilityPreviewResult,
  type CompanyPortabilityTaskManifestEntry,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { type OrgNode } from "../routes/org-chart-svg.js";
import { routineService } from "./routines.js";
import { type SecretMutationActor } from "./secrets.js";
import { requirePortablePath } from "./portable-path.js";
import { isAbsoluteCommand } from "./company-portability-format-support.js";
import { isPlainRecord, asString } from "./company-portability-format-support.js";

export /** Build OrgNode tree from manifest agent list (slug + reportsToSlug). */
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
      status: "idle",
      reports: build(m.slug),
    }));
  };
  // Find roots: agents whose reportsToSlug is null or points to a non-existent slug
  const roots = agents.filter((a) => !a.reportsToSlug || !bySlug.has(a.reportsToSlug));
  // Start from null parent, but also include orphans
  const tree = build(null);
  for (const root of roots) {
    if (root.reportsToSlug && !bySlug.has(root.reportsToSlug)) {
      // Orphan root (parent slug doesn't exist)
      tree.push({
        id: root.slug,
        name: root.name,
        subtitle: root.title ?? "",
        status: "idle",
        reports: build(root.slug),
      });
    }
  }
  return tree;
}

export const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: false,
  tasks: false,
};

export const DEFAULT_COLLISION_STRATEGY: CompanyPortabilityCollisionStrategy = "rename";

export function resolveImportMode(options?: ImportPreviewOptions): ImportMode {
  return options?.mode ?? "board_full";
}

export function collectAgentSafeImportPolicyErrors(
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

export function classifyPortableFileKind(
  pathValue: string,
): CompanyPortabilityExportPreviewResult["fileInventory"][number]["kind"] {
  const filePath = requirePortablePath(pathValue, "Export file path");
  if (filePath === "COMPANY.md") return "company";
  if (filePath === ".paperclip.yaml" || filePath === ".paperclip.yml") return "extension";
  if (filePath === "README.md") return "readme";
  if (filePath.startsWith("agents/")) return "agent";
  if (filePath.startsWith("projects/")) return "project";
  if (filePath.startsWith("tasks/")) return "task";
  return "other";
}

export function isSensitiveEnvKey(key: string) {
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

export function normalizePortableProjectEnv(value: unknown): AgentEnvConfig | null {
  const parsed = envConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parsePortableProjectIcon(
  value: unknown,
  projectSlug: string,
): (typeof PROJECT_ICON_NAMES)[number] | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" &&
    PROJECT_ICON_NAMES.includes(value as (typeof PROJECT_ICON_NAMES)[number])
  ) {
    return value as (typeof PROJECT_ICON_NAMES)[number];
  }
  throw unprocessable(`Project ${projectSlug} icon must be an exact canonical project icon name or null`);
}

export function extractPortableProjectEnvInputs(
  projectSlug: string,
  envValue: unknown,
  warnings: string[],
): CompanyPortabilityEnvInput[] {
  if (!isPlainRecord(envValue)) return [];
  const env = envValue as Record<string, unknown>;
  const inputs: CompanyPortabilityEnvInput[] = [];

  for (const [key, binding] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      warnings.push(
        `Project ${projectSlug} PATH override was omitted from export because it is system-dependent.`,
      );
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
      const portability = defaultValue && isAbsoluteCommand(defaultValue) ? "system_dependent" : "portable";
      if (portability === "system_dependent") {
        warnings.push(`Project ${projectSlug} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on project ${projectSlug}`,
        projectSlug,
        kind: isSensitive ? "secret" : "plain",
        requirement: "optional",
        defaultValue: isSensitive ? "" : (defaultValue ?? ""),
        portability,
      });
      continue;
    }
  }

  return inputs;
}

export type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  warnings: string[];
};

export type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

export type CompanyPackageIncludeEntry = {
  path: string;
};

export const PAPERCLIP_EXTENSION_KEYS = [
  "schema",
  "company",
  "sidebar",
  "agents",
  "projects",
  "tasks",
  "routines",
] as const;

export const PORTABLE_COMPANY_EXTENSION_KEYS = [
  "brandColor",
  "logoPath",
  "budgetCurrency",
  "budgetMonthlyAmount",
  "attachmentMaxBytes",
  "requireBoardApprovalForNewAgents",
] as const;

export const PORTABLE_AGENT_EXTENSION_KEYS = [
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

export const PORTABLE_AGENT_FRONTMATTER_KEYS = ["name", "title", "slug", "kind", "reportsTo"] as const;

export const PORTABLE_TASK_EXTENSION_KEYS = [
  "lifecycleStatus",
  "disposition",
  "boardPresentationStatus",
  "priority",
  "labelIds",
  "billingCode",
  "comments",
  "metadata",
] as const;

export const PORTABLE_TASK_FRONTMATTER_KEYS = [
  "name",
  "title",
  "slug",
  "kind",
  "project",
  "owner",
  "recurring",
] as const;

export type TaskLike = {
  id: string;
  identifier: string;
  title: string | null;
  request: string | null;
  projectId: string | null;
  ownerAgentId: string | null;
  status: string;
  priority: string;
  labelIds?: string[];
  billingCode: string | null;
};

export function taskDisplayLabel(task: Pick<TaskLike, "id" | "identifier" | "title">) {
  if (task.title) return task.title;
  return task.identifier;
}

export function portableTaskDisplayLabel(task: CompanyPortabilityTaskManifestEntry) {
  if (task.title) return task.title;
  return task.slug;
}

export type RoutineLike = NonNullable<Awaited<ReturnType<ReturnType<typeof routineService>["getDetail"]>>>;

export type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
};

export type ImportMode = "board_full" | "agent_safe";

export type ImportPreviewOptions = {
  mode?: ImportMode;
  sourceCompanyId?: string | null;
  authorizationActor?: AuthorizationActor;
};

export type ImportApplyOptions = ImportPreviewOptions & {
  secretMutationActor: SecretMutationActor;
};

export type EnvInputRecord = {
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  default?: string | null;
  description?: string | null;
  portability?: "portable" | "system_dependent";
};

export const COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
};

export const COMPANY_LOGO_FILE_NAME = "company-logo";
