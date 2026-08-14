import path from "node:path";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  isCanonicalUuid,
  portabilityAgentManifestEntrySchema,
  type CompanyPortabilityFileEntry,
  type CompanyPortabilityManifest,
  type CompanyPortabilityTaskManifestEntry,
} from "@paperclipai/shared";
import { parseCanonicalGithubImportSourceUrl } from "@paperclipai/shared/company-portability-source";
import { unprocessable } from "../errors.js";
import { resolvePortablePath } from "./portable-path.js";
import { isCanonicalSlug } from "./slug.js";
import {
  normalizePortableProjectEnv,
  parsePortableProjectIcon,
  type ResolvedSource,
  PAPERCLIP_EXTENSION_KEYS,
  PORTABLE_COMPANY_EXTENSION_KEYS,
  PORTABLE_AGENT_EXTENSION_KEYS,
  PORTABLE_AGENT_FRONTMATTER_KEYS,
  PORTABLE_TASK_EXTENSION_KEYS,
  PORTABLE_TASK_FRONTMATTER_KEYS,
  type MarkdownDoc,
} from "./company-portability-manifest-types.js";
import {
  isPlainRecord,
  asString,
  readOptionalPortablePath,
  portableBudgetCurrency,
  portableMoneyAmount,
  asBoolean,
  normalizePortableDisposition,
} from "./company-portability-format-support.js";
import {
  normalizePortablePermissionGrants,
  hasOwn,
  assertExactPortableKeys,
  parseExactPortableBooleanMap,
  readPortableTaskComments,
  normalizeRoutineExtension,
} from "./company-portability-extension-parser.js";
import {
  readPortableTextFile,
  validateFileMap,
  normalizePortableSidebarOrder,
  findPaperclipExtensionPath,
} from "./company-portability-selection.js";
import { parseYamlFile, parseFrontmatterMarkdown } from "./company-portability-yaml-codec.js";
import {
  dedupeEnvInputs,
  readCompanyApprovalDefault,
  readIncludeEntries,
  readProjectEnvInputs,
} from "./company-portability-format-support.js";

