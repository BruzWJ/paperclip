import { useRef } from "react";

import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "@/features/markdown/MarkdownEditor";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function EntityCreationFields({
  description,
  expanded,
  mentions,
  onDescriptionChange,
  onTitleChange,
  onUploadImage,
  title,
  titleLabel,
  titlePlaceholder,
}: {
  description: string;
  expanded: boolean;
  mentions?: MentionOption[];
  onDescriptionChange: (description: string) => void;
  onTitleChange: (title: string) => void;
  onUploadImage: (file: File) => Promise<string>;
  title: string;
  titleLabel: string;
  titlePlaceholder: string;
}) {
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  return (
    <>
      <div className="shrink-0 px-4 pb-2 pt-4">
        <Input
          className="h-auto border-0 bg-transparent px-0 py-0 text-lg font-semibold shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
          placeholder={titlePlaceholder}
          aria-label={titleLabel}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              descriptionEditorRef.current?.focus();
            }
          }}
          autoFocus
        />
      </div>
      <div className="max-h-(--sz-50vh) overflow-y-auto px-4 pb-2">
        <MarkdownEditor
          ref={descriptionEditorRef}
          value={description}
          onChange={onDescriptionChange}
          placeholder="Add description..."
          bordered={false}
          mentions={mentions}
          contentClassName={cn(
            "text-sm text-muted-foreground",
            expanded ? "min-h-(--sz-220px)" : "min-h-(--sz-120px)",
          )}
          imageUploadHandler={onUploadImage}
        />
      </div>
    </>
  );
}
