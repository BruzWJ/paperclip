import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityFileEntry,
  CompanyPortabilityPreviewResult,
  CompanyPortabilitySource,
  CompanyPortabilityAdapterOverride,
} from "@paperclipai/shared";
import { parseCanonicalGithubImportSourceUrl } from "@paperclipai/shared/company-portability-source";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useToastActions } from "@/context/ToastContext";
import { authApi } from "@/api/auth";
import { companiesApi } from "@/api/companies";
import { sidebarPreferencesApi } from "@/api/sidebarPreferences";
import { queryKeys } from "@/lib/queryKeys";
import { getAgentOrderStorageKey, writeAgentOrder } from "@/lib/agent-order";
import { Button } from "@/components/ui/button";
import { CompanyPortabilityFilePreview } from "@/components/CompanyPortabilityFilePreview";
import { AgentConfigForm } from "@/components/AgentConfigForm";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  Github,
  Upload,
} from "lucide-react";
import { Field } from "@/components/agent-config-primitives";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { getUIAdapter, listUIAdapters } from "@/adapters";
import { useAdapterCatalogSyncState } from "@/adapters/use-adapter-catalog";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  type FileTreeNode,
  type FileTreeTone,
  buildFileTree,
  countFiles,
  toggleFileTreeCheckedFiles,
  FileTree,
} from "@/components/FileTree";
import { readZipArchive } from "@/lib/zip";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute(
  "/_authenticated/$companyId/company/import/",
)({ component: CompanyImport });

// ── Import-specific helpers ───────────────────────────────────────────

/** Build a map from file path → planned action (create/update/skip) using the manifest + plan */
function buildActionMap(
  preview: CompanyPortabilityPreviewResult,
): Map<string, string> {
  const map = new Map<string, string>();
  const manifest = preview.manifest;

  for (const ap of preview.plan.agentPlans) {
    const agent = manifest.agents.find((a) => a.slug === ap.slug);
    if (agent) {
      const path = ensureMarkdownPath(agent.path);
      map.set(path, ap.action);
    }
  }

  for (const pp of preview.plan.projectPlans) {
    const project = manifest.projects.find((p) => p.slug === pp.slug);
    if (project) {
      const path = ensureMarkdownPath(project.path);
      map.set(path, pp.action);
    }
  }

  for (const ip of preview.plan.taskPlans) {
    const task = manifest.tasks.find((i) => i.slug === ip.slug);
    if (task) {
      const path = ensureMarkdownPath(task.path);
      map.set(path, ip.action);
    }
  }

  // Company file
  if (manifest.company) {
    const path = ensureMarkdownPath(manifest.company.path);
    map.set(
      path,
      preview.plan.companyAction === "none"
        ? "skip"
        : preview.plan.companyAction,
    );
  }

  return map;
}

function ensureMarkdownPath(p: string): string {
  return p.endsWith(".md") ? p : `${p}.md`;
}

const ACTION_COLORS: Record<string, string> = {
  create: "text-emerald-500 border-emerald-500/30",
  update: "text-amber-500 border-amber-500/30",
  overwrite: "text-red-500 border-red-500/30",
  replace: "text-red-500 border-red-500/30",
  skip: "text-muted-foreground border-border",
  none: "text-muted-foreground border-border",
};

// ── Import file tree customization ───────────────────────────────────

function renderImportFileExtra(
  node: FileTreeNode,
  checked: boolean,
  renameMap: Map<string, string>,
) {
  // Show rename indicator only on directories (folders), not individual files
  const renamedTo = node.kind === "dir" ? renameMap.get(node.path) : undefined;
  const actionBadge = node.action ? (
    <Badge
      variant="outline"
      className={cn(
        "text-(length:--text-nano) uppercase tracking-wide",
        ACTION_COLORS[node.action] ?? ACTION_COLORS.skip,
      )}
    >
      {checked ? node.action : "skip"}
    </Badge>
  ) : null;

  if (!actionBadge && !renamedTo) return null;

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      {renamedTo && checked && (
        <span
          className="text-(length:--text-nano) text-cyan-500 font-mono truncate max-w-(--sz-7rem)"
          title={renamedTo}
        >
          &rarr; {renamedTo}
        </span>
      )}
      {actionBadge}
    </span>
  );
}

// ── Conflict item type ───────────────────────────────────────────────

