import {
  buildSecretPathBreadcrumbs,
  buildSecretPathListing,
  getSecretPathRowName,
  validateSecretFolderSegment,
} from "@/routes/_authenticated/$companyId/company/settings/secrets/-secret-path";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { SECRETS_VIEW_MODE_STORAGE_KEY, type SecretsViewMode } from "./-secrets-model";
import type { SecretsControllerState } from "./-useSecretsControllerState";
import type { SecretsData } from "./-useSecretsData";

const secretsRoute = getRouteApi("/_authenticated/$companyId/company/settings/secrets/");

type SecretsFolderState = Pick<
  SecretsControllerState,
  | "activeTab"
  | "newFolderName"
  | "search"
  | "setNewFolderError"
  | "setNewFolderName"
  | "setNewFolderOpen"
  | "setStoredViewMode"
  | "storedViewMode"
>;

type SecretsFolderData = Pick<SecretsData, "filteredRows" | "unifiedRows">;

export interface UseSecretsFoldersOptions {
  state: SecretsFolderState;
  data: SecretsFolderData;
}

export function useSecretsFolders({ state, data }: UseSecretsFoldersOptions) {
  const navigate = secretsRoute.useNavigate();
  const routeSearch = secretsRoute.useSearch();
  const {
    activeTab,
    newFolderName,
    search,
    setNewFolderError,
    setNewFolderName,
    setNewFolderOpen,
    setStoredViewMode,
    storedViewMode,
  } = state;
  const { filteredRows, unifiedRows } = data;

  // Folders are derived from slash-delimited names; no server folder record
  // exists. `?path=` is meaningful only on the main Secrets tab.
  const pathParam = routeSearch.path ?? "";
  const folderPath = activeTab === "secrets" ? pathParam : "";
  const searching = search.trim().length > 0;
  const hasSlashNames = useMemo(
    () => unifiedRows.some((row) => getSecretPathRowName(row).includes("/")),
    [unifiedRows],
  );
  const resolvedViewMode: SecretsViewMode = storedViewMode ?? (hasSlashNames ? "folders" : "flat");
  const effectiveViewMode: SecretsViewMode = folderPath ? "folders" : resolvedViewMode;
  const showFolderView = effectiveViewMode === "folders" && !searching;

  const goToFolder = useCallback(
    (path: string) => {
      void navigate({
        from: "/$companyId/company/settings/secrets/",
        search: (current) => ({
          ...current,
          path: path || undefined,
        }),
      });
    },
    [navigate],
  );

  const closeNewFolder = useCallback(() => {
    setNewFolderOpen(false);
    setNewFolderName("");
    setNewFolderError(null);
  }, [setNewFolderError, setNewFolderName, setNewFolderOpen]);

  const stageNewFolder = useCallback(() => {
    const segment = newFolderName.trim();
    const error = validateSecretFolderSegment(segment);
    if (error) {
      setNewFolderError(error);
      return;
    }
    goToFolder(folderPath ? `${folderPath}/${segment}` : segment);
    closeNewFolder();
  }, [closeNewFolder, folderPath, goToFolder, newFolderName, setNewFolderError]);

  const setViewMode = useCallback(
    (mode: SecretsViewMode) => {
      setStoredViewMode(mode);
      try {
        window.localStorage.setItem(SECRETS_VIEW_MODE_STORAGE_KEY, mode);
      } catch {
        // Storage may be disabled; the in-memory preference still works.
      }
      if (mode === "flat") goToFolder("");
    },
    [goToFolder, setStoredViewMode],
  );

  const folderListing = useMemo(
    () => buildSecretPathListing(filteredRows, folderPath),
    [filteredRows, folderPath],
  );
  const breadcrumbs = useMemo(() => buildSecretPathBreadcrumbs(folderPath), [folderPath]);
  const parentFolderPath = useMemo(() => {
    const segments = folderPath ? folderPath.split("/") : [];
    return segments.slice(0, -1).join("/");
  }, [folderPath]);
  const currentFolderSecretCount =
    folderListing.secrets.length +
    folderListing.folders.reduce((total, folder) => total + folder.secretCount, 0);
  const folderRows = showFolderView ? folderListing.folders : [];
  const secretRows = showFolderView ? folderListing.secrets : filteredRows;
  const showUpRow = showFolderView && folderPath.length > 0;

  const folderSearch = useCallback(
    (path: string) => ({
      ...routeSearch,
      path: path || undefined,
    }),
    [routeSearch],
  );

  return {
    navigate,
    routeSearch,
    pathParam,
    folderPath,
    searching,
    hasSlashNames,
    resolvedViewMode,
    effectiveViewMode,
    showFolderView,
    goToFolder,
    closeNewFolder,
    stageNewFolder,
    setViewMode,
    folderListing,
    breadcrumbs,
    parentFolderPath,
    currentFolderSecretCount,
    folderRows,
    secretRows,
    showUpRow,
    folderSearch,
  };
}

export type SecretsFolders = ReturnType<typeof useSecretsFolders>;
