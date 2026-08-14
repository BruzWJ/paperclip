import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RefObject } from "react";
import type { PendingAnchor } from "./DocumentAnnotationLayer";
import { isSubmitShortcut, truncate } from "./DocumentAnnotationOptimistic";
import { deriveInitials } from "@/lib/identity";

interface DocumentAnnotationComposerProps {
  anchor: PendingAnchor;
  currentUser: {
    name: string;
    image: string | null;
  };
  composerRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onValueChange: (value: string) => void;
  posting: boolean;
  disabled?: boolean;
  hasBaseRevision: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}

export function DocumentAnnotationComposer({
  anchor,
  currentUser,
  composerRef,
  value,
  onValueChange,
  posting,
  disabled,
  hasBaseRevision,
  onCancel,
  onSubmit,
}: DocumentAnnotationComposerProps) {
  const submit = () => {
    const body = value.trim();
    if (!body || posting || disabled || !hasBaseRevision) return;
    onSubmit(body);
  };

  return (
    <div className="border-t border-border bg-popover px-3 py-2">
      <blockquote className="mb-2 line-clamp-2 overflow-hidden rounded-none bg-muted px-2 py-1 text-xs italic leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        {truncate(anchor.selectedText, 160)}
      </blockquote>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Avatar size="sm" className="shrink-0">
          {currentUser.image ? <AvatarImage src={currentUser.image} alt={currentUser.name} /> : null}
          <AvatarFallback>{deriveInitials(currentUser.name)}</AvatarFallback>
        </Avatar>
        <span className="truncate text-(length:--text-micro) font-medium text-foreground">
          {currentUser.name}
        </span>
      </div>
      <Textarea
        ref={composerRef}
        aria-label="Write annotation comment"
        data-testid="document-annotation-composer"
        rows={3}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (!isSubmitShortcut(event)) return;
          event.preventDefault();
          submit();
        }}
        placeholder="Write a comment…"
        disabled={disabled}
        className="resize-y rounded-none text-sm"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={posting || !value.trim() || disabled || !hasBaseRevision}
          onClick={submit}
        >
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}
