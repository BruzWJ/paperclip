import path from "node:path";
import { unprocessable } from "../errors.js";
import { requirePortablePath, resolvePortablePath } from "./portable-path.js";
import { createHash } from "node:crypto";
import {
  decodeTaskDisposition,
  parseBudgetCurrency,
  parseMoneyAmount,
  type AgentVisibleTaskStatus,
  type CompanyPortabilityTaskManifestEntry,
  type TaskDisposition,
  type TaskStatus,
  type CompanyPortabilityFileEntry,
  type CompanyPortabilityEnvInput,
  type CompanyPortabilityManifest,
  type AgentEnvConfig,
} from "@paperclipai/shared";
import { TaskExecutionWorkspaceReservationRejected } from "./execution-workspaces.js";
import {
  type ResolvedSource,
  CompanyPackageIncludeEntry,
  EnvInputRecord,
} from "./company-portability-manifest-types.js";
import { buildManifestFromPackageFiles } from "./company-portability-manifest-parser.js";
import {
  buildMarkdown,
  parseFrontmatterMarkdown,
  requireSelectedFiles,
} from "./company-portability-yaml-codec.js";
import { ghFetch } from "./github-fetch.js";

export function ensureMarkdownPath(pathValue: string) {
  const filePath = requirePortablePath(pathValue, "Manifest file path");
  if (!filePath.endsWith(".md")) {
    throw unprocessable(`Manifest file path must end in .md: ${pathValue}`);
  }
  return filePath;
}

export function isAbsoluteCommand(value: string) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

export function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function isEmptyObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

export function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

export function stripEmptyValues(
  value: unknown,
  opts?: {
    preserveEmptyStrings?: boolean;
    preserveEmptyCollections?: boolean;
    preserveNullKeys?: readonly string[];
  },
): unknown {
  if (Array.isArray(value)) {
    const next = value.map((entry) => stripEmptyValues(entry, opts)).filter((entry) => entry !== undefined);
    return next.length > 0 || opts?.preserveEmptyCollections ? next : undefined;
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null && opts?.preserveNullKeys?.includes(key)) {
        next[key] = null;
        continue;
      }
      const cleaned = stripEmptyValues(entry, opts);
      if (cleaned === undefined) continue;
      next[key] = cleaned;
    }
    return Object.keys(next).length > 0 || opts?.preserveEmptyCollections ? next : undefined;
  }
  if (
    value === undefined ||
    value === null ||
    (!opts?.preserveEmptyStrings && value === "") ||
    (!opts?.preserveEmptyCollections && (isEmptyArray(value) || isEmptyObject(value)))
  ) {
    return undefined;
  }
  return value;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

export function readOptionalPortablePath(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw unprocessable(`${label} must be a portable relative path or null`);
  }
  return requirePortablePath(value, label);
}

export function portableBudgetCurrency(value: unknown, subject: string) {
  try {
    return parseBudgetCurrency(value);
  } catch {
    throw unprocessable(`${subject} must be an exact supported budget currency`);
  }
}

