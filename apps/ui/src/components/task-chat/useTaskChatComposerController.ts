import type { FileUIPart } from "ai";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildTaskReferenceHref,
  buildUserMentionHref,
  type TaskWorkMode,
} from "@paperclipai/shared";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ForwardedRef } from "react";

import { restoreSubmittedCommentDraft } from "../../lib/comment-submit-draft";
import {
  computeComposerOwnerPreview,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  type OwnerAgentMention,
} from "../../lib/owner-transition";
import { captureComposerViewportSnapshot, restoreComposerViewportSnapshot } from "../../lib/task-chat-scroll";
import type { MentionOption } from "../MarkdownEditor";
import type { TaskChatComposerHandle, TaskChatComposerProps } from "./TaskChatShared";
import {
  COMPOSER_FOCUS_SCROLL_PADDING_PX,
  DRAFT_DEBOUNCE_MS,
  clearDraft,
  loadDraft,
  parseOwnerChange,
  saveDraft,
} from "./TaskChatMessageUtils";

function mentionMarkdown(mention: MentionOption) {
  if (mention.kind === "task") {
    return `[${mention.taskIdentifier}](${buildTaskReferenceHref(mention.taskId)}) `;
  }
  if (mention.kind === "project") {
    return `[@${mention.name}](${buildProjectMentionHref(mention.projectId, mention.projectColor ?? null)}) `;
  }
  if (mention.kind === "user") {
    return `[@${mention.name}](${buildUserMentionHref(mention.userId)}) `;
  }
  return `[@${mention.name}](${buildAgentMentionHref(mention.agentId, mention.agentIcon ?? null)}) `;
}

function appendMarkdown(current: string, markdown: string) {
  if (!current) return markdown;
  return `${current}${current.endsWith(" ") || current.endsWith("\n") ? "" : " "}${markdown}`;
}

async function filePartToFile(part: FileUIPart) {
  const response = await fetch(part.url);
  if (!response.ok) throw new Error(`Unable to read ${part.filename ?? "attachment"}`);
  const blob = await response.blob();
  return new File([blob], part.filename || "attachment", {
    type: part.mediaType || blob.type || "application/octet-stream",
  });
}

