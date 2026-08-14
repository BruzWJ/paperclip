import type { RoutineCommandOption } from "../context/EditorAutocompleteContext";

interface MentionOptionBase {
  id: string;
  name: string;
}
export type MentionOption =
  | (MentionOptionBase & {
      kind: "agent";
      agentId: string;
      agentIcon?: string | null;
    })
  | (MentionOptionBase & {
      kind: "project";
      projectId: string;
      projectColor?: string | null;
    })
  | (MentionOptionBase & { kind: "user"; userId: string })
  | (MentionOptionBase & {
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
export interface MentionState {
  trigger: "mention" | "command";
  marker: "@" | "/";
  query: string;
  top: number;
  left: number;
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
  textNode: Text;
  atPos: number;
  endPos: number;
}
export type AutocompleteOption = MentionOption | RoutineCommandOption;
