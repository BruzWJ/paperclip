import type { NamedEntity } from "@/lib/presentation-contracts";
import type { UserMentionReference } from "@/lib/mention-chips";

export type MentionOption =
  | (NamedEntity & {
      kind: "agent";
      agentId: string;
      agentIcon?: string | null;
    })
  | (NamedEntity & {
      kind: "project";
      projectId: string;
      projectColor?: string | null;
    })
  | (NamedEntity & UserMentionReference)
  | (NamedEntity & {
      kind: "task";
      taskId: string;
      taskIdentifier: string;
    });
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
