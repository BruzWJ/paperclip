import { Command } from "commander";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type {
  Company,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityImportResult,
} from "@paperclipai/shared";
import { isCanonicalUuid, isPortableRelativePath } from "@paperclipai/shared";
import { validateCanonicalGithubImportSourceUrl } from "@paperclipai/shared/company-portability-source";
import { getTelemetryClient, trackCompanyImported } from "../../telemetry.js";
import { ApiRequestError } from "../../client/http.js";
import { openUrl } from "../../client/board-auth.js";
import { binaryContentTypeByExtension, readZipArchive } from "./zip.js";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import { parseExplicitAdapterOverrides } from "./adapter-overrides.js";
import { parseExactInclude } from "./exact-include.js";

interface CompanyCommandOptions extends BaseClientOptions {}
interface CompanyJsonOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
}
type CompanyImportTargetMode = "new" | "existing";
type CompanyCollisionMode = "rename" | "skip" | "replace";

interface CompanyDeleteOptions extends BaseClientOptions {
  yes?: boolean;
  confirm?: string;
}

interface CompanyExportOptions extends BaseClientOptions {
  out?: string;
  include: string;
  projects?: string;
  tasks?: string;
  projectTasks?: string;
}

interface CompanyImportOptions extends BaseClientOptions {
  include?: string;
  target?: CompanyImportTargetMode;
  companyId?: string;
  newCompanyName?: string;
  agents?: string;
  collision?: CompanyCollisionMode;
  yes?: boolean;
  dryRun?: boolean;
  adapterOverride?: string[];
  adapterConfig?: string[];
}

const COMPANY_INCLUDE_SELECTORS = [
  "company",
  "agents",
  "projects",
  "tasks",
] as const;
const DEFAULT_EXPORT_INCLUDE = "company,agents";
const DEFAULT_IMPORT_INCLUDE = "company,agents,projects,tasks";

const IMPORT_INCLUDE_OPTIONS: Array<{
  value: keyof CompanyPortabilityInclude;
  label: string;
  hint: string;
}> = [
  {
    value: "company",
    label: "Company",
    hint: "name, branding, and company settings",
  },
  { value: "projects", label: "Projects", hint: "project metadata" },
  { value: "tasks", label: "Tasks", hint: "tasks and recurring routines" },
  { value: "agents", label: "Agents", hint: "agent records and org structure" },
];

const IMPORT_PREVIEW_SAMPLE_LIMIT = 6;

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

type ImportSelectableGroup = "projects" | "tasks" | "agents";

type ImportSelectionCatalog = {
  company: {
    includedByDefault: boolean;
    files: string[];
  };
  projects: Array<{
    key: string;
    label: string;
    hint?: string;
    files: string[];
  }>;
  tasks: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  agents: Array<{ key: string; label: string; hint?: string; files: string[] }>;
  extensionPath: string | null;
};

type ImportSelectionState = {
  company: boolean;
  projects: Set<string>;
  tasks: Set<string>;
  agents: Set<string>;
};

function readPortableFileEntry(
  filePath: string,
  contents: Buffer,
): CompanyPortabilityFileEntry {
  const contentType =
    binaryContentTypeByExtension[path.extname(filePath).toLowerCase()];
  if (!contentType) return contents.toString("utf8");
  return {
    encoding: "base64",
    data: contents.toString("base64"),
    contentType,
  };
}

function portableFileEntryToWriteValue(
  entry: CompanyPortabilityFileEntry,
): string | Uint8Array {
  if (typeof entry === "string") return entry;
  return Buffer.from(entry.data, "base64");
}

export function parseCompanyInclude(input: string): CompanyPortabilityInclude {
  const selected = parseExactInclude(input, COMPANY_INCLUDE_SELECTORS);
  return {
    company: selected.has("company"),
    agents: selected.has("agents"),
    projects: selected.has("projects"),
    tasks: selected.has("tasks"),
  };
}

function parseAgents(input: string | undefined): "all" | string[] {
  if (input === undefined || input === "all") return "all";
  const values = input.split(",");
  if (
    values.length === 0 ||
    values.some((value) => value.length === 0 || value.trim() !== value) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(
      "Agent slugs must be a non-empty, duplicate-free list using exact package spelling, or exactly 'all'.",
    );
  }
  return values;
}