function escapeMarkdownLabel(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function useTaskChatComposerController(
  props: TaskChatComposerProps,
  forwardedRef: ForwardedRef<TaskChatComposerHandle>,
) {
  const {
    onSubmit,
    onImageUpload,
    onAttachImage,
    draftKey,
    enableOwnerChange = false,
    ownerOptions = [],
    currentOwnerValue = "",
    suggestedOwnerValue,
    mentions = [],
    agentMap,
    hasActiveRun = false,
    composerDisabledReason = null,
    composerHint = null,
    taskWorkMode,
    replyTarget = null,
    onClearReply,
    onReplySubmitted,
    onReplyPendingChange,
  } = props;

  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const effectiveSuggestedOwnerValue = suggestedOwnerValue ?? currentOwnerValue;
  const [ownerTarget, setOwnerTarget] = useState(effectiveSuggestedOwnerValue);
  const [dismissedCoachToken, setDismissedCoachToken] = useState<string | null>(null);
  const resolvedTaskWorkMode: TaskWorkMode = taskWorkMode ?? "standard";
  const ownerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles = Boolean(onImageUpload || onAttachImage);

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
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraft(draftKey, body), DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );

  useEffect(() => setOwnerTarget(effectiveSuggestedOwnerValue), [effectiveSuggestedOwnerValue]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: focusComposer,
      restoreDraft: (submittedBody: string) => {
        setBody((current) => restoreSubmittedCommentDraft({ currentBody: current, submittedBody }));
        focusComposer();
      },
      setDraft: (nextBody: string) => {
        setBody(nextBody);
        focusComposer();
      },
    }),
    [],
  );

  const agentMentionOptions = useMemo<OwnerAgentMention[]>(
    () =>
      mentions
        .filter((mention): mention is Extract<MentionOption, { kind: "agent" }> => mention.kind === "agent")
        .map((mention) => ({ agentId: mention.agentId, name: mention.name })),
    [mentions],
  );
  const mentionedAgentIds = useMemo(() => extractAgentMentionIds(body), [body]);
  const plainNameCandidate = useMemo(
    () => (mentionedAgentIds.length > 0 ? null : findPlainAgentNameCandidate(body, agentMentionOptions)),
    [body, mentionedAgentIds, agentMentionOptions],
  );
  const ownerPreview = useMemo(
    () =>
      computeComposerOwnerPreview({
        ownerTarget,
        currentOwnerValue,
        hasActiveRun,
        bodyHasAgentMention: mentionedAgentIds.length > 0,
        mentionedAgentId: mentionedAgentIds[0] ?? null,
        plainNameCandidate,
      }),
    [ownerTarget, currentOwnerValue, hasActiveRun, mentionedAgentIds, plainNameCandidate],
  );
  const coachVisible = Boolean(plainNameCandidate && plainNameCandidate.matchedText !== dismissedCoachToken);
  const coachAgentName = plainNameCandidate
    ? (agentMap?.get(plainNameCandidate.agentId)?.name ?? plainNameCandidate.matchedText)
    : "";

  function insertMention(mention: MentionOption) {
    setBody((current) => appendMarkdown(current, mentionMarkdown(mention)));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function insertCoachMention() {
    if (!plainNameCandidate) return;
    const option = mentions.find(
      (mention): mention is Extract<MentionOption, { kind: "agent" }> =>
        mention.kind === "agent" && mention.agentId === plainNameCandidate.agentId,
    );
    const name = option?.name ?? plainNameCandidate.matchedText;
    const markdown = `[@${name}](${buildAgentMentionHref(
      plainNameCandidate.agentId,
      option?.agentIcon ?? null,
    )})`;
    const tokenRe = new RegExp(
      `(?<![\\w@/])${plainNameCandidate.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`,
      "i",
    );
    setBody((current) =>
      tokenRe.test(current) ? current.replace(tokenRe, markdown) : appendMarkdown(current, `${markdown} `),
    );
    setDismissedCoachToken(plainNameCandidate.matchedText);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function uploadFiles(files: FileUIPart[]) {
    const markdown: string[] = [];
    for (const part of files) {
      const file = await filePartToFile(part);
      const label = escapeMarkdownLabel(file.name);
      if (file.type.startsWith("image/") && onImageUpload) {
        markdown.push(`![${label}](${await onImageUpload(file)})`);
        continue;
      }
      if (onAttachImage) {
        const attachment = await onAttachImage(file);
        if (!attachment) throw new Error(`Unable to attach ${file.name}`);
        markdown.push(
          `[${escapeMarkdownLabel(attachment.originalFilename ?? file.name)}](${attachment.contentPath})`,
        );
        continue;
      }
      throw new Error(`This file type cannot be attached: ${file.name}`);
    }
    return markdown;
  }

  async function handleSubmit(message: { text: string; files: FileUIPart[] }) {
    if ((!body.trim() && message.files.length === 0) || isSubmitting) return;
    if (enableOwnerChange && ownerOptions.length > 0 && !parseOwnerChange(ownerTarget)) {
      ownerTriggerRef.current?.focus();
      throw new Error("Choose an owner before sending");
    }
    await submitComment(message.files);
  }

  async function submitComment(files: FileUIPart[]) {
    if ((!body.trim() && files.length === 0) || isSubmitting) return;
    const hasOwnerChange = enableOwnerChange && ownerTarget !== currentOwnerValue;
    const ownerChange = hasOwnerChange ? (parseOwnerChange(ownerTarget) ?? undefined) : undefined;
    const mentionAgentId = replyTarget
      ? undefined
      : mentionedAgentIds.length === 1
        ? mentionedAgentIds[0]
        : undefined;
    const submittedBody = body;
    const viewportSnapshot = captureComposerViewportSnapshot(composerContainerRef.current);

    setIsSubmitting(true);
    setAttachmentError(null);
    onReplyPendingChange?.(true);
    try {
      const attachmentMarkdown = await uploadFiles(files);
      const finalBody = attachmentMarkdown.length
        ? [submittedBody, ...attachmentMarkdown].filter((value) => value.trim()).join("\n\n")
        : submittedBody;
      await onSubmit(finalBody, ownerChange, mentionAgentId, replyTarget?.commentId);
      setBody("");
      if (draftKey) clearDraft(draftKey);
      setOwnerTarget(effectiveSuggestedOwnerValue);
      onReplySubmitted?.();
    } catch (error) {
      setBody((current) => restoreSubmittedCommentDraft({ currentBody: current, submittedBody }));
      setAttachmentError(error instanceof Error ? error.message : "Unable to send this message");
      throw error;
    } finally {
      setIsSubmitting(false);
      onReplyPendingChange?.(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  return {
    attachmentError,
    body,
    canAcceptFiles,
    coachAgentName,
    coachVisible,
    composerContainerRef,
    composerDisabledReason,
    composerHint,
    enableOwnerChange,
    handleSubmit,
    insertCoachMention,
    insertMention,
    isSubmitting,
    mentions,
    onClearReply,
    ownerOptions,
    ownerPreview,
    ownerTarget,
    ownerTriggerRef,
    plainNameCandidate,
    replyTarget,
    resolvedTaskWorkMode,
    setAttachmentError,
    setBody,
    setDismissedCoachToken,
    setOwnerTarget,
    textareaRef,
  };
}
