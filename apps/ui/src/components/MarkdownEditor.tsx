import "@mdxeditor/editor/style.css";
import { forwardRef } from "react";
import type { MarkdownEditorProps, MarkdownEditorRef } from "./MarkdownEditorTypes";
import { MarkdownEditorView } from "./MarkdownEditorView";
import { useMarkdownEditorController } from "./useMarkdownEditorController";

export * from "./MarkdownAutocompleteEditing.js";
export * from "./MarkdownAutocompleteMenu.js";
export * from "./MarkdownEditorUtils";
export type { MarkdownEditorRef, MentionOption } from "./MarkdownEditorTypes";

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(
  function MarkdownEditor(props, forwardedRef) {
    const controller = useMarkdownEditorController(props, forwardedRef);
    return <MarkdownEditorView {...controller} />;
  },
);
