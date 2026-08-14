import { isAbsoluteProjectFolder, isCanonicalProjectRepositoryUrl, type Project } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { goalsApi } from "@/api/goals";
import { projectsApi } from "@/api/projects";
import { secretsApi } from "@/api/secrets";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";

export type ProjectFieldSaveState = "idle" | "saving" | "saved" | "error";

export type ProjectConfigFieldKey = "name" | "description" | "status" | "goals" | "env";

export function useProjectPropertiesFields({
  project,
  onUpdate,
  onFieldUpdate,
  getFieldSaveState,
}: {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
}) {
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const [codebaseEditor, setCodebaseEditor] = useState<"local" | "repo" | null>(null);
  const [localFolderDraft, setLocalFolderDraft] = useState("");
  const [repoUrlDraft, setRepoUrlDraft] = useState("");
  const [codebaseValidationError, setCodebaseValidationError] = useState<string | null>(null);

  const commitField = (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    if (onFieldUpdate) onFieldUpdate(field, data);
    else onUpdate?.(data);
  };
  const fieldState = (field: ProjectConfigFieldKey): ProjectFieldSaveState =>
    getFieldSaveState?.(field) ?? "idle";

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
  });
  const { data: availableSecrets = [] } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const { data: userSecretDefinitions = [] } = useQuery({
    queryKey: queryKeys.secrets.userDefinitions(companyId),
    queryFn: () => secretsApi.listUserSecretDefinitions(companyId),
    retry: false,
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => secretsApi.create(companyId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      }),
  });

  const codebaseQuery = useQuery({
    queryKey: queryKeys.projects.codebase(project.id),
    queryFn: () => projectsApi.getCodebase(project.id),
  });
  const resetCodebaseEditor = () => {
    setCodebaseEditor(null);
    setLocalFolderDraft("");
    setRepoUrlDraft("");
    setCodebaseValidationError(null);
  };
  const updateCodebase = useMutation({
    mutationFn: (data: { localFolder?: string | null; repoUrl?: string | null }) =>
      projectsApi.updateCodebase(project.id, data),
    onSuccess: (codebase) => {
      queryClient.setQueryData(queryKeys.projects.codebase(project.id), codebase);
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(project.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(companyId),
      });
      resetCodebaseEditor();
    },
  });

  const linkedGoalIds = project.goalIds;
  const linkedGoals = project.goals.length
    ? project.goals
    : linkedGoalIds.map((id) => ({
        id,
        title: allGoals?.find((goal) => goal.id === id)?.title ?? id.slice(0, 8),
      }));
  const availableGoals = (allGoals ?? []).filter((goal) => !linkedGoalIds.includes(goal.id));
  const removeGoal = (goalId: string) => {
    if (onUpdate || onFieldUpdate) {
      commitField("goals", {
        goalIds: linkedGoalIds.filter((id) => id !== goalId),
      });
    }
  };
  const submitLocalFolder = () => {
    if (localFolderDraft && !isAbsoluteProjectFolder(localFolderDraft)) {
      setCodebaseValidationError("Local folder must be a full absolute path.");
      return;
    }
    setCodebaseValidationError(null);
    updateCodebase.mutate({ localFolder: localFolderDraft || null });
  };
  const submitRepoUrl = () => {
    if (repoUrlDraft && !isCanonicalProjectRepositoryUrl(repoUrlDraft)) {
      setCodebaseValidationError("Repo must use its exact canonical HTTPS URL.");
      return;
    }
    setCodebaseValidationError(null);
    updateCodebase.mutate({ repoUrl: repoUrlDraft || null });
  };

  return {
    availableGoals,
    availableSecrets,
    codebaseEditor,
    codebaseQuery,
    codebaseValidationError,
    commitField,
    createSecret,
    fieldState,
    linkedGoalIds,
    linkedGoals,
    localFolderDraft,
    removeGoal,
    repoUrlDraft,
    resetCodebaseEditor,
    setCodebaseEditor,
    setCodebaseValidationError,
    setLocalFolderDraft,
    setRepoUrlDraft,
    submitLocalFolder,
    submitRepoUrl,
    updateCodebase,
    userSecretDefinitions,
    clearLocalFolder: () => updateCodebase.mutate({ localFolder: null }),
    clearRepoUrl: () => updateCodebase.mutate({ repoUrl: null }),
  };
}
