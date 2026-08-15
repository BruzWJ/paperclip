import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandInput,
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
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import {
  BotIcon,
  FolderKanbanIcon,
  ListTodoIcon,
  PaperclipIcon,
  ReplyIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { forwardRef, useState } from "react";

import type { MentionOption } from "../../../../../../features/markdown/MarkdownEditor";
import {
  shouldRenderComposerOwnerPreview,
  type TaskChatComposerHandle,
  type TaskChatComposerProps,
} from "./-TaskChatShared";
import { useTaskChatComposerController } from "./-useTaskChatComposerController";

function PromptAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <Attachments variant="inline">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
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

function mentionIcon(kind: MentionOption["kind"]) {
  if (kind === "agent") return BotIcon;
  if (kind === "project") return FolderKanbanIcon;
  if (kind === "task") return ListTodoIcon;
  return UserIcon;
}

function mentionLabel(mention: MentionOption) {
  return mention.kind === "task" ? mention.taskIdentifier : `@${mention.name}`;
}

export function TaskChatComposerView(props: ReturnType<typeof useTaskChatComposerController>) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const {
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
  } = props;
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);

  return (
    <div ref={composerContainerRef} data-testid="task-chat-composer">
      {coachVisible && plainNameCandidate ? (
        <Suggestions className="mb-2" aria-live="polite" data-testid="composer-mention-coach">
          <Suggestion
            suggestion={`Insert @${coachAgentName}`}
            onClick={insertCoachMention}
            aria-label={`Insert mention for ${coachAgentName} into your comment`}
          />
          <Suggestion
            suggestion="Keep as plain text"
            variant="ghost"
            onClick={() => setDismissedCoachToken(plainNameCandidate.matchedText)}
          />
        </Suggestions>
      ) : null}

      <PromptInput
        accept="*/*"
        multiple
        maxFiles={20}
        onError={(error) => setAttachmentError(error.message)}
        onSubmit={handleSubmit}
        data-pending-work-mode={resolvedTaskWorkMode}
      >
        {replyTarget || canAcceptFiles ? (
          <PromptInputHeader>
            {replyTarget ? (
              <div
                className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground"
                data-testid="task-chat-reply-target"
                aria-label={`Replying to ${replyTarget.authorLabel}`}
              >
                <ReplyIcon className="size-4 shrink-0" aria-hidden="true"  data-icon="inline-start"/>
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
                  <XIcon className="size-4"  data-icon="inline-start"/>
                </PromptInputButton>
              </div>
            ) : null}
            <PromptAttachments />
          </PromptInputHeader>
        ) : null}

        <PromptInputBody>
          <PromptInputTextarea
            ref={textareaRef}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder={composerDisabledReason ?? "Message this task…"}
            disabled={Boolean(composerDisabledReason) || isSubmitting}
            aria-label="Task message"
          />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            {canAcceptFiles || mentions.length > 0 ? (
              <PromptInputActionMenu open={mentionMenuOpen} onOpenChange={setMentionMenuOpen}>
                <PromptInputActionMenuTrigger tooltip="Add context">
                  <PaperclipIcon className="size-4"  data-icon="inline-start"/>
                </PromptInputActionMenuTrigger>
                <PromptInputActionMenuContent>
                  {canAcceptFiles ? <PromptInputActionAddAttachments label="Attach files" /> : null}
                  {mentions.length > 0 ? (
                    <PromptInputCommand>
                      <PromptInputCommandInput placeholder="Find people, agents, projects, or tasks…" />
                      <PromptInputCommandList>
                        <PromptInputCommandEmpty>No matching mention.</PromptInputCommandEmpty>
                        <PromptInputCommandGroup heading="Mention">
                          {mentions.map((mention) => {
                            const Icon = mentionIcon(mention.kind);
                            return (
                              <PromptInputCommandItem
                                key={mention.id}
                                value={`${mentionLabel(mention)} ${mention.name} ${mention.kind}`}
                                onSelect={() => {
                                  insertMention(mention);
                                  setMentionMenuOpen(false);
                                }}
                              >
                                <Icon className="size-4" aria-hidden="true" />
                                <span>{mentionLabel(mention)}</span>
                                <span className="ml-auto text-xs text-muted-foreground">{mention.kind}</span>
                              </PromptInputCommandItem>
                            );
                          })}
                        </PromptInputCommandGroup>
                      </PromptInputCommandList>
                    </PromptInputCommand>
                  ) : null}
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            ) : null}

            {enableOwnerChange && ownerOptions.length > 0 ? (
              <PromptInputSelect value={ownerTarget} onValueChange={setOwnerTarget}>
                <PromptInputSelectTrigger ref={ownerTriggerRef} aria-label="Owner">
                  <PromptInputSelectValue placeholder="Owner" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
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

      {shouldRenderComposerOwnerPreview(body, ownerPreview) ? (
        <Task defaultOpen className="mt-2" data-testid="composer-owner-preview">
          <TaskTrigger title="Delivery" />
          <TaskContent>
            <TaskItem role="status" aria-live="polite" data-kind={ownerPreview.kind}>
              {ownerPreview.text}
              {ownerPreview.chip
                ? ` ${ownerOptions.find((option) => option.id === `agent:${ownerPreview.chip?.id}`)?.label ?? "the selected agent"}`
                : ownerPreview.suffix
                  ? ` ${ownerPreview.suffix}`
                  : ""}
            </TaskItem>
          </TaskContent>
        </Task>
      ) : null}

      {attachmentError ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {attachmentError}
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
