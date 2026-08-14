import type { TaskAttachment } from "@paperclipai/shared";
import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from "react";

import {
  hasFilePayload,
  type ComposerAttachmentItem,
} from "./TaskChatMessageUtils";

export interface TaskChatAttachmentsOptions {
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<TaskAttachment | void>;
  setBody: Dispatch<SetStateAction<string>>;
}

/** Owns the upload queue and drag-and-drop state used by the task composer. */
export function useTaskChatAttachments({
  onImageUpload,
  onAttachImage,
  setBody,
}: TaskChatAttachmentsOptions) {
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<
    ComposerAttachmentItem[]
  >([]);
  const dragDepthRef = useRef(0);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const attachInputId = useId();
  const canAcceptFiles = Boolean(onImageUpload || onAttachImage);

  async function attachFile(file: File) {
    const attachmentId = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const inline = Boolean(onImageUpload && file.type.startsWith("image/"));
    setComposerAttachments((prev) => [
      ...prev,
      {
        id: attachmentId,
        name: file.name,
        size: file.size,
        status: "uploading",
        inline,
      },
    ]);

    try {
      if (onImageUpload && file.type.startsWith("image/")) {
        const url = await onImageUpload(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? { ...item, status: "attached", contentPath: url }
              : item,
          ),
        );
      } else if (onAttachImage) {
        const attachment = await onAttachImage(file);
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "attached",
                  contentPath: attachment?.contentPath,
                  name: attachment?.originalFilename ?? item.name,
                }
              : item,
          ),
        );
      } else {
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "error",
                  error: "This file type cannot be attached here",
                }
              : item,
          ),
        );
      }
    } catch (err) {
      setComposerAttachments((prev) =>
        prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: "error",
                error: err instanceof Error ? err.message : "Upload failed",
              }
            : item,
        ),
      );
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      await attachFile(file);
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleDroppedFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        await attachFile(file);
      }
    } finally {
      setAttaching(false);
    }
  }

  function resetDragState() {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleFileDragEnter(evt: DragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleFileDragOver(evt: DragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(evt: DragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleFileDrop(evt: DragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    resetDragState();
    void handleDroppedFiles(evt.dataTransfer?.files);
  }

  return {
    attaching,
    setAttaching,
    isDragOver,
    setIsDragOver,
    composerAttachments,
    setComposerAttachments,
    dragDepthRef,
    attachInputRef,
    attachInputId,
    canAcceptFiles,
    attachFile,
    handleAttachFile,
    handleDroppedFiles,
    resetDragState,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
  };
}
