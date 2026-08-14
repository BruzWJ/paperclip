import path from "node:path";
import type {
  CompanyPortabilityFileEntry,
  CompanyPortabilityInclude,
  CompanyPortabilitySidebarOrder,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { requirePortablePath } from "./portable-path.js";
import { normalizeSlug } from "./slug.js";
import {
  DEFAULT_INCLUDE,
  COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS,
} from "./company-portability-manifest-types.js";
import { isPlainRecord, readOptionalPortablePath } from "./company-portability-format-support.js";
import { requireSelectedFiles, parseYamlFile, buildYamlFile } from "./company-portability-yaml-codec.js";
import { stripEmptyValues } from "./company-portability-format-support.js";

export * from "./company-portability-format-support.js";

export function uniqueSlug(base: string, used: Set<string>) {
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

export function stableEntitySlugMap<T extends { id: string; name: string }>(rows: T[], fallback: string) {
  const used = new Set<string>();
  const slugById = new Map<string, string>();
  const ordered = [...rows].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  for (const row of ordered) {
    const base = normalizeSlug(row.name) ?? fallback;
    slugById.set(row.id, uniqueSlug(base, used));
  }
  return slugById;
}

export function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
    projects: input?.projects ?? DEFAULT_INCLUDE.projects,
    tasks: input?.tasks ?? DEFAULT_INCLUDE.tasks,
  };
}

export function isPortableBinaryFile(
  value: CompanyPortabilityFileEntry,
): value is Extract<CompanyPortabilityFileEntry, { encoding: "base64" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    value.encoding === "base64" &&
    typeof value.data === "string"
  );
}

export function readPortableTextFile(files: Record<string, CompanyPortabilityFileEntry>, filePath: string) {
  const value = files[filePath];
  return typeof value === "string" ? value : null;
}

export function inferContentTypeFromPath(filePath: string) {
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

export function resolveCompanyLogoExtension(
  contentType: string | null | undefined,
  originalFilename: string | null | undefined,
) {
  const fromContentType = contentType
    ? COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase()]
    : null;
  if (fromContentType) return fromContentType;

  const extension = originalFilename ? path.extname(originalFilename).toLowerCase() : "";
  return extension || ".png";
}

export function portableBinaryFileToBuffer(
  entry: Extract<CompanyPortabilityFileEntry, { encoding: "base64" }>,
) {
  return Buffer.from(entry.data, "base64");
}

export function portableFileToBuffer(entry: CompanyPortabilityFileEntry, filePath: string) {
  if (typeof entry === "string") {
    return Buffer.from(entry, "utf8");
  }
  if (isPortableBinaryFile(entry)) {
    return portableBinaryFileToBuffer(entry);
  }
  throw unprocessable(`Unsupported file entry encoding for ${filePath}`);
}

export function bufferToPortableBinaryFile(
  buffer: Buffer,
  contentType: string | null,
): CompanyPortabilityFileEntry {
  return {
    encoding: "base64",
    data: buffer.toString("base64"),
    contentType,
  };
}

export async function streamToBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function validateFileMap(
  files: Record<string, CompanyPortabilityFileEntry>,
  rootPath?: string | null,
): Record<string, CompanyPortabilityFileEntry> {
  const sourceRoot =
    rootPath === undefined || rootPath === null
      ? null
      : requirePortablePath(rootPath, "Inline source root path");
  const out: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(files)) {
    requirePortablePath(filePath, "Package file path");
    if (sourceRoot && (filePath === sourceRoot || filePath.startsWith(`${sourceRoot}/`))) {
      throw unprocessable(`Package file paths must be relative to inline source root ${sourceRoot}`);
    }
    out[filePath] = content;
  }
  return out;
}

export function collectSelectedExportSlugs(selectedFiles: Set<string>) {
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

export function normalizePortableSlugList(value: unknown) {
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

export function normalizePortableSidebarOrder(value: unknown): CompanyPortabilitySidebarOrder | null {
  if (!isPlainRecord(value)) return null;
  const sidebar = {
    agents: normalizePortableSlugList(value.agents),
    projects: normalizePortableSlugList(value.projects),
  };
  return sidebar.agents.length > 0 || sidebar.projects.length > 0 ? sidebar : null;
}

export function sortAgentsBySidebarOrder<T extends { id: string; name: string; reportsTo: string | null }>(
  agents: T[],
) {
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

export function filterPortableExtensionYaml(yaml: string, selectedFiles: Set<string>) {
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
    const logoPath = readOptionalPortablePath(companySection.logoPath, "Company logo path");
    if (logoPath && !selectedFiles.has(logoPath)) {
      delete companySection.logoPath;
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

export function filterExportFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  selectedFilesInput: string[] | undefined,
  paperclipExtensionPath: string,
) {
  if (!selectedFilesInput) {
    return files;
  }

  const selectedFiles = requireSelectedFiles(selectedFilesInput);
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

export function findPaperclipExtensionPath(files: Record<string, CompanyPortabilityFileEntry>) {
  if (typeof files[".paperclip.yaml"] === "string") return ".paperclip.yaml";
  if (typeof files[".paperclip.yml"] === "string") return ".paperclip.yml";
  return (
    Object.keys(files).find(
      (entry) => entry.endsWith("/.paperclip.yaml") || entry.endsWith("/.paperclip.yml"),
    ) ?? null
  );
}
