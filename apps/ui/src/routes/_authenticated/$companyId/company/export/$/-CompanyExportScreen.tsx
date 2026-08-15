// Empty collections render dedicated UI when data.length === 0.
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { companiesApi } from "@/api/companies";
import { projectsApi } from "@/api/projects";
import { CompanyPortabilityFilePreview } from "@/routes/_authenticated/$companyId/company/-CompanyPortabilityFilePreview";
import {
  buildFileTree,
  countFiles,
  FileTree,
  toggleFileTreeCheckedFiles,
} from "@/components/patterns/FileTree";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { toast } from "sonner";
import { useAgentOrder } from "@/hooks/useAgentOrder";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import { buildInitialExportCheckedFiles } from "@/lib/company-export-selection";
import { buildPortableSidebarOrder } from "@/lib/company-portability-sidebar";
import { queryKeys } from "@/lib/queryKeys";
import {
  collectMatchedParentDirs,
  downloadZip,
  expandAncestors,
  filterPaperclipYaml,
  filterTree,
  generateReadmeFromSelection,
  paginateTaskNodes,
  sortByChecked,
} from "@/routes/_authenticated/$companyId/company/export/$/-company-export-data";
import type {
  Agent,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityFileEntry,
  Project,
} from "@paperclipai/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Download, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function CompanyExportScreen({
  filePath: routeFilePath,
}: {
  filePath: string | null;
}) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const { data: session, isFetched: isSessionFetched } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: agents = [], isFetched: areAgentsFetched } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: projects = [], isFetched: areProjectsFetched } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const [exportData, setExportData] =
    useState<CompanyPortabilityExportPreviewResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [treeSearch, setTreeSearch] = useState("");
  const [taskLimit, setTaskLimit] = useState(10);
  const savedExpandedRef = useRef<Set<string> | null>(null);
  const initialFileFromUrl = useRef(routeFilePath);
  const currentUserId = session?.user.id ?? null;
  const visibleAgents = useMemo(
    () => agents.filter((agent: Agent) => agent.status !== "terminated"),
    [agents],
  );
  const visibleProjects = useMemo(
    () => projects.filter((project: Project) => !project.archivedAt),
    [projects],
  );
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId,
    userId: currentUserId,
  });
  const { orderedProjects } = useProjectOrder({
    projects: visibleProjects,
    companyId,
    userId: currentUserId,
  });
  const sidebarOrder = useMemo(
    () =>
      buildPortableSidebarOrder({
        orderedAgents,
        orderedProjects,
      }),
    [orderedAgents, orderedProjects],
  );
  const sidebarOrderKey = useMemo(
    () => JSON.stringify(sidebarOrder ?? null),
    [sidebarOrder],
  );

  const selectFile = useCallback(
    (filePath: string | null, replace = false) => {
      setSelectedFile(filePath);
      if (filePath) {
        void navigate({
          to: "/$companyId/company/export/$",
          params: { companyId, _splat: `files/${filePath}` },
          replace,
        });
      } else {
        void navigate({
          to: "/$companyId/company/export/$",
          params: { companyId, _splat: "" },
          replace,
        });
      }
    },
    [companyId, navigate],
  );

  useEffect(() => {
    if (!exportData) return;
    const urlFile = routeFilePath;
    if (urlFile && urlFile in exportData.files && urlFile !== selectedFile) {
      setSelectedFile(urlFile);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of expandAncestors(urlFile)) next.add(dir);
        return next;
      });
    } else if (!urlFile && selectedFile) {
      setSelectedFile(null);
    }
  }, [routeFilePath, exportData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Agents",
        renderLink: (content) => (
          <Link to="/$companyId/agents" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Export" },
    ]);
  }, [setBreadcrumbs, companyId]);

  const exportPreviewMutation = useMutation({
    mutationFn: () =>
      companiesApi.exportPreview(companyId, {
        include: { company: true, agents: true, projects: true, tasks: true },
        sidebarOrder,
      }),
    onSuccess: (result) => {
      setExportData(result);
      setCheckedFiles((prev) =>
        buildInitialExportCheckedFiles(
          Object.keys(result.files),
          result.manifest.tasks,
          prev,
        ),
      );
      const tree = buildFileTree(result.files);
      const topDirs = new Set<string>();
      for (const node of tree) {
        if (node.kind === "dir" && node.name !== "tasks")
          topDirs.add(node.path);
      }

      const urlFile = initialFileFromUrl.current;
      if (urlFile && urlFile in result.files) {
        setSelectedFile(urlFile);
        const ancestors = expandAncestors(urlFile);
        setExpandedDirs(new Set([...topDirs, ...ancestors]));
      } else {
        const defaultFile =
          "README.md" in result.files
            ? "README.md"
            : Object.keys(result.files)[0];
        if (defaultFile) {
          selectFile(defaultFile, true);
        }
        setExpandedDirs(topDirs);
      }
    },
    onError: (err) => {
      toast.error("Export failed", {
        description:
          err instanceof Error ? err.message : "Failed to load export data.",
      });
    },
  });

  const downloadMutation = useMutation({
    mutationFn: () =>
      companiesApi.exportBundle(companyId, {
        include: { company: true, agents: true, projects: true, tasks: true },
        selectedFiles: Array.from(checkedFiles).sort(),
        sidebarOrder,
      }),
    onSuccess: (result) => {
      const resultCheckedFiles = new Set(Object.keys(result.files));
      downloadZip(result, resultCheckedFiles, result.files);
      toast.success("Export downloaded", {
        description: `${resultCheckedFiles.size} file${resultCheckedFiles.size === 1 ? "" : "s"} exported as ${result.rootPath}.zip`,
      });
    },
    onError: (err) => {
      toast.error("Export failed", {
        description:
          err instanceof Error
            ? err.message
            : "Failed to build export package.",
      });
    },
  });

  useEffect(() => {
    if (exportPreviewMutation.isPending) return;
    if (!isSessionFetched || !areAgentsFetched || !areProjectsFetched) return;
    setExportData(null);
    exportPreviewMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    companyId,
    isSessionFetched,
    areAgentsFetched,
    areProjectsFetched,
    sidebarOrderKey,
  ]);

  const tree = useMemo(
    () => (exportData ? buildFileTree(exportData.files) : []),
    [exportData],
  );

  const { displayTree, totalTaskChildren, visibleTaskChildren } =
    useMemo(() => {
      let result = tree;
      if (treeSearch) result = filterTree(result, treeSearch);
      result = sortByChecked(result, checkedFiles);
      const paginated = paginateTaskNodes(
        result,
        taskLimit,
        checkedFiles,
        treeSearch,
      );
      return {
        displayTree: paginated.nodes,
        totalTaskChildren: paginated.totalTaskChildren,
        visibleTaskChildren: paginated.visibleTaskChildren,
      };
    }, [tree, treeSearch, checkedFiles, taskLimit]);

  const effectiveFiles = useMemo(() => {
    if (!exportData) return {} as Record<string, CompanyPortabilityFileEntry>;
    const filtered = { ...exportData.files };

    const yamlPath = exportData.paperclipExtensionPath;
    if (yamlPath && typeof exportData.files[yamlPath] === "string") {
      filtered[yamlPath] = filterPaperclipYaml(
        exportData.files[yamlPath],
        checkedFiles,
      );
    }

    if (typeof exportData.files["README.md"] === "string") {
      const companyName =
        exportData.manifest.company?.name ?? selectedCompany?.name ?? "Company";
      const companyDescription =
        exportData.manifest.company?.description ?? null;
      filtered["README.md"] = generateReadmeFromSelection(
        exportData.manifest,
        checkedFiles,
        companyName,
        companyDescription,
      );
    }

    return filtered;
  }, [exportData, checkedFiles, selectedCompany?.name]);

  const totalFiles = useMemo(() => countFiles(tree), [tree]);
  const selectedCount = checkedFiles.size;

  const warnings = useMemo(() => {
    if (!exportData) return [] as string[];
    return exportData.warnings.filter((w) => !/terminated agent/i.test(w));
  }, [exportData]);

  function handleToggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleToggleCheck(path: string, kind: "file" | "dir") {
    if (!exportData) return;
    setCheckedFiles((previous) =>
      toggleFileTreeCheckedFiles(tree, previous, path, kind),
    );
  }

  function handleSearchChange(query: string) {
    const wasSearching = treeSearch.length > 0;
    const isSearching = query.length > 0;

    if (isSearching && !wasSearching) {
      savedExpandedRef.current = new Set(expandedDirs);
    }

    setTreeSearch(query);

    if (isSearching) {
      const matchedParents = collectMatchedParentDirs(tree, query);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        for (const d of matchedParents) next.add(d);
        return next;
      });
    } else if (wasSearching) {
      if (savedExpandedRef.current) {
        setExpandedDirs(savedExpandedRef.current);
        savedExpandedRef.current = null;
      }
    }
  }

  function handleDownload() {
    if (!exportData || checkedFiles.size === 0 || downloadMutation.isPending)
      return;
    downloadMutation.mutate();
  }

  if (exportPreviewMutation.isPending && !exportData) {
    return (
      <div role="status">
        <span className="sr-only">Preparing export data…</span>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!exportData) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner /> Loading export data...
      </div>
    );
  }

  if (routeFilePath && !(routeFilePath in exportData.files)) {
    return (
      <Alert>
        <AlertDescription>
          File not found. This export does not contain the requested file.
        </AlertDescription>
      </Alert>
    );
  }

  const previewContent = selectedFile
    ? (() => {
        return effectiveFiles[selectedFile] ?? null;
      })()
    : null;

  return (
    <div>
      {downloadMutation.isPending ? (
        <p className="sr-only" role="status">
          Building export…
        </p>
      ) : null}
      <div className="sticky top-0 z-10 border-b border-border bg-background px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="font-medium">
              {selectedCompany?.name ?? "Company"} export
            </span>
            <span className="text-muted-foreground">
              {selectedCount} / {totalFiles} file{totalFiles === 1 ? "" : "s"}{" "}
              selected
            </span>
            {warnings.length > 0 && (
              <Badge variant="secondary">
                {warnings.length} warning{warnings.length === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
          <Button
            size="sm"
            onClick={handleDownload}
            disabled={selectedCount === 0 || downloadMutation.isPending}
          >
            <Download className="mr-1.5 h-3.5 w-3.5"  data-icon="inline-start"/>
            {downloadMutation.isPending
              ? "Building export..."
              : `Export ${selectedCount} file${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>

      {warnings.length > 0 && (
        <Alert className="mx-5 mt-3">
          <AlertDescription>
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 xl:h-(--sz-calc-30) xl:grid-cols-(--gtc-25) xl:gap-0">
        <aside className="flex max-h-(--sz-24rem) flex-col overflow-hidden border-b border-border xl:max-h-none xl:border-b-0 xl:border-r">
          <div className="border-b border-border px-4 py-3 shrink-0">
            <h2 className="text-base font-semibold">Package files</h2>
          </div>
          <div className="border-b border-border px-3 py-2 shrink-0">
            <InputGroup>
              <InputGroupAddon>
                <Search  data-icon="inline-start"/>
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search package files"
                type="text"
                value={treeSearch}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search files..."
                data-page-search-target="true"
              />
            </InputGroup>
          </div>
          <div className="flex-1 overflow-y-auto">
            <FileTree
              nodes={displayTree}
              selectedFile={selectedFile}
              expandedDirs={expandedDirs}
              checkedFiles={checkedFiles}
              onToggleDir={handleToggleDir}
              onSelectFile={selectFile}
              onToggleCheck={handleToggleCheck}
              wrapLabels={false}
            />
            {totalTaskChildren > visibleTaskChildren && !treeSearch && (
              <div className="px-4 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTaskLimit((prev) => prev + 10)}
                  className="w-full"
                >
                  Show more tasks ({visibleTaskChildren} of {totalTaskChildren})
                </Button>
              </div>
            )}
          </div>
        </aside>
        <div className="min-w-0 overflow-y-auto xl:pl-6">
          <CompanyPortabilityFilePreview
            selectedFile={selectedFile}
            content={previewContent}
            allFiles={effectiveFiles}
          />
        </div>
      </div>
    </div>
  );
}
