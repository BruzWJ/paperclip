import { foldersApi } from "@/api/folders";
import { routinesApi } from "@/api/routines";
import type { RoutineRunDialogSubmitData } from "@/components/RoutineRunVariablesDialog";
import type { FolderSelection } from "@/components/folders/FolderControls";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import type { FolderListItem, RoutineListItem } from "@paperclipai/shared";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Dispatch, SetStateAction } from "react";
import { buildRoutineMutationPayload } from "./-routines-list-data";

type RoutineDraft = Parameters<typeof buildRoutineMutationPayload>[0];

type RoutinesMutationContext = {
  companyId: string;
  queryClient: QueryClient;
  draft: RoutineDraft;
  setDraft: Dispatch<SetStateAction<RoutineDraft>>;
  setComposerOpen: Dispatch<SetStateAction<boolean>>;
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  navigate: ReturnType<typeof useNavigate>;
  setFolderDialogOpen: Dispatch<SetStateAction<boolean>>;
  setFolderDialogTarget: Dispatch<SetStateAction<FolderListItem | null>>;
  moveAfterCreateIds: string[];
  setMoveAfterCreateIds: Dispatch<SetStateAction<string[]>>;
  setFolderSelection: (selection: FolderSelection) => void;
  folderSelection: FolderSelection;
  setDeleteFolderTarget: Dispatch<SetStateAction<FolderListItem | null>>;
  setStatusMutationRoutineId: Dispatch<SetStateAction<string | null>>;
  setRunningRoutineId: Dispatch<SetStateAction<string | null>>;
  setRunDialogRoutine: Dispatch<SetStateAction<RoutineListItem | null>>;
};

export async function moveRoutineSelection(input: {
  companyId: string;
  folderId: string | null;
  selectedRoutineIds: string[];
  setSelectedRoutineIds: Dispatch<SetStateAction<string[]>>;
  setSelectMode: Dispatch<SetStateAction<boolean>>;
  queryClient: QueryClient;
}) {
  if (input.selectedRoutineIds.length === 0) return;
  try {
    await Promise.all(
      input.selectedRoutineIds.map((itemId) =>
        foldersApi.moveItem(input.companyId, {
          kind: "routine",
          itemId,
          folderId: input.folderId,
        }),
      ),
    );
    input.setSelectedRoutineIds([]);
    input.setSelectMode(false);
    await Promise.all([
      input.queryClient.invalidateQueries({
        queryKey: queryKeys.routines.list(input.companyId),
      }),
      input.queryClient.invalidateQueries({
        queryKey: queryKeys.folders.list(input.companyId, "routine"),
      }),
    ]);
    toast.success("Routines moved", {
      description: `${input.selectedRoutineIds.length} routine${input.selectedRoutineIds.length === 1 ? "" : "s"} filed.`,
    });
  } catch (error) {
    toast.error("Failed to move routines", {
      description: error instanceof Error ? error.message : "Paperclip could not move the selected routines.",
    });
  }
}

