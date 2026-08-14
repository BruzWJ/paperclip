import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AccessibleDropzone } from "@/components/patterns/AccessibleDropzone";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { AlertTriangle, Check, Reply as ReplyIcon, X } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import { MarkdownEditor } from "../MarkdownEditor";
import { ComposerMentionCoach, ComposerOwnerPreviewRow } from "../owner-transition/OwnerTransitionViews";

import {
  shouldRenderComposerOwnerPreview,
  type TaskChatComposerHandle,
  type TaskChatComposerProps,
} from "./TaskChatShared";

import { formatAttachmentSize } from "./TaskChatMessageUtils";
import { useTaskChatComposerController } from "./useTaskChatComposerController";

export function TaskChatComposerView(props: ReturnType<typeof useTaskChatComposerController>) {
  const {
    onImageUpload,
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
    composerAttachments,
    ownerTarget,
    setOwnerTarget,
    setDismissedCoachToken,
    resolvedTaskWorkMode,
    ownerTriggerRef,
    editorRef,
    composerContainerRef,
    canAcceptFiles,
    handleSubmit,
    handleDroppedFiles,
    ownerResolvers,
    plainNameCandidate,
    ownerPreview,
    coachVisible,
    coachAgentName,
    insertCoachMention,
  } = props;
  if (composerDisabledReason) {
    return (
      <Alert>
        <AlertDescription>{composerDisabledReason}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Card
      ref={composerContainerRef}
      data-testid="task-chat-composer"
      data-pending-work-mode={resolvedTaskWorkMode}
      className="relative gap-0 rounded-md border-border/70 bg-background/95 p-(--sz-15px) shadow-(--shadow-extract-4) backdrop-blur transition-(--tp-border-color-background-color-box-shadow) duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)"
    >
      {replyTarget ? (
        <Item
          data-testid="task-chat-reply-target"
          variant="muted"
          size="sm"
          className="mb-2 min-w-0 flex-nowrap px-2.5 py-2"
          aria-label={`Replying to ${replyTarget.authorLabel}`}
        >
          <ItemMedia>
            <ReplyIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </ItemMedia>
          <ItemContent className="min-w-0 truncate text-xs">
            <ItemTitle className="inline text-xs">{replyTarget.authorLabel}</ItemTitle>
            <span className="text-muted-foreground"> · {replyTarget.preview}</span>
          </ItemContent>
          <ItemActions>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={isSubmitting}
              onClick={onClearReply}
              aria-label="Cancel reply"
              title="Cancel reply"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </ItemActions>
        </Item>
      ) : null}

      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Reply"
        mentions={replyTarget ? [] : mentions}
        onSubmit={handleSubmit}
        readOnly={isSubmitting}
        imageUploadHandler={onImageUpload}
        fileDropTarget="parent"
        bordered={false}
        contentClassName="max-h-(--sz-28dvh) overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
      />

      {coachVisible && plainNameCandidate ? (
        <div className="mt-2">
          <ComposerMentionCoach
            candidate={plainNameCandidate}
            agentDisplayName={coachAgentName}
            onInsert={insertCoachMention}
            onDismiss={() => setDismissedCoachToken(plainNameCandidate.matchedText)}
          />
        </div>
      ) : null}

      {composerHint ? (
        <Badge variant="outline" className="text-muted-foreground">
          {composerHint}
        </Badge>
      ) : null}

      {composerAttachments.length > 0 ? (
        <AttachmentGroup
          data-testid="task-chat-composer-attachments"
          className="mb-3 mt-2 flex-col gap-1.5 overflow-visible rounded-md border border-dashed border-border/80 bg-muted/20 p-2"
        >
          {composerAttachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading to task"
                : attachment.status === "error"
                  ? (attachment.error ?? "Upload failed")
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached to task";
            return (
              <Attachment
                key={attachment.id}
                size="xs"
                state={attachment.status === "attached" ? "done" : attachment.status}
                className={cn(
                  "w-full flex-nowrap",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                <AttachmentMedia>
                  {attachment.status === "uploading" ? (
                    <Spinner />
                  ) : attachment.status === "attached" ? (
                    <Check />
                  ) : (
                    <AlertTriangle />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{attachment.name}</AttachmentTitle>
                  <AttachmentDescription>
                    {[sizeLabel, statusLabel].filter(Boolean).join(" · ")}
                  </AttachmentDescription>
                </AttachmentContent>
              </Attachment>
            );
          })}
        </AttachmentGroup>
      ) : null}

      {canAcceptFiles ? (
        <AccessibleDropzone
          ariaLabel="Attach files to this comment"
          maxFiles={20}
          disabled={attaching}
          className="my-2"
          onDrop={(files) => void handleDroppedFiles(files)}
        />
      ) : null}

      {shouldRenderComposerOwnerPreview(body, ownerPreview) ? (
        <div className="my-2">
          <ComposerOwnerPreviewRow preview={ownerPreview} resolvers={ownerResolvers} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto" />

        {enableOwnerChange && ownerOptions.length > 0 ? (
          <EntityCombobox
            ref={ownerTriggerRef}
            value={ownerTarget}
            options={ownerOptions}
            type="agent owner"
            ariaLabel="Owner"
            placeholder="Owner"
            noneLabel="Choose owner"
            includeNone={false}
            onValueChange={setOwnerTarget}
            triggerClassName="h-8 text-xs"
            searchPlaceholder="Search agent owners..."
            emptyMessage="No agent owners found."
            renderValue={(option) => {
              if (!option) return <span className="text-muted-foreground">Owner</span>;
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? <AgentIcon icon={agent.icon} className="size-3.5 shrink-0" /> : null}
                  {option.label}
                </>
              );
            }}
            renderOption={(option) => {
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? <AgentIcon icon={agent.icon} className="size-3.5 shrink-0" /> : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        ) : null}

        <Button size="sm" disabled={isSubmitting || !body.trim()} onClick={() => void handleSubmit()}>
          {isSubmitting ? "Posting..." : "Send"}
        </Button>
      </div>
    </Card>
  );
}

export const TaskChatComposer = forwardRef<TaskChatComposerHandle, TaskChatComposerProps>(
  function TaskChatComposer(props, forwardedRef) {
    return <TaskChatComposerView {...useTaskChatComposerController(props, forwardedRef)} />;
  },
);
