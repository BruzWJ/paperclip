import type { FileUIPart } from "ai";
import { buildAgentMentionHref, parseAgentMentionHref } from "@paperclipai/shared";
import { useEffect, useImperativeHandle, useRef, useState, type ForwardedRef } from "react";

import { captureComposerViewportSnapshot, restoreComposerViewportSnapshot } from "@/lib/task-chat-scroll";
import type {
  TaskChatAgentMention,
  TaskChatComposerHandle,
  TaskChatComposerProps,
  TaskChatMentionTarget,
} from "./-TaskChatShared";
import {
  COMPOSER_FOCUS_SCROLL_PADDING_PX,
  DRAFT_DEBOUNCE_MS,
  clearDraft,
  loadDraft,
  saveDraft,
} from "./-TaskChatMessageUtils";

const AGENT_LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;

function escapeMarkdownLabel(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function renderPersistedAgentMentions(body: string) {
  return body.replace(AGENT_LINK_RE, (match, label: string, href: string) =>
    parseAgentMentionHref(href) ? label : match,
  );
}

export function serializeTaskChatOwnerNotification(body: string, target: TaskChatMentionTarget) {
  const mention = `[@${escapeMarkdownLabel(target.name)}](${buildAgentMentionHref(
    target.targetAgentId,
    target.icon ?? null,
  )})`;
  return body.length > 0 ? `${mention} ${body}` : mention;
}

async function filePartToFile(part: FileUIPart) {
  const response = await fetch(part.url);
  if (!response.ok) throw new Error(`Unable to read ${part.filename ?? "attachment"}`);
  const blob = await response.blob();
  return new File([blob], part.filename || "attachment", {
    type: part.mediaType || blob.type || "application/octet-stream",
  });
}

export function useTaskChatComposerController(
  props: TaskChatComposerProps,
  forwardedRef: ForwardedRef<TaskChatComposerHandle>,
) {
  const {
    onSubmit,
    onAttachFile,
    draftKey,
    mentionTarget = null,
    mentionIsResponseOnly,
    composerHint = null,
    replyTarget = null,
    onClearReply,
    onReplySubmitted,
    onReplyPendingChange,
  } = props;

  const [body, setBodyState] = useState("");
  const [notifyOwner, setNotifyOwner] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles = Boolean(onAttachFile && !isSubmitting);
  const canMention = Boolean(mentionTarget && !isSubmitting);

  function setBody(nextBody: string) {
    setBodyState(nextBody);
    setComposerError(null);
  }

  function queueViewportRestore(snapshot: ReturnType<typeof captureComposerViewportSnapshot>) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    requestAnimationFrame(() => {
      window.scrollBy({ top: COMPOSER_FOCUS_SCROLL_PADDING_PX, behavior: "smooth" });
      textareaRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!draftKey) return;
    setBodyState(renderPersistedAgentMentions(loadDraft(draftKey)));
    setNotifyOwner(false);
    setComposerError(null);
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );

  useEffect(() => {
    setNotifyOwner(false);
  }, [mentionTarget?.targetAgentId, mentionTarget?.ownershipEpoch]);

  useImperativeHandle(forwardedRef, () => ({
    focus: focusComposer,
  }));

  function toggleOwnerNotification() {
    if (!canMention && !notifyOwner) return;
    setNotifyOwner((current) => !current);
    setComposerError(null);
    textareaRef.current?.focus();
  }

  async function uploadFiles(files: FileUIPart[]) {
    const markdown: string[] = [];
    for (const part of files) {
      const file = await filePartToFile(part);
      if (!onAttachFile) throw new Error(`This file type cannot be attached: ${file.name}`);
      const attachment = await onAttachFile(file);
      if (!attachment) throw new Error(`Unable to attach ${file.name}`);
      const attachmentLabel = escapeMarkdownLabel(attachment.originalFilename ?? file.name);
      markdown.push(
        file.type.startsWith("image/")
          ? `![${attachmentLabel}](${attachment.contentPath})`
          : `[${attachmentLabel}](${attachment.contentPath})`,
      );
    }
    return markdown;
  }

  async function handleSubmit(message: { text: string; files: FileUIPart[] }) {
    if ((!body.trim() && message.files.length === 0) || isSubmitting) return;
    await submitComment(message.files);
  }

  async function submitComment(files: FileUIPart[]) {
    let mention: TaskChatAgentMention | undefined;
    let outgoingBody = body;
    if (notifyOwner) {
      if (!mentionTarget) {
        const errorMessage = "The task owner changed. Select Notify owner again before sending.";
        setComposerError(errorMessage);
        throw new Error(errorMessage);
      }
      mention = {
        targetAgentId: mentionTarget.targetAgentId,
        ownershipEpoch: mentionTarget.ownershipEpoch,
      };
      outgoingBody = serializeTaskChatOwnerNotification(body, mentionTarget);
    }
    const viewportSnapshot = captureComposerViewportSnapshot(composerContainerRef.current);

    setIsSubmitting(true);
    setComposerError(null);
    onReplyPendingChange?.(true);
    try {
      const attachmentMarkdown = await uploadFiles(files);
      const finalBody = attachmentMarkdown.length
        ? [outgoingBody, ...attachmentMarkdown].filter((value) => value.trim()).join("\n\n")
        : outgoingBody;
      await onSubmit(finalBody, mention, replyTarget?.commentId);
      setBodyState("");
      setNotifyOwner(false);
      if (draftKey) clearDraft(draftKey);
      onReplySubmitted?.();
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : "Unable to send this message");
      throw error;
    } finally {
      setIsSubmitting(false);
      onReplyPendingChange?.(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  return {
    body,
    canAcceptFiles,
    canMention,
    composerContainerRef,
    composerError,
    composerHint,
    handleSubmit,
    isSubmitting,
    mentionTarget,
    mentionIsResponseOnly,
    notifyOwner,
    onClearReply,
    replyTarget,
    setBody,
    setComposerError,
    textareaRef,
    toggleOwnerNotification,
  };
}