export function useRoutinesMutations(input: RoutinesMutationContext) {
  const {
    companyId,
    queryClient,
    draft,
    setDraft,
    setComposerOpen,
    setAdvancedOpen,
    navigate,
    setFolderDialogOpen,
    setFolderDialogTarget,
    moveAfterCreateIds,
    setMoveAfterCreateIds,
    setFolderSelection,
    folderSelection,
    setDeleteFolderTarget,
    setStatusMutationRoutineId,
    setRunningRoutineId,
    setRunDialogRoutine,
  } = input;

  const createRoutine = useMutation({
    mutationFn: () => routinesApi.create(companyId, buildRoutineMutationPayload(draft)),
    onSuccess: async (routine) => {
      setDraft({
        title: "",
        description: "",
        projectId: "",
        folderId: null,
        assigneeAgentId: "",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      });
      setComposerOpen(false);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.routines.list(companyId),
      });
      toast.success("Routine created", {
        description: routine.assigneeAgentId
          ? "Add the first trigger to turn it into a live workflow."
          : "Draft saved. Add a default agent before enabling automation.",
      });
      void navigate({
        to: "/$companyId/routines/$routineId/$section",
        params: { companyId, routineId: routine.id, section: "triggers" },
      });
    },
  });
  const createFolder = useMutation({
    mutationFn: (payload: { name: string; color: string | null }) =>
      foldersApi.create(companyId, { kind: "routine", ...payload }),
    onSuccess: async (folder) => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.folders.list(companyId, "routine"),
      });
      if (moveAfterCreateIds.length > 0) {
        const ids = moveAfterCreateIds;
        setMoveAfterCreateIds([]);
        try {
          await Promise.all(
            ids.map((itemId) =>
              foldersApi.moveItem(companyId, {
                kind: "routine",
                itemId,
                folderId: folder.id,
              }),
            ),
          );
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: queryKeys.routines.list(companyId),
            }),
            queryClient.invalidateQueries({
              queryKey: queryKeys.folders.list(companyId, "routine"),
            }),
          ]);
        } catch (moveError) {
          toast.error("Folder created, move failed", {
            description:
              moveError instanceof Error
                ? moveError.message
                : "Paperclip could not move the selected routines.",
          });
          return;
        }
      } else {
        setFolderSelection(folder.id);
      }
      toast.success("Folder created", { description: folder.name });
    },
    onError: (mutationError) => {
      toast.error("Failed to save folder", {
        description:
          mutationError instanceof Error ? mutationError.message : "Paperclip could not save the folder.",
      });
    },
  });
  const updateFolder = useMutation({
    mutationFn: ({
      folderId,
      payload,
    }: {
      folderId: string;
      payload: { name?: string; color?: string | null };
    }) => foldersApi.update(companyId, folderId, payload),
    onSuccess: async () => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.folders.list(companyId, "routine"),
      });
    },
    onError: (mutationError) => {
      toast.error("Folder save failed", {
        description:
          mutationError instanceof Error ? mutationError.message : "Paperclip could not update the folder.",
      });
    },
  });
  const deleteFolder = useMutation({
    mutationFn: (folderId: string) => foldersApi.delete(companyId, folderId),
    onSuccess: async (_, folderId) => {
      if (folderSelection === folderId) setFolderSelection("all");
      setDeleteFolderTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.folders.list(companyId, "routine"),
        }),
      ]);
      toast.success("Folder deleted", {
        description: "Items moved to Unfiled.",
      });
    },
    onError: (mutationError) => {
      toast.error("Folder delete failed", {
        description:
          mutationError instanceof Error ? mutationError.message : "Paperclip could not delete the folder.",
      });
    },
  });
  const moveRoutineToFolder = useMutation({
    mutationFn: ({ itemId, folderId }: { itemId: string; folderId: string | null }) =>
      foldersApi.moveItem(companyId, { kind: "routine", itemId, folderId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.folders.list(companyId, "routine"),
        }),
      ]);
    },
    onError: (mutationError) => {
      toast.error("Move failed", {
        description:
          mutationError instanceof Error ? mutationError.message : "Paperclip could not move the routine.",
      });
    },
  });
  const updateRoutineStatus = useMutation({
    mutationFn: ({ id, status, baseRevisionId }: { id: string; status: string; baseRevisionId: string }) =>
      routinesApi.update(id, { status, baseRevisionId }),
    onMutate: ({ id }) => {
      setStatusMutationRoutineId(id);
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(variables.id),
        }),
      ]);
    },
    onSettled: () => {
      setStatusMutationRoutineId(null);
    },
    onError: (mutationError) => {
      toast.error("Failed to update routine", {
        description:
          mutationError instanceof Error ? mutationError.message : "Paperclip could not update the routine.",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: ({ id, data }: { id: string; data?: RoutineRunDialogSubmitData }) =>
      routinesApi.run(id, {
        ...(data?.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
        ...(data?.assigneeAgentId !== undefined ? { assigneeAgentId: data.assigneeAgentId } : {}),
        ...(data?.projectId !== undefined ? { projectId: data.projectId } : {}),
      }),
    onMutate: ({ id }) => {
      setRunningRoutineId(id);
    },
    onSuccess: async (_, { id }) => {
      setRunDialogRoutine(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.list(companyId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.routines.detail(id),
        }),
      ]);
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      toast.error("Routine run failed", {
        description:
          mutationError instanceof Error
            ? mutationError.message
            : "Paperclip could not start the routine run.",
      });
    },
  });

  return {
    createRoutine,
    createFolder,
    updateFolder,
    deleteFolder,
    moveRoutineToFolder,
    updateRoutineStatus,
    runRoutine,
  };
}
