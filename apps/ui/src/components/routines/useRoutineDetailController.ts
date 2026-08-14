import { type RestoreRoutineRevisionResponse } from "@/api/routines";
import type { EntityOption } from "@/lib/entity-selector";
import { type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import {
  EDITABLE_SECTIONS,
  SECTION_FIELD_KEYS,
  createDefaultNewTrigger,
  type RoutineDetailContextValue,
  type RoutineEditDraft,
  type RoutineSectionKey,
  type SecretMessage,
} from "@/components/routine-sections/context";
import { toast } from "sonner";
import { buildMarkdownMentionOptions } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { autoResizeTextarea } from "@/lib/textarea";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "@/lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "@/lib/recent-projects";
import type {
  RoutineDetail as RoutineDetailType,
  RoutineEnvConfig,
  RoutineVariable,
} from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildRoutineEditDraft, getRoutineDirtyFields, useRoutineDetailQueries } from "./routineDetailDraft";
import { useRoutineDetailMutations } from "./useRoutineDetailMutations";

export function useRoutineDetailController({
  companyId,
  routineId,
  section: sectionParam,
}: {
  companyId: string;
  routineId: string;
  section?: RoutineSectionKey;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const hydratedRoutineIdRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [secretMessage, setSecretMessage] = useState<SecretMessage | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [runVariablesOpen, setRunVariablesOpen] = useState(false);
  const [newTrigger, setNewTrigger] = useState(createDefaultNewTrigger);
  const [editDraft, setEditDraft] = useState<RoutineEditDraft>({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    env: null,
  });

  const section: RoutineSectionKey = sectionParam ?? "overview";

  const navigateToSection = useCallback(
    (next: RoutineSectionKey, options?: { replace?: boolean }) => {
      if (!routineId) return;
      if (next === "overview") {
        void navigate({
          to: "/$companyId/routines/$routineId",
          params: { companyId, routineId },
          replace: options?.replace ?? true,
        });
        return;
      }
      void navigate({
        to: "/$companyId/routines/$routineId/$section",
        params: { companyId, routineId, section: next },
        replace: options?.replace ?? true,
      });
    },
    [companyId, navigate, routineId],
  );

  const {
    routine,
    isLoading,
    error,
    activeTaskId,
    hasLiveRun,
    routineRuns,
    activity,
    agents,
    projects,
    companyMembers,
    availableSecrets,
  } = useRoutineDetailQueries({ companyId, routineId });

  const routineDefaults = useMemo<RoutineEditDraft | null>(
    () => (routine ? buildRoutineEditDraft(routine) : null),
    [routine],
  );
  const dirtyFields = useMemo(
    () => getRoutineDirtyFields(editDraft, routineDefaults),
    [editDraft, routineDefaults],
  );
  const isEditDirty = dirtyFields.length > 0;

  const sectionDirtyFields = useCallback(
    (target: RoutineSectionKey) => {
      const keys = SECTION_FIELD_KEYS[target];
      if (!keys) return [];
      return dirtyFields.filter((field) => keys.includes(field.key));
    },
    [dirtyFields],
  );
  const isSectionDirty = useCallback(
    (target: RoutineSectionKey) => sectionDirtyFields(target).length > 0,
    [sectionDirtyFields],
  );
  const discardSection = useCallback(
    (target: RoutineSectionKey) => {
      if (!routineDefaults) return;
      const keys = SECTION_FIELD_KEYS[target];
      if (!keys) return;
      setEditDraft((current) => {
        const next = { ...current } as Record<string, unknown>;
        for (const key of keys) {
          next[key] = (routineDefaults as Record<string, unknown>)[key];
        }
        return next as RoutineEditDraft;
      });
    },
    [routineDefaults],
  );

  useEffect(() => {
    if (!routine || !routineDefaults) return;
    const changedRoutine = hydratedRoutineIdRef.current !== routine.id;
    if (changedRoutine || !isEditDirty) {
      setEditDraft(routineDefaults);
      hydratedRoutineIdRef.current = routine.id;
    }
  }, [routine, routineDefaults, isEditDirty]);

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [editDraft.title, routine?.id]);

  const copySecretValue = useCallback(async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch (copyError) {
      toast.error(`Failed to copy ${label.toLowerCase()}`, {
        description: copyError instanceof Error ? copyError.message : "Clipboard access was denied.",
      });
    }
  }, []);

  const {
    createSecret,
    saveRoutine,
    runRoutine,
    updateRoutineStatus,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    rotateTrigger,
  } = useRoutineDetailMutations({
    companyId,
    routineId,
    routine,
    editDraft,
    newTrigger,
    setRunVariablesOpen,
    setSaveConflict,
    setSecretMessage,
    navigateToSection,
  });

  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [routine?.id]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [routine?.id]);
  const assigneeOptions = useMemo<EntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<EntityOption[]>(
    () =>
      (projects ?? []).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const mentionOptions = useMemo<MentionOption[]>(
    () =>
      buildMarkdownMentionOptions({
        agents,
        projects,
        members: companyMembers?.users,
      }),
    [agents, companyMembers?.users, projects],
  );

  // Wrap track-recent side-effects so the section components stay declarative.
  const setEditDraftTracked: typeof setEditDraft = useCallback((updater) => {
    setEditDraft((current) => {
      const next =
        typeof updater === "function"
          ? (updater as (c: RoutineEditDraft) => RoutineEditDraft)(current)
          : updater;
      if (next.assigneeAgentId && next.assigneeAgentId !== current.assigneeAgentId) {
        trackRecentAssignee(next.assigneeAgentId);
      }
      if (next.projectId && next.projectId !== current.projectId) {
        trackRecentProject(next.projectId);
      }
      return next;
    });
  }, []);

  const currentAssignee = editDraft.assigneeAgentId
    ? (agentById.get(editDraft.assigneeAgentId) ?? null)
    : null;
  const currentProject = editDraft.projectId ? (projectById.get(editDraft.projectId) ?? null) : null;

  const reloadLatest = useCallback(() => {
    setSaveConflict(false);
    if (routineDefaults) setEditDraft(routineDefaults);
    queryClient.invalidateQueries({
      queryKey: queryKeys.routines.detail(routineId!),
    });
  }, [queryClient, routineDefaults, routineId]);

  const onHistoryRestoreSecretMaterials = useCallback((response: RestoreRoutineRevisionResponse) => {
    if (response.secretMaterials.length > 0) {
      setSecretMessage({
        title:
          response.secretMaterials.length === 1
            ? "Webhook trigger restored"
            : `${response.secretMaterials.length} webhook triggers restored`,
        entries: response.secretMaterials.map((recreated) => ({
          webhookUrl: recreated.webhookUrl,
          webhookSecret: recreated.webhookSecret,
        })),
      });
    }
  }, []);

  const onHistoryRestored = useCallback(
    (response: RestoreRoutineRevisionResponse) => {
      setSaveConflict(false);
      queryClient.setQueryData<RoutineDetailType | undefined>(
        queryKeys.routines.detail(routineId!),
        (prev) =>
          prev
            ? {
                ...prev,
                ...response.routine,
                latestRevisionId: response.revision.id,
                latestRevisionNumber: response.revision.revisionNumber,
              }
            : prev,
      );
      setEditDraft({
        title: response.routine.title,
        description: response.routine.description ?? "",
        projectId: response.routine.projectId ?? "",
        assigneeAgentId: response.routine.assigneeAgentId ?? "",
        priority: response.routine.priority,
        concurrencyPolicy: response.routine.concurrencyPolicy,
        catchUpPolicy: response.routine.catchUpPolicy,
        variables: response.routine.variables as RoutineVariable[],
        env: (response.routine.env ?? null) as RoutineEnvConfig | null,
      });
      hydratedRoutineIdRef.current = response.routine.id;
    },
    [queryClient, routineId],
  );

  if (isLoading) {
    return { state: "loading" as const };
  }

  if (error || !routine || !routineDefaults) {
    return {
      state: "error" as const,
      message: error instanceof Error ? error.message : "We couldn't load this routine.",
    };
  }

  const automationEnabled = routine.status === "active";
  const automationToggleDisabled = updateRoutineStatus.isPending || routine.status === "archived";
  const automationLabel =
    routine.status === "archived"
      ? "Archived"
      : !routine.assigneeAgentId
        ? "Draft"
        : automationEnabled
          ? "Active"
          : "Paused";
  const contextValue: RoutineDetailContextValue = {
    routine,
    routineId: routineId!,
    companyId,
    editDraft,
    setEditDraft: setEditDraftTracked,
    routineDefaults,
    dirtyFields,
    isEditDirty,
    sectionDirtyFields,
    isSectionDirty,
    discardSection,
    saveRoutine,
    saveConflict,
    reloadLatest,
    automationEnabled,
    automationLabel,
    automationToggleDisabled,
    onToggleAutomation: () => {
      if (!automationEnabled && !routine.assigneeAgentId) {
        toast.warning("Default agent required", {
          description: "Set a default agent before enabling routine automation.",
        });
        return;
      }
      updateRoutineStatus.mutate(automationEnabled ? "paused" : "active");
    },
    onOpenRunDialog: () => setRunVariablesOpen(true),
    runRoutinePending: runRoutine.isPending,
    newTrigger,
    setNewTrigger,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    rotateTrigger,
    secretMessage,
    setSecretMessage,
    copySecretValue,
    availableSecrets,
    createSecret,
    agents: agents ?? [],
    projects: projects ?? [],
    agentById,
    projectById,
    assigneeOptions,
    projectOptions,
    recentAssigneeIds,
    recentProjectIds,
    mentionOptions,
    currentAssignee,
    currentProject,
    routineRuns,
    activity,
    hasLiveRun,
    activeTaskId,
    titleInputRef,
    descriptionEditorRef,
    assigneeSelectorRef,
    projectSelectorRef,
    onHistoryRestoreSecretMaterials,
    onHistoryRestored,
    navigateToSection,
  };

  const isEditableSection = EDITABLE_SECTIONS.includes(section);

  return {
    state: "ready" as const,
    contextValue,
    runRoutine,
    titleInputRef,
    editDraft,
    setEditDraft,
    section,
    descriptionEditorRef,
    navigateToSection,
    routine,
    setRunVariablesOpen,
    automationEnabled,
    automationToggleDisabled,
    automationLabel,
    isSectionDirty,
    companyId,
    routineId,
    hasLiveRun,
    isEditableSection,
    sectionDirtyFields,
    saveRoutine,
    saveConflict,
    discardSection,
    reloadLatest,
    runVariablesOpen,
    agents,
    projects,
  };
}
