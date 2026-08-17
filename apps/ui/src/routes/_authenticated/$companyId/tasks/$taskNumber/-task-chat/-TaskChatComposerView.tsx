import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { AtSignIcon, PaperclipIcon, ReplyIcon, XIcon } from "lucide-react";
import { forwardRef, useCallback, useState, type KeyboardEvent } from "react";

import { AgentIcon } from "../../../-AgentIconPicker";
import {
  type TaskChatComposerHandle,
  type TaskChatComposerProps,
  type TaskChatReplyTarget,
} from "./-TaskChatShared";
import {
  findTaskChatMentionQuery,
  taskChatMentionMatchesQuery,
  type TaskChatMentionQuery,
  useTaskChatComposerController,
} from "./-useTaskChatComposerController";

function ComposerHeader({
  replyTarget,
  isSubmitting,
  onClearReply,
}: {
  replyTarget: TaskChatReplyTarget | null;
  isSubmitting: boolean;
  onClearReply?: () => void;
}) {
  const attachments = usePromptInputAttachments();
  if (!replyTarget && attachments.files.length === 0) return null;

  return (
    <PromptInputHeader>
      {replyTarget ? (
        <div
          className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground"
          aria-label={`Replying to ${replyTarget.authorLabel}`}
        >
          <ReplyIcon className="size-4 shrink-0" aria-hidden="true" data-icon="inline-start" />
          <span className="truncate">
            {replyTarget.authorLabel} · {replyTarget.preview}
          </span>
          <PromptInputButton
            className="ml-auto"
            tooltip="Cancel reply"
            aria-label="Cancel reply"
            disabled={isSubmitting}
            onClick={onClearReply}
          >
            <XIcon className="size-4" data-icon="inline-start" />
          </PromptInputButton>
        </div>
      ) : null}
      {attachments.files.length > 0 ? (
        <Attachments variant="inline">
          {attachments.files.map((file) => (
            <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
              <AttachmentPreview />
              <AttachmentInfo />
              <AttachmentRemove disabled={isSubmitting} />
            </Attachment>
          ))}
        </Attachments>
      ) : null}
    </PromptInputHeader>
  );
}

function ComposerSubmit({
  body,
  disabled,
  isSubmitting,
}: {
  body: string;
  disabled: boolean;
  isSubmitting: boolean;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputSubmit
      status={isSubmitting ? "submitted" : undefined}
      disabled={disabled || isSubmitting || (!body.trim() && attachments.files.length === 0)}
    />
  );
}

function ComposerAttachmentButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton aria-label="Attach files" tooltip="Attach files" onClick={attachments.openFileDialog}>
      <PaperclipIcon className="size-4" aria-hidden="true" />
    </PromptInputButton>
  );
}

