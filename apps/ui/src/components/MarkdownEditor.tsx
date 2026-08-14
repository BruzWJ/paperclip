import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { useCurrentEditor, type Editor } from "@tiptap/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ForwardedRef,
} from "react";

import {
  EditorBubbleMenu,
  EditorClearFormatting,
  EditorFloatingMenu,
  EditorFormatBold,
  EditorFormatCode,
  EditorFormatItalic,
  EditorFormatStrike,
  EditorLinkSelector,
  EditorNodeBulletList,
  EditorNodeCode,
  EditorNodeHeading1,
  EditorNodeHeading2,
  EditorNodeHeading3,
  EditorNodeOrderedList,
  EditorNodeQuote,
  EditorNodeTable,
  EditorNodeTaskList,
  EditorNodeText,
  EditorProvider,
  EditorSelector,
} from "@/components/kibo-ui/editor";
import {
  createEditorAutocompleteExtension,
  createEditorSlashSuggestions,
  findEditorSlashSuggestionMatch,
} from "@/components/patterns/EditorAutocomplete";
import { FieldError } from "@/components/ui/field";
import { useEditorAutocomplete } from "@/context/EditorAutocompleteContext";
import { cn } from "@/lib/utils";

import type { MarkdownEditorProps, MarkdownEditorRef } from "./MarkdownEditorTypes";
export type { MarkdownEditorRef, MentionOption } from "./MarkdownEditorTypes";

function EditorBridge({
  value,
  readOnly,
  forwardedRef,
  onEditorChange,
  ariaLabel,
}: {
  value: string;
  readOnly: boolean;
  forwardedRef: ForwardedRef<MarkdownEditorRef>;
  onEditorChange: (editor: Editor | null) => void;
  ariaLabel: string;
}) {
  const { editor } = useCurrentEditor();

  useEffect(() => {
    onEditorChange(editor);
    return () => onEditorChange(null);
  }, [editor, onEditorChange]);

  useEffect(() => {
    if (!editor || editor.getMarkdown() === value) return;
    editor.commands.setContent(value, {
      contentType: "markdown",
      emitUpdate: false,
    });
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    const editable = editor.view?.dom;
    if (!editable) return;
    editable.setAttribute("role", "textbox");
    editable.setAttribute("aria-label", ariaLabel);
    editable.setAttribute("aria-multiline", "true");
    editable.setAttribute("aria-readonly", String(readOnly));
  }, [ariaLabel, editor, readOnly]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => editor?.commands.focus("end"),
      insertMarkdown: (markdown: string) => {
        if (readOnly) return;
        editor?.commands.insertContent(markdown, { contentType: "markdown" });
      },
    }),
    [editor, readOnly],
  );

  return null;
}

function imageMarkdown(file: File, source: string) {
  const alt = file.name.replace(/[\[\]]/g, "");
  const href = source.replace(/[()]/g, (character) => `\\${character}`);
  return `![${alt}](${href})`;
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor(
  {
    value,
    onChange,
    placeholder,
    className,
    contentClassName,
    onBlur,
    imageUploadHandler,
    onDropFile,
    fileDropTarget = "editor",
    bordered = true,
    mentions = [],
    onSubmit,
    readOnly = false,
  },
  forwardedRef,
) {
  const editorRef = useRef<Editor | null>(null);
  const routines = useEditorAutocomplete();
  const mentionsRef = useRef(mentions);
  const routinesRef = useRef(routines);
  mentionsRef.current = mentions;
  routinesRef.current = routines;
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const autocompleteExtension = useMemo(
    () =>
      createEditorAutocompleteExtension({
        getMentions: () => mentionsRef.current,
      }),
    [],
  );
  const slashSuggestions = useMemo(() => createEditorSlashSuggestions(() => routinesRef.current), []);
  const setEditor = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
  }, []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        if (file.type.startsWith("image/") && imageUploadHandler) {
          try {
            const source = await imageUploadHandler(file);
            editorRef.current?.commands.insertContent(imageMarkdown(file, source), {
              contentType: "markdown",
            });
            setUploadError(null);
          } catch (error) {
            setUploadError(error instanceof Error ? error.message : "Image upload failed");
          }
        } else if (onDropFile) {
          await onDropFile(file);
        }
      }
    },
    [imageUploadHandler, onDropFile],
  );

  const canDropFiles = fileDropTarget === "editor" && Boolean(imageUploadHandler || onDropFile);
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    setIsDragOver(false);
    if (readOnly || !canDropFiles) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void handleFiles(files);
  };
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || !canDropFiles) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void handleFiles(files);
  };

  return (
    <div
      className={cn("relative", isDragOver && "ring-1 ring-primary", className)}
      data-slot="markdown-editor"
      onDragEnter={(event) => {
        if (!readOnly && canDropFiles && event.dataTransfer.types.includes("Files")) {
          setIsDragOver(true);
        }
      }}
      onDragOver={(event) => {
        if (!readOnly && canDropFiles && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragOver(false);
      }}
      onDrop={handleDrop}
      onPasteCapture={handlePaste}
      onKeyDownCapture={(event) => {
        if (!readOnly && onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit();
        }
      }}
    >
      <EditorProvider
        className={cn(
          "min-h-(--sz-44px) w-full bg-background p-3",
          bordered && "rounded-md border",
          contentClassName,
        )}
        content={value}
        contentType="markdown"
        editable={!readOnly}
        extensions={[Markdown, Image, autocompleteExtension]}
        placeholder={placeholder}
        slashFindSuggestionMatch={findEditorSlashSuggestionMatch}
        slashSuggestions={slashSuggestions}
        onBlur={() => onBlur?.()}
        onUpdate={({ editor }) => {
          if (!readOnly) onChange(editor.getMarkdown());
        }}
      >
        <EditorBridge
          value={value}
          readOnly={readOnly}
          forwardedRef={forwardedRef}
          onEditorChange={setEditor}
          ariaLabel={placeholder ?? "Markdown editor"}
        />
        {!readOnly ? (
          <>
            <EditorFloatingMenu>
              <EditorNodeHeading1 hideName />
              <EditorNodeBulletList hideName />
              <EditorNodeQuote hideName />
              <EditorNodeCode hideName />
              <EditorNodeTable hideName />
            </EditorFloatingMenu>
            <EditorBubbleMenu>
              <EditorSelector title="Text">
                <EditorNodeText />
                <EditorNodeHeading1 />
                <EditorNodeHeading2 />
                <EditorNodeHeading3 />
                <EditorNodeBulletList />
                <EditorNodeOrderedList />
                <EditorNodeTaskList />
                <EditorNodeQuote />
                <EditorNodeCode />
              </EditorSelector>
              <EditorSelector title="Format">
                <EditorFormatBold />
                <EditorFormatItalic />
                <EditorFormatStrike />
                <EditorFormatCode />
              </EditorSelector>
              <EditorLinkSelector />
              <EditorClearFormatting />
            </EditorBubbleMenu>
          </>
        ) : null}
      </EditorProvider>
      {uploadError ? <FieldError className="px-3 pb-2 text-xs">{uploadError}</FieldError> : null}
    </div>
  );
});