export function buildManifestFromPackageFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  opts?: { sourceLabel?: { companyId: string; companyName: string } | null },
): ResolvedSource {
  const validatedFiles = validateFileMap(files);
  const companyPath =
    typeof validatedFiles["COMPANY.md"] === "string" ? validatedFiles["COMPANY.md"] : undefined;
  const resolvedCompanyPath =
    companyPath !== undefined
      ? "COMPANY.md"
      : Object.keys(validatedFiles).find((entry) => entry.endsWith("/COMPANY.md") || entry === "COMPANY.md");
  if (!resolvedCompanyPath) {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const companyMarkdown = readPortableTextFile(validatedFiles, resolvedCompanyPath);
  if (typeof companyMarkdown !== "string") {
    throw unprocessable(`Company package file is not readable as text: ${resolvedCompanyPath}`);
  }
  const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
  const companyFrontmatter = companyDoc.frontmatter;
  const paperclipExtensionPath = findPaperclipExtensionPath(validatedFiles);
  if (!paperclipExtensionPath) {
    throw unprocessable("Company package is missing the canonical .paperclip.yaml manifest");
  }
  const paperclipExtension = parseYamlFile(
    readPortableTextFile(validatedFiles, paperclipExtensionPath) ?? "",
  );
  assertExactPortableKeys(paperclipExtension, PAPERCLIP_EXTENSION_KEYS, "Paperclip manifest");
  if (paperclipExtension.schema !== "paperclip/v1") {
    throw unprocessable("Paperclip manifest schema must be exactly paperclip/v1");
  }
  const paperclipCompany = isPlainRecord(paperclipExtension.company) ? paperclipExtension.company : {};
  assertExactPortableKeys(paperclipCompany, PORTABLE_COMPANY_EXTENSION_KEYS, "Company manifest");
  const paperclipSidebar = normalizePortableSidebarOrder(paperclipExtension.sidebar);
  const paperclipAgents = isPlainRecord(paperclipExtension.agents) ? paperclipExtension.agents : {};
  const paperclipProjects = isPlainRecord(paperclipExtension.projects) ? paperclipExtension.projects : {};
  const paperclipTasks = isPlainRecord(paperclipExtension.tasks) ? paperclipExtension.tasks : {};
  const paperclipRoutines = isPlainRecord(paperclipExtension.routines) ? paperclipExtension.routines : {};
  const companyName =
    asString(companyFrontmatter.name) ?? opts?.sourceLabel?.companyName ?? "Imported Company";
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
  const discoveredAgentPaths = Object.keys(validatedFiles).filter(
    (entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md",
  );
  const discoveredProjectPaths = Object.keys(validatedFiles).filter(
    (entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md",
  );
  const discoveredTaskPaths = Object.keys(validatedFiles).filter(
    (entry) => entry.endsWith("/TASK.md") || entry === "TASK.md",
  );
  const agentPaths = Array.from(new Set([...referencedAgentPaths, ...discoveredAgentPaths])).sort();
  const projectPaths = Array.from(new Set([...referencedProjectPaths, ...discoveredProjectPaths])).sort();
  const taskPaths = Array.from(new Set([...referencedTaskPaths, ...discoveredTaskPaths])).sort();

  const manifest: CompanyPortabilityManifest = {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    source: opts?.sourceLabel ?? null,
    includes: {
      company: true,
      agents: true,
      projects: projectPaths.length > 0,
      tasks: taskPaths.length > 0,
    },
    company: {
      path: resolvedCompanyPath,
      name: companyName,
      description: asString(companyFrontmatter.description),
      brandColor: asString(paperclipCompany.brandColor),
      logoPath: readOptionalPortablePath(paperclipCompany.logoPath, "Company logo path"),
      budgetCurrency: portableBudgetCurrency(paperclipCompany.budgetCurrency, "Company budgetCurrency"),
      budgetMonthlyAmount: portableMoneyAmount(
        paperclipCompany.budgetMonthlyAmount,
        "Company budgetMonthlyAmount",
      ),
      attachmentMaxBytes:
        typeof paperclipCompany.attachmentMaxBytes === "number" &&
        Number.isFinite(paperclipCompany.attachmentMaxBytes)
          ? Math.max(1, Math.floor(paperclipCompany.attachmentMaxBytes))
          : null,
      requireBoardApprovalForNewAgents:
        typeof paperclipCompany.requireBoardApprovalForNewAgents === "boolean"
          ? paperclipCompany.requireBoardApprovalForNewAgents
          : readCompanyApprovalDefault(companyFrontmatter),
    },
    sidebar: paperclipSidebar,
    agents: [],
    projects: [],
    tasks: [],
    envInputs: [],
  };

  const warnings: string[] = [];
  if (manifest.company?.logoPath && !validatedFiles[manifest.company.logoPath]) {
    warnings.push(`Referenced company logo file is missing from package: ${manifest.company.logoPath}`);
  }
  for (const agentPath of agentPaths) {
    const agentDoc = readPortableMarkdownDoc(validatedFiles, agentPath, "agent", warnings);
    if (!agentDoc) continue;
    const frontmatter = agentDoc.frontmatter;
    assertExactPortableKeys(frontmatter, PORTABLE_AGENT_FRONTMATTER_KEYS, `Agent file ${agentPath}`);
    if (agentDoc.body.trim().length > 0) {
      throw unprocessable(`Agent file ${agentPath} contains retired instruction content`);
    }
    const slug = asString(frontmatter.slug);
    if (!slug || !isCanonicalSlug(slug)) {
      throw unprocessable(`Agent file requires an exact canonical slug: ${agentPath}`);
    }
    const extension = isPlainRecord(paperclipAgents[slug]) ? paperclipAgents[slug] : {};
    assertExactPortableKeys(extension, PORTABLE_AGENT_EXTENSION_KEYS, `Agent ${slug} manifest`);
    if (!hasOwn(frontmatter, "reportsTo")) {
      throw unprocessable(`Agent ${slug} must declare reportsTo explicitly, using null for a root agent`);
    }
    const rawAdapterRevision = extension.adapterRevision;
    if (!isPlainRecord(rawAdapterRevision)) {
      throw unprocessable(`Agent ${slug} requires an explicit adapterRevision`);
    }
    assertExactPortableKeys(
      rawAdapterRevision,
      ["sourceRevisionId", "acpConfiguration"],
      `Agent ${slug} adapterRevision`,
    );
    const sourceRevisionId = asString(rawAdapterRevision.sourceRevisionId);
    if (!sourceRevisionId || !isCanonicalUuid(sourceRevisionId)) {
      throw unprocessable(`Agent ${slug} adapterRevision.sourceRevisionId must be a UUID`);
    }
    const parsedAcpConfiguration =
      portabilityAgentManifestEntrySchema.shape.adapterRevision.shape.acpConfiguration.safeParse(
        rawAdapterRevision.acpConfiguration,
      );
    if (!parsedAcpConfiguration.success) {
      throw unprocessable(`Agent ${slug} adapterRevision.acpConfiguration is invalid`);
    }
    const extensionPermissionGrants = normalizePortablePermissionGrants(extension.permissionGrants);
    const title = asString(frontmatter.title);

    manifest.agents.push({
      slug,
      name: asString(frontmatter.name) ?? title ?? slug,
      path: agentPath,
      title,
      icon: asString(extension.icon),
      capabilities: asString(extension.capabilities),
      reportsToSlug: asString(frontmatter.reportsTo) ?? asString(extension.reportsTo),
      reportsToExistingAgentId: asString(extension.reportsToExistingAgentId),
      reportsToExistingAgentSlug: asString(extension.reportsToExistingAgentSlug),
      adapterRevision: {
        sourceRevisionId,
        acpConfiguration: parsedAcpConfiguration.data,
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

  for (const projectPath of projectPaths) {
    const projectDoc = readPortableMarkdownDoc(validatedFiles, projectPath, "project", warnings);
    if (!projectDoc) continue;
    const frontmatter = projectDoc.frontmatter;
    const slug = asString(frontmatter.slug);
    if (!slug || !isCanonicalSlug(slug)) {
      throw unprocessable(`Project file requires an exact canonical slug: ${projectPath}`);
    }
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
      icon: parsePortableProjectIcon(extension.icon, slug),
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
    const taskDoc = readPortableMarkdownDoc(validatedFiles, taskPath, "task", warnings);
    if (!taskDoc) continue;
    const frontmatter = taskDoc.frontmatter;
    assertExactPortableKeys(frontmatter, PORTABLE_TASK_FRONTMATTER_KEYS, `Task file ${taskPath}`);
    const slug = asString(frontmatter.slug);
    if (!slug || !isCanonicalSlug(slug)) {
      throw unprocessable(`Task file requires an exact canonical slug: ${taskPath}`);
    }
    const extension = isPlainRecord(paperclipTasks[slug]) ? paperclipTasks[slug] : {};
    assertExactPortableKeys(extension, PORTABLE_TASK_EXTENSION_KEYS, `Task ${slug} manifest`);
    const routineExtension = normalizeRoutineExtension(paperclipRoutines[slug]);
    const recurring = asBoolean(frontmatter.recurring) === true || routineExtension !== null;
    const ownerAgentSlug = asString(frontmatter.owner);
    if (!ownerAgentSlug) {
      throw unprocessable(`Task ${slug} requires an explicit owner`);
    }
    const lifecycleStatus = asString(extension.lifecycleStatus);
    if (!lifecycleStatus || !["open", "blocked", "done", "cancelled"].includes(lifecycleStatus)) {
      throw unprocessable(`Task ${slug} requires lifecycleStatus open, blocked, done, or cancelled`);
    }
    const boardPresentationStatus = asString(extension.boardPresentationStatus);
    if (!boardPresentationStatus) {
      throw unprocessable(`Task ${slug} requires boardPresentationStatus`);
    }
    manifest.tasks.push({
      slug,
      title: asString(frontmatter.name) ?? asString(frontmatter.title) ?? slug,
      path: taskPath,
      projectSlug: asString(frontmatter.project),
      ownerAgentSlug,
      request: taskDoc.body,
      recurring,
      routine: routineExtension,
      lifecycleStatus: lifecycleStatus as CompanyPortabilityTaskManifestEntry["lifecycleStatus"],
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
    files: validatedFiles,
    warnings,
  };
}

function readPortableMarkdownDoc(
  files: Record<string, CompanyPortabilityFileEntry>,
  filePath: string,
  kind: "agent" | "project" | "task",
  warnings: string[],
): MarkdownDoc | null {
  const markdownRaw = readPortableTextFile(files, filePath);
  if (typeof markdownRaw === "string") {
    return parseFrontmatterMarkdown(markdownRaw);
  }
  warnings.push(`Referenced ${kind} file is missing from package: ${filePath}`);
  return null;
}

export function parseCompanyImportGithubSource(rawUrl: string) {
  try {
    return parseCanonicalGithubImportSourceUrl(rawUrl);
  } catch (error) {
    throw unprocessable(
      error instanceof Error ? error.message : "Invalid canonical GitHub import source URL.",
    );
  }
}
