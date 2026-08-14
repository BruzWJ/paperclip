import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { FieldLabel } from "@/components/ui/field";
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
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertTriangle, Check, ChevronsUpDown, Paperclip, Reply as ReplyIcon, X } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import { MarkdownEditor } from "../MarkdownEditor";
import { ENTITY_NONE_VALUE, entityOptionMatchesSearch, useEntitySelectorState } from "@/lib/entity-selector";
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
  } = props;
  const ownerSelector = useEntitySelectorState({
    value: ownerTarget,
    options: ownerOptions,
    noneLabel: "Choose owner",
    includeNone: false,
    onChange: setOwnerTarget,
  });
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
      className={cn(
        "relative gap-0 rounded-md border-border/70 bg-background/95 p-(--sz-15px) shadow-(--shadow-extract-4) backdrop-blur transition-(--tp-border-color-background-color-box-shadow) duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)",
        isDragOver && "border-primary/45 bg-background shadow-(--shadow-extract-7)",
      )}
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {isDragOver && canAcceptFiles ? (
        <div
          data-testid="task-chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-(--blur-2px) dark:bg-background/65"
        >
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Paperclip className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Drop to upload</div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Images insert into the reply. Other files are added to this task.
              </div>
            </div>
          </div>
        </div>
      ) : null}

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

      {shouldRenderComposerOwnerPreview(body, ownerPreview) ? (
        <div className="my-2">
          <ComposerOwnerPreviewRow preview={ownerPreview} resolvers={ownerResolvers} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto flex items-center gap-2">
          {onImageUpload || onAttachImage ? (
            <>
              <FieldLabel className="sr-only" htmlFor={attachInputId}>
                Attach file
              </FieldLabel>
              <input
                id={attachInputId}
                ref={attachInputRef}
                type="file"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                aria-label="Attach file"
                title="Attach file"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </>
          ) : null}
        </div>

        {enableOwnerChange && ownerOptions.length > 0 ? (
          <Popover open={ownerSelector.open} onOpenChange={ownerSelector.setOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={ownerTriggerRef}
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={ownerSelector.open}
                aria-label="Owner"
                className="h-8 w-full justify-between overflow-hidden text-xs"
                onPointerDown={() => {
                  ownerSelector.pointerFocusRef.current = true;
                }}
                onFocus={() => {
                  if (ownerSelector.pointerFocusRef.current) {
                    ownerSelector.pointerFocusRef.current = false;
                  } else {
                    ownerSelector.setOpen(true);
                  }
                }}
              >
                {ownerSelector.currentOption ? (
                  <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
                    {(() => {
                      const agentId = ownerSelector.currentOption.id.startsWith("agent:")
                        ? ownerSelector.currentOption.id.slice("agent:".length)
                        : null;
                      const agent = agentId ? agentMap?.get(agentId) : null;
                      return agent ? <AgentIcon icon={agent.icon} className="size-3.5 shrink-0" /> : null;
                    })()}
                    {ownerSelector.currentOption.label}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Owner</span>
                )}
                <ChevronsUpDown className="ml-2 size-4 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" collisionPadding={16} className="w-72 max-w-(--sz-calc-23) p-0">
              <Command
                filter={(optionValue, search) =>
                  entityOptionMatchesSearch(
                    ownerSelector.orderedOptions.find(
                      (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                    ),
                    search,
                  )
                }
              >
                <CommandInput autoFocus placeholder="Search agent owners..." />
                <CommandList>
                  <CommandEmpty>No agent owners found.</CommandEmpty>
                  {ownerSelector.orderedOptions.map((option) => {
                    const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
                    const agent = agentId ? agentMap?.get(agentId) : null;
                    return (
                      <CommandItem
                        key={option.id}
                        value={option.id || ENTITY_NONE_VALUE}
                        keywords={[option.label, option.searchText ?? ""]}
                        onSelect={() => ownerSelector.select(option)}
                      >
                        {agent ? <AgentIcon icon={agent.icon} className="size-3.5 shrink-0" /> : null}
                        <span className="truncate">{option.label}</span>
                        <Check
                          className={cn(
                            "ml-auto size-4",
                            option.id === ownerTarget ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </CommandItem>
                    );
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
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
