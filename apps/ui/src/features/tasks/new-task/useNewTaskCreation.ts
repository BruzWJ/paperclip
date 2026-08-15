import { useCallback, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateTask } from "@paperclipai/shared";
import { toast } from "sonner";
import { assetsApi } from "@/api/assets";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigateCompanyBoardTarget } from "../../navigation/CompanyBoardLink";
import { clearDraft, type StagedTaskFile } from "./model";

export function useNewTaskCreation({
  companyId,
  closeNewTask,
  reset,
  draftTimer,
}: {
  companyId: string;
  closeNewTask: () => void;
  reset: () => void;
  draftTimer: RefObject<ReturnType<typeof setTimeout> | null>;
}) {
  const queryClient = useQueryClient();
  const navigateToBoardTarget = useNavigateCompanyBoardTarget();
  const createTask = useMutation({
    mutationFn: async ({
      companyId: targetCompanyId,
      stagedFiles,
      ...data
    }: { companyId: string; stagedFiles: StagedTaskFile[] } & CreateTask) => {
      const task = await tasksApi.create(targetCompanyId, data);
      const failures: string[] = [];
      for (const stagedFile of stagedFiles) {
        try {
          if (stagedFile.kind === "document") {
            await tasksApi.upsertDocument(
              task.id,
              stagedFile.documentKey ?? "document",
              {
                title:
                  stagedFile.documentKey === "plan"
                    ? null
                    : (stagedFile.title ?? null),
                format: "markdown",
                body: await stagedFile.file.text(),
                baseRevisionId: null,
              },
            );
          } else {
            await tasksApi.uploadAttachment(
              targetCompanyId,
              task.id,
              stagedFile.file,
            );
          }
        } catch {
          failures.push(stagedFile.file.name);
        }
      }
      return { task, companyId: targetCompanyId, failures };
    },
    onSuccess: ({ task, companyId: targetCompanyId, failures }) => {
      [
        queryKeys.tasks.list(targetCompanyId),
        queryKeys.tasks.listMineByMe(targetCompanyId),
        queryKeys.tasks.listTouchedByMe(targetCompanyId),
        queryKeys.tasks.listUnreadTouchedByMe(targetCompanyId),
        queryKeys.sidebarBadges(targetCompanyId),
      ].forEach((queryKey) => void queryClient.invalidateQueries({ queryKey }));
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (failures.length) {
        const label = task.identifier;
        toast.warning(`Created ${label} with upload warnings`, {
          description: `${failures.length} staged ${failures.length === 1 ? "file" : "files"} could not be added.`,
          action: {
            label: `Open ${label}`,
            onClick: () =>
              navigateToBoardTarget({
                kind: "task",
                taskNumber: task.taskNumber,
                hash: null,
              }),
          },
        });
      }
      clearDraft();
      reset();
      closeNewTask();
    },
  });
  const uploadRequestImage = useMutation({
    mutationFn: (file: File) =>
      assetsApi.uploadImage(companyId, file, "tasks/drafts"),
  });
  const uploadRequestImageHandler = useCallback(
    async (file: File) =>
      (await uploadRequestImage.mutateAsync(file)).contentPath,
    [uploadRequestImage.mutateAsync],
  );
  const isPending = createTask.isPending;
  // Create action stays disabled={isPending} and shows {isPending ? "Creating" : "Create"}.
  return { createTask, isPending, uploadRequestImageHandler };
}
