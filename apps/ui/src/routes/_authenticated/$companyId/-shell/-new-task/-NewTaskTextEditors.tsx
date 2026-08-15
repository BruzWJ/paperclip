import { memo, useEffect, useState, type RefObject } from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "../../-markdown/-MarkdownEditor";

export const TaskTitleTextarea = memo(function TaskTitleTextarea({
  value,
  pending,
  ownerAgentId,
  projectId,
  requestEditorRef,
  ownerSelectorRef,
  projectSelectorRef,
  onChange,
}: {
  value: string;
  pending: boolean;
  ownerAgentId: string;
  projectId: string;
  requestEditorRef: RefObject<MarkdownEditorRef | null>;
  ownerSelectorRef: RefObject<HTMLButtonElement | null>;
  projectSelectorRef: RefObject<HTMLButtonElement | null>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => setDraftValue(value), [value]);

  return (
    <Textarea
      aria-label="Task title"
      className="w-full resize-none overflow-hidden bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
      placeholder="Optional task title"
      rows={1}
      value={draftValue}
      onChange={(event) => {
        const nextValue = event.target.value;
        setDraftValue(nextValue);
        onChange(nextValue);
        event.target.style.height = "auto";
        event.target.style.height = `${event.target.scrollHeight}px`;
      }}
      readOnly={pending}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          requestEditorRef.current?.focus();
        }
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          if (!ownerAgentId) ownerSelectorRef.current?.focus();
          else if (!projectId) projectSelectorRef.current?.focus();
          else requestEditorRef.current?.focus();
        }
      }}
      autoFocus
    />
  );
});

export const TaskRequestEditor = memo(function TaskRequestEditor({
  value,
  expanded,
  mentions,
  requestEditorRef,
  imageUploadHandler,
  onChange,
}: {
  value: string;
  expanded: boolean;
  mentions: MentionOption[];
  requestEditorRef: RefObject<MarkdownEditorRef | null>;
  imageUploadHandler: (file: File) => Promise<string>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => setDraftValue(value), [value]);

  return (
    <MarkdownEditor
      ref={requestEditorRef}
      value={draftValue}
      onChange={(nextValue) => {
        setDraftValue(nextValue);
        onChange(nextValue);
      }}
      placeholder="Describe the request..."
      bordered={false}
      mentions={mentions}
      contentClassName={cn(
        "pb-12 text-sm text-muted-foreground",
        expanded ? "min-h-(--sz-220px)" : "min-h-(--sz-120px)",
      )}
      imageUploadHandler={imageUploadHandler}
    />
  );
});