function TaskChatComposerView(props: ReturnType<typeof useTaskChatComposerController>) {
  const {
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
  } = props;
  const [mentionQuery, setMentionQuery] = useState<TaskChatMentionQuery | null>(null);
  const [mentionListId, setMentionListId] = useState<string>();
  const [mentionOptionId, setMentionOptionId] = useState<string>();
  const mentionMatches = Boolean(
    mentionTarget && mentionQuery && taskChatMentionMatchesQuery(mentionTarget, mentionQuery.query),
  );
  const mentionPopupOpen = canMention && mentionMatches;

  const captureMentionList = useCallback((node: HTMLDivElement | null) => {
    if (!node?.id) return;
    setMentionListId((current) => (current === node.id ? current : node.id));
  }, []);

  const captureMentionOption = useCallback((node: HTMLDivElement | null) => {
    if (!node?.id) return;
    setMentionOptionId((current) => (current === node.id ? current : node.id));
  }, []);

  function closeMentionMenu() {
    setMentionQuery(null);
  }

  function syncMentionMenu(value: string, cursor: number | null) {
    const nextQuery = canMention ? findTaskChatMentionQuery(value, cursor ?? value.length) : null;
    setMentionQuery(nextQuery);
  }

  function chooseMention() {
    if (!mentionQuery || !mentionMatches) return;
    insertMention(mentionQuery);
    closeMentionMenu();
  }

  function handleMentionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionPopupOpen || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionMenu();
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      chooseMention();
    }
  }

  function beginMention() {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? body.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const before = body.slice(0, selectionStart);
    const needsBoundary = before.length > 0 && !/[\s(\[{]$/.test(before);
    const insertion = `${needsBoundary ? " " : ""}@`;
    const nextBody = `${before}${insertion}${body.slice(selectionEnd)}`;
    const cursor = before.length + insertion.length;
    setBody(nextBody);
    setMentionQuery({ start: cursor - 1, end: cursor, query: "" });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  return (
    <div
      ref={composerContainerRef}
      data-testid="task-chat-composer"
      aria-busy={isSubmitting || undefined}
    >
      {isSubmitting ? (
        <p role="status" className="sr-only">
          Sending message…
        </p>
      ) : null}
      <PromptInput
        accept="*/*"
        multiple
        maxFiles={20}
        onError={(error) => setComposerError(error.message)}
        onSubmit={handleSubmit}
      >
        <ComposerHeader replyTarget={replyTarget} isSubmitting={isSubmitting} onClearReply={onClearReply} />

        <PromptInputBody>
          <Popover
            open={mentionPopupOpen}
            onOpenChange={(open) => {
              if (!open) closeMentionMenu();
            }}
          >
            <PopoverAnchor asChild>
              <PromptInputTextarea
                ref={textareaRef}
                value={body}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setBody(value);
                  syncMentionMenu(value, event.currentTarget.selectionStart);
                }}
                onKeyDown={handleMentionKeyDown}
                onKeyUp={(event) => {
                  if (event.key === "Enter" || event.key === "Tab" || event.key === "Escape") return;
                  syncMentionMenu(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onSelect={(event) =>
                  syncMentionMenu(event.currentTarget.value, event.currentTarget.selectionStart)
                }
                placeholder={
                  composerDisabledReason ??
                  (replyTarget
                    ? "Write a reply…"
                    : mentionTarget
                      ? `Message this task or @${mentionTarget.name}…`
                      : "Message this task…")
                }
                disabled={Boolean(composerDisabledReason) || isSubmitting}
                aria-label="Task message"
                aria-autocomplete={canMention ? "list" : undefined}
                aria-activedescendant={mentionPopupOpen && mentionMatches ? mentionOptionId : undefined}
                aria-controls={mentionPopupOpen ? mentionListId : undefined}
                aria-expanded={canMention ? mentionPopupOpen : undefined}
                aria-haspopup={canMention ? "listbox" : undefined}
                role={canMention ? "combobox" : undefined}
              />
            </PopoverAnchor>
            <PopoverContent
              role="presentation"
              side="top"
              align="start"
              className="w-72 p-0 shadow-none"
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onInteractOutside={(event) => {
                if (event.target === textareaRef.current) event.preventDefault();
              }}
            >
              <PromptInputCommand
                aria-label="Agent mention suggestions"
                shouldFilter={false}
                value={mentionMatches ? mentionTarget?.targetAgentId : undefined}
              >
                <PromptInputCommandList ref={captureMentionList}>
                  <PromptInputCommandGroup>
                    {mentionMatches && mentionTarget ? (
                      <PromptInputCommandItem
                        ref={captureMentionOption}
                        value={mentionTarget.targetAgentId}
                        aria-label={`Mention ${mentionTarget.name}`}
                        onPointerDown={(event) => event.preventDefault()}
                        onSelect={chooseMention}
                      >
                        <Avatar size="sm">
                          <AvatarFallback>
                            <AgentIcon icon={mentionTarget.icon} className="size-3" />
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">@{mentionTarget.name}</span>
                          <span className="block text-xs text-muted-foreground">Current task owner</span>
                        </span>
                      </PromptInputCommandItem>
                    ) : null}
                  </PromptInputCommandGroup>
                </PromptInputCommandList>
              </PromptInputCommand>
            </PopoverContent>
          </Popover>
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            {canAcceptFiles ? <ComposerAttachmentButton /> : null}

            {canMention ? (
              <PromptInputButton
                aria-label="Mention task owner"
                tooltip="Mention task owner"
                onClick={beginMention}
              >
                <AtSignIcon className="size-4" aria-hidden="true" />
              </PromptInputButton>
            ) : null}

            {!replyTarget && ownerOptions.length > 0 ? (
              <PromptInputSelect
                value={ownerTarget}
                onValueChange={setOwnerTarget}
                disabled={!canChangeOwner}
              >
                <PromptInputSelectTrigger ref={ownerTriggerRef} aria-label="Owner">
                  <PromptInputSelectValue placeholder="Owner" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent position="popper" align="start">
                  {ownerOptions.map((option) => (
                    <PromptInputSelectItem key={option.id} value={option.id} disabled={option.disabled}>
                      {option.label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            ) : null}
          </PromptInputTools>

          <ComposerSubmit
            body={body}
            disabled={Boolean(composerDisabledReason)}
            isSubmitting={isSubmitting}
          />
        </PromptInputFooter>
      </PromptInput>

      {composerError ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {composerError}
        </p>
      ) : composerHint ? (
        <p className="mt-2 text-sm text-muted-foreground">{composerHint}</p>
      ) : null}
    </div>
  );
}

export const TaskChatComposer = forwardRef<TaskChatComposerHandle, TaskChatComposerProps>(
  function TaskChatComposer(props, forwardedRef) {
    return <TaskChatComposerView {...useTaskChatComposerController(props, forwardedRef)} />;
  },
);
