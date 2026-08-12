import { isCanonicalUuid, taskDocumentKeySchema } from "@paperclipai/shared";

export interface DocumentAnnotationHashTarget {
  documentKey: string;
  threadId: string | null;
  commentId: string | null;
}

const DOCUMENT_HASH_PREFIX = "#document-";

export function parseDocumentAnnotationHash(
  hash: string,
): DocumentAnnotationHashTarget | null {
  if (!hash.startsWith(DOCUMENT_HASH_PREFIX)) return null;
  const stripped = hash.slice(DOCUMENT_HASH_PREFIX.length);
  const parts = stripped.split("&");
  const documentKey = parts[0];
  if (!taskDocumentKeySchema.safeParse(documentKey).success) return null;

  let threadId: string | null = null;
  let commentId: string | null = null;
  if (parts.length >= 2) {
    if (!parts[1]?.startsWith("thread=")) return null;
    threadId = parts[1].slice("thread=".length);
    if (!isCanonicalUuid(threadId)) return null;
  }
  if (parts.length === 3) {
    if (!parts[2]?.startsWith("comment=")) return null;
    commentId = parts[2].slice("comment=".length);
    if (!isCanonicalUuid(commentId)) return null;
  } else if (parts.length > 3) {
    return null;
  }

  const target = { documentKey, threadId, commentId };
  return buildDocumentAnnotationHash(target) === hash ? target : null;
}

export function buildDocumentAnnotationHash(
  target: DocumentAnnotationHashTarget,
): string {
  if (!taskDocumentKeySchema.safeParse(target.documentKey).success) {
    throw new Error("Document annotation links require an exact document key");
  }
  if (target.threadId !== null && !isCanonicalUuid(target.threadId)) {
    throw new Error(
      "Document annotation links require a canonical thread UUID",
    );
  }
  if (target.commentId !== null) {
    if (target.threadId === null || !isCanonicalUuid(target.commentId)) {
      throw new Error(
        "Document annotation comment links require canonical thread and comment UUIDs",
      );
    }
  }

  let hash = `${DOCUMENT_HASH_PREFIX}${target.documentKey}`;
  if (target.threadId !== null) hash += `&thread=${target.threadId}`;
  if (target.commentId !== null) hash += `&comment=${target.commentId}`;
  return hash;
}