function parseExactSelectors(
  input: string | undefined,
  label: string,
  isValid: (value: string) => boolean,
): string[] {
  if (input === undefined) return [];
  const values = input.split(",");
  if (
    values.length === 0 ||
    values.some((value) => !isValid(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(
      `${label} must be a non-empty, duplicate-free list using exact canonical spelling.`,
    );
  }
  return values;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function resolveImportInclude(
  input: string | undefined,
): CompanyPortabilityInclude {
  return parseCompanyInclude(
    input === undefined ? DEFAULT_IMPORT_INCLUDE : input,
  );
}

function requirePortablePath(filePath: string): string {
  if (!isPortableRelativePath(filePath)) {
    throw new Error(`Invalid non-canonical portable path: ${filePath}`);
  }
  return filePath;
}

function shouldIncludePortableFile(filePath: string): boolean {
  const baseName = path.basename(filePath);
  const isMarkdown = baseName.endsWith(".md");
  const isPaperclipYaml =
    baseName === ".paperclip.yaml" || baseName === ".paperclip.yml";
  const contentType =
    binaryContentTypeByExtension[path.extname(baseName).toLowerCase()];
  return isMarkdown || isPaperclipYaml || Boolean(contentType);
}

function findPortableExtensionPath(
  files: Record<string, CompanyPortabilityFileEntry>,
): string | null {
  if (files[".paperclip.yaml"] !== undefined) return ".paperclip.yaml";
  if (files[".paperclip.yml"] !== undefined) return ".paperclip.yml";
  return (
    Object.keys(files).find(
      (entry) =>
        entry.endsWith("/.paperclip.yaml") || entry.endsWith("/.paperclip.yml"),
    ) ?? null
  );
}

function collectFilesUnderDirectory(
  files: Record<string, CompanyPortabilityFileEntry>,
  directory: string,
  opts?: { excludePrefixes?: string[] },
): string[] {
  if (!directory) return [];
  const canonicalDirectory = requirePortablePath(directory);
  const prefix = `${canonicalDirectory}/`;
  const excluded = (opts?.excludePrefixes ?? []).map(requirePortablePath);
  return Object.keys(files)
    .map(requirePortablePath)
    .filter((filePath) => filePath.startsWith(prefix))
    .filter(
      (filePath) =>
        !excluded.some((excludePrefix) =>
          filePath.startsWith(`${excludePrefix}/`),
        ),
    )
    .sort((left, right) => left.localeCompare(right));
}

function collectEntityFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  entryPath: string,
  opts?: { excludePrefixes?: string[] },
): string[] {
  const canonicalPath = requirePortablePath(entryPath);
  const directory = canonicalPath.includes("/")
    ? canonicalPath.slice(0, canonicalPath.lastIndexOf("/"))
    : "";
  const selected = new Set<string>([canonicalPath]);
  if (directory) {
    for (const filePath of collectFilesUnderDirectory(files, directory, opts)) {
      selected.add(filePath);
    }
  }
  return Array.from(selected).sort((left, right) => left.localeCompare(right));
}

export function buildImportSelectionCatalog(
  preview: CompanyPortabilityPreviewResult,
): ImportSelectionCatalog {
  const selectedAgentSlugs = new Set(preview.selectedAgentSlugs);
  const companyFiles = new Set<string>();
  const companyPath = preview.manifest.company?.path
    ? requirePortablePath(preview.manifest.company.path)
    : null;
  if (companyPath) {
    companyFiles.add(companyPath);
  }
  const readmePath = Object.keys(preview.files).find(
    (entry) => requirePortablePath(entry) === "README.md",
  );
  if (readmePath) {
    companyFiles.add(requirePortablePath(readmePath));
  }
  const logoPath = preview.manifest.company?.logoPath
    ? requirePortablePath(preview.manifest.company.logoPath)
    : null;
  if (logoPath && preview.files[logoPath] !== undefined) {
    companyFiles.add(logoPath);
  }

  return {
    company: {
      includedByDefault:
        preview.include.company && preview.manifest.company !== null,
      files: Array.from(companyFiles).sort((left, right) =>
        left.localeCompare(right),
      ),
    },
    projects: preview.manifest.projects.map((project) => {
      const projectPath = requirePortablePath(project.path);
      const projectDir = projectPath.includes("/")
        ? projectPath.slice(0, projectPath.lastIndexOf("/"))
        : "";
      return {
        key: project.slug,
        label: project.name,
        hint: project.slug,
        files: collectEntityFiles(preview.files, projectPath, {
          excludePrefixes: projectDir ? [`${projectDir}/tasks`] : [],
        }),
      };
    }),
    tasks: preview.manifest.tasks.map((task) => ({
      key: task.slug,
      label: task.title ?? task.slug,
      hint: task.slug,
      files: collectEntityFiles(preview.files, requirePortablePath(task.path)),
    })),
    agents: preview.manifest.agents
      .filter(
        (agent) =>
          selectedAgentSlugs.size === 0 || selectedAgentSlugs.has(agent.slug),
      )
      .map((agent) => ({
        key: agent.slug,
        label: agent.name,
        hint: agent.slug,
        files: collectEntityFiles(
          preview.files,
          requirePortablePath(agent.path),
        ),
      })),
    extensionPath: findPortableExtensionPath(preview.files),
  };
}

function toKeySet(items: Array<{ key: string }>): Set<string> {
  return new Set(items.map((item) => item.key));
}

export function buildDefaultImportSelectionState(
  catalog: ImportSelectionCatalog,
): ImportSelectionState {
  return {
    company: catalog.company.includedByDefault,
    projects: toKeySet(catalog.projects),
    tasks: toKeySet(catalog.tasks),
    agents: toKeySet(catalog.agents),
  };
}

function countSelected(
  state: ImportSelectionState,
  group: ImportSelectableGroup,
): number {
  return state[group].size;
}

function countTotal(
  catalog: ImportSelectionCatalog,
  group: ImportSelectableGroup,
): number {
  return catalog[group].length;
}

function summarizeGroupSelection(
  catalog: ImportSelectionCatalog,
  state: ImportSelectionState,
  group: ImportSelectableGroup,
): string {
  return `${countSelected(state, group)}/${countTotal(catalog, group)} selected`;
}

function getGroupLabel(group: ImportSelectableGroup): string {
  switch (group) {
    case "projects":
      return "Projects";
    case "tasks":
      return "Tasks";
    case "agents":
      return "Agents";
  }
}

export function buildSelectedFilesFromImportSelection(
  catalog: ImportSelectionCatalog,
  state: ImportSelectionState,
): string[] {
  const selected = new Set<string>();

  if (state.company) {
    for (const filePath of catalog.company.files) {
      selected.add(requirePortablePath(filePath));
    }
  }

  for (const group of ["projects", "tasks", "agents"] as const) {
    const selectedKeys = state[group];
    for (const item of catalog[group]) {
      if (!selectedKeys.has(item.key)) continue;
      for (const filePath of item.files) {
        selected.add(requirePortablePath(filePath));
      }
    }
  }

  if (catalog.extensionPath) {
    selected.add(requirePortablePath(catalog.extensionPath));
  }

  return Array.from(selected).sort((left, right) => left.localeCompare(right));
}

async function promptForImportSelection(
  preview: CompanyPortabilityPreviewResult,
): Promise<string[]> {
  const catalog = buildImportSelectionCatalog(preview);
  const state = buildDefaultImportSelectionState(catalog);

  while (true) {
    const choice = await p.select<
      ImportSelectableGroup | "company" | "confirm"
    >({
      message: "Select what Paperclip should import",
      options: [
        {
          value: "company",
          label: state.company ? "Company: included" : "Company: skipped",
          hint:
            catalog.company.files.length > 0
              ? "toggle company metadata"
              : "no company metadata in package",
        },
        {
          value: "projects",
          label: "Select Projects",
          hint: summarizeGroupSelection(catalog, state, "projects"),
        },
        {
          value: "tasks",
          label: "Select Tasks",
          hint: summarizeGroupSelection(catalog, state, "tasks"),
        },
        {
          value: "agents",
          label: "Select Agents",
          hint: summarizeGroupSelection(catalog, state, "agents"),
        },
        {
          value: "confirm",
          label: "Confirm",
          hint: `${buildSelectedFilesFromImportSelection(catalog, state).length} files selected`,
        },
      ],
      initialValue: "confirm",
    });

    if (p.isCancel(choice)) {
      p.cancel("Import cancelled.");
      process.exit(0);
    }

    if (choice === "confirm") {
      const selectedFiles = buildSelectedFilesFromImportSelection(
        catalog,
        state,
      );
      if (selectedFiles.length === 0) {
        p.note(
          "Select at least one import target before confirming.",
          "Nothing selected",
        );
        continue;
      }
      return selectedFiles;
    }

    if (choice === "company") {
      if (catalog.company.files.length === 0) {
        p.note(
          "This package does not include company metadata to toggle.",
          "No company metadata",
        );
        continue;
      }
      state.company = !state.company;
      continue;
    }

    const group = choice;
    const groupItems = catalog[group];
    if (groupItems.length === 0) {
      p.note(
        `This package does not include any ${getGroupLabel(group).toLowerCase()}.`,
        `No ${getGroupLabel(group)}`,
      );
      continue;
    }

    const selection = await p.multiselect<string>({
      message: `${getGroupLabel(group)} to import. Space toggles, enter returns to the main menu.`,
      options: groupItems.map((item) => ({
        value: item.key,
        label: item.label,
        hint: item.hint,
      })),
      initialValues: Array.from(state[group]),
    });

    if (p.isCancel(selection)) {
      p.cancel("Import cancelled.");
      process.exit(0);
    }

    state[group] = new Set(selection);
  }
}

function summarizeInclude(include: CompanyPortabilityInclude): string {
  const labels = IMPORT_INCLUDE_OPTIONS.filter(
    (option) => include[option.value],
  ).map((option) => option.label.toLowerCase());
  return labels.length > 0 ? labels.join(", ") : "nothing selected";
}

function formatSourceLabel(
  source:
    | { type: "inline"; rootPath?: string | null }
    | { type: "github"; url: string },
): string {
  if (source.type === "github") {
    return `GitHub: ${source.url}`;
  }
  return `Local package: ${source.rootPath?.trim() || "(current folder)"}`;
}

function formatTargetLabel(
  target:
    | { mode: "existing_company"; companyId?: string | null }
    | { mode: "new_company"; newCompanyName?: string | null },
  preview?: CompanyPortabilityPreviewResult,
): string {
  if (target.mode === "existing_company") {
    const targetName = preview?.targetCompanyName?.trim();
    const targetId =
      preview?.targetCompanyId || target.companyId || "unknown-company";
    return targetName ? `${targetName} (${targetId})` : targetId;
  }
  return (
    target.newCompanyName?.trim() ||
    preview?.manifest.company?.name ||
    "new company"
  );
}

function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}

function summarizePlanCounts(
  plans: Array<{ action: "create" | "update" | "skip" }>,
  noun: string,
): string {
  if (plans.length === 0) return `0 ${pluralize(0, noun)} selected`;
  const createCount = plans.filter((plan) => plan.action === "create").length;
  const updateCount = plans.filter((plan) => plan.action === "update").length;
  const skipCount = plans.filter((plan) => plan.action === "skip").length;
  const parts: string[] = [];
  if (createCount > 0) parts.push(`${createCount} create`);
  if (updateCount > 0) parts.push(`${updateCount} update`);
  if (skipCount > 0) parts.push(`${skipCount} skip`);
  return `${plans.length} ${pluralize(plans.length, noun)} total (${parts.join(", ")})`;
}

function summarizeImportAgentResults(
  agents: CompanyPortabilityImportResult["agents"],
): string {
  if (agents.length === 0) return "0 agents changed";
  const created = agents.filter((agent) => agent.action === "created").length;
  const updated = agents.filter((agent) => agent.action === "updated").length;
  const skipped = agents.filter((agent) => agent.action === "skipped").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${agents.length} ${pluralize(agents.length, "agent")} total (${parts.join(", ")})`;
}

function summarizeImportProjectResults(
  projects: CompanyPortabilityImportResult["projects"],
): string {
  if (projects.length === 0) return "0 projects changed";
  const created = projects.filter(
    (project) => project.action === "created",
  ).length;
  const updated = projects.filter(
    (project) => project.action === "updated",
  ).length;
  const skipped = projects.filter(
    (project) => project.action === "skipped",
  ).length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${projects.length} ${pluralize(projects.length, "project")} total (${parts.join(", ")})`;
}

function actionChip(action: string): string {
  switch (action) {
    case "create":
    case "created":
      return pc.green(action);
    case "update":
    case "updated":
      return pc.yellow(action);
    case "skip":
    case "skipped":
    case "none":
    case "unchanged":
      return pc.dim(action);
    default:
      return action;
  }
}

function appendPreviewExamples(
  lines: string[],
  title: string,
  entries: Array<{ action: string; label: string; reason?: string | null }>,
): void {
  if (entries.length === 0) return;
  lines.push("");
  lines.push(pc.bold(title));
  const shown = entries.slice(0, IMPORT_PREVIEW_SAMPLE_LIMIT);
  for (const entry of shown) {
    const reason = entry.reason?.trim()
      ? pc.dim(` (${entry.reason.trim()})`)
      : "";
    lines.push(`- ${actionChip(entry.action)} ${entry.label}${reason}`);
  }
  if (entries.length > shown.length) {
    lines.push(pc.dim(`- +${entries.length - shown.length} more`));
  }
}

function appendMessageBlock(
  lines: string[],
  title: string,
  messages: string[],
): void {
  if (messages.length === 0) return;
  lines.push("");
  lines.push(pc.bold(title));
  for (const message of messages) {
    lines.push(`- ${message}`);
  }
}

export function renderCompanyImportPreview(
  preview: CompanyPortabilityPreviewResult,
  meta: {
    sourceLabel: string;
    targetLabel: string;
    infoMessages?: string[];
  },
): string {
  const lines: string[] = [
    `${pc.bold("Source")}  ${meta.sourceLabel}`,
    `${pc.bold("Target")}  ${meta.targetLabel}`,
    `${pc.bold("Include")} ${summarizeInclude(preview.include)}`,
    `${pc.bold("Mode")}    ${preview.collisionStrategy} collisions`,
    "",
    pc.bold("Package"),
    `- company: ${preview.manifest.company?.name ?? preview.manifest.source?.companyName ?? "not included"}`,
    `- agents: ${preview.manifest.agents.length}`,
    `- projects: ${preview.manifest.projects.length}`,
    `- tasks: ${preview.manifest.tasks.length}`,
  ];

  if (preview.envInputs.length > 0) {
    const requiredCount = preview.envInputs.filter(
      (item) => item.requirement === "required",
    ).length;
    lines.push(
      `- env inputs: ${preview.envInputs.length} (${requiredCount} required)`,
    );
  }

  lines.push("");
  lines.push(pc.bold("Plan"));
  lines.push(
    `- company: ${actionChip(preview.plan.companyAction === "none" ? "unchanged" : preview.plan.companyAction)}`,
  );
  lines.push(
    `- agents: ${summarizePlanCounts(preview.plan.agentPlans, "agent")}`,
  );
  lines.push(
    `- projects: ${summarizePlanCounts(preview.plan.projectPlans, "project")}`,
  );
  lines.push(`- tasks: ${summarizePlanCounts(preview.plan.taskPlans, "task")}`);
  appendPreviewExamples(
    lines,
    "Agent examples",
    preview.plan.agentPlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedName}`,
      reason: plan.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Project examples",
    preview.plan.projectPlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedName}`,
      reason: plan.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Task examples",
    preview.plan.taskPlans.map((plan) => ({
      action: plan.action,
      label: `${plan.slug} -> ${plan.plannedTitle}`,
      reason: plan.reason,
    })),
  );

  appendMessageBlock(lines, pc.cyan("Info"), meta.infoMessages ?? []);
  appendMessageBlock(lines, pc.yellow("Warnings"), preview.warnings);
  appendMessageBlock(lines, pc.red("Errors"), preview.errors);

  return lines.join("\n");
}

