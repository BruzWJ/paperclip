import type { MentionOption } from "@/lib/markdown-mentions";

export type { MentionOption } from "@/lib/markdown-mentions";
export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  onBlur?: () => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  onDropFile?: (file: File) => Promise<void>;
  fileDropTarget?: "editor" | "parent";
  bordered?: boolean;
  mentions?: MentionOption[];
  onSubmit?: () => void;
  readOnly?: boolean;
}
export interface MarkdownEditorRef {
  focus: () => void;
  insertMarkdown: (markdown: string) => void;
}
