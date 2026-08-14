import type { TaskAttachment } from "@paperclipai/shared";
import { useState, type Dispatch, type SetStateAction } from "react";

import { type ComposerAttachmentItem } from "./TaskChatMessageUtils";

export interface TaskChatAttachmentsOptions {
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<TaskAttachment | void>;
  setBody: Dispatch<SetStateAction<string>>;
}

/** Owns the upload queue used by the Kibo Dropzone in the task composer. */
export function useTaskChatAttachments({
  onImageUpload,
  onAttachImage,
  setBody,
}: TaskChatAttachmentsOptions) {
  const [attaching, setAttaching] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachmentItem[]>([]);
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
            item.id === attachmentId ? { ...item, status: "attached", contentPath: url } : item,
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

  async function handleDroppedFiles(files: File[] | FileList | null | undefined) {
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

  return {
    attaching,
    composerAttachments,
    setComposerAttachments,
    canAcceptFiles,
    handleDroppedFiles,
  };
}
