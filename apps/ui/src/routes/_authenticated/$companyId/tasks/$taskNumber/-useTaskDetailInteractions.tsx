import { tasksApi } from "@/api/tasks";
import type { GalleryMediaItem } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-ImageGalleryModal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { toast } from "sonner";
import { copyTextToClipboard } from "@/lib/clipboard";
import { isImageAttachment, isVideoAttachment } from "@/lib/task-attachments";
import { taskDisplayTitle } from "@/lib/task-display";
import {
  getPromotedOutputAttachmentIds,
  getTaskOutputs,
  isImageContentType,
  isVideoLikeOutput,
} from "@/lib/task-output";
import type { Task, TaskAttachment, TaskWorkProduct } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { Archive, ArrowLeft, Copy, MoreVertical, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";

import type { CommentOwnerChange } from "./-task-detail-model";
import type { useTaskDetailActionMutations } from "./-useTaskDetailActionMutations";
import type { useTaskDetailCacheActions } from "./-useTaskDetailEffects";
import type { useTaskDetailCoreMutations } from "./-useTaskDetailCoreMutations";

export interface TaskDetailInteractionsOptions {
  companyId: string;
  taskId: string;
  task: Task | undefined;
  attachments?: TaskAttachment[];
  attachmentsLoading: boolean;
  workProducts?: TaskWorkProduct[];
  isMobile: boolean;
  isFromInbox: boolean;
  setMobileToolbar: ReturnType<typeof useBreadcrumbs>["setMobileToolbar"];
  archiveFromInbox: ReturnType<typeof useTaskDetailActionMutations>["archiveFromInbox"];
  addComment: ReturnType<typeof useTaskDetailActionMutations>["addComment"];
  uploadAttachment: ReturnType<typeof useTaskDetailActionMutations>["uploadAttachment"];
  reassignTask: ReturnType<typeof useTaskDetailCoreMutations>["reassignTask"];
  cacheActions: ReturnType<typeof useTaskDetailCacheActions>;
  isNamedUserCreator: boolean;
  isSystemEscalationHumanOwner: boolean;
  isUserCreatorWithdrawalOwner: boolean;
  copied: boolean;
  setCopied: Dispatch<SetStateAction<boolean>>;
  mobilePropsOpen: boolean;
  setMobilePropsOpen: Dispatch<SetStateAction<boolean>>;
  galleryOpen: boolean;
  setGalleryOpen: Dispatch<SetStateAction<boolean>>;
  galleryIndex: number;
  setGalleryIndex: Dispatch<SetStateAction<number>>;
}

/** Owns gallery, clipboard, mobile-toolbar, and chat interaction handlers. */
export function useTaskDetailInteractions({
  companyId,
  taskId,
  task,
  attachments,
  attachmentsLoading,
  workProducts,
  isMobile,
  isFromInbox,
  setMobileToolbar,
  archiveFromInbox,
  addComment,
  uploadAttachment,
  reassignTask,
  cacheActions,
  isNamedUserCreator,
  isSystemEscalationHumanOwner,
  isUserCreatorWithdrawalOwner,
  copied,
  setCopied,
  mobilePropsOpen,
  setMobilePropsOpen,
  galleryOpen,
  setGalleryOpen,
  galleryIndex,
  setGalleryIndex,
}: TaskDetailInteractionsOptions) {
  const { invalidateTaskDetail, invalidateTaskRunState, upsertCommentInCache, invalidateTaskCollections } =
    cacheActions;

  const promotedOutputAttachmentIds = useMemo(
    () => getPromotedOutputAttachmentIds(workProducts),
    [workProducts],
  );
  const attachmentList = useMemo(
    () => (attachments ?? []).filter((attachment) => !promotedOutputAttachmentIds.has(attachment.id)),
    [attachments, promotedOutputAttachmentIds],
  );
  const mediaGalleryItems = useMemo<GalleryMediaItem[]>(() => {
    const items: GalleryMediaItem[] = [];
    const seen = new Set<string>();
    const mark = (attachmentId: string | null | undefined, contentPath: string) => {
      if (attachmentId) seen.add(`attachment:${attachmentId}`);
      seen.add(`content:${contentPath}`);
    };
    const hasSeen = (attachmentId: string | null | undefined, contentPath: string) =>
      Boolean(attachmentId && seen.has(`attachment:${attachmentId}`)) || seen.has(`content:${contentPath}`);

    for (const attachment of attachments ?? []) {
      if (!isImageAttachment(attachment) && !isVideoAttachment(attachment)) {
        continue;
      }
      items.push(attachment);
      mark(attachment.id, attachment.contentPath);
    }
    for (const item of getTaskOutputs(workProducts).items) {
      const metadata = item.metadata;
      if (!metadata) continue;
      const isMedia =
        isImageContentType(metadata.contentType) ||
        isVideoLikeOutput(metadata.contentType, metadata.originalFilename);
      if (!isMedia || hasSeen(metadata.attachmentId, metadata.contentPath)) {
        continue;
      }
      items.push({
        id: `work-product-${item.id}`,
        contentPath: metadata.contentPath,
        openPath: metadata.openPath,
        downloadPath: metadata.downloadPath,
        contentType: metadata.contentType,
        originalFilename: metadata.originalFilename ?? item.title,
      });
      mark(metadata.attachmentId, metadata.contentPath);
    }
    return items;
  }, [attachments, workProducts]);

  const handleChatImageClick = useCallback(
    (src: string) => {
      let index = mediaGalleryItems.findIndex((item) => item.contentPath === src);
      if (index < 0) {
        const assetMatch = src.match(/\/api\/assets\/([^/]+)\/content/);
        if (assetMatch) {
          index = mediaGalleryItems.findIndex((item) => "assetId" in item && item.assetId === assetMatch[1]);
        }
      }
      if (index >= 0) {
        setGalleryIndex(index);
        setGalleryOpen(true);
      } else {
        window.open(src, "_blank");
      }
    },
    [mediaGalleryItems],
  );

  const copyTaskToClipboard = async () => {
    if (!task) return;
    const decodeEntities = (text: string) => {
      const element = document.createElement("textarea");
      element.innerHTML = text;
      return element.value;
    };
    const title = decodeEntities(taskDisplayTitle(task));
    const body = decodeEntities(task.request ?? "");
    const markdown = `# ${task.identifier}: ${title}\n\n${body}`.trimEnd();
    try {
      await copyTextToClipboard(markdown);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Copy failed", {
        description: error instanceof Error ? error.message : "Unable to copy task markdown",
      });
    }
  };
  const inboxToolbarCallbacksRef = useRef({
    onArchive: () => {
      if (!archiveFromInbox.isPending && task?.id) {
        archiveFromInbox.mutate(task.id);
      }
    },
    onCopy: () => copyTaskToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
  });
  inboxToolbarCallbacksRef.current = {
    onArchive: () => {
      if (!archiveFromInbox.isPending && task?.id) {
        archiveFromInbox.mutate(task.id);
      }
    },
    onCopy: () => copyTaskToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
  };

  const showInboxToolbar = isMobile && isFromInbox;
  const archivePending = archiveFromInbox.isPending;
  const taskHidden = !!task?.hiddenAt;
  const canArchiveFromInbox = isFromInbox && !!task?.id && !taskHidden;
  useEffect(() => {
    if (!showInboxToolbar) {
      setMobileToolbar(null);
      return;
    }
    setMobileToolbar(
      <div className="flex w-full items-center">
        <Button variant="ghost" size="icon-sm" asChild aria-label="Back to inbox">
          <Link to="/$companyId/inbox" params={{ companyId }} aria-label="Back to inbox">
            <ArrowLeft  data-icon="inline-start"/>
          </Link>
        </Button>

        <div className="ml-auto flex items-center gap-0.5">
          {task?.id && !taskHidden ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => inboxToolbarCallbacksRef.current.onArchive()}
              disabled={archivePending}
              aria-label="Archive from inbox"
            >
              <Archive  data-icon="inline-start"/>
            </Button>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More actions">
                <MoreVertical  data-icon="inline-start"/>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => inboxToolbarCallbacksRef.current.onCopy()}>
                <Copy  data-icon="inline-end"/>
                Copy as markdown
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => inboxToolbarCallbacksRef.current.onProperties()}>
                <SlidersHorizontal  data-icon="inline-end"/>
                Properties
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>,
    );
    return () => setMobileToolbar(null);
  }, [showInboxToolbar, companyId, task?.id, taskHidden, archivePending, setMobileToolbar]);

  const handleChatAdd = useCallback(
    async (
      body: string,
      ownerChange?: CommentOwnerChange,
      mentionAgentId?: string,
      replyToCommentId?: string,
    ) => {
      let commentTarget = task;
      if (ownerChange) {
        const result = await reassignTask.mutateAsync(ownerChange.ownerAgentId);
        commentTarget = result.task;
      }
      if (isUserCreatorWithdrawalOwner) {
        throw new Error("A withdrawn task accepts only the creator's cancellation");
      }
      if (isNamedUserCreator && !replyToCommentId) {
        const result = await tasksApi.commitCreatorFormUpdate({
          taskId,
          message: body,
        });
        upsertCommentInCache(result.comment);
        invalidateTaskDetail();
        invalidateTaskRunState();
        invalidateTaskCollections();
        return;
      }
      if (isSystemEscalationHumanOwner && !replyToCommentId) {
        const result = await tasksApi.commitOwnerFormUpdate({
          taskId,
          message: body,
        });
        upsertCommentInCache(result.comment);
        invalidateTaskDetail();
        invalidateTaskCollections();
        return;
      }
      const mention =
        mentionAgentId &&
        commentTarget?.ownerAgentId === mentionAgentId &&
        typeof commentTarget.ownershipEpoch === "number" &&
        Number.isInteger(commentTarget.ownershipEpoch) &&
        commentTarget.ownershipEpoch > 0
          ? {
              targetAgentId: mentionAgentId,
              ownershipEpoch: commentTarget.ownershipEpoch,
            }
          : null;
      await addComment.mutateAsync({
        message: body,
        idempotencyKey: crypto.randomUUID(),
        mention: replyToCommentId ? null : mention,
        replyToCommentId: replyToCommentId ?? null,
      });
    },
    [
      addComment,
      invalidateTaskCollections,
      invalidateTaskDetail,
      invalidateTaskRunState,
      isNamedUserCreator,
      isSystemEscalationHumanOwner,
      isUserCreatorWithdrawalOwner,
      task,
      taskId,
      reassignTask,
      upsertCommentInCache,
    ],
  );
  const handleCommentImageUpload = useCallback(
    async (file: File) => {
      const attachment = await uploadAttachment.mutateAsync(file);
      return attachment.contentPath;
    },
    [uploadAttachment],
  );
  const handleCommentAttachImage = useCallback(
    (file: File) => uploadAttachment.mutateAsync(file),
    [uploadAttachment],
  );

  return {
    copied,
    setCopied,
    mobilePropsOpen,
    setMobilePropsOpen,
    galleryOpen,
    setGalleryOpen,
    galleryIndex,
    setGalleryIndex,
    attachmentList,
    mediaGalleryItems,
    handleChatImageClick,
    copyTaskToClipboard,
    archivePending,
    canArchiveFromInbox,
    attachmentsInitialLoading: attachmentsLoading && attachments === undefined,
    handleChatAdd,
    handleCommentImageUpload,
    handleCommentAttachImage,
  };
}
