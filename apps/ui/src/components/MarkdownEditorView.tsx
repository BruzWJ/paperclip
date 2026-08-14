import { MDXEditor } from "@mdxeditor/editor";
import { CalendarClock, Hash, User } from "lucide-react";
import { createPortal } from "react-dom";
import { MentionAwareLinkNode, mentionAwareLinkNodeReplacement } from "../lib/mention-aware-link-node";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Command, CommandItem, CommandList } from "./ui/command";
import { FieldError } from "./ui/field";
import { Textarea } from "./ui/textarea";
import {
  shouldAcceptAutocompleteKey,
  slashCommandLabel,
  taskMentionTitle,
} from "./MarkdownAutocompleteEditing";
import type { AutocompleteOption } from "./MarkdownEditorTypes";
import { MarkdownEditorRichErrorBoundary } from "./MarkdownEditorUtils";
import type { useMarkdownEditorController } from "./useMarkdownEditorController";

export function MarkdownEditorView(props: ReturnType<typeof useMarkdownEditorController>) {
  const {
    richEditorError,
    containerRef,
    bordered,
    className,
    fallbackTextareaRef,
    editorRef,
    value,
    placeholder,
    readOnly,
    onChange,
    autoSizeFallbackTextarea,
    onBlur,
    onSubmit,
    contentClassName,
    isDragOver,
    canDropFile,
    dragDepthRef,
    onDropFile,
    handlePasteCapture,
    handleRichEditorError,
    setEditorRef,
    editorValue,
    initialChildOnChangeRef,
    echoIgnoreMarkdownRef,
    latestValueRef,
    plugins,
    mentionActive,
    mentionStateRef,
    commandEnterArmedRef,
    setMentionState,
    filteredMentions,
    setMentionIndex,
    selectMention,
    mentionIndex,
    mentionMenuPosition,
    autocompleteOptionRefs,
    handleAutocompletePress,
    handleAutocompleteTouchStart,
    handleAutocompleteTouchMove,
    handleAutocompleteTouchEnd,
    uploadError,
    setRichEditorError,
    setIsDragOver,
    hasFilePayload,
  } = props;
  if (richEditorError)
    return (
      <div
        ref={containerRef}
        className={cn(
          "relative paperclip-mdxeditor-scope",
          bordered ? "rounded-md border border-border bg-transparent" : "bg-transparent",
          className,
        )}
      >
        <Alert>
          <AlertDescription>
            Rich editor unavailable for this markdown. Showing raw source instead.
          </AlertDescription>
          <Button type="button" variant="outline" size="sm" onClick={() => setRichEditorError(null)}>
            Retry rich editor
          </Button>
        </Alert>
        <Textarea
          ref={fallbackTextareaRef}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder ?? "Markdown source"}
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return;
            onChange(event.target.value);
            autoSizeFallbackTextarea(event.target);
          }}
          onBlur={() => onBlur?.()}
          onKeyDown={(event) => {
            if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={cn("min-h-(--sz-12rem) resize-none font-mono", contentClassName)}
        />
      </div>
    );
  return (
    <div
      ref={containerRef}
      className={cn(
        "relative paperclip-mdxeditor-scope",
        bordered ? "rounded-md border border-border bg-transparent" : "bg-transparent",
        isDragOver && "ring-1 ring-primary/60 bg-accent/20",
        className,
      )}
      onKeyDownCapture={(event) => {
        if (readOnly) return;
        if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          onSubmit();
          return;
        }
        if (!mentionActive) return;
        if (event.key === " " && mentionStateRef.current?.trigger === "command") {
          mentionStateRef.current = null;
          commandEnterArmedRef.current = false;
          setMentionState(null);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          mentionStateRef.current = null;
          commandEnterArmedRef.current = false;
          setMentionState(null);
          return;
        }
        if (!filteredMentions.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          commandEnterArmedRef.current = mentionStateRef.current?.trigger === "command";
          setMentionIndex((index: number) =>
            event.key === "ArrowDown"
              ? Math.min(index + 1, filteredMentions.length - 1)
              : Math.max(index - 1, 0),
          );
          return;
        }
        if (
          shouldAcceptAutocompleteKey(
            event.key,
            mentionStateRef.current?.trigger ?? null,
            commandEnterArmedRef.current,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          selectMention(filteredMentions[mentionIndex]);
        }
      }}
      onDragEnter={(event) => {
        if (readOnly || !canDropFile || !hasFilePayload(event)) return;
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(event) => {
        if (readOnly || !canDropFile || !hasFilePayload(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (readOnly || !canDropFile) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setIsDragOver(false);
      }}
      onDrop={(event) => {
        if (readOnly) return;
        dragDepthRef.current = 0;
        setIsDragOver(false);
        if (!onDropFile) return;
        const allFiles = Array.from(event.dataTransfer?.files ?? []);
        const files = allFiles.filter((file: File) => !file.type.startsWith("image/"));
        if (!files.length) return;
        if (files.length === allFiles.length) {
          event.preventDefault();
          event.stopPropagation();
        }
        for (const file of files) void onDropFile(file);
      }}
      onPasteCapture={handlePasteCapture}
    >
      <MarkdownEditorRichErrorBoundary onError={handleRichEditorError}>
        <MDXEditor
          ref={setEditorRef}
          markdown={editorValue}
          suppressHtmlProcessing
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(next) => {
            if (readOnly) return;
            const echo = echoIgnoreMarkdownRef.current;
            if (echo !== null && next === echo) {
              echoIgnoreMarkdownRef.current = null;
              latestValueRef.current = next;
              return;
            }
            if (echo !== null) echoIgnoreMarkdownRef.current = null;
            if (initialChildOnChangeRef.current) {
              initialChildOnChangeRef.current = false;
              if (next === "" && editorValue !== "") {
                echoIgnoreMarkdownRef.current = editorValue;
                editorRef.current?.setMarkdown(editorValue);
                return;
              }
            }
            latestValueRef.current = next;
            onChange(next);
          }}
          onBlur={() => onBlur?.()}
          onError={(payload) => handleRichEditorError(payload.error)}
          className={cn("paperclip-mdxeditor", !bordered && "paperclip-mdxeditor--borderless")}
          contentEditableClassName={cn(
            "paperclip-mdxeditor-content focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:list-item",
            contentClassName,
          )}
          additionalLexicalNodes={[MentionAwareLinkNode, mentionAwareLinkNodeReplacement]}
          plugins={plugins}
        />
      </MarkdownEditorRichErrorBoundary>
      {mentionActive &&
        filteredMentions.length > 0 &&
        mentionMenuPosition &&
        createPortal(
          <Command
            data-paperclip-floating-ui=""
            data-testid="mention-autocomplete-menu"
            shouldFilter={false}
            value={filteredMentions[mentionIndex]?.id}
            onValueChange={(id) => {
              const index = filteredMentions.findIndex((option: AutocompleteOption) => option.id === id);
              if (index >= 0) setMentionIndex(index);
            }}
            className="pointer-events-auto fixed z-(--z-9999) max-h-(--sz-208px) min-w-(--sz-180px) max-w-(--sz-calc-15) overflow-y-auto border shadow-md"
            style={{
              top: mentionMenuPosition.top,
              left: mentionMenuPosition.left,
              touchAction: "pan-y",
              WebkitOverflowScrolling: "touch",
            }}
          >
            <CommandList>
              {filteredMentions.map((option: AutocompleteOption, index: number) => (
                <CommandItem
                  key={option.id}
                  value={option.id}
                  className="h-auto w-full justify-start"
                  ref={(node) => {
                    autocompleteOptionRefs.current[index] = node;
                  }}
                  onPointerDown={(event) => {
                    if (event.pointerType !== "touch") handleAutocompletePress(event, option);
                  }}
                  onMouseDown={(event) => handleAutocompletePress(event, option)}
                  onTouchStart={handleAutocompleteTouchStart}
                  onTouchMove={handleAutocompleteTouchMove}
                  onTouchEnd={(event) => handleAutocompleteTouchEnd(event, option)}
                  onMouseEnter={() => {
                    if (mentionStateRef.current?.trigger === "command") commandEnterArmedRef.current = true;
                    setMentionIndex(index);
                  }}
                >
                  {option.kind === "routine" ? (
                    <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : option.kind === "task" ? (
                    <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : option.kind === "project" ? (
                    <span
                      className="inline-flex h-2 w-2 rounded-full border border-border/50"
                      style={{
                        backgroundColor: option.projectColor ?? "var(--project-none)",
                      }}
                    />
                  ) : option.kind === "user" ? (
                    <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <AgentIcon
                      icon={option.agentIcon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  {option.kind === "task" && option.taskIdentifier ? (
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                        {option.taskIdentifier}
                      </span>
                      <span className="truncate">{taskMentionTitle(option)}</span>
                    </span>
                  ) : (
                    <span className="truncate">
                      {option.kind === "routine" ? slashCommandLabel(option) : option.name}
                    </span>
                  )}
                  {["task", "project", "user", "routine"].includes(option.kind) ? (
                    <span className="ml-auto text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                      {option.kind[0].toUpperCase() + option.kind.slice(1)}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandList>
          </Command>,
          document.body,
        )}
      {isDragOver && canDropFile ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-md border border-dashed border-primary/80 bg-primary/10 text-xs font-medium text-primary",
            !bordered && "inset-0 rounded-sm",
          )}
        >
          Drop {onDropFile ? "file" : "image"} to upload
        </div>
      ) : null}
      {uploadError ? <FieldError className="px-3 pb-2 text-xs">{uploadError}</FieldError> : null}
    </div>
  );
}