export function renderCompanyImportResult(
  result: CompanyPortabilityImportResult,
  meta: { targetLabel: string; companyUrl?: string; infoMessages?: string[] },
): string {
  const lines: string[] = [
    `${pc.bold("Target")}  ${meta.targetLabel}`,
    `${pc.bold("Company")} ${result.company.name} (${actionChip(result.company.action)})`,
    `${pc.bold("Agents")}  ${summarizeImportAgentResults(result.agents)}`,
    `${pc.bold("Projects")} ${summarizeImportProjectResults(result.projects)}`,
  ];

  if (meta.companyUrl) {
    lines.splice(1, 0, `${pc.bold("URL")}     ${meta.companyUrl}`);
  }

  appendPreviewExamples(
    lines,
    "Agent results",
    result.agents.map((agent) => ({
      action: agent.action,
      label: `${agent.slug} -> ${agent.name}`,
      reason: agent.reason,
    })),
  );
  appendPreviewExamples(
    lines,
    "Project results",
    result.projects.map((project) => ({
      action: project.action,
      label: `${project.slug} -> ${project.name}`,
      reason: project.reason,
    })),
  );

  if (result.envInputs.length > 0) {
    lines.push("");
    lines.push(pc.bold("Env inputs"));
    lines.push(
      `- ${result.envInputs.length} ${pluralize(result.envInputs.length, "input")} may need values after import`,
    );
  }

  appendMessageBlock(lines, pc.cyan("Info"), meta.infoMessages ?? []);
  appendMessageBlock(lines, pc.yellow("Warnings"), result.warnings);

  return lines.join("\n");
}

