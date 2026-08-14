import { useAui } from "@assistant-ui/react";
import type { TaskWorkMode } from "@paperclipai/shared";
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
} from "react";
import { restoreSubmittedCommentDraft } from "../../lib/comment-submit-draft";
import {
  computeComposerOwnerPreview,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  type OwnerAgentMention,
} from "../../lib/owner-transition";
import {
  captureComposerViewportSnapshot,
  restoreComposerViewportSnapshot,
} from "../../lib/task-chat-scroll";
import { formatOwnerUserLabel } from "../../lib/task-owners";
import type { MarkdownEditorRef, MentionOption } from "../MarkdownEditor";
import type { OwnerChipResolvers } from "../owner-transition/OwnerTransitionViews";

import type {
  TaskChatComposerHandle,
  TaskChatComposerProps,
} from "./TaskChatShared";

import {
  COMPOSER_FOCUS_SCROLL_PADDING_PX,
  DRAFT_DEBOUNCE_MS,
  clearDraft,
  loadDraft,
  parseOwnerChange,
  saveDraft,
} from "./TaskChatMessageUtils";
import { useTaskChatAttachments } from "./useTaskChatAttachments";

export function useTaskChatComposerController(
  props: TaskChatComposerProps,
  forwardedRef: ForwardedRef<TaskChatComposerHandle>,
) {
  const {
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
    currentUserId = null,
    userLabelMap = null,
    composerDisabledReason = null,
    composerHint = null,
    taskWorkMode,
    replyTarget = null,
    onClearReply,
    onReplySubmitted,
    onReplyPendingChange,
  } = props;
  const api = useAui();

  const [body, setBody] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);

  const effectiveSuggestedOwnerValue = suggestedOwnerValue ?? currentOwnerValue;

  const [ownerTarget, setOwnerTarget] = useState(effectiveSuggestedOwnerValue);

  const [dismissedCoachToken, setDismissedCoachToken] = useState<string | null>(
    null,
  );

  const resolvedTaskWorkMode: TaskWorkMode = taskWorkMode ?? "standard";

  const ownerTriggerRef = useRef<HTMLButtonElement | null>(null);

  const editorRef = useRef<MarkdownEditorRef>(null);

  const composerContainerRef = useRef<HTMLDivElement | null>(null);

  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const attachments = useTaskChatAttachments({
    onImageUpload,
    onAttachImage,
    setBody,
  });
  const {
    attaching,
    isDragOver,
    composerAttachments,
    setComposerAttachments,
    attachInputRef,
    attachInputId,
    canAcceptFiles,
    handleAttachFile,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
  } = attachments;

  function queueViewportRestore(
    snapshot: ReturnType<typeof captureComposerViewportSnapshot>,
  ) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
    requestAnimationFrame(() => {
      window.scrollBy({
        top: COMPOSER_FOCUS_SCROLL_PADDING_PX,
        behavior: "smooth",
      });
      editorRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  useEffect(() => {
    setOwnerTarget(effectiveSuggestedOwnerValue);
  }, [effectiveSuggestedOwnerValue]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: focusComposer,
      restoreDraft: (submittedBody: string) => {
        setBody((current) =>
          restoreSubmittedCommentDraft({
            currentBody: current,
            submittedBody,
          }),
        );
        focusComposer();
      },
    }),
    [],
  );

  async function handleSubmit() {
    if (!body.trim() || isSubmitting) return;

    const composerHasOwnerPicker = enableOwnerChange && ownerOptions.length > 0;
    if (composerHasOwnerPicker && !parseOwnerChange(ownerTarget)) {
      ownerTriggerRef.current?.focus();
      return;
    }

    await submitComment();
  }

  async function submitComment() {
    if (!body.trim() || isSubmitting) return;

    const hasOwnerChange =
      enableOwnerChange && ownerTarget !== currentOwnerValue;
    const ownerChange = hasOwnerChange
      ? (parseOwnerChange(ownerTarget) ?? undefined)
      : undefined;
    const mentionAgentId = replyTarget
      ? undefined
      : mentionedAgentIds.length === 1
        ? mentionedAgentIds[0]
        : undefined;
    const submittedBody = body;
    const viewportSnapshot = captureComposerViewportSnapshot(
      composerContainerRef.current,
    );

    setIsSubmitting(true);
    onReplyPendingChange?.(true);
    setBody("");
    try {
      const appendPromise = api.thread().append({
        role: "user",
        content: [{ type: "text", text: submittedBody }],
        metadata: { custom: {} },
        attachments: [],
        runConfig: {
          custom: {
            ...(ownerChange ? { ownerChange } : {}),
            ...(mentionAgentId ? { mentionAgentId } : {}),
            ...(replyTarget ? { replyToCommentId: replyTarget.commentId } : {}),
          },
        },
      });
      queueViewportRestore(viewportSnapshot);
      await appendPromise;
      if (draftKey) clearDraft(draftKey);
      setComposerAttachments([]);
      setOwnerTarget(effectiveSuggestedOwnerValue);
      onReplySubmitted?.();
    } catch {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody,
        }),
      );
    } finally {
      setIsSubmitting(false);
      onReplyPendingChange?.(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  // Interrupt-owner clarity (PAP-10669): preview what this comment will durably
  // do, and coach plain agent names toward real mentions.
  const agentMentionOptions = useMemo<OwnerAgentMention[]>(
    () =>
      mentions
        .filter((m) => m.kind === "agent")
        .map((m) => ({
          agentId: m.agentId,
          name: m.name,
        })),
    [mentions],
  );

  const ownerResolvers = useMemo<OwnerChipResolvers>(
    () => ({
      agentMap,
      currentUserId,
      resolveUserLabel: (userId: string) =>
        formatOwnerUserLabel(userId, null, userLabelMap),
    }),
    [agentMap, currentUserId, userLabelMap],
  );

  const mentionedAgentIds = useMemo(() => extractAgentMentionIds(body), [body]);

  const plainNameCandidate = useMemo(
    () =>
      mentionedAgentIds.length > 0
        ? null
        : findPlainAgentNameCandidate(body, agentMentionOptions),
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
    [
      ownerTarget,
      currentOwnerValue,
      hasActiveRun,
      mentionedAgentIds,
      plainNameCandidate,
    ],
  );

  const coachVisible = Boolean(
    plainNameCandidate &&
    plainNameCandidate.matchedText !== dismissedCoachToken,
  );

  const coachAgentName = plainNameCandidate
    ? (agentMap?.get(plainNameCandidate.agentId)?.name ??
      plainNameCandidate.matchedText)
    : "";

  function insertCoachMention() {
    if (!plainNameCandidate) return;
    const option = mentions.find(
      (mention): mention is Extract<MentionOption, { kind: "agent" }> =>
        mention.kind === "agent" &&
        mention.agentId === plainNameCandidate.agentId,
    );
    const agentId = plainNameCandidate.agentId;
    const name = option?.name ?? plainNameCandidate.matchedText;
    const markdown = `[@${name}](${buildAgentMentionHref(agentId, option?.agentIcon ?? null)}) `;
    // Replace the first bare occurrence of the matched token (outside links).
    const tokenRe = new RegExp(
      `(?<![\\w@/])${plainNameCandidate.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`,
      "i",
    );
    setBody((current) => {
      if (tokenRe.test(current))
        return current.replace(tokenRe, markdown.trimEnd());
      return current ? `${current} ${markdown}` : markdown;
    });
    setDismissedCoachToken(plainNameCandidate.matchedText);
  }

  return {
    onImageUpload,
    onAttachImage,
    enableOwnerChange,
    ownerOptions,
    mentions,
    agentMap,
    composerDisabledReason,
    composerHint,
    replyTarget,
    onClearReply,
    body,
    setBody,
    isSubmitting,
    attaching,
    isDragOver,
    composerAttachments,
    ownerTarget,
    setOwnerTarget,
    setDismissedCoachToken,
    resolvedTaskWorkMode,
    attachInputRef,
    attachInputId,
    ownerTriggerRef,
    editorRef,
    composerContainerRef,
    canAcceptFiles,
    handleSubmit,
    handleAttachFile,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
    ownerResolvers,
    plainNameCandidate,
    ownerPreview,
    coachVisible,
    coachAgentName,
    insertCoachMention,
  };
}
