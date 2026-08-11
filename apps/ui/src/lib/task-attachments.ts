import type { TaskAttachment } from "@paperclipai/shared";
import { isVideoLikeOutput } from "./task-output";

const GENERIC_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
]);

type AttachmentPathLike = {
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
};

function normalizedContentType(attachment: Pick<TaskAttachment, "contentType">) {
  return attachment.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function attachmentFilename(attachment: Pick<TaskAttachment, "id" | "originalFilename">) {
  return attachment.originalFilename ?? attachment.id;
}

export function attachmentOpenPath(attachment: AttachmentPathLike) {
  return attachment.openPath ?? attachment.contentPath;
}

export function attachmentDownloadPath(attachment: AttachmentPathLike) {
  return attachment.downloadPath ?? `${attachment.contentPath}?download=1`;
}

export function isImageAttachment(attachment: Pick<TaskAttachment, "contentType">) {
  return normalizedContentType(attachment).startsWith("image/");
}

export function isVideoAttachment(
  attachment: Pick<TaskAttachment, "contentType" | "originalFilename">,
) {
  return isVideoLikeOutput(attachment.contentType, attachment.originalFilename);
}

export function isMarkdownAttachment(
  attachment: Pick<TaskAttachment, "contentType" | "originalFilename">,
) {
  const contentType = normalizedContentType(attachment);
  if (
    contentType === "text/markdown" ||
    contentType === "text/x-markdown" ||
    contentType === "application/markdown" ||
    contentType === "application/x-markdown"
  ) {
    return true;
  }

  const filename = (attachment.originalFilename ?? "").toLowerCase();
  if (!filename.endsWith(".md") && !filename.endsWith(".markdown")) return false;
  return contentType === "text/plain" || GENERIC_ATTACHMENT_CONTENT_TYPES.has(contentType);
}