function printCompanyImportView(
  title: string,
  body: string,
  opts?: { interactive?: boolean },
): void {
  if (opts?.interactive) {
    p.note(body, title);
    return;
  }
  console.log(pc.bold(title));
  console.log(body);
}

export function resolveCompanyImportApiPath(input: {
  dryRun: boolean;
  targetMode: "new_company" | "existing_company";
  companyId?: string | null;
}): string {
  if (input.targetMode === "existing_company") {
    const companyId = input.companyId;
    if (!companyId || !isCanonicalUuid(companyId)) {
      throw new Error(
        "Existing-company imports require an exact canonical company UUID to resolve the API route.",
      );
    }
    return input.dryRun
      ? apiPath`/api/companies/${companyId}/imports/preview`
      : apiPath`/api/companies/${companyId}/imports/apply`;
  }

  return input.dryRun
    ? "/api/companies/imports/preview"
    : "/api/companies/imports";
}

export function buildCompanyDashboardUrl(
  apiBase: string,
  companyId: string,
): string {
  if (!isCanonicalUuid(companyId)) {
    throw new Error("Company dashboard URLs require a canonical company UUID.");
  }
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${companyId}/dashboard`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolveCompanyImportApplyConfirmationMode(input: {
  yes?: boolean;
  interactive: boolean;
  json: boolean;
}): "skip" | "prompt" {
  if (input.yes) {
    return "skip";
  }
  if (input.json) {
    throw new Error(
      "Applying a company import with --json requires --yes. Use --dry-run first to inspect the preview.",
    );
  }
  if (!input.interactive) {
    throw new Error(
      "Applying a company import from a non-interactive terminal requires --yes. Use --dry-run first to inspect the preview.",
    );
  }
  return "prompt";
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await stat(path.resolve(inputPath));
    return true;
  } catch {
    return false;
  }
}

async function collectPackageFiles(
  root: string,
  current: string,
  files: Record<string, CompanyPortabilityFileEntry>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".git")) continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectPackageFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    if (!shouldIncludePortableFile(relativePath)) continue;
    files[relativePath] = readPortableFileEntry(
      relativePath,
      await readFile(absolutePath),
    );
  }
}

export async function resolveInlineSourceFromPath(inputPath: string): Promise<{
  rootPath: string;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  const resolved = path.resolve(inputPath);
  const resolvedStat = await stat(resolved);
  if (
    resolvedStat.isFile() &&
    path.extname(resolved).toLowerCase() === ".zip"
  ) {
    const archive = await readZipArchive(await readFile(resolved));
    const filteredFiles = Object.fromEntries(
      Object.entries(archive.files).filter(([relativePath]) =>
        shouldIncludePortableFile(relativePath),
      ),
    );
    return {
      rootPath: archive.rootPath ?? path.basename(resolved, ".zip"),
      files: filteredFiles,
    };
  }

  const rootDir = resolvedStat.isDirectory()
    ? resolved
    : path.dirname(resolved);
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  await collectPackageFiles(rootDir, rootDir, files);
  return {
    rootPath: path.basename(rootDir),
    files,
  };
}

export async function writeExportToFolder(
  outDir: string,
  exported: CompanyPortabilityExportResult,
): Promise<void> {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(exported.files)) {
    const filePath = resolveExportOutputPath(
      root,
      requirePortablePath(relativePath),
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    const writeValue = portableFileEntryToWriteValue(content);
    if (typeof writeValue === "string") {
      await writeFile(filePath, writeValue, "utf8");
    } else {
      await writeFile(filePath, writeValue);
    }
  }
}

export function resolveExportOutputPath(
  root: string,
  relativePath: string,
): string {
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, relativePath);
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (filePath !== resolvedRoot && !filePath.startsWith(rootPrefix)) {
    throw new Error(
      `Refusing to write export file outside output directory: ${relativePath}`,
    );
  }
  return filePath;
}

async function confirmOverwriteExportDirectory(outDir: string): Promise<void> {
  const root = path.resolve(outDir);
  const stats = await stat(root).catch(() => null);
  if (!stats) return;
  if (!stats.isDirectory()) {
    throw new Error(
      `Export output path ${root} exists and is not a directory.`,
    );
  }

  const entries = await readdir(root);
  if (entries.length === 0) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Export output directory ${root} already contains files. Re-run interactively or choose an empty directory.`,
    );
  }

  const confirmed = await p.confirm({
    message: `Overwrite existing files in ${root}?`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    throw new Error("Export cancelled.");
  }
}

