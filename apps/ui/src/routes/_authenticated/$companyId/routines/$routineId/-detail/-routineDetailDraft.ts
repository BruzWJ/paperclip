import { routinesApi } from "@/api/routines";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { secretsApi } from "@/api/secrets";
import type { DirtyFieldDescriptor } from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-RoutineHistoryTab";
import type { RoutineScope } from "@/lib/presentation-contracts";
import type { RoutineEditDraft } from "@/routes/_authenticated/$companyId/routines/$routineId/-sections/-context";
import { queryKeys } from "@/lib/queryKeys";
import type { RoutineDetail } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useRoutineDirectoryData } from "../../-useRoutinePresentationData";

/** Converts a persisted routine into the editable form model used by sections. */
export function buildRoutineEditDraft(routine: RoutineDetail): RoutineEditDraft {
  return {
    title: routine.title,
    description: routine.description ?? "",
    projectId: routine.projectId ?? "",
    assigneeAgentId: routine.assigneeAgentId ?? "",
    priority: routine.priority,
    concurrencyPolicy: routine.concurrencyPolicy,
    catchUpPolicy: routine.catchUpPolicy,
    variables: routine.variables,
    env: routine.env ?? null,
  };
}

/** Describes form fields that differ from the routine's canonical revision. */
export function getRoutineDirtyFields(
  editDraft: RoutineEditDraft,
  defaults: RoutineEditDraft | null,
): DirtyFieldDescriptor[] {
  if (!defaults) return [];
  const result: DirtyFieldDescriptor[] = [];
  if (editDraft.title !== defaults.title) result.push({ key: "title", label: "the title" });
  if (editDraft.description !== defaults.description)
    result.push({ key: "description", label: "the description" });
  if (editDraft.projectId !== defaults.projectId) result.push({ key: "projectId", label: "the project" });
  if (editDraft.assigneeAgentId !== defaults.assigneeAgentId)
    result.push({ key: "assigneeAgentId", label: "the default agent" });
  if (editDraft.priority !== defaults.priority) result.push({ key: "priority", label: "the priority" });
  if (editDraft.concurrencyPolicy !== defaults.concurrencyPolicy) {
    result.push({
      key: "concurrencyPolicy",
      label: "the concurrency policy",
    });
  }
  if (editDraft.catchUpPolicy !== defaults.catchUpPolicy)
    result.push({ key: "catchUpPolicy", label: "the catch-up policy" });
  if (JSON.stringify(editDraft.variables) !== JSON.stringify(defaults.variables))
    result.push({ key: "variables", label: "the variables" });
  if (JSON.stringify(editDraft.env ?? null) !== JSON.stringify(defaults.env ?? null))
    result.push({ key: "env", label: "the secrets" });
  return result;
}

export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function buildRoutineMutationPayload(input: RoutineEditDraft) {
  return {
    ...input,
    description: input.description.trim() || null,
    projectId: input.projectId || null,
    assigneeAgentId: input.assigneeAgentId || null,
    env: input.env && Object.keys(input.env).length > 0 ? input.env : null,
  };
}

export type UseRoutineDetailQueriesOptions = RoutineScope;

export function useRoutineDetailQueries({ companyId, routineId }: UseRoutineDetailQueriesOptions) {
  const routineQuery = useQuery({
    queryKey: queryKeys.routines.detail(routineId),
    queryFn: () => routinesApi.get(routineId),
    enabled: Boolean(routineId),
  });
  const routine = routineQuery.data;
  const activeTaskId = routine?.activeTask?.id;
  const { data: activeRunPage } = useQuery({
    queryKey: queryKeys.tasks.runs(activeTaskId!, ACTIVE_TASK_EXECUTION_RUN_STATUSES),
    queryFn: () =>
      runsApi.listForTask(activeTaskId!, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
    enabled: Boolean(activeTaskId),
  });
  const { data: routineRuns } = useQuery({
    queryKey: queryKeys.routines.runs(routineId),
    queryFn: () => routinesApi.listRuns(routineId),
    enabled: Boolean(routineId),
  });
  const relatedActivityIds = useMemo(
    () => ({
      triggerIds: routine?.triggers.map((trigger) => trigger.id) ?? [],
      runIds: routineRuns?.map((run) => run.id) ?? [],
    }),
    [routine?.triggers, routineRuns],
  );
  const { data: activity } = useQuery({
    queryKey: [
      ...queryKeys.routines.activity(companyId, routineId),
      relatedActivityIds.triggerIds.join(","),
      relatedActivityIds.runIds.join(","),
    ],
    queryFn: () => routinesApi.activity(companyId, routineId, relatedActivityIds),
    enabled: Boolean(routine),
  });
  const { agents, projects, companyMembers } = useRoutineDirectoryData(companyId);
  const { data: availableSecrets = [] } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  return {
    routine,
    isLoading: routineQuery.isLoading,
    error: routineQuery.error,
    activeTaskId,
    hasLiveRun: (activeRunPage?.items.length ?? 0) > 0,
    routineRuns,
    activity,
    agents,
    projects,
    companyMembers,
    availableSecrets,
  };
}
