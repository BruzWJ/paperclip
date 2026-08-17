import type { FileUIPart } from "ai";
import {
  buildAgentMentionHref,
  extractAgentMentionIds,
  parseAgentMentionHref,
} from "@paperclipai/shared";
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
  parseOwnerChange,
  saveDraft,
} from "./-TaskChatMessageUtils";

const AGENT_LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const EMPTY_OWNER_OPTIONS: NonNullable<TaskChatComposerProps["ownerOptions"]> = [];

export interface TaskChatMentionQuery {
  start: number;
  end: number;
  query: string;
}

interface TaskChatSelectedMention {
  target: TaskChatMentionTarget;
  start: number;
  end: number;
}

export function findTaskChatMentionQuery(value: string, cursor: number): TaskChatMentionQuery | null {
  if (cursor < 0 || cursor > value.length) return null;
  const match = value.slice(0, cursor).match(/(?:^|[\s(\[{])@([^@\n]{0,64})$/);
  const query = match?.[1];
  if (query === undefined) return null;
  return {
    start: cursor - query.length - 1,
    end: cursor,
    query,
  };
}

export function taskChatMentionMatchesQuery(target: TaskChatMentionTarget, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || target.name.toLocaleLowerCase().includes(normalized);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionToken(target: TaskChatMentionTarget) {
  return `@${target.name}`;
}

function mentionTokenExpression(target: TaskChatMentionTarget) {
  return new RegExp(`(^|[\\s(\\[{])${escapeRegExp(mentionToken(target))}(?=$|[\\s)\\]},.!?:;])`);
}

function bodyHasMentionToken(body: string, target: TaskChatMentionTarget) {
  return mentionTokenExpression(target).test(body);
}

function selectedMentionIsIntact(body: string, selection: TaskChatSelectedMention) {
  const { start, end, target } = selection;
  if (start < 0 || end > body.length || body.slice(start, end) !== mentionToken(target)) return false;
  const before = body[start - 1];
  const after = body[end];
  return (
    (before === undefined || /[\s(\[{]/.test(before)) && (after === undefined || /[\s)\]},.!?:;]/.test(after))
  );
}

export function reconcileTaskChatMentionSelection(
  previousBody: string,
  nextBody: string,
  selection: TaskChatSelectedMention | null,
): TaskChatSelectedMention | null {
  if (!selection || !selectedMentionIsIntact(previousBody, selection)) return null;
  if (previousBody === nextBody) return selection;

  let prefixLength = 0;
  while (
    prefixLength < previousBody.length &&
    prefixLength < nextBody.length &&
    previousBody[prefixLength] === nextBody[prefixLength]
  ) {
    prefixLength += 1;
  }

  let previousSuffixStart = previousBody.length;
  let nextSuffixStart = nextBody.length;
  while (
    previousSuffixStart > prefixLength &&
    nextSuffixStart > prefixLength &&
    previousBody[previousSuffixStart - 1] === nextBody[nextSuffixStart - 1]
  ) {
    previousSuffixStart -= 1;
    nextSuffixStart -= 1;
  }

  let nextSelection = selection;
  if (previousSuffixStart <= selection.start) {
    const shift = nextBody.length - previousBody.length;
    nextSelection = { ...selection, start: selection.start + shift, end: selection.end + shift };
  } else if (prefixLength < selection.end) {
    return null;
  }
  return selectedMentionIsIntact(nextBody, nextSelection) ? nextSelection : null;
}

function mentionMarkdown(target: TaskChatMentionTarget) {
  return `[@${escapeMarkdownLabel(target.name)}](${buildAgentMentionHref(target.targetAgentId, target.icon ?? null)})`;
}

export function replaceTaskChatMentionQuery(
  body: string,
  query: TaskChatMentionQuery,
  target: TaskChatMentionTarget,
) {
  const before = body.slice(0, query.start);
  const after = body.slice(query.end);
  const token = mentionToken(target);
  const separator = after.length === 0 ? " " : /^\s/.test(after) ? "" : " ";
  const mentionStart = before.length;
  return {
    body: `${before}${token}${separator}${after}`,
    cursor: before.length + token.length + separator.length,
    mentionStart,
    mentionEnd: mentionStart + token.length,
  };
}

export function serializeTaskChatMention(body: string, selection: TaskChatSelectedMention): string | null {
  if (!selectedMentionIsIntact(body, selection)) return null;
  return `${body.slice(0, selection.start)}${mentionMarkdown(selection.target)}${body.slice(selection.end)}`;
}

function renderPersistedAgentMentions(body: string) {
  return body.replace(AGENT_LINK_RE, (match, label: string, href: string) =>
    parseAgentMentionHref(href) ? label : match,
  );
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
    onAttachFile,
    draftKey,
    ownerOptions = EMPTY_OWNER_OPTIONS,
    currentOwnerValue = "",
    mentionTarget = null,
    composerDisabledReason = null,
    composerHint = null,
    replyTarget = null,
    onClearReply,
    onReplySubmitted,
    onReplyPendingChange,
  } = props;

  const [body, setBodyState] = useState("");
  const [selectedMention, setSelectedMention] = useState<TaskChatSelectedMention | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [ownerTarget, setOwnerTarget] = useState(currentOwnerValue);
  const ownerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolsDisabled = isSubmitting || Boolean(composerDisabledReason);
  const canAcceptFiles = Boolean(onAttachFile && !toolsDisabled);
  const canChangeOwner = !selectedMention && !toolsDisabled;
  const canMention = Boolean(
    mentionTarget && !replyTarget && !selectedMention && ownerTarget === currentOwnerValue && !toolsDisabled,
  );

  function setBody(nextBody: string) {
    setBodyState(nextBody);
    setSelectedMention((current) => reconcileTaskChatMentionSelection(body, nextBody, current));
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
    setSelectedMention(null);
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

  useEffect(() => setOwnerTarget(currentOwnerValue), [currentOwnerValue]);

  useEffect(() => {
    if (!replyTarget || !selectedMention) return;
    setBodyState((current) => {
      if (!selectedMentionIsIntact(current, selectedMention)) return current;
      const afterStart = current[selectedMention.end] === " " ? selectedMention.end + 1 : selectedMention.end;
      return `${current.slice(0, selectedMention.start)}${current.slice(afterStart)}`;
    });
    setSelectedMention(null);
    setComposerError("Agent mentions aren't available in replies, so the mention was removed.");
  }, [replyTarget, selectedMention]);

  useImperativeHandle(forwardedRef, () => ({
    focus: focusComposer,
  }));

  function insertMention(query: TaskChatMentionQuery) {
    if (!canMention || !mentionTarget) return;
    const next = replaceTaskChatMentionQuery(body, query, mentionTarget);
    setBodyState(next.body);
    setSelectedMention({ target: mentionTarget, start: next.mentionStart, end: next.mentionEnd });
    setComposerError(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
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
    if (!replyTarget && ownerOptions.length > 0 && !parseOwnerChange(ownerTarget)) {
      ownerTriggerRef.current?.focus();
      const errorMessage = "Choose an owner before sending.";
      setComposerError(errorMessage);
      throw new Error(errorMessage);
    }
    await submitComment(message.files);
  }

  function rejectSubmission(message: string): never {
    setComposerError(message);
    throw new Error(message);
  }

  function prepareMentionSubmission(hasOwnerChange: boolean): {
    outgoingBody: string;
    mention: TaskChatAgentMention | undefined;
  } {
    if (extractAgentMentionIds(body).length > 0) {
      rejectSubmission("Use the @ suggestions to mention the current task owner.");
    }
    if (!selectedMention) {
      if (!replyTarget && mentionTarget && bodyHasMentionToken(body, mentionTarget)) {
        rejectSubmission(`Select @${mentionTarget.name} from the suggestions to notify them.`);
      }
      return { outgoingBody: body, mention: undefined };
    }
    if (replyTarget) {
      rejectSubmission("Agent mentions aren't available in replies.");
    }
    if (hasOwnerChange) {
      rejectSubmission("A comment cannot change the owner and mention an agent at the same time.");
    }
    const selectedTarget = selectedMention.target;
    if (
      !mentionTarget ||
      mentionTarget.targetAgentId !== selectedTarget.targetAgentId ||
      mentionTarget.ownershipEpoch !== selectedTarget.ownershipEpoch ||
      currentOwnerValue !== `agent:${selectedTarget.targetAgentId}`
    ) {
      rejectSubmission("The task owner changed. Remove the old @mention and select the current owner again.");
    }
    const outgoingBody = serializeTaskChatMention(body, selectedMention);
    if (!outgoingBody) {
      rejectSubmission("The selected @mention was edited. Select the task owner again.");
    }
    return {
      outgoingBody,
      mention: {
        targetAgentId: selectedTarget.targetAgentId,
        ownershipEpoch: selectedTarget.ownershipEpoch,
      },
    };
  }

  async function submitComment(files: FileUIPart[]) {
    const hasOwnerChange = !replyTarget && ownerOptions.length > 0 && ownerTarget !== currentOwnerValue;
    const ownerChange = hasOwnerChange ? (parseOwnerChange(ownerTarget) ?? undefined) : undefined;
    const { outgoingBody, mention } = prepareMentionSubmission(hasOwnerChange);
    const viewportSnapshot = captureComposerViewportSnapshot(composerContainerRef.current);

    setIsSubmitting(true);
    setComposerError(null);
    onReplyPendingChange?.(true);
    try {
      const attachmentMarkdown = await uploadFiles(files);
      const finalBody = attachmentMarkdown.length
        ? [outgoingBody, ...attachmentMarkdown].filter((value) => value.trim()).join("\n\n")
        : outgoingBody;
      await onSubmit(finalBody, ownerChange, mention, replyTarget?.commentId);
      setBodyState("");
      setSelectedMention(null);
      if (draftKey) clearDraft(draftKey);
      setOwnerTarget(currentOwnerValue);
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
    canChangeOwner,
    canMention,
    composerContainerRef,
    composerDisabledReason,
    composerError,
    composerHint,
    handleSubmit,
    insertMention,
    isSubmitting,
    mentionTarget,
    onClearReply,
    ownerOptions,
    ownerTarget,
    ownerTriggerRef,
    replyTarget,
    setBody,
    setComposerError,
    setOwnerTarget,
    textareaRef,
  };
}