interface ConflictItem {
  slug: string;
  kind: "agent" | "project" | "task";
  originalName: string;
  plannedName: string;
  filePath: string | null;
  action: "rename" | "update";
}

function buildConflictList(
  preview: CompanyPortabilityPreviewResult,
): ConflictItem[] {
  const conflicts: ConflictItem[] = [];
  const manifest = preview.manifest;

  // Agents with collisions
  for (const ap of preview.plan.agentPlans) {
    if (ap.existingAgentId) {
      const agent = manifest.agents.find((a) => a.slug === ap.slug);
      conflicts.push({
        slug: ap.slug,
        kind: "agent",
        originalName: agent?.name ?? ap.slug,
        plannedName: ap.plannedName,
        filePath: agent ? ensureMarkdownPath(agent.path) : null,
        action: ap.action === "update" ? "update" : "rename",
      });
    }
  }

  // Projects with collisions
  for (const pp of preview.plan.projectPlans) {
    if (pp.existingProjectId) {
      const project = manifest.projects.find((p) => p.slug === pp.slug);
      conflicts.push({
        slug: pp.slug,
        kind: "project",
        originalName: project?.name ?? pp.slug,
        plannedName: pp.plannedName,
        filePath: project ? ensureMarkdownPath(project.path) : null,
        action: pp.action === "update" ? "update" : "rename",
      });
    }
  }

  return conflicts;
}

/** Extract a prefix from the import source URL or uploaded zip package name */
function deriveSourcePrefix(
  sourceMode: string,
  importUrl: string,
  localPackageName: string | null,
  localRootPath: string | null,
): string | null {
  if (sourceMode === "local") {
    if (localRootPath) return localRootPath.split("/").pop() ?? null;
    if (!localPackageName) return null;
    return localPackageName.replace(/\.zip$/i, "") || null;
  }
  if (sourceMode === "github") {
    if (importUrl.length === 0) return null;
    try {
      const { basePath, repo } = parseCanonicalGithubImportSourceUrl(importUrl);
      return basePath.split("/").at(-1) ?? repo;
    } catch {
      return null;
    }
  }
  return null;
}

/** Generate a prefix-based rename: e.g. "gstack" + "Lead" → "gstack-Lead" */
function prefixedName(prefix: string | null, originalName: string): string {
  if (!prefix) return originalName;
  return `${prefix}-${originalName}`;
}

async function applyImportedSidebarOrder(
  preview: CompanyPortabilityPreviewResult | null,
  result: {
    company: { id: string };
    agents: Array<{ slug: string; id: string | null }>;
    projects: Array<{ slug: string; id: string | null }>;
  },
  userId: string | null | undefined,
) {
  const sidebar = preview?.manifest.sidebar;
  if (!sidebar) return;
  if (!userId || userId.trim() !== userId) return;

  const agentIdBySlug = new Map(
    result.agents
      .filter(
        (agent): agent is { slug: string; id: string } =>
          typeof agent.id === "string" && agent.id.length > 0,
      )
      .map((agent) => [agent.slug, agent.id]),
  );
  const projectIdBySlug = new Map(
    result.projects
      .filter(
        (project): project is { slug: string; id: string } =>
          typeof project.id === "string" && project.id.length > 0,
      )
      .map((project) => [project.slug, project.id]),
  );

  const orderedAgentIds = sidebar.agents
    .map((slug) => agentIdBySlug.get(slug))
    .filter((id): id is string => Boolean(id));
  const orderedProjectIds = sidebar.projects
    .map((slug) => projectIdBySlug.get(slug))
    .filter((id): id is string => Boolean(id));

  if (orderedAgentIds.length > 0) {
    writeAgentOrder(
      getAgentOrderStorageKey(result.company.id, userId),
      orderedAgentIds,
    );
  }
  if (orderedProjectIds.length > 0) {
    await sidebarPreferencesApi.updateProjectOrder(result.company.id, userId, {
      orderedIds: orderedProjectIds,
    });
  }
}

// ── Conflict resolution UI ───────────────────────────────────────────

