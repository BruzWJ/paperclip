import { authApi } from "@/api/auth";
import { companiesApi } from "@/api/companies";
import { defaultCreateValues } from "@/features/agents/configuration/agent-config-defaults";
import type { AdapterPickerItem } from "@/routes/_authenticated/$companyId/company/import/-CompanyImportControls";
import {
  buildFileTree,
  countFiles,
  toggleFileTreeCheckedFiles,
  type FileTreeTone,
} from "@/components/patterns/FileTree";
import { useCompany } from "@/context/CompanyContext";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type {
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityPreviewResult,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  buildCompanyImportAdapterOverrides,
  buildCompanyImportNameOverrides,
  buildCompanyImportSelectedFiles,
  buildCompanyImportSource,
  type LocalCompanyImportPackage,
} from "./-company-import-controller-helpers";
import {
  applyImportedSidebarOrder,
  buildActionMap,
  buildConflictList,
  deriveSourcePrefix,
  ensureMarkdownPath,
  prefixedName,
  readLocalPackageZip,
} from "./-company-import-data";

export function useCompanyImportController() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user.id ?? null;

  // Source state
  const [sourceMode, setSourceMode] = useState<"github" | "local">("github");
  const [importUrl, setImportUrl] = useState("");
  const [localPackage, setLocalPackage] = useState<LocalCompanyImportPackage | null>(null);
  const [localPackageFile, setLocalPackageFile] = useState<File | null>(null);

  // Target state
  const [targetMode, setTargetMode] = useState<"existing" | "new">("new");
  const [newCompanyName, setNewCompanyName] = useState("");

  // Preview state
  const [importPreview, setImportPreview] = useState<CompanyPortabilityPreviewResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());

  // Conflict resolution state
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});
  const [skippedSlugs, setSkippedSlugs] = useState<Set<string>>(new Set());
  const [confirmedSlugs, setConfirmedSlugs] = useState<Set<string>>(new Set());
  const [collisionStrategy, setCollisionStrategy] = useState<CompanyPortabilityCollisionStrategy>("rename");

  // Adapter override state
  const [adapterOverrides, setAdapterOverrides] = useState<Record<string, string>>({});
  const [adapterExpandedSlugs, setAdapterExpandedSlugs] = useState<Set<string>>(new Set());
  const [adapterConfigValues, setAdapterConfigValues] = useState<Record<string, CreateConfigValues>>({});

  const localZipHelpText =
    "Upload a .zip exported directly from Paperclip. Re-zipped archives created by Finder, Explorer, or other zip tools may not import correctly.";

  const buildSource = () => buildCompanyImportSource({ sourceMode, importUrl, localPackage });

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
        selectedFiles: buildCompanyImportSelectedFiles(checkedFiles),
        adapterOverrides: buildCompanyImportAdapterOverrides({
          adapterAgents,
          adapterOverrides,
          adapterConfigValues,
        }),
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
      if (targetMode === "existing" && result.manifest.company && result.plan.companyAction === "update") {
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
      toast.error("Preview failed", {
        description: err instanceof Error ? err.message : "Failed to preview import.",
      });
    },
  });

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
        nameOverrides: buildCompanyImportNameOverrides(importPreview, nameOverrides),
        selectedFiles: buildCompanyImportSelectedFiles(checkedFiles),
        adapterOverrides: buildCompanyImportAdapterOverrides({
          adapterAgents,
          adapterOverrides,
          adapterConfigValues,
        }),
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
      const sidebarOrderUserId = currentUserId ?? refreshedSession?.user?.id ?? null;
      await applyImportedSidebarOrder(importPreview, result, sidebarOrderUserId);
      toast.success("Import complete", {
        description: `${result.company.name}: ${result.agents.length} agent${result.agents.length === 1 ? "" : "s"} processed.`,
      });
      void navigate({
        to: "/$companyId/dashboard",
        params: { companyId: importedCompany.id },
        replace: true,
      });
    },
    onError: (err) => {
      toast.error("Import failed", {
        description: err instanceof Error ? err.message : "Failed to apply import.",
      });
    },
  });

  async function handleChooseLocalPackage(file: File) {
    try {
      const pkg = await readLocalPackageZip(file);
      setLocalPackage(pkg);
      setLocalPackageFile(file);
      setImportPreview(null);
    } catch (err) {
      toast.error("Package read failed", {
        description: err instanceof Error ? err.message : "Failed to read folder.",
      });
    }
  }

  const actionMap = useMemo(
    () => (importPreview ? buildActionMap(importPreview) : new Map<string, string>()),
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

  const conflicts = useMemo(() => (importPreview ? buildConflictList(importPreview) : []), [importPreview]);

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
    setCheckedFiles((previous) => toggleFileTreeCheckedFiles(tree, previous, path, kind));
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

  function handleAdapterConfigChange(slug: string, patch: Partial<CreateConfigValues>) {
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

  const hasSource = sourceMode === "local" ? !!localPackage : importUrl.length > 0;
  const hasErrors = importPreview ? importPreview.errors.length > 0 : false;

  const previewContent = selectedFile && importPreview ? (importPreview.files[selectedFile] ?? null) : null;
  const selectedAction = selectedFile ? (actionMap.get(selectedFile) ?? null) : null;
  const selectedRenamedTo = selectedFile ? renameMap.get(selectedFile) : undefined;

  return {
    adapterAgents,
    adapterConfigValues,
    adapterExpandedSlugs,
    adapterOverrides,
    checkedFiles,
    collisionStrategy,
    companyId,
    confirmedSlugs,
    conflicts,
    expandedDirs,
    fileTones,
    handleAdapterChange,
    handleAdapterConfigChange,
    handleAdapterToggleExpand,
    handleChooseLocalPackage,
    handleConflictRename,
    handleConflictToggleConfirm,
    handleConflictToggleSkip,
    handleToggleCheck,
    handleToggleDir,
    hasErrors,
    hasSource,
    importMutation,
    importPreview,
    importUrl,
    localPackage,
    localPackageFile,
    localZipHelpText,
    nameOverrides,
    newCompanyName,
    previewContent,
    previewMutation,
    renameMap,
    selectedAction,
    selectedCompany,
    selectedCount,
    selectedFile,
    selectedRenamedTo,
    setCollisionStrategy,
    setImportPreview,
    setImportUrl,
    setNewCompanyName,
    setSelectedFile,
    setSourceMode,
    setTargetMode,
    skippedSlugs,
    sourceMode,
    targetMode,
    totalFiles,
    tree,
  };
}

export type CompanyImportController = ReturnType<typeof useCompanyImportController>;
