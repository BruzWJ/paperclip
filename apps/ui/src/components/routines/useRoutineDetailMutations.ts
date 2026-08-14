import { ApiError } from "@/api/client";
import {
  routinesApi,
  type RotateRoutineTriggerResponse,
  type RoutineTriggerResponse,
} from "@/api/routines";
import { secretsApi } from "@/api/secrets";
import type { RoutineRunDialogSubmitData } from "@/components/RoutineRunVariablesDialog";
import {
  createDefaultNewTrigger,
  type RoutineEditDraft,
  type RoutineSectionKey,
  type SecretMessage,
} from "@/components/routine-sections/context";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import {
  buildRoutineMutationPayload,
  getLocalTimezone,
} from "./routineDetailDraft";
import type { RoutineDetail } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

export interface UseRoutineDetailMutationsOptions {
  companyId: string;
  routineId: string;
  routine: RoutineDetail | undefined;
  editDraft: RoutineEditDraft;
  newTrigger: ReturnType<typeof createDefaultNewTrigger>;
  setRunVariablesOpen: Dispatch<SetStateAction<boolean>>;
  setSaveConflict: Dispatch<SetStateAction<boolean>>;
  setSecretMessage: Dispatch<SetStateAction<SecretMessage | null>>;
  navigateToSection: (section: RoutineSectionKey) => void;
}

/** Owns all server mutations used by the routine detail screen. */
export function useRoutineDetailMutations({
  companyId,
  routineId,
  routine,
  editDraft,
  newTrigger,
  setRunVariablesOpen,
  setSaveConflict,
  setSecretMessage,
  navigateToSection,
}: UseRoutineDetailMutationsOptions) {
  const queryClient = useQueryClient();

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) =>
      secretsApi.create(companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
    },
  });

  const saveRoutine = useMutation({
    mutationFn: () => {
      const payload = buildRoutineMutationPayload(editDraft);
      const baseRevisionId = routine?.latestRevisionId;
      if (!baseRevisionId) {
        throw new Error("Routine has no canonical revision.");
      }
      return routinesApi.update(routineId, { ...payload, baseRevisionId });
    },
    onSuccess: async () => {
      setSaveConflict(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(routineId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.activity(companyId, routineId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.revisions(routineId),
        }),
      ]);
    },
    onError: (mutationError) => {
      if (mutationError instanceof ApiError && mutationError.status === 409) {
        setSaveConflict(true);
        toast.warning("Routine changed", {
          description:
            "Someone else updated this routine. Reload to see the latest revision.",
        });
        return;
      }
      toast.error("Failed to save routine", {
        description:
          mutationError instanceof Error
            ? mutationError.message
            : "Paperclip could not save the routine.",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: (data?: RoutineRunDialogSubmitData) =>
      routinesApi.run(routineId, {
        ...(data?.variables && Object.keys(data.variables).length > 0
          ? { variables: data.variables }
          : {}),
        ...(data?.assigneeAgentId !== undefined
          ? { assigneeAgentId: data.assigneeAgentId }
          : {}),
        ...(data?.projectId !== undefined ? { projectId: data.projectId } : {}),
      }),
    onSuccess: async () => {
      toast.success("Routine run started");
      setRunVariablesOpen(false);
      navigateToSection("runs");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(routineId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.runs(routineId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.activity(companyId, routineId),
        }),
      ]);
    },
    onError: (runError) => {
      toast.error("Routine run failed", {
        description:
          runError instanceof Error
            ? runError.message
            : "Paperclip could not start the routine run.",
      });
    },
  });

  const updateRoutineStatus = useMutation({
    mutationFn: (status: string) => {
      if (!routine?.latestRevisionId) {
        throw new Error("Routine has no canonical revision.");
      }
      return routinesApi.update(routineId, {
        status,
        baseRevisionId: routine.latestRevisionId,
      });
    },
    onSuccess: async (_data, status) => {
      toast.success("Routine saved", {
        description:
          status === "paused" ? "Automation paused." : "Automation enabled.",
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(routineId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(companyId),
        }),
      ]);
    },
    onError: (statusError) => {
      toast.error("Failed to update routine", {
        description:
          statusError instanceof Error
            ? statusError.message
            : "Paperclip could not update the routine.",
      });
    },
  });

  const createTrigger = useMutation({
    mutationFn: async (): Promise<RoutineTriggerResponse> => {
      const existingOfKind = (routine?.triggers ?? []).filter(
        (trigger) => trigger.kind === newTrigger.kind,
      ).length;
      const autoLabel =
        existingOfKind > 0
          ? `${newTrigger.kind}-${existingOfKind + 1}`
          : newTrigger.kind;
      return routinesApi.createTrigger(routineId, {
        kind: newTrigger.kind,
        label: autoLabel,
        ...(newTrigger.kind === "schedule"
          ? {
              cronExpression: newTrigger.cronExpression.trim(),
              timezone: getLocalTimezone(),
            }
          : {}),
        ...(newTrigger.kind === "webhook"
          ? {
              signingMode: newTrigger.signingMode,
              replayWindowSec: Number(newTrigger.replayWindowSec || "300"),
            }
          : {}),
      });
    },
    onSuccess: async (result) => {
      if (result.secretMaterial) {
        setSecretMessage({
          title: "Webhook trigger created",
          entries: [{ ...result.secretMaterial }],
        });
      } else {
        toast.success("Trigger added", {
          description: "The routine schedule was saved.",
        });
      }
      await invalidateRoutineDetail(queryClient, companyId, routineId);
    },
    onError: (triggerError) => {
      toast.error("Failed to add trigger", {
        description:
          triggerError instanceof Error
            ? triggerError.message
            : "Paperclip could not create the trigger.",
      });
    },
  });

  const updateTrigger = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Record<string, unknown>;
    }) => routinesApi.updateTrigger(id, patch),
    onSuccess: async () => {
      toast.success("Trigger saved", {
        description: "The routine cadence update was saved.",
      });
      await invalidateRoutineDetail(queryClient, companyId, routineId);
    },
    onError: (triggerError) => {
      toast.error("Failed to update trigger", {
        description:
          triggerError instanceof Error
            ? triggerError.message
            : "Paperclip could not update the trigger.",
      });
    },
  });

  const deleteTrigger = useMutation({
    mutationFn: (id: string) => routinesApi.deleteTrigger(id),
    onSuccess: async () => {
      toast.success("Trigger deleted");
      await invalidateRoutineDetail(queryClient, companyId, routineId);
    },
    onError: (triggerError) => {
      toast.error("Failed to delete trigger", {
        description:
          triggerError instanceof Error
            ? triggerError.message
            : "Paperclip could not delete the trigger.",
      });
    },
  });

  const rotateTrigger = useMutation({
    mutationFn: (id: string): Promise<RotateRoutineTriggerResponse> =>
      routinesApi.rotateTriggerSecret(id),
    onSuccess: async (result) => {
      setSecretMessage({
        title: "Webhook secret rotated",
        entries: [{ ...result.secretMaterial }],
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(routineId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.activity(companyId, routineId),
        }),
      ]);
    },
    onError: (triggerError) => {
      toast.error("Failed to rotate webhook secret", {
        description:
          triggerError instanceof Error
            ? triggerError.message
            : "Paperclip could not rotate the webhook secret.",
      });
    },
  });

  return {
    createSecret,
    saveRoutine,
    runRoutine,
    updateRoutineStatus,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    rotateTrigger,
  };
}

async function invalidateRoutineDetail(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  routineId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.routines.detail(routineId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.routines.list(companyId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.routines.activity(companyId, routineId),
    }),
  ]);
}