export function assertCanonicalCompanyId(companyId: string): void {
  if (!isCanonicalUuid(companyId)) {
    throw new Error("Company ID must be an exact canonical company UUID.");
  }
}

export function assertDeleteConfirmation(
  companyId: string,
  opts: CompanyDeleteOptions,
): void {
  assertCanonicalCompanyId(companyId);
  if (!opts.yes) {
    throw new Error("Deletion requires --yes.");
  }

  const confirm = opts.confirm;
  if (!confirm) {
    throw new Error("Deletion requires --confirm <company-uuid>.");
  }

  if (confirm !== companyId) {
    throw new Error(
      `Confirmation '${confirm}' does not match exact company UUID '${companyId}'.`,
    );
  }
}

export function registerCompanyCommands(program: Command): void {
  const company = program.command("company").description("Company operations");

  addCommonClientOptions(
    company
      .command("list")
      .description("List companies")
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await listCompaniesForContext(ctx);
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          const formatted = rows.map((row) => ({
            id: row.id,
            name: row.name,
            status: row.status,
            budgetCurrency: row.budgetCurrency,
            budgetMonthlyAmount: row.budgetMonthlyAmount,
            knownSpendAmount: row.knownSpendAmount,
            requireBoardApprovalForNewAgents:
              row.requireBoardApprovalForNewAgents,
          }));
          for (const row of formatted) {
            console.log(formatInlineRecord(row));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("get")
      .description("Get one company")
      .argument("<companyId>", "Canonical company UUID")
      .action(async (companyId: string, opts: CompanyCommandOptions) => {
        try {
          assertCanonicalCompanyId(companyId);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Company>(
            apiPath`/api/companies/${companyId}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("current")
      .description(
        "Get the current scoped company from --company-id, PAPERCLIP_BOARD_COMPANY_ID, or a context profile",
      )
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const companyId = await resolveCurrentCompanyId(ctx);
          const row = await ctx.api.get<Company>(
            apiPath`/api/companies/${companyId}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    company
      .command("stats")
      .description("Get company stats")
      .action(async (opts: CompanyCommandOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/companies/stats"), {
            json: ctx.json,
          });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("create")
      .description("Create a company")
      .requiredOption("--payload-json <json>", "CreateCompany JSON payload")
      .action(async (opts: CompanyJsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await createCompanyForContext(
              ctx,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("update")
      .description("Update a company")
      .argument("<companyId>", "Canonical company UUID")
      .requiredOption("--payload-json <json>", "UpdateCompany JSON payload")
      .action(async (companyId: string, opts: CompanyJsonOptions) => {
        try {
          assertCanonicalCompanyId(companyId);
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.patch(
              apiPath`/api/companies/${companyId}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("branding:update")
      .description("Update company branding")
      .argument("<companyId>", "Canonical company UUID")
      .requiredOption(
        "--payload-json <json>",
        "UpdateCompanyBranding JSON payload",
      )
      .action(async (companyId: string, opts: CompanyJsonOptions) => {
        try {
          assertCanonicalCompanyId(companyId);
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.patch(
              apiPath`/api/companies/${companyId}/branding`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("archive")
      .description("Archive a company")
      .argument("<companyId>", "Canonical company UUID")
      .action(async (companyId: string, opts: CompanyCommandOptions) => {
        try {
          assertCanonicalCompanyId(companyId);
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.post(
              apiPath`/api/companies/${companyId}/archive`,
              {},
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCompanyJsonPost(
    company,
    "export:preview",
    "Preview a portable company export",
    "exports/preview",
  );
  addCompanyJsonPost(
    company,
    "export:api",
    "Export a company through the raw API route",
    "exports",
  );
  addCompanyJsonPost(
    company,
    "import:preview",
    "Preview a safe company import through the raw API route",
    "imports/preview",
  );
  addCompanyJsonPost(
    company,
    "import:apply",
    "Apply a safe company import through the raw API route",
    "imports/apply",
  );

  addCommonClientOptions(
    company
      .command("export")
      .description("Export a company into a portable markdown package")
      .argument("<companyId>", "Canonical company UUID")
      .requiredOption("--out <path>", "Output directory")
      .option(
        "--include <values>",
        "Comma-separated include set: company,agents,projects,tasks",
        DEFAULT_EXPORT_INCLUDE,
      )
      .option("--projects <values>", "Comma-separated project UUIDs to export")
      .option("--tasks <values>", "Comma-separated task UUIDs to export")
      .option(
        "--project-tasks <values>",
        "Comma-separated project UUIDs whose tasks should be exported",
      )
      .action(async (companyId: string, opts: CompanyExportOptions) => {
        try {
          assertCanonicalCompanyId(companyId);
          const ctx = resolveCommandContext(opts);
          const include = parseCompanyInclude(opts.include);
          const projectIds = parseExactSelectors(
            opts.projects,
            "Project UUIDs",
            isCanonicalUuid,
          );
          const taskIds = parseExactSelectors(
            opts.tasks,
            "Task UUIDs",
            isCanonicalUuid,
          );
          const projectTaskIds = parseExactSelectors(
            opts.projectTasks,
            "Project-task UUIDs",
            isCanonicalUuid,
          );
          const exported = await ctx.api.post<CompanyPortabilityExportResult>(
            apiPath`/api/companies/${companyId}/exports`,
            {
              include,
              ...(projectIds.length > 0 ? { projects: projectIds } : {}),
              ...(taskIds.length > 0 ? { tasks: taskIds } : {}),
              ...(projectTaskIds.length > 0
                ? { projectTasks: projectTaskIds }
                : {}),
            },
          );
          if (!exported) {
            throw new Error("Export request returned no data");
          }
          await confirmOverwriteExportDirectory(opts.out!);
          await writeExportToFolder(opts.out!, exported);
          printOutput(
            {
              ok: true,
              out: path.resolve(opts.out!),
              rootPath: exported.rootPath,
              filesWritten: Object.keys(exported.files).length,
              paperclipExtensionPath: exported.paperclipExtensionPath,
              warningCount: exported.warnings.length,
            },
            { json: ctx.json },
          );
          if (!ctx.json && exported.warnings.length > 0) {
            for (const warning of exported.warnings) {
              console.log(`warning=${warning}`);
            }
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("import")
      .description(
        "Import a portable markdown company package from a local path or canonical GitHub HTTPS URL",
      )
      .argument(
        "<source>",
        "Local filesystem path or canonical GitHub HTTPS URL",
      )
      .option(
        "--include <values>",
        "Comma-separated include set: company,agents,projects,tasks",
      )
      .option("--target <mode>", "Target mode: new | existing")
      .option("-C, --company-id <id>", "Existing target company ID")
      .option("--new-company-name <name>", "Name override for --target new")
      .option(
        "--agents <list>",
        "Comma-separated agent slugs to import, or all",
        "all",
      )
      .option(
        "--collision <mode>",
        "Collision strategy: rename | skip | replace",
        "rename",
      )
      .option(
        "--adapter-override <slug=type>",
        "Explicit adapter type for an imported agent slug; may be repeated",
        collectOptionValue,
        [] as string[],
      )
      .option(
        "--adapter-config <slug=json>",
        "Explicit adapter config JSON object for an imported agent slug; may be repeated",
        collectOptionValue,
        [] as string[],
      )
      .option(
        "--yes",
        "Accept default selection and skip the pre-import confirmation prompt",
        false,
      )
      .option("--dry-run", "Run preview only without applying", false)
      .action(async (source: string, opts: CompanyImportOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const interactiveView = isInteractiveTerminal() && !ctx.json;
          if (!source) {
            throw new Error(
              "Local filesystem path or canonical GitHub HTTPS URL is required.",
            );
          }

          const include = resolveImportInclude(opts.include);
          const agents = parseAgents(opts.agents);
          const collision = opts.collision ?? "rename";
          if (!["rename", "skip", "replace"].includes(collision)) {
            throw new Error(
              "Invalid --collision value. Use: rename, skip, replace",
            );
          }
          const adapterOverrides = parseExplicitAdapterOverrides(
            opts.adapterOverride,
            opts.adapterConfig,
          );

          const inferredTarget =
            opts.target ??
            (opts.companyId || ctx.companyId ? "existing" : "new");
          const target = inferredTarget;
          if (!["new", "existing"].includes(target)) {
            throw new Error("Invalid --target value. Use: new | existing");
          }

          const existingTargetCompanyId = opts.companyId ?? ctx.companyId;
          const targetPayload =
            target === "existing"
              ? {
                  mode: "existing_company" as const,
                  companyId: existingTargetCompanyId,
                }
              : {
                  mode: "new_company" as const,
                  newCompanyName: opts.newCompanyName?.trim() || null,
                };

          if (
            targetPayload.mode === "existing_company" &&
            !targetPayload.companyId
          ) {
            throw new Error(
              "Target existing company requires --company-id (or context default companyId).",
            );
          }

          let sourcePayload:
            | {
                type: "inline";
                rootPath?: string | null;
                files: Record<string, CompanyPortabilityFileEntry>;
              }
            | { type: "github"; url: string };

          const treatAsLocalPath = await pathExists(source);
          if (!treatAsLocalPath && source.includes("://")) {
            sourcePayload = {
              type: "github",
              url: validateCanonicalGithubImportSourceUrl(source),
            };
          } else {
            const inline = await resolveInlineSourceFromPath(source);
            sourcePayload = {
              type: "inline",
              rootPath: inline.rootPath,
              files: inline.files,
            };
          }

          const sourceLabel = formatSourceLabel(sourcePayload);
          const targetLabel = formatTargetLabel(targetPayload);
          const previewApiPath = resolveCompanyImportApiPath({
            dryRun: true,
            targetMode: targetPayload.mode,
            companyId:
              targetPayload.mode === "existing_company"
                ? targetPayload.companyId
                : null,
          });

          let selectedFiles: string[] | undefined;
          if (interactiveView && !opts.yes && opts.include === undefined) {
            const initialPreview =
              await ctx.api.post<CompanyPortabilityPreviewResult>(
                previewApiPath,
                {
                  source: sourcePayload,
                  include,
                  target: targetPayload,
                  agents,
                  collisionStrategy: collision,
                  adapterOverrides,
                },
              );
            if (!initialPreview) {
              throw new Error("Import preview returned no data.");
            }
            selectedFiles = await promptForImportSelection(initialPreview);
          }

          const previewPayload = {
            source: sourcePayload,
            include,
            target: targetPayload,
            agents,
            collisionStrategy: collision,
            selectedFiles,
            adapterOverrides,
          };
          const preview = await ctx.api.post<CompanyPortabilityPreviewResult>(
            previewApiPath,
            previewPayload,
          );
          if (!preview) {
            throw new Error("Import preview returned no data.");
          }

          if (opts.dryRun) {
            if (ctx.json) {
              printOutput(preview, { json: true });
            } else {
              printCompanyImportView(
                "Import Preview",
                renderCompanyImportPreview(preview, {
                  sourceLabel,
                  targetLabel: formatTargetLabel(targetPayload, preview),
                }),
                { interactive: interactiveView },
              );
            }
            return;
          }

          if (!ctx.json) {
            printCompanyImportView(
              "Import Preview",
              renderCompanyImportPreview(preview, {
                sourceLabel,
                targetLabel: formatTargetLabel(targetPayload, preview),
              }),
              { interactive: interactiveView },
            );
          }

          const confirmationMode = resolveCompanyImportApplyConfirmationMode({
            yes: opts.yes,
            interactive: interactiveView,
            json: ctx.json,
          });
          if (confirmationMode === "prompt") {
            const confirmed = await p.confirm({
              message: "Apply this import? (y/N)",
              initialValue: false,
            });
            if (p.isCancel(confirmed) || !confirmed) {
              p.log.warn("Import cancelled.");
              return;
            }
          }

          const importApiPath = resolveCompanyImportApiPath({
            dryRun: false,
            targetMode: targetPayload.mode,
            companyId:
              targetPayload.mode === "existing_company"
                ? targetPayload.companyId
                : null,
          });
          const imported = await ctx.api.post<CompanyPortabilityImportResult>(
            importApiPath,
            {
              ...previewPayload,
            },
          );
          if (!imported) {
            throw new Error("Import request returned no data.");
          }
          const tc = getTelemetryClient();
          if (tc) {
            const isPrivate = sourcePayload.type !== "github";
            const sourceRef =
              sourcePayload.type === "github" ? sourcePayload.url : source;
            trackCompanyImported(tc, {
              sourceType:
                sourcePayload.type === "inline" ? "local_path" : "github",
              sourceRef,
              isPrivate,
            });
          }
          const companyUrl = ctx.json
            ? undefined
            : buildCompanyDashboardUrl(ctx.api.apiBase, imported.company.id);
          if (ctx.json) {
            printOutput(imported, { json: true });
          } else {
            printCompanyImportView(
              "Import Result",
              renderCompanyImportResult(imported, {
                targetLabel,
                companyUrl,
              }),
              { interactive: interactiveView },
            );
            if (interactiveView && companyUrl) {
              const openImportedCompany = await p.confirm({
                message: "Open the imported company in your browser?",
                initialValue: true,
              });
              if (!p.isCancel(openImportedCompany) && openImportedCompany) {
                if (await openUrl(companyUrl)) {
                  p.log.info(`Opened ${companyUrl}`);
                } else {
                  p.log.warn(
                    `Could not open your browser automatically. Open this URL manually:\n${companyUrl}`,
                  );
                }
              }
            }
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    company
      .command("delete")
      .description("Delete a company by its exact canonical UUID (destructive)")
      .argument("<company-id>", "Exact canonical company UUID")
      .option(
        "--yes",
        "Required safety flag to confirm destructive action",
        false,
      )
      .option(
        "--confirm <company-id>",
        "Required safety value: exact canonical company UUID",
      )
      .action(async (companyId: string, opts: CompanyDeleteOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          assertDeleteConfirmation(companyId, opts);
          const target = await ctx.api.get<Company>(
            apiPath`/api/companies/${companyId}`,
          );
          if (!target || target.id !== companyId) {
            throw new Error(`No company found with exact UUID '${companyId}'.`);
          }

          await ctx.api.delete<{ ok: true }>(
            apiPath`/api/companies/${companyId}`,
          );

          printOutput(
            {
              ok: true,
              deletedCompanyId: target.id,
              deletedCompanyName: target.name,
              deletedTaskPrefix: target.taskPrefix,
            },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function listCompaniesForContext(ctx: {
  companyId?: string;
  api: { get<T>(path: string): Promise<T | null> };
}): Promise<Company[]> {
  try {
    return (await ctx.api.get<Company[]>("/api/companies")) ?? [];
  } catch (error) {
    if (!isBoardAccessRequiredError(error)) {
      throw error;
    }
  }

  const companyId = await resolveCurrentCompanyId(ctx);
  const scopedCompany = await ctx.api.get<Company>(
    apiPath`/api/companies/${companyId}`,
  );
  return scopedCompany ? [scopedCompany] : [];
}

async function createCompanyForContext(
  ctx: {
    api: { post<T>(path: string, body?: unknown): Promise<T | null> };
  },
  payload: unknown,
): Promise<unknown> {
  try {
    return await ctx.api.post("/api/companies", payload);
  } catch (error) {
    if (
      isBoardAccessRequiredError(error) ||
      isInstanceAdminRequiredError(error)
    ) {
      throw new Error(
        "Creating companies requires board/instance-admin authentication. Use `paperclipai company list --json` or `paperclipai company current --json` to select a company, or rerun create with a board token/login.",
      );
    }
    throw error;
  }
}

async function resolveCurrentCompanyId(ctx: {
  companyId?: string;
  api: { get<T>(path: string): Promise<T | null> };
}): Promise<string> {
  if (ctx.companyId) return ctx.companyId;
  throw new Error(
    "Current company is not available. Pass --company-id, set PAPERCLIP_BOARD_COMPANY_ID, or set a context profile companyId.",
  );
}

function isBoardAccessRequiredError(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    error.status === 403 &&
    error.message.toLowerCase().includes("board access required")
  );
}

function isInstanceAdminRequiredError(
  error: unknown,
): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    error.status === 403 &&
    error.message.toLowerCase().includes("instance admin")
  );
}

function addCompanyJsonPost(
  parent: Command,
  name: string,
  description: string,
  pathSuffix: string,
): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<companyId>", "Canonical company UUID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (companyId: string, opts: CompanyJsonOptions) => {
        try {
          assertCanonicalCompanyId(companyId);
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.post(
              `${apiPath`/api/companies/${companyId}`}/${pathSuffix}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
