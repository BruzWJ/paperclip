import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type {
  CatalogManifest,
  CatalogTeam,
  CatalogTeamFileKind,
  CatalogTeamKind,
  CatalogTeamSkillRequirement,
  CatalogTeamSkillRequirementType,
  CompanyPortabilityAgentSelection,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityFileEntry,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewResult,
  CompanyPortabilitySource,
} from "@paperclipai/shared";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  normalizeAgentUrlKey,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import {
  parseFrontmatterMarkdown,
  stringifyFrontmatter,
} from "@paperclipai/shared/frontmatter";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { companyPortabilityService } from "./company-portability.js";
import { companySkillService } from "./company-skills.js";
import { logActivity } from "./activity-log.js";
import {
  requireSecretMutationActor,
  type SecretMutationActor,
} from "./secrets.js";
import { normalizePortablePath } from "./portable-path.js";
import { validateRegisteredAdapterRuntimeConfiguration } from "./agent-adapter-config-revisions.js";
import type { AuthorizationActor } from "./authorization.js";
import type { OrdinaryIssueRuntime } from "./ordinary-issue-runtime.js";

type CatalogManifestFile = CatalogManifest;

export interface CatalogTeamListQuery {
  kind?: CatalogTeamKind;
  category?: string;
  q?: string;
}

export interface CatalogTeamSourcePolicy {
  allowExternalSources?: boolean;
  allowUnpinnedOptionalSources?: boolean;
  allowLocalPathSources?: boolean;
}

export interface CatalogTeamActorContext {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
}

export interface CatalogTeamImportOptions {
  targetManagerAgentId?: string | null;
  targetManagerSlug?: string | null;
  include?: Partial<CompanyPortabilityInclude>;
  agents?: CompanyPortabilityAgentSelection;
  collisionStrategy?: CompanyPortabilityCollisionStrategy;
  nameOverrides?: Record<string, string>;
  selectedFiles?: string[];
  adapterOverrides?: CompanyPortabilityImport["adapterOverrides"];
  secretValues?: CompanyPortabilityImport["secretValues"];
  sourcePolicy?: CatalogTeamSourcePolicy;
}

export interface CatalogTeamPreviewOptions extends CatalogTeamImportOptions {
  actor?: CatalogTeamActorContext | null;
}

export interface CatalogTeamInstallOptions extends CatalogTeamImportOptions {
  actor: CatalogTeamActorContext;
  authorizationActor?: AuthorizationActor;
}

function catalogTeamSecretMutationActor(
  actor: CatalogTeamActorContext | null | undefined,
): SecretMutationActor {
  const candidate: unknown =
    actor?.actorType === "user"
      ? { type: "user", userId: actor.actorId }
      : actor?.actorType === "agent"
        ? { type: "agent", agentId: actor.actorId }
        : actor?.actorType === "system" || actor?.actorType === "plugin"
          ? { type: "system" }
          : actor;
  requireSecretMutationActor(candidate);
  return candidate as SecretMutationActor;
}

export type CatalogTeamSkillPreparationAction =
  | "already_in_package"
  | "catalog_install_required"
  | "external_import_required"
  | "blocked";

export interface CatalogTeamSkillPreparation {
  type: CatalogTeamSkillRequirementType;
  ref: string;
  agentSlugs: string[];
  action: CatalogTeamSkillPreparationAction;
  catalogSkillId: string | null;
  catalogSkillKey: string | null;
  sourceLocator: string | null;
  sourceRef: string | null;
  reason: string | null;
}

export interface CatalogTeamPreparedSource {
  team: CatalogTeam;
  source: CompanyPortabilitySource & { type: "inline" };
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
  errors: string[];
}

interface CatalogTargetManagerReference {
  agentId: string;
  slug: string;
}

export interface CatalogTeamImportPreviewResult {
  team: CatalogTeam;
  portabilityPreview: CompanyPortabilityPreviewResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
  errors: string[];
}

export interface CatalogTeamInstallResult {
  team: CatalogTeam;
  portabilityImport: CompanyPortabilityImportResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
}

export interface InstalledCatalogTeam {
  catalogId: string;
  catalogKey: string | null;
  present: boolean;
  currentContentHash: string | null;
  installedOriginHashes: string[];
  agentCount: number;
  outOfDate: boolean;
}