export function portableMoneyAmount(value: unknown, subject: string) {
  try {
    return parseMoneyAmount(value);
  } catch {
    throw unprocessable(`${subject} must be a canonical decimal string`);
  }
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function normalizePortableDisposition(
  value: unknown,
  lifecycleStatus: CompanyPortabilityTaskManifestEntry["lifecycleStatus"],
  subjectLabel: string,
) {
  const terminal = lifecycleStatus === "done" || lifecycleStatus === "cancelled";
  if (value == null) {
    if (terminal) {
      throw unprocessable(`${subjectLabel} requires a disposition when lifecycleStatus is terminal`);
    }
    return null;
  }
  if (!terminal) {
    throw unprocessable(`${subjectLabel} cannot carry a disposition while lifecycleStatus is nonterminal`);
  }
  try {
    return decodeTaskDisposition(value);
  } catch {
    throw unprocessable(
      `${subjectLabel} disposition must contain only a non-empty message and optional structuredResult`,
    );
  }
}

export { deterministicUuid as deterministicPortableUuid } from "./deterministic-uuid.js";

export function stablePortableSessionId(key: string): string {
  return `ses_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

export async function withPortableWorkspaceReservationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaskExecutionWorkspaceReservationRejected) {
      throw unprocessable(error.message, { code: error.reason });
    }
    throw error;
  }
}

export function canonicalPortableJson(value: unknown): string {
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
    .map((key) => `${JSON.stringify(key)}:${canonicalPortableJson(record[key])}`)
    .join(",")}}`;
}

export interface PortableCanonicalTaskCreateInput {
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

export * from "./company-portability-yaml-codec.js";

export function readSelectedFiles(selectedFiles?: string[]) {
  if (!selectedFiles) return null;
  return requireSelectedFiles(selectedFiles);
}

export function filterCompanyMarkdownIncludes(
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

export function applySelectedFilesToSource(source: ResolvedSource, selectedFiles?: string[]): ResolvedSource {
  const selectedFilePaths = readSelectedFiles(selectedFiles);
  if (!selectedFilePaths) return source;

  const companyPath = source.manifest.company
    ? ensureMarkdownPath(source.manifest.company.path)
    : (Object.keys(source.files).find((entry) => entry.endsWith("/COMPANY.md") || entry === "COMPANY.md") ??
      null);
  if (!companyPath) {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const companyMarkdown = source.files[companyPath];
  if (typeof companyMarkdown !== "string") {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const effectiveFiles: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(source.files)) {
    requirePortablePath(filePath, "Package file path");
    if (!selectedFilePaths.has(filePath)) continue;
    effectiveFiles[filePath] = content;
  }

  effectiveFiles[companyPath] = filterCompanyMarkdownIncludes(
    companyPath,
    companyMarkdown,
    selectedFilePaths,
  );
  const canonicalManifest = source.files[".paperclip.yaml"];
  if (canonicalManifest === undefined) {
    throw unprocessable("Company package is missing the canonical .paperclip.yaml manifest");
  }
  effectiveFiles[".paperclip.yaml"] = canonicalManifest;

  const filtered = buildManifestFromPackageFiles(effectiveFiles, {
    sourceLabel: source.manifest.source,
  });

  if (!selectedFilePaths.has(companyPath)) {
    filtered.manifest.company = null;
  }

  filtered.manifest.includes = {
    company: filtered.manifest.company !== null,
    agents: filtered.manifest.agents.length > 0,
    projects: filtered.manifest.projects.length > 0,
    tasks: filtered.manifest.tasks.length > 0,
  };

  return filtered;
}

export async function fetchText(url: string) {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchOptionalText(url: string) {
  const response = await ghFetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchBinary(url: string) {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchJson<T>(url: string): Promise<T> {
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

export function dedupeEnvInputs(values: CompanyPortabilityManifest["envInputs"]) {
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

export function buildEnvInputMap(inputs: CompanyPortabilityEnvInput[]) {
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

export function envInputScopedKey(input: CompanyPortabilityEnvInput) {
  if (input.projectSlug) return `project:${input.projectSlug}:${input.key}`;
  return input.key;
}

export function envInputValue(
  input: CompanyPortabilityEnvInput,
  values: Record<string, string> | null | undefined,
) {
  if (!values) return null;
  const scopedKey = envInputScopedKey(input);
  if (Object.prototype.hasOwnProperty.call(values, scopedKey)) return values[scopedKey];
  if (Object.prototype.hasOwnProperty.call(values, input.key)) return values[input.key];
  return null;
}

export function importSecretLabel(input: CompanyPortabilityEnvInput) {
  const scope = input.projectSlug ? `project ${input.projectSlug}` : "company import";
  return `${scope} ${input.key}`;
}

export function importSecretKey(input: CompanyPortabilityEnvInput, suffix: string) {
  const scope = input.projectSlug ? `project-${input.projectSlug}` : "company";
  return `import-${scope}-${input.key}-${suffix}`;
}

export function writeManifestEnvBinding(
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

export function readCompanyApprovalDefault(_frontmatter: Record<string, unknown>) {
  return false;
}

export function readIncludeEntries(frontmatter: Record<string, unknown>): CompanyPackageIncludeEntry[] {
  const includes = frontmatter.includes;
  if (includes === undefined) return [];
  if (!Array.isArray(includes)) {
    throw unprocessable("Company includes must be an array of portable paths");
  }

  const seen = new Set<string>();
  return includes.map((entry, index) => {
    if (typeof entry !== "string") {
      throw unprocessable(`Company include ${index + 1} must be a path string`);
    }
    const includePath = requirePortablePath(entry, "Company include path");
    if (seen.has(includePath)) {
      throw unprocessable(`Company include path is duplicated: ${includePath}`);
    }
    seen.add(includePath);
    return { path: includePath };
  });
}

export function readProjectEnvInputs(
  extension: Record<string, unknown>,
  projectSlug: string,
): CompanyPortabilityManifest["envInputs"] {
  const inputs = isPlainRecord(extension.inputs) ? extension.inputs : null;
  const env = inputs && isPlainRecord(inputs.env) ? inputs.env : null;
  if (!env) return [];

  return Object.entries(env).flatMap(([key, value]) => {
    if (!isPlainRecord(value)) return [];
    const record = value as EnvInputRecord;
    return [
      {
        key,
        description: asString(record.description) ?? null,
        projectSlug,
        kind: record.kind === "plain" ? "plain" : "secret",
        requirement: record.requirement === "required" ? "required" : "optional",
        defaultValue: typeof record.default === "string" ? record.default : null,
        portability: record.portability === "system_dependent" ? "system_dependent" : "portable",
      },
    ];
  });
}
