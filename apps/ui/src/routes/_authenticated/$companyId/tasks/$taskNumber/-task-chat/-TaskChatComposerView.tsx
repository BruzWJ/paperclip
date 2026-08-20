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
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { AtSignIcon, PaperclipIcon, ReplyIcon, XIcon } from "lucide-react";
import { forwardRef } from "react";

import type { TaskChatComposerHandle, TaskChatComposerProps, TaskChatReplyTarget } from "./-TaskChatShared";
import { useTaskChatComposerController } from "./-useTaskChatComposerController";

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
  isSubmitting,
  notifyOwner,
}: {
  body: string;
  isSubmitting: boolean;
  notifyOwner: boolean;
}) {
  const attachments = usePromptInputAttachments();
  const unavailable = isSubmitting || (!body.trim() && attachments.files.length === 0);
  if (notifyOwner) {
    return (
      <PromptInputSubmit
        status={isSubmitting ? "submitted" : undefined}
        size="sm"
        aria-label="Send message and notify owner"
        disabled={unavailable}
      >
        {isSubmitting ? undefined : "Send & notify"}
      </PromptInputSubmit>
    );
  }
  return (
    <PromptInputSubmit
      status={isSubmitting ? "submitted" : undefined}
      aria-label="Send message"
      disabled={unavailable}
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
  } = props;
  return (
    <div ref={composerContainerRef} data-testid="task-chat-composer" aria-busy={isSubmitting || undefined}>
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
          <PromptInputTextarea
            ref={textareaRef}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder={replyTarget ? "Write a reply…" : "Message this task…"}
            disabled={isSubmitting}
            aria-label="Task message"
          />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            {canAcceptFiles ? <ComposerAttachmentButton /> : null}

            {canMention && mentionTarget ? (
              <PromptInputButton
                size="sm"
                variant={notifyOwner ? "secondary" : "ghost"}
                aria-label={`Notify ${mentionTarget.name}`}
                aria-pressed={notifyOwner}
                tooltip={notifyOwner ? "Send without notifying the owner" : "Notify the current owner"}
                onClick={toggleOwnerNotification}
              >
                <AtSignIcon className="size-4" aria-hidden="true" />
                <span className="max-w-32 truncate">{mentionTarget.name}</span>
              </PromptInputButton>
            ) : null}
          </PromptInputTools>

          <ComposerSubmit
            body={body}
            isSubmitting={isSubmitting}
            notifyOwner={notifyOwner}
          />
        </PromptInputFooter>
      </PromptInput>

      {composerError ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {composerError}
        </p>
      ) : notifyOwner && mentionTarget ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {mentionIsResponseOnly
            ? `${mentionTarget.name} can read and answer but cannot make changes. The task status will not change.`
            : `${mentionTarget.name} will receive your message.`}
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