export interface CatalogTeamFileDetail {
  catalogTeamId: string;
  path: string;
  kind: CatalogTeamFileKind;
  content: string;
  language: string | null;
  markdown: boolean;
}

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const catalogPackageRootCandidates = buildCatalogPackageRootCandidates();
let catalogPackageRoot = catalogPackageRootCandidates[0]!;
let catalogManifestPath = path.join(catalogPackageRoot, "generated/catalog.json");
let cachedCatalogManifest: {
  manifest: CatalogManifestFile;
  manifestPath: string;
  mtimeMs: number;
  size: number;
} | null = null;

function buildCatalogPackageRootCandidates() {
  const configuredRoot = process.env.PAPERCLIP_TEAMS_CATALOG_DIR?.trim();
  const candidates = [
    ...(configuredRoot ? [path.resolve(configuredRoot)] : []),
    path.resolve(process.cwd(), "packages/teams-catalog"),
    path.resolve(serviceDir, "../../../../", "packages/teams-catalog"),
  ];
  return Array.from(new Set(candidates));
}

async function statCatalogManifest() {
  for (const candidateRoot of catalogPackageRootCandidates) {
    const candidateManifestPath = path.join(candidateRoot, "generated/catalog.json");
    try {
      const stats = await fs.stat(candidateManifestPath);
      catalogPackageRoot = candidateRoot;
      catalogManifestPath = candidateManifestPath;
      return { stats, manifestPath: candidateManifestPath };
    } catch {
      // Try the next known runtime layout before reporting all checked paths.
    }
  }
  throw new Error(
    `Teams catalog manifest not found. Checked: ${catalogPackageRootCandidates.map((root) => path.join(root, "generated/catalog.json")).join(", ")}. Run pnpm --filter @paperclipai/teams-catalog build:manifest.`,
  );
}