function ConflictResolutionList({
  conflicts,
  nameOverrides,
  skippedSlugs,
  confirmedSlugs,
  onRename,
  onToggleSkip,
  onToggleConfirm,
}: {
  conflicts: ConflictItem[];
  nameOverrides: Record<string, string>;
  skippedSlugs: Set<string>;
  confirmedSlugs: Set<string>;
  onRename: (slug: string, newName: string) => void;
  onToggleSkip: (slug: string, filePath: string | null) => void;
  onToggleConfirm: (slug: string) => void;
}) {
  if (conflicts.length === 0) return null;

  return (
    <div className="mx-5 mt-3">
      <div className="rounded-md border border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-medium">Renames</h3>
          <span className="text-xs text-muted-foreground">
            {conflicts.length} item{conflicts.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="divide-y divide-border">
          {conflicts.map((item) => {
            const isSkipped = skippedSlugs.has(item.slug);
            const isConfirmed = confirmedSlugs.has(item.slug);
            const currentName = nameOverrides[item.slug] ?? item.plannedName;
            return (
              <div
                key={item.slug}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 text-sm",
                  isSkipped && "opacity-40",
                  isConfirmed && !isSkipped && "bg-emerald-500/5",
                )}
              >
                {/* Skip button on the left */}
                <button
                  type="button"
                  className={cn(
                    "shrink-0 rounded-md border px-2.5 py-1 text-xs transition-colors",
                    isSkipped
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50",
                  )}
                  onClick={() => onToggleSkip(item.slug, item.filePath)}
                >
                  {isSkipped ? "skipped" : "skip"}
                </button>

                <Badge
                  variant="outline"
                  className={cn(
                    "text-(length:--text-nano) uppercase tracking-wide",
                    isSkipped
                      ? "text-muted-foreground border-border"
                      : isConfirmed
                        ? "text-emerald-500 border-emerald-500/30"
                        : "text-amber-500 border-amber-500/30",
                  )}
                >
                  {item.kind}
                </Badge>

                <span
                  className={cn(
                    "shrink-0 font-mono text-xs",
                    isSkipped
                      ? "text-muted-foreground line-through"
                      : "text-muted-foreground",
                  )}
                >
                  {item.originalName}
                </span>

                {!isSkipped && (
                  <>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    {isConfirmed ? (
                      <span className="min-w-0 flex-1 font-mono text-xs text-emerald-500">
                        {currentName}
                      </span>
                    ) : (
                      <input
                        aria-label={`Rename ${item.originalName}`}
                        className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs outline-none focus:border-foreground"
                        value={currentName}
                        onChange={(e) => onRename(item.slug, e.target.value)}
                      />
                    )}
                  </>
                )}

                {/* Confirm rename button on the right */}
                {!isSkipped && (
                  <button
                    type="button"
                    className={cn(
                      "ml-auto shrink-0 rounded-md border px-2.5 py-1 text-xs transition-colors inline-flex items-center gap-1.5",
                      isConfirmed
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                        : "border-border text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => onToggleConfirm(item.slug)}
                  >
                    {isConfirmed ? (
                      <>
                        <Check className="h-3 w-3" />
                        confirmed
                      </>
                    ) : (
                      "confirm rename"
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Adapter picker for imported agents ───────────────────────────────

interface AdapterPickerItem {
  slug: string;
  name: string;
}

function AdapterPickerList({
  agents,
  adapterOverrides,
  expandedSlugs,
  configValues,
  onChangeAdapter,
  onToggleExpand,
  onChangeConfig,
}: {
  agents: AdapterPickerItem[];
  adapterOverrides: Record<string, string>;
  expandedSlugs: Set<string>;
  configValues: Record<string, CreateConfigValues>;
  onChangeAdapter: (slug: string, adapterType: string) => void;
  onToggleExpand: (slug: string) => void;
  onChangeConfig: (slug: string, patch: Partial<CreateConfigValues>) => void;
}) {
  const { adapters: admittedAdapters } = useAdapterCatalogSyncState();
  const adapterOptions = useMemo(
    () =>
      listUIAdapters().map((adapter) => ({
        value: adapter.type,
        label: adapter.label,
      })),
    [admittedAdapters],
  );
  if (agents.length === 0) return null;

  return (
    <div className="mx-5 mt-3">
      <div className="rounded-md border border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-medium">Adapters</h3>
          <span className="text-xs text-muted-foreground">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="divide-y divide-border">
          {agents.map((agent) => {
            const selectedType = adapterOverrides[agent.slug] ?? "";
            const isExpanded = expandedSlugs.has(agent.slug);
            const vals = configValues[agent.slug] ?? {
              ...defaultCreateValues,
              adapterType: selectedType,
            };
            return (
              <div key={agent.slug}>
                <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-(length:--text-nano) uppercase tracking-wide",
                      "text-blue-500 border-blue-500/30",
                    )}
                  >
                    agent
                  </Badge>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {agent.name}
                  </span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <Select
                    value={selectedType || "__placeholder__"}
                    onValueChange={(v) => onChangeAdapter(agent.slug, v)}
                  >
                    <SelectTrigger
                      aria-label="Target adapter"
                      className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-foreground"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__placeholder__" disabled>
                        Select target adapter
                      </SelectItem>
                      {adapterOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {selectedType
                      ? "Operator-managed native"
                      : "Select an adapter first"}
                  </span>
                  <button
                    type="button"
                    className={cn(
                      "ml-auto shrink-0 rounded-md border px-2.5 py-1 text-xs transition-colors inline-flex items-center gap-1.5",
                      isExpanded
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => onToggleExpand(agent.slug)}
                    disabled={!selectedType}
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 transition-transform",
                        isExpanded && "rotate-90",
                      )}
                    />
                    configure adapter
                  </button>
                </div>
                {isExpanded && selectedType && (
                  <div className="border-t border-border bg-accent/10 px-4 py-3 space-y-3">
                    <AgentConfigForm
                      mode="create"
                      values={vals}
                      onChange={(patch) => onChangeConfig(agent.slug, patch)}
                      showAdapterTypeField={false}
                      sectionLayout="cards"
                      applyAdapterSchemaDefaults={false}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

async function readLocalPackageZip(file: File): Promise<{
  name: string;
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
}> {
  if (!/\.zip$/i.test(file.name)) {
    throw new Error("Select a .zip company package.");
  }
  const archive = await readZipArchive(await file.arrayBuffer());
  if (Object.keys(archive.files).length === 0) {
    throw new Error("No package files were found in the selected zip archive.");
  }
  return {
    name: file.name,
    rootPath: archive.rootPath,
    files: archive.files,
  };
}

// ── Main page ─────────────────────────────────────────────────────────

export function CompanyImport() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const packageInputRef = useRef<HTMLInputElement | null>(null);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user.id ?? null;

  // Source state
  const [sourceMode, setSourceMode] = useState<"github" | "local">("github");
  const [importUrl, setImportUrl] = useState("");
  const [localPackage, setLocalPackage] = useState<{
    name: string;
    rootPath: string | null;
    files: Record<string, CompanyPortabilityFileEntry>;
  } | null>(null);

  // Target state
  const [targetMode, setTargetMode] = useState<"existing" | "new">("new");
  const [newCompanyName, setNewCompanyName] = useState("");

  // Preview state
  const [importPreview, setImportPreview] =
    useState<CompanyPortabilityPreviewResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());

  // Conflict resolution state
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>(
    {},
  );
  const [skippedSlugs, setSkippedSlugs] = useState<Set<string>>(new Set());
  const [confirmedSlugs, setConfirmedSlugs] = useState<Set<string>>(new Set());
  const [collisionStrategy, setCollisionStrategy] =
    useState<CompanyPortabilityCollisionStrategy>("rename");

  // Adapter override state
  const [adapterOverrides, setAdapterOverrides] = useState<
    Record<string, string>
  >({});
  const [adapterExpandedSlugs, setAdapterExpandedSlugs] = useState<Set<string>>(
    new Set(),
  );
  const [adapterConfigValues, setAdapterConfigValues] = useState<
    Record<string, CreateConfigValues>
  >({});

  const localZipHelpText =
    "Upload a .zip exported directly from Paperclip. Re-zipped archives created by Finder, Explorer, or other zip tools may not import correctly.";

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Org Chart",
        renderLink: (content) => (
          <Link to="/$companyId/org" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Import" },
    ]);
  }, [companyId, setBreadcrumbs]);

  function buildSource(): CompanyPortabilitySource | null {
    if (sourceMode === "local") {
      if (!localPackage) return null;
      return {
        type: "inline",
        rootPath: localPackage.rootPath,
        files: localPackage.files,
      };
    }
    if (importUrl.length === 0) return null;
    return { type: "github", url: importUrl };
  }

  // Preview mutation
  const previewMutation = useMutation({
    mutationFn: () => {
      const source = buildSource();
      if (!source) throw new Error("No source configured.");
      return companiesApi.importPreview({
        source,
        include: { company: true, agents: true, projects: true, tasks: true },
        target:
          targetMode === "new"
            ? { mode: "new_company", newCompanyName: newCompanyName || null }
            : { mode: "existing_company", companyId },
        collisionStrategy,
        selectedFiles: buildSelectedFiles(),
        adapterOverrides: buildFinalAdapterOverrides(),
      });
    },
    onSuccess: (result) => {
      setImportPreview(result);

      // Build conflicts and set default name overrides with prefix
      const conflicts = buildConflictList(result);
      const prefix = deriveSourcePrefix(
        sourceMode,
        importUrl,
        localPackage?.name ?? null,
        localPackage?.rootPath ?? null,
      );
      const defaultOverrides: Record<string, string> = {};

      for (const c of conflicts) {
        if (c.action === "rename" && prefix) {
          // Use prefix-based default rename
          defaultOverrides[c.slug] = prefixedName(prefix, c.originalName);
        }
      }
      setNameOverrides(defaultOverrides);
      setSkippedSlugs(new Set());
      setConfirmedSlugs(new Set());

      if (!importPreview) {
        // Source package adapter bytes are descriptive only. Target runtime
        // authority starts empty and must be selected explicitly.
        setAdapterOverrides({});
        setAdapterExpandedSlugs(new Set());
        setAdapterConfigValues({});
      }

      // Check all files by default, then uncheck COMPANY.md for existing company
      const allFiles = new Set(Object.keys(result.files));
      if (
        targetMode === "existing" &&
        result.manifest.company &&
        result.plan.companyAction === "update"
      ) {
        const companyPath = ensureMarkdownPath(result.manifest.company.path);
        allFiles.delete(companyPath);
      }
      setCheckedFiles(allFiles);

      // Expand top-level dirs + all ancestor dirs of files with conflicts (update action)
      const am = buildActionMap(result);
      const tree = buildFileTree(result.files, am);
      const dirsToExpand = new Set<string>();
      for (const node of tree) {
        if (node.kind === "dir") dirsToExpand.add(node.path);
      }
      // Auto-expand directories containing conflicting files so they're visible
      for (const [filePath, action] of am) {
        if (action === "update") {
          const segments = filePath.split("/").filter(Boolean);
          let current = "";
          for (let i = 0; i < segments.length - 1; i++) {
            current = current ? `${current}/${segments[i]}` : segments[i];
            dirsToExpand.add(current);
          }
        }
      }
      setExpandedDirs(dirsToExpand);
      // Select first file
      const firstFile = Object.keys(result.files)[0];
      if (firstFile) setSelectedFile(firstFile);
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Preview failed",
        body: err instanceof Error ? err.message : "Failed to preview import.",
      });
    },
  });

  // Build the final nameOverrides to send (only overrides that differ from plannedName)
  function buildFinalNameOverrides(): Record<string, string> | undefined {
    if (!importPreview) return undefined;
    const overrides: Record<string, string> = {};
    for (const [slug, name] of Object.entries(nameOverrides)) {
      if (name.trim()) {
        overrides[slug] = name.trim();
      }
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  function buildSelectedFiles(): string[] | undefined {
    const selected = Array.from(checkedFiles).sort();
    return selected.length > 0 ? selected : undefined;
  }

  // Apply mutation
  const importMutation = useMutation({
    mutationFn: () => {
      const source = buildSource();
      if (!source) throw new Error("No source configured.");
      return companiesApi.importBundle({
        source,
        include: { company: true, agents: true, projects: true, tasks: true },
        target:
          targetMode === "new"
            ? { mode: "new_company", newCompanyName: newCompanyName || null }
            : { mode: "existing_company", companyId },
        collisionStrategy,
        nameOverrides: buildFinalNameOverrides(),
        selectedFiles: buildSelectedFiles(),
        adapterOverrides: buildFinalAdapterOverrides(),
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all,
      });
      const importedCompany = await companiesApi.get(result.company.id);
      const refreshedSession = currentUserId
        ? null
        : await queryClient.fetchQuery({
            queryKey: queryKeys.auth.session,
            queryFn: () => authApi.getSession(),
          });
      const sidebarOrderUserId =
        currentUserId ?? refreshedSession?.user?.id ?? null;
      await applyImportedSidebarOrder(
        importPreview,
        result,
        sidebarOrderUserId,
      );
      pushToast({
        tone: "success",
        title: "Import complete",
        body: `${result.company.name}: ${result.agents.length} agent${result.agents.length === 1 ? "" : "s"} processed.`,
      });
      void navigate({
        to: "/$companyId/dashboard",
        params: { companyId: importedCompany.id },
        replace: true,
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Import failed",
        body: err instanceof Error ? err.message : "Failed to apply import.",
      });
    },
  });

  async function handleChooseLocalPackage(e: ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    try {
      const pkg = await readLocalPackageZip(fileList[0]!);
      setLocalPackage(pkg);
      setImportPreview(null);
    } catch (err) {
      pushToast({
        tone: "error",
        title: "Package read failed",
        body: err instanceof Error ? err.message : "Failed to read folder.",
      });
    }
  }

  const actionMap = useMemo(
    () =>
      importPreview ? buildActionMap(importPreview) : new Map<string, string>(),
    [importPreview],
  );

  const tree = useMemo(
    () => (importPreview ? buildFileTree(importPreview.files, actionMap) : []),
    [importPreview, actionMap],
  );

  const fileTones = useMemo(() => {
    if (!importPreview) return {};
    const tones: Record<string, FileTreeTone> = {};
    for (const path of Object.keys(importPreview.files)) {
      if (!checkedFiles.has(path)) tones[path] = "muted";
    }
    return tones;
  }, [checkedFiles, importPreview]);

  const conflicts = useMemo(
    () => (importPreview ? buildConflictList(importPreview) : []),
    [importPreview],
  );

  // Map directory paths → planned rename name for display in the file tree
  // Also maps file paths for use in the preview header
  const renameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!importPreview) return map;
    for (const c of conflicts) {
      if (!c.filePath) continue;
      const isSkipped = skippedSlugs.has(c.slug);
      if (isSkipped) continue;
      const renamedTo = nameOverrides[c.slug] ?? c.plannedName;
      if (renamedTo === c.originalName) continue;
      // Map the parent directory (e.g. agents/lead → gstack-lead) for the file tree
      const parentDir = c.filePath.split("/").slice(0, -1).join("/");
      if (parentDir) map.set(parentDir, renamedTo);
      // Map the file path too — used by the preview header, not shown in tree
      map.set(c.filePath, renamedTo);
    }
    return map;
  }, [importPreview, conflicts, nameOverrides, skippedSlugs]);

  const totalFiles = useMemo(() => countFiles(tree), [tree]);
  const selectedCount = checkedFiles.size;

  function handleToggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleToggleCheck(path: string, kind: "file" | "dir") {
    if (!importPreview) return;
    setCheckedFiles((previous) =>
      toggleFileTreeCheckedFiles(tree, previous, path, kind),
    );
  }

  function handleConflictRename(slug: string, newName: string) {
    setNameOverrides((prev) => ({ ...prev, [slug]: newName }));
    // Editing the name un-confirms
    setConfirmedSlugs((prev) => {
      if (!prev.has(slug)) return prev;
      const next = new Set(prev);
      next.delete(slug);
      return next;
    });
  }

  function handleConflictToggleConfirm(slug: string) {
    setConfirmedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function handleConflictToggleSkip(slug: string, filePath: string | null) {
    setSkippedSlugs((prev) => {
      const next = new Set(prev);
      const wasSkipped = next.has(slug);
      if (wasSkipped) {
        next.delete(slug);
      } else {
        next.add(slug);
      }

      // Sync with file tree checkboxes
      if (filePath) {
        setCheckedFiles((prevChecked) => {
          const nextChecked = new Set(prevChecked);
          if (wasSkipped) {
            nextChecked.add(filePath);
          } else {
            nextChecked.delete(filePath);
          }
          return nextChecked;
        });
      }

      return next;
    });
  }

  function handleAdapterChange(slug: string, adapterType: string) {
    setAdapterOverrides((prev) => ({ ...prev, [slug]: adapterType }));
    // Reset config values when adapter type changes
    setAdapterConfigValues((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }

  function handleAdapterToggleExpand(slug: string) {
    setAdapterExpandedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function handleAdapterConfigChange(
    slug: string,
    patch: Partial<CreateConfigValues>,
  ) {
    setAdapterConfigValues((prev) => ({
      ...prev,
      [slug]: {
        ...(prev[slug] ?? {
          ...defaultCreateValues,
          adapterType: adapterOverrides[slug] ?? "",
        }),
        ...patch,
      },
    }));
  }

  // Build the list of agents for adapter picking
  const adapterAgents = useMemo<AdapterPickerItem[]>(() => {
    if (!importPreview) return [];
    return importPreview.manifest.agents.map((a) => ({
      slug: a.slug,
      name: a.name,
    }));
  }, [importPreview]);

  // Build final adapterOverrides for import request
  function buildFinalAdapterOverrides():
    Record<string, CompanyPortabilityAdapterOverride> | undefined {
    if (adapterAgents.length === 0) return undefined;
    const overrides: Record<string, CompanyPortabilityAdapterOverride> = {};
    for (const agent of adapterAgents) {
      const selectedType = adapterOverrides[agent.slug];
      if (!selectedType) continue;
      const configVals = adapterConfigValues[agent.slug];
      const uiAdapter = getUIAdapter(selectedType);
      const override: CompanyPortabilityAdapterOverride = {
        adapterType: selectedType,
        adapterConfig: configVals
          ? uiAdapter.buildAdapterConfig(configVals)
          : {},
      };
      overrides[agent.slug] = override;
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  const hasSource =
    sourceMode === "local" ? !!localPackage : importUrl.length > 0;
  const hasErrors = importPreview ? importPreview.errors.length > 0 : false;

  const previewContent =
    selectedFile && importPreview
      ? (importPreview.files[selectedFile] ?? null)
      : null;
  const selectedAction = selectedFile
    ? (actionMap.get(selectedFile) ?? null)
    : null;
  const selectedRenamedTo = selectedFile
    ? renameMap.get(selectedFile)
    : undefined;

  return (
    <div>
      {/* Source form section */}
      <div className="border-b border-border px-5 py-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Import source</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Choose a GitHub repo or upload a local Paperclip zip package.
          </p>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          {(
            [
              { key: "github", icon: Github, label: "GitHub repo" },
              { key: "local", icon: Upload, label: "Local zip" },
            ] as const
          ).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              type="button"
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                sourceMode === key
                  ? "border-foreground bg-accent"
                  : "border-border hover:bg-accent/50",
              )}
              onClick={() => {
                setSourceMode(key);
                setImportPreview(null);
              }}
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4" />
                {label}
              </div>
            </button>
          ))}
        </div>

        {sourceMode === "local" ? (
          <div className="rounded-md border border-dashed border-border px-3 py-3">
            <input
              ref={packageInputRef}
              type="file"
              aria-label="Choose company package ZIP file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={handleChooseLocalPackage}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => packageInputRef.current?.click()}
              >
                Choose zip
              </Button>
              {localPackage && (
                <span className="text-xs text-muted-foreground">
                  {localPackage.name} with{" "}
                  {Object.keys(localPackage.files).length} file
                  {Object.keys(localPackage.files).length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {!localPackage && (
              <p className="mt-2 text-xs text-muted-foreground">
                {localZipHelpText}
              </p>
            )}
          </div>
        ) : (
          <Field
            label="GitHub URL"
            hint="Exact HTTPS repository URL with required ref and optional package path."
          >
            <input
              aria-label="GitHub repository URL"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="text"
              value={importUrl}
              placeholder="https://github.com/paperclipai/companies?ref=main&path=gstack%2Fengineering"
              onChange={(e) => {
                setImportUrl(e.target.value);
                setImportPreview(null);
              }}
            />
          </Field>
        )}

        <Field
          label="Target"
          hint="Import into this company or create a new one."
        >
          <Select
            value={targetMode}
            onValueChange={(v) => {
              setTargetMode(v as "existing" | "new");
              setImportPreview(null);
            }}
          >
            <SelectTrigger
              aria-label="Import target"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Create new company</SelectItem>
              <SelectItem value="existing">
                Existing company: {selectedCompany?.name}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {targetMode === "new" && (
          <Field
            label="New company name"
            hint="Optional override. Leave blank to use the package name."
          >
            <input
              aria-label="New company name"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="text"
              value={newCompanyName}
              onChange={(e) => setNewCompanyName(e.target.value)}
              placeholder="Imported Company"
            />
          </Field>
        )}

        <Field
          label="Collision strategy"
          hint="Board imports can rename, skip, or replace matching company content."
        >
          <Select
            value={collisionStrategy}
            onValueChange={(v) => {
              setCollisionStrategy(v as CompanyPortabilityCollisionStrategy);
              setImportPreview(null);
            }}
          >
            <SelectTrigger
              aria-label="Collision strategy"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rename">Rename on conflict</SelectItem>
              <SelectItem value="skip">Skip on conflict</SelectItem>
              <SelectItem value="replace">Replace existing</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !hasSource}
          >
            {previewMutation.isPending ? "Previewing..." : "Preview import"}
          </Button>
        </div>
      </div>

      {/* Preview results */}
      {importPreview && (
        <>
          {/* Sticky import action bar */}
          <div className="sticky top-0 z-10 border-b border-border bg-background px-5 py-3">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="font-medium">Import preview</span>
              <span className="text-muted-foreground">
                {selectedCount} / {totalFiles} file{totalFiles === 1 ? "" : "s"}{" "}
                selected
              </span>
              {conflicts.length > 0 && (
                <span className="text-amber-500">
                  {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
                </span>
              )}
              {importPreview.errors.length > 0 && (
                <span className="text-destructive">
                  {importPreview.errors.length} error
                  {importPreview.errors.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>

          {/* Conflict resolution list */}
          <ConflictResolutionList
            conflicts={conflicts}
            nameOverrides={nameOverrides}
            skippedSlugs={skippedSlugs}
            confirmedSlugs={confirmedSlugs}
            onRename={handleConflictRename}
            onToggleSkip={handleConflictToggleSkip}
            onToggleConfirm={handleConflictToggleConfirm}
          />

          {/* Adapter picker list */}
          <AdapterPickerList
            agents={adapterAgents}
            adapterOverrides={adapterOverrides}
            expandedSlugs={adapterExpandedSlugs}
            configValues={adapterConfigValues}
            onChangeAdapter={handleAdapterChange}
            onToggleExpand={handleAdapterToggleExpand}
            onChangeConfig={handleAdapterConfigChange}
          />

          {/* Import button — below renames */}
          <div className="mx-5 mt-3 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              onClick={() => importMutation.mutate()}
              disabled={
                importMutation.isPending || hasErrors || selectedCount === 0
              }
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {importMutation.isPending
                ? "Importing..."
                : `Import ${selectedCount} file${selectedCount === 1 ? "" : "s"}`}
            </Button>
          </div>

          {/* Warnings */}
          {importPreview.warnings.length > 0 && (
            <div className="mx-5 mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              {importPreview.warnings.map((w) => (
                <div key={w} className="text-xs text-amber-500">
                  {w}
                </div>
              ))}
            </div>
          )}

          {/* Errors */}
          {importPreview.errors.length > 0 && (
            <div
              role="alert"
              className="mx-5 mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3"
            >
              {importPreview.errors.map((e) => (
                <div key={e} className="text-xs text-destructive">
                  {e}
                </div>
              ))}
            </div>
          )}

          {/* Two-column layout */}
          <div className="grid gap-4 xl:h-(--sz-calc-31) xl:grid-cols-(--gtc-25) xl:gap-0">
            <aside className="flex max-h-(--sz-24rem) flex-col overflow-hidden border-b border-border xl:max-h-none xl:border-b-0 xl:border-r">
              <div className="border-b border-border px-4 py-3 shrink-0">
                <h2 className="text-base font-semibold">Package files</h2>
              </div>
              <div className="flex-1 overflow-y-auto">
                <FileTree
                  nodes={tree}
                  selectedFile={selectedFile}
                  expandedDirs={expandedDirs}
                  checkedFiles={checkedFiles}
                  onToggleDir={handleToggleDir}
                  onSelectFile={setSelectedFile}
                  onToggleCheck={handleToggleCheck}
                  renderFileExtra={(node, checked) =>
                    renderImportFileExtra(node, checked, renameMap)
                  }
                  fileTones={fileTones}
                  wrapLabels={false}
                />
              </div>
            </aside>
            <div className="min-w-0 overflow-y-auto xl:pl-6">
              <CompanyPortabilityFilePreview
                selectedFile={selectedFile}
                content={previewContent}
                allFiles={importPreview?.files ?? {}}
                header={
                  selectedFile ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-sm">
                          {selectedFile}
                        </span>
                        {selectedRenamedTo ? (
                          <span className="shrink-0 font-mono text-sm text-cyan-500">
                            &rarr; {selectedRenamedTo}
                          </span>
                        ) : null}
                      </div>
                      {selectedAction ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "uppercase tracking-wide",
                            ACTION_COLORS[selectedAction] ?? ACTION_COLORS.skip,
                          )}
                        >
                          {selectedAction}
                        </Badge>
                      ) : null}
                    </div>
                  ) : undefined
                }
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
