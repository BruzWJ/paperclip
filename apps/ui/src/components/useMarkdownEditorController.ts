import {
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  type MDXEditorMethods,
  type RealmPlugin,
} from "@mdxeditor/editor";
import {
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
import { useEditorAutocomplete } from "../context/EditorAutocompleteContext";
import { looksLikeMarkdownPaste } from "../lib/markdownPaste";
import { mentionDeletionPlugin } from "../lib/mention-deletion";
import { normalizeMarkdown } from "../lib/normalize-markdown";
import { pasteNormalizationPlugin } from "../lib/paste-normalization";

import {
  escapeRegExp,
  isRichEditorDomEmpty,
  isSafeMarkdownLinkUrl,
  prepareMarkdownForEditor,
  richEditorErrorMessage,
} from "./MarkdownEditorUtils";

import { isSelectionInsideCodeLikeElement } from "./MarkdownAutocompleteEditing";
import { CODE_BLOCK_LANGUAGES, FALLBACK_CODE_BLOCK_DESCRIPTOR } from "./MarkdownAutocompleteMenu";
import type { MarkdownEditorProps, MarkdownEditorRef } from "./MarkdownEditorTypes";
import { useMarkdownAutocompleteController } from "./useMarkdownAutocompleteController";

export function useMarkdownEditorController(
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
    mentions,
    onSubmit,
    readOnly = false,
  }: MarkdownEditorProps,
  forwardedRef: ForwardedRef<MarkdownEditorRef>,
) {
  const editorValue = useMemo(() => prepareMarkdownForEditor(value), [value]);
  const { slashCommands } = useEditorAutocomplete();
  const containerRef = useRef<HTMLDivElement>(null);
  const ref = useRef<MDXEditorMethods>(null);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(editorValue);
  valueRef.current = editorValue;
  const latestValueRef = useRef(editorValue);
  const initialChildOnChangeRef = useRef(true);
  const echoIgnoreMarkdownRef = useRef<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [richEditorError, setRichEditorError] = useState<string | null>(null);
  const dragDepthRef = useRef(0);

  const imageUploadHandlerRef = useRef(imageUploadHandler);
  imageUploadHandlerRef.current = imageUploadHandler;

  const autocomplete = useMarkdownAutocompleteController({
    containerRef,
    editorRef: ref,
    latestValueRef,
    echoIgnoreMarkdownRef,
    mentions,
    slashCommands,
    onChange,
  });

  const setEditorRef = useCallback((instance: MDXEditorMethods | null) => {
    ref.current = instance;
    if (!instance) {
      return;
    }
    if (valueRef.current !== latestValueRef.current) {
      echoIgnoreMarkdownRef.current = valueRef.current;
      instance.setMarkdown(valueRef.current);
      latestValueRef.current = valueRef.current;
    }
  }, []);

  const insertMarkdown = useCallback(
    (markdown: string) => {
      if (readOnly) return;
      if (!richEditorError && ref.current) {
        ref.current.insertMarkdown(markdown);
        return;
      }
      const textarea = fallbackTextareaRef.current;
      if (!textarea) {
        onChange(`${value}${markdown}`);
        return;
      }
      const start = textarea.selectionStart ?? value.length;
      const end = textarea.selectionEnd ?? value.length;
      const next = `${value.slice(0, start)}${markdown}${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => {
        textarea.focus();
        const cursor = start + markdown.length;
        textarea.setSelectionRange(cursor, cursor);
      });
    },
    [onChange, readOnly, richEditorError, value],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => {
        if (richEditorError) {
          fallbackTextareaRef.current?.focus();
          return;
        }
        ref.current?.focus(undefined, { defaultSelection: "rootEnd" });
      },
      insertMarkdown,
    }),
    [insertMarkdown, richEditorError],
  );

  const autoSizeFallbackTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (!richEditorError) return;
    autoSizeFallbackTextarea(fallbackTextareaRef.current);
  }, [autoSizeFallbackTextarea, richEditorError, value]);

  useEffect(() => {
    if (richEditorError || editorValue.trim().length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    let timeoutId = 0;
    const scheduleCheck = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        const editable = container.querySelector('[contenteditable="true"]');
        if (!(editable instanceof HTMLElement)) return;
        const activeElement = document.activeElement;
        if (activeElement === editable || editable.contains(activeElement)) return;
        if (isRichEditorDomEmpty(editable, editorValue, placeholder)) {
          setRichEditorError("Rich editor failed to load content");
        }
      }, 0);
    };

    scheduleCheck();
    const observer = new MutationObserver(() => {
      scheduleCheck();
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    return () => {
      window.clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [editorValue, placeholder, richEditorError]);

  const hasImageUpload = Boolean(imageUploadHandler);

  const plugins = useMemo<RealmPlugin[]>(() => {
    const imageHandler = hasImageUpload
      ? async (file: File) => {
          const handler = imageUploadHandlerRef.current;
          if (!handler) throw new Error("No image upload handler");
          try {
            const src = await handler(file);
            setUploadError(null);
            setTimeout(() => {
              const current = latestValueRef.current;
              const escapedSrc = escapeRegExp(src);
              const updated = current.replace(
                new RegExp(`(!\\[[^\\]]*\\]\\(${escapedSrc}\\))(?!\\n\\n)`, "g"),
                "$1\n\n",
              );
              if (updated !== current) {
                latestValueRef.current = updated;
                echoIgnoreMarkdownRef.current = updated;
                ref.current?.setMarkdown(updated);
                onChange(updated);
                requestAnimationFrame(() => {
                  ref.current?.focus(undefined, {
                    defaultSelection: "rootEnd",
                  });
                });
              }
            }, 100);
            return src;
          } catch (err) {
            const message = err instanceof Error ? err.message : "Image upload failed";
            setUploadError(message);
            throw err;
          }
        }
      : undefined;
    const all: RealmPlugin[] = [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      tablePlugin(),
      linkPlugin({ validateUrl: isSafeMarkdownLinkUrl }),
      linkDialogPlugin(),
      mentionDeletionPlugin(),
      pasteNormalizationPlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin({
        defaultCodeBlockLanguage: "txt",
        codeBlockEditorDescriptors: [FALLBACK_CODE_BLOCK_DESCRIPTOR],
      }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
      markdownShortcutPlugin(),
    ];
    if (imageHandler) {
      all.push(imagePlugin({ imageUploadHandler: imageHandler }));
    }
    return all;
  }, [hasImageUpload]);

  useEffect(() => {
    if (editorValue !== latestValueRef.current) {
      if (ref.current) {
        echoIgnoreMarkdownRef.current = editorValue;
        ref.current.setMarkdown(editorValue);
        latestValueRef.current = editorValue;
      }
    }
  }, [editorValue]);

  function hasFilePayload(evt: DragEvent<HTMLDivElement>) {
    return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
  }

  const canDropFile = fileDropTarget === "editor" && Boolean(imageUploadHandler || onDropFile);
  const handlePasteCapture = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard || !ref.current) return;
    const types = new Set(Array.from(clipboard.types));
    if (types.has("Files") || types.has("text/html")) return;
    if (isSelectionInsideCodeLikeElement(containerRef.current)) return;

    const rawText = clipboard.getData("text/plain");
    if (!looksLikeMarkdownPaste(rawText)) return;

    event.preventDefault();
    ref.current.insertMarkdown(normalizeMarkdown(rawText));
  }, []);

  const handleRichEditorError = useCallback((error: unknown) => {
    setRichEditorError(richEditorErrorMessage(error));
  }, []);

  return {
    richEditorError,
    containerRef,
    bordered,
    className,
    fallbackTextareaRef,
    editorRef: ref,
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
    ...autocomplete,
    uploadError,
    setRichEditorError,
    setIsDragOver,
    hasFilePayload,
  };
}