async function getCatalogManifest() {
  const { stats, manifestPath } = await statCatalogManifest();
  if (
    cachedCatalogManifest
    && cachedCatalogManifest.manifestPath === manifestPath
    && cachedCatalogManifest.mtimeMs === stats.mtimeMs
    && cachedCatalogManifest.size === stats.size
  ) {
    return cachedCatalogManifest.manifest;
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as CatalogManifestFile;
  cachedCatalogManifest = {
    manifest,
    manifestPath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
  return manifest;
}

async function getCatalogTeams() {
  const manifest = await getCatalogManifest();
  return manifest.teams.map((team) => ({
    ...team,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
  }));
}

function searchText(team: CatalogTeam) {
  return [
    team.id,
    team.key,
    team.slug,
    team.name,
    team.description,
    team.category,
    team.kind,
    ...team.recommendedForCompanyTypes,
    ...team.tags,
  ].join("\n").toLowerCase();
}

export async function listCatalogTeams(query: CatalogTeamListQuery = {}): Promise<CatalogTeam[]> {
  const normalizedQuery = query.q?.trim().toLowerCase() ?? "";
  return (await getCatalogTeams())
    .filter((team) => !query.kind || team.kind === query.kind)
    .filter((team) => !query.category || team.category === query.category)
    .filter((team) => !normalizedQuery || searchText(team).includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface CatalogTeamProvenance {
  catalogId: string;
  catalogKey: string | null;
  originHash: string | null;
}

/**
 * Extract `metadata.paperclip.catalogTeam` provenance written by the team
 * importer (see `renderCatalogProvenanceYaml`). Returns null when the agent was
 * not installed from a catalog team.
 */
export function readCatalogTeamProvenance(
  metadata: Record<string, unknown> | null | undefined,
): CatalogTeamProvenance | null {
  if (!isPlainRecord(metadata)) return null;
  const paperclip = isPlainRecord(metadata.paperclip) ? metadata.paperclip : null;
  const catalogTeam = paperclip && isPlainRecord(paperclip.catalogTeam) ? paperclip.catalogTeam : null;
  if (!catalogTeam) return null;
  const catalogId = readNonEmptyString(catalogTeam.catalogId);
  if (!catalogId) return null;
  return {
    catalogId,
    catalogKey: readNonEmptyString(catalogTeam.catalogKey),
    originHash: readNonEmptyString(catalogTeam.originHash),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveCatalogTeamReference(reference: string): Promise<{ team: CatalogTeam | null; ambiguous: boolean }> {
  const trimmed = reference.trim();
  if (!trimmed) return { team: null, ambiguous: false };
  const teams = await getCatalogTeams();

  const exact = teams.find((team) => team.id === trimmed || team.key === trimmed);
  if (exact) return { team: exact, ambiguous: false };

  const slugMatches = teams.filter((team) => team.slug === trimmed);
  if (slugMatches.length === 1) return { team: slugMatches[0]!, ambiguous: false };
  if (slugMatches.length > 1) return { team: null, ambiguous: true };
  return { team: null, ambiguous: false };
}

export async function getCatalogTeamOrThrow(reference: string): Promise<CatalogTeam> {
  const result = await resolveCatalogTeamReference(reference);
  if (result.ambiguous) {
    throw conflict(`Catalog team slug "${reference}" is ambiguous. Use an id or key.`);
  }
  if (!result.team) {
    throw notFound("Catalog team not found");
  }
  return result.team;
}

function isMarkdownPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  return fileName === "team.md" || fileName.endsWith(".md");
}

function inferLanguageFromPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  if (fileName.endsWith(".md")) return "markdown";
  if (fileName.endsWith(".json")) return "json";
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) return "yaml";
  if (fileName.endsWith(".sh")) return "bash";
  if (fileName.endsWith(".ts")) return "typescript";
  if (fileName.endsWith(".tsx")) return "tsx";
  if (fileName.endsWith(".js")) return "javascript";
  if (fileName.endsWith(".jsx")) return "jsx";
  if (fileName.endsWith(".py")) return "python";
  return null;
}

function catalogTeamRoot(team: CatalogTeam) {
  return path.resolve(catalogPackageRoot, team.path);
}

function resolveCatalogTeamFile(team: CatalogTeam, relativePath: string) {
  const normalizedPath = normalizePortablePath(relativePath || team.entrypoint);
  const fileEntry = team.files.find((entry) => entry.path === normalizedPath);
  if (!fileEntry) {
    throw notFound("Catalog team file not found");
  }

  const teamRoot = catalogTeamRoot(team);
  const absolutePath = path.resolve(teamRoot, normalizedPath);
  if (absolutePath !== teamRoot && !absolutePath.startsWith(`${teamRoot}${path.sep}`)) {
    throw notFound("Catalog team file not found");
  }

  return { normalizedPath, fileEntry, absolutePath };
}

export async function readCatalogTeamFile(
  reference: string,
  relativePath = "TEAM.md",
): Promise<CatalogTeamFileDetail> {
  const team = await getCatalogTeamOrThrow(reference);
  const resolved = resolveCatalogTeamFile(team, relativePath);

  if (resolved.fileEntry.kind === "asset") {
    throw new HttpError(415, "Catalog team asset previews are not supported.");
  }

  const content = await fs.readFile(resolved.absolutePath, "utf8");
  return {
    catalogTeamId: team.id,
    path: resolved.normalizedPath,
    kind: resolved.fileEntry.kind,
    content,
    language: inferLanguageFromPath(resolved.normalizedPath),
    markdown: isMarkdownPath(resolved.normalizedPath),
  };
}

function yamlScalar(value: string | number | boolean | null) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderYamlBlock(value: unknown, indentLevel = 0): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        (Array.isArray(entry) && entry.length === 0) ||
        (isPlainRecord(entry) && Object.keys(entry).length === 0)
      ) {
        lines.push(`${indent}- ${yamlScalar(entry as string | number | boolean | null)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        (Array.isArray(entry) && entry.length === 0) ||
        (isPlainRecord(entry) && Object.keys(entry).length === 0)
      ) {
        lines.push(`${indent}${key}: ${yamlScalar(entry as string | number | boolean | null)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${yamlScalar(String(value))}`];
}

function renderYamlFile(value: Record<string, unknown>) {
  return `${renderYamlBlock(value).join("\n")}\n`;
}

function renderSyntheticCompanyMarkdown(team: CatalogTeam) {
  const lines = [
    "---",
    `name: ${yamlScalar(team.name)}`,
    `description: ${yamlScalar(team.description)}`,
    "schema: agentcompanies/v1",
    `slug: ${yamlScalar(team.slug)}`,
    "includes:",
    "  - TEAM.md",
    "---",
    "",
    `# ${team.name}`,
    "",
    team.description,
    "",
  ];
  return lines.join("\n");
}

async function catalogProvenance(team: CatalogTeam) {
  const manifest = await getCatalogManifest();
  return {
    catalogId: team.id,
    catalogKey: team.key,
    catalogKind: team.kind,
    catalogCategory: team.category,
    catalogSlug: team.slug,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    originHash: team.contentHash,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function catalogAdapterRevisionId(
  team: CatalogTeam,
  slug: string,
  override: NonNullable<
    CompanyPortabilityImport["adapterOverrides"]
  >[string],
) {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(
        [
          "paperclip-catalog-adapter-revision/v1",
          team.id,
          slug,
          override.adapterType,
          canonicalJson(override.adapterConfig),
          override.skillChannel,
        ].join("\0"),
      )
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function explicitFalseMap(keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, false]));
}

async function renderCatalogProvenanceYaml(
  team: CatalogTeam,
  targetManager: CatalogTargetManagerReference | null,
  adapterOverrides: CompanyPortabilityImport["adapterOverrides"],
) {
  const provenance = await catalogProvenance(team);
  const agentSlugs = Array.from(new Set(team.agentSlugs)).sort();
  const projectSlugs = Array.from(new Set(team.projectSlugs)).sort();
  const issueSlugs = team.files
    .filter((file) => file.kind === "issue")
    .map((file) => normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(file.path))))
    .filter((slug): slug is string => Boolean(slug));

  const renderEntity = (slug: string, opts?: {
    reparentRoot?: boolean;
    includeAdapterRevision?: boolean;
  }) => ({
    ...(opts?.reparentRoot && targetManager
      ? {
          reportsToExistingAgentId: targetManager.agentId,
          reportsToExistingAgentSlug: targetManager.slug,
        }
      : {}),
    ...(opts?.includeAdapterRevision && adapterOverrides?.[slug]
      ? {
          adapterRevision: {
            sourceRevisionId: catalogAdapterRevisionId(
              team,
              slug,
              adapterOverrides[slug],
            ),
            adapterType: adapterOverrides[slug].adapterType,
            adapterConfig: adapterOverrides[slug].adapterConfig,
            runtimeConfig: {},
            skillChannel: adapterOverrides[slug].skillChannel,
          },
          contextGrants: explicitFalseMap(AGENT_CONTEXT_GRANT_KEYS),
          actionGrants: explicitFalseMap(PAPERCLIP_ACTION_KEYS),
          mentionReachGrants: explicitFalseMap(
            AGENT_MENTION_REACH_GRANT_KEYS,
          ),
        }
      : {}),
    metadata: {
      paperclip: {
        catalogTeam: {
          catalogId: provenance.catalogId,
          catalogKey: provenance.catalogKey,
          catalogKind: provenance.catalogKind,
          catalogCategory: provenance.catalogCategory,
          catalogSlug: provenance.catalogSlug,
          packageName: provenance.packageName,
          packageVersion: provenance.packageVersion,
          originHash: provenance.originHash,
        },
      },
    },
  });

  const extension: Record<string, unknown> = {
    schema: "paperclip/v1",
    agents: Object.fromEntries(agentSlugs.map((slug) => [
      slug,
      renderEntity(slug, {
        reparentRoot: Boolean(targetManager && team.rootAgentSlugs.includes(slug)),
        includeAdapterRevision: true,
      }),
    ])),
  };
  if (projectSlugs.length > 0) {
    extension.projects = Object.fromEntries(projectSlugs.map((slug) => [slug, renderEntity(slug)]));
  }
  if (issueSlugs.length > 0) {
    extension.issues = Object.fromEntries(
      Array.from(new Set(issueSlugs)).sort().map((slug) => [
        slug,
        {
          ...renderEntity(slug),
          lifecycleStatus: "open",
          boardPresentationStatus: "backlog",
          priority: "medium",
        },
      ]),
    );
  }
  return renderYamlFile(extension);
}

function mergePlainRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      merged[key] = mergePlainRecords(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function parseYamlDocument(raw: string): Record<string, unknown> {
  return parseFrontmatterMarkdown(`---\n${raw.trim()}\n---\n`).frontmatter;
}

function preparation(
  requirement: CatalogTeamSkillRequirement,
  action: CatalogTeamSkillPreparationAction,
  reason: string | null = null,
): CatalogTeamSkillPreparation {
  return {
    type: requirement.type,
    ref: requirement.ref,
    agentSlugs: requirement.agentSlugs,
    action,
    catalogSkillId: requirement.catalogSkillId ?? null,
    catalogSkillKey: requirement.catalogSkillKey ?? null,
    sourceLocator: requirement.sourceLocator ?? null,
    sourceRef: requirement.sourceRef ?? null,
    reason,
  };
}

function isPinnedSourceRef(value: string | null | undefined) {
  return Boolean(value && /^[0-9a-f]{40}$/i.test(value.trim()));
}

export function collectCatalogTeamSkillPreparations(
  team: CatalogTeam,
  sourcePolicy: CatalogTeamSourcePolicy = {},
): { preparations: CatalogTeamSkillPreparation[]; warnings: string[]; errors: string[] } {
  const preparations: CatalogTeamSkillPreparation[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const requirement of team.requiredSkills) {
    if (!requirement.resolved) {
      const reason = `Skill requirement "${requirement.ref}" is unresolved in catalog manifest.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (requirement.type === "catalog") {
      preparations.push(preparation(requirement, "catalog_install_required"));
      continue;
    }

    if (requirement.type === "local") {
      preparations.push(preparation(requirement, "already_in_package"));
      continue;
    }

    if (requirement.type === "local_path" && !sourcePolicy.allowLocalPathSources) {
      const reason = `Local path skill source "${requirement.ref}" is development-only and is not allowed for catalog team install.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (requirement.type === "agent_package") {
      const reason = `Agent package skill source "${requirement.ref}" is declared but no safe resolver is available yet.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (!sourcePolicy.allowExternalSources) {
      const reason = `External skill source "${requirement.ref}" requires explicit source policy approval.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (team.kind === "bundled" && (requirement.type === "github" || requirement.type === "skills_sh") && !isPinnedSourceRef(requirement.sourceRef)) {
      const reason = `Bundled catalog team external skill source "${requirement.ref}" must be pinned to a commit.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (team.kind === "optional" && (requirement.type === "github" || requirement.type === "skills_sh") && !isPinnedSourceRef(requirement.sourceRef)) {
      const reason = `Optional catalog team external skill source "${requirement.ref}" is not pinned to a commit.`;
      if (!sourcePolicy.allowUnpinnedOptionalSources) {
        preparations.push(preparation(requirement, "blocked", reason));
        errors.push(reason);
        continue;
      }
      warnings.push(reason);
    }

    preparations.push(preparation(requirement, "external_import_required"));
  }

  return { preparations, warnings, errors };
}

async function readCatalogTeamSourceFiles(team: CatalogTeam): Promise<Record<string, CompanyPortabilityFileEntry>> {
  const files: Record<string, CompanyPortabilityFileEntry> = {
    "COMPANY.md": renderSyntheticCompanyMarkdown(team),
  };
  for (const file of team.files) {
    const resolved = resolveCatalogTeamFile(team, file.path);
    const normalizedPath = normalizePortablePath(file.path);
    if (file.kind === "asset") {
      const data = await fs.readFile(resolved.absolutePath);
      files[normalizedPath] = {
        encoding: "base64",
        data: data.toString("base64"),
      };
      continue;
    }
    const contents = await fs.readFile(resolved.absolutePath, "utf8");
    if (file.kind !== "agent") {
      files[normalizedPath] = contents;
      continue;
    }
    const parsed = parseFrontmatterMarkdown(contents);
    if (!parsed.hasFrontmatter) {
      throw unprocessable(
        `Catalog agent ${normalizedPath} must have frontmatter`,
      );
    }
    const frontmatter = stringifyFrontmatter({
      ...parsed.frontmatter,
      skills: [],
    });
    files[normalizedPath] = parsed.body
      ? `---\n${frontmatter}\n---\n\n${parsed.body}\n`
      : `---\n${frontmatter}\n---\n`;
  }
  return files;
}

function selectedCatalogAgentSlugs(
  team: CatalogTeam,
  options: CatalogTeamImportOptions,
) {
  if (options.include?.agents === false) return [];
  const requestedSlugs =
    options.agents && options.agents !== "all"
      ? Array.from(new Set(options.agents)).filter((slug) =>
          team.agentSlugs.includes(slug)
        )
      : [...team.agentSlugs];
  if (!options.selectedFiles) return requestedSlugs;

  const selectedPaths = new Set(
    options.selectedFiles.map((entry) => normalizePortablePath(entry)),
  );
  const selectedFileSlugs = new Set(
    team.files
      .filter(
        (file) =>
          file.kind === "agent"
          && selectedPaths.has(normalizePortablePath(file.path)),
      )
      .map((file) => {
        const normalized = normalizePortablePath(file.path);
        const match = /^agents\/([^/]+)\/AGENTS\.md$/i.exec(normalized);
        return match?.[1] ?? null;
      })
      .filter((slug): slug is string => Boolean(slug)),
  );
  return requestedSlugs.filter((slug) => selectedFileSlugs.has(slug));
}

async function collectExplicitCatalogConfigurationErrors(
  team: CatalogTeam,
  options: CatalogTeamImportOptions,
) {
  const selectedSlugs = selectedCatalogAgentSlugs(team, options);
  const errors: string[] = [];
  const overrides = options.adapterOverrides ?? {};
  for (const slug of selectedSlugs) {
    const override = overrides[slug];
    if (!override?.adapterType?.trim()) {
      errors.push(
        `Explicit adapter configuration is required for catalog agent ${slug}.`,
      );
      continue;
    }
    if (
      !Object.prototype.hasOwnProperty.call(override, "adapterConfig")
      || typeof override.adapterConfig !== "object"
      || override.adapterConfig === null
      || Array.isArray(override.adapterConfig)
    ) {
      errors.push(
        `Explicit adapterConfig is required for catalog agent ${slug}.`,
      );
      continue;
    }
    try {
      await validateRegisteredAdapterRuntimeConfiguration({
        adapterType: override.adapterType,
        adapterConfig: override.adapterConfig,
      });
    } catch (error) {
      errors.push(
        `Invalid adapter configuration for catalog agent ${slug}: ${formatError(error)}.`,
      );
    }
  }
  const unusedOverrides = Object.keys(overrides).filter(
    (slug) => !selectedSlugs.includes(slug),
  );
  if (unusedOverrides.length > 0) {
    errors.push(
      `Adapter configuration targets agents not selected from this catalog team: ${unusedOverrides.join(", ")}.`,
    );
  }
  const importsRoot = selectedSlugs.some((slug) =>
    team.rootAgentSlugs.includes(slug)
  );
  const hasExplicitTarget =
    Object.hasOwn(options, "targetManagerAgentId") ||
    Object.hasOwn(options, "targetManagerSlug");
  if (importsRoot && !hasExplicitTarget) {
    errors.push(
      "Catalog team target is required: select a target manager or explicitly choose a standalone team.",
    );
  }
  return errors;
}

function buildPortabilityInput(
  companyId: string,
  source: CompanyPortabilitySource,
  options: CatalogTeamImportOptions,
): CompanyPortabilityPreview {
  const requestedInclude = options.include ?? {};
  const selectedFiles = options.selectedFiles
    ? Array.from(new Set([
        ...options.selectedFiles,
        ".paperclip.yaml",
      ]))
    : undefined;
  return {
    source,
    include: {
      agents: true,
      projects: true,
      issues: true,
      skills: true,
      ...requestedInclude,
      company: false,
    },
    target: {
      mode: "existing_company",
      companyId,
    },
    agents: options.agents,
    collisionStrategy: options.collisionStrategy ?? "rename",
    nameOverrides: options.nameOverrides,
    selectedFiles,
    adapterOverrides: options.adapterOverrides,
  };
}

export function teamsCatalogService(
  db: Db,
  ordinaryIssues: OrdinaryIssueRuntime,
) {
  const portability = companyPortabilityService(db, undefined, ordinaryIssues);
  const companySkills = companySkillService(db);
  const agents = agentService(db);

  async function resolveTargetManagerReference(
    companyId: string,
    options: CatalogTeamImportOptions,
  ): Promise<CatalogTargetManagerReference | null> {
    if (options.targetManagerSlug) {
      const slug = normalizeAgentUrlKey(options.targetManagerSlug);
      if (!slug) throw unprocessable("Target manager slug is invalid.");
      const managers = await agents.list(companyId);
      const manager = managers.find((candidate) => normalizeAgentUrlKey(candidate.name) === slug);
      if (!manager) throw notFound("Target manager agent not found");
      return { agentId: manager.id, slug };
    }
    if (!options.targetManagerAgentId) return null;
    const manager = await agents.getById(options.targetManagerAgentId);
    if (!manager) throw notFound("Target manager agent not found");
    if (manager.companyId !== companyId) {
      throw forbidden("Target manager agent must belong to the target company.");
    }
    return {
      agentId: manager.id,
      slug: normalizeAgentUrlKey(manager.name) ?? manager.id,
    };
  }

  async function prepareCatalogTeamSource(
    companyId: string,
    catalogRef: string,
    options: CatalogTeamImportOptions = {},
  ): Promise<CatalogTeamPreparedSource> {
    const team = await getCatalogTeamOrThrow(catalogRef);
    const warnings: string[] = [];
    const errors: string[] = [];
    errors.push(...await collectExplicitCatalogConfigurationErrors(team, options));

    if (team.compatibility !== "compatible") {
      errors.push(`Catalog team ${team.id} is not compatible.`);
    }
    if (team.trustLevel === "scripts_executables") {
      errors.push(`Catalog team ${team.id} contains executable scripts and cannot be installed by the safe team importer.`);
    }
    if (team.trustLevel === "external_sources" && !options.sourcePolicy?.allowExternalSources) {
      errors.push(`Catalog team ${team.id} declares external sources and requires explicit source policy approval.`);
    }

    const skillPrep = collectCatalogTeamSkillPreparations(team, options.sourcePolicy);
    warnings.push(...skillPrep.warnings);
    errors.push(...skillPrep.errors);

    const targetManager = await resolveTargetManagerReference(companyId, options);
    const files = await readCatalogTeamSourceFiles(team);
    const existingExtension =
      typeof files[".paperclip.yaml"] === "string"
        ? parseYamlDocument(files[".paperclip.yaml"])
        : {};
    const generatedExtension = parseYamlDocument(
      await renderCatalogProvenanceYaml(
        team,
        targetManager,
        options.adapterOverrides,
      ),
    );
    files[".paperclip.yaml"] = renderYamlFile(mergePlainRecords(existingExtension, generatedExtension));

    return {
      team,
      source: {
        type: "inline",
        files,
      },
      skillPreparations: skillPrep.preparations,
      warnings,
      errors,
    };
  }

  async function logCatalogEvent(
    action: string,
    companyId: string,
    team: CatalogTeam,
    actor: CatalogTeamActorContext | null | undefined,
    details: Record<string, unknown>,
  ) {
    if (!actor) return;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action,
      entityType: "company",
      entityId: companyId,
      details: {
        catalogId: team.id,
        catalogKey: team.key,
        catalogKind: team.kind,
        originHash: team.contentHash,
        ...details,
      },
    });
  }

  async function previewCatalogTeamImport(
    companyId: string,
    catalogRef: string,
    options: CatalogTeamPreviewOptions = {},
  ): Promise<CatalogTeamImportPreviewResult> {
    const prepared = await prepareCatalogTeamSource(companyId, catalogRef, options);
    const previewInput = buildPortabilityInput(companyId, prepared.source, options);
    const portabilityPreview = await portability.previewImport(previewInput, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    portabilityPreview.warnings.push(...prepared.warnings);
    portabilityPreview.errors.push(...prepared.errors);
    await logCatalogEvent("company.team_catalog_previewed", companyId, prepared.team, options.actor, {
      warningCount: portabilityPreview.warnings.length,
      errorCount: portabilityPreview.errors.length,
    });
    return {
      team: prepared.team,
      portabilityPreview,
      skillPreparations: prepared.skillPreparations,
      warnings: portabilityPreview.warnings,
      errors: portabilityPreview.errors,
    };
  }

  async function prepareSkillInstalls(companyId: string, prepared: CatalogTeamPreparedSource) {
    const warnings: string[] = [];
    for (const skill of prepared.skillPreparations) {
      if (skill.action === "blocked") {
        warnings.push(skill.reason ?? `Catalog team skill source ${skill.ref} is blocked.`);
        continue;
      }
      if (skill.action === "catalog_install_required") {
        if (!skill.catalogSkillId) {
          warnings.push(`Catalog skill requirement ${skill.ref} is missing catalogSkillId.`);
          continue;
        }
        try {
          const result = await companySkills.installFromCatalog(companyId, {
            catalogSkillId: skill.catalogSkillId,
          });
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(`Catalog skill requirement ${skill.ref} could not be installed after team import: ${formatError(error)}`);
        }
        continue;
      }
      if (skill.action === "external_import_required") {
        const source = skill.sourceLocator ?? skill.ref;
        try {
          const result = await companySkills.importFromSource(companyId, source);
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(`External skill source ${source} could not be imported after team import: ${formatError(error)}`);
        }
      }
    }
    return warnings;
  }

  async function installCatalogTeam(
    companyId: string,
    catalogRef: string,
    options: CatalogTeamInstallOptions,
  ): Promise<CatalogTeamInstallResult> {
    const secretMutationActor =
      catalogTeamSecretMutationActor(options.actor);
    const prepared = await prepareCatalogTeamSource(companyId, catalogRef, options);
    if (prepared.errors.length > 0) {
      throw unprocessable(`Catalog team source preparation failed: ${prepared.errors.join("; ")}`);
    }

    const importInput: CompanyPortabilityImport = {
      ...buildPortabilityInput(companyId, prepared.source, options),
      secretValues: options.secretValues,
    };
    const importPreview = await portability.previewImport(importInput, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    if (importPreview.errors.length > 0) {
      throw unprocessable(`Catalog team import preview has errors: ${importPreview.errors.join("; ")}`);
    }
    const warnings = [
      ...prepared.warnings,
      ...importPreview.warnings,
    ];
    const result = await portability.importBundle(
      importInput,
      options.actor?.userId ?? (options.actor?.actorType === "user" ? options.actor.actorId : null),
      {
        mode: "agent_safe",
        sourceCompanyId: companyId,
        authorizationActor: options.authorizationActor,
        secretMutationActor,
      },
    );
    warnings.push(...await prepareSkillInstalls(companyId, prepared));
    result.warnings.push(...warnings);
    await logCatalogEvent("company.team_catalog_installed", companyId, prepared.team, options.actor, {
      warningCount: result.warnings.length,
      agentCount: result.agents.length,
      projectCount: result.projects.length,
      skillPreparationCount: prepared.skillPreparations.length,
    });
    return {
      team: prepared.team,
      portabilityImport: result,
      skillPreparations: prepared.skillPreparations,
      warnings: result.warnings,
    };
  }

  /**
   * Compare each company agent's installed catalog-team provenance against the
   * live catalog. Drives the Team Catalog `INSTALLED · N` group and the
   * out-of-date badge from a real server signal (design
   * [PAP-10238 §3.2 + §5]).
   */
  async function listInstalledCatalogTeams(companyId: string): Promise<InstalledCatalogTeam[]> {
    const companyAgents = await agents.list(companyId);
    const currentTeams = await getCatalogTeams();
    const currentById = new Map(currentTeams.map((team) => [team.id, team]));

    type Aggregate = {
      catalogId: string;
      catalogKey: string | null;
      originHashes: Set<string>;
      agentCount: number;
    };
    const byCatalogId = new Map<string, Aggregate>();

    for (const agent of companyAgents) {
      const provenance = readCatalogTeamProvenance(
        agent.metadata as Record<string, unknown> | null,
      );
      if (!provenance) continue;
      let entry = byCatalogId.get(provenance.catalogId);
      if (!entry) {
        entry = {
          catalogId: provenance.catalogId,
          catalogKey: provenance.catalogKey,
          originHashes: new Set<string>(),
          agentCount: 0,
        };
        byCatalogId.set(provenance.catalogId, entry);
      }
      entry.agentCount += 1;
      if (!entry.catalogKey && provenance.catalogKey) entry.catalogKey = provenance.catalogKey;
      if (provenance.originHash) entry.originHashes.add(provenance.originHash);
    }

    return Array.from(byCatalogId.values())
      .map((entry) => {
        const current = currentById.get(entry.catalogId) ?? null;
        const currentContentHash = current?.contentHash ?? null;
        const installedOriginHashes = Array.from(entry.originHashes).sort();
        const present = Boolean(current);
        const outOfDate = present
          && currentContentHash !== null
          && installedOriginHashes.length > 0
          && installedOriginHashes.some((hash) => hash !== currentContentHash);
        return {
          catalogId: entry.catalogId,
          catalogKey: entry.catalogKey ?? current?.key ?? null,
          present,
          currentContentHash,
          installedOriginHashes,
          agentCount: entry.agentCount,
          outOfDate,
        } satisfies InstalledCatalogTeam;
      })
      .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  }

  return {
    listCatalogTeams,
    getCatalogTeamOrThrow,
    readCatalogTeamFile,
    prepareCatalogTeamSource,
    previewCatalogTeamImport,
    installCatalogTeam,
    listInstalledCatalogTeams,
  };
}
