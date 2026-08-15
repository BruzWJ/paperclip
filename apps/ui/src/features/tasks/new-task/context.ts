import {
  createContext,
  useContext,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Agent, Company, Project, TaskWorkMode } from "@paperclipai/shared";
import type { MarkdownEditorRef, MentionOption } from "../../markdown/MarkdownEditor";
import type { EntityOption } from "@/lib/entity-selector";
import type { WorkModeMeta } from "@/lib/work-mode-meta";
import { priorities, statusOptions, type StagedTaskFile } from "./model";

export type NewTaskDialogViewModel = {
  dialog: {
    newTaskOpen: boolean;
    isSubTaskMode: boolean;
    parentTaskLabel: string;
    newTaskDefaults: { parentTitle?: string };
    closeNewTask: () => void;
  };
  company: { companyId: string; selectedCompany: Company | null; currentUserId: string | null };
  values: {
    title: string;
    request: string;
    requestHasText: boolean;
    draftHasText: boolean;
    status: string;
    priority: string;
    ownerAgentId: string;
    selectedOwnerAgentId: string | null;
    reviewerValue: string;
    approverValue: string;
    showReviewerRow: boolean;
    showApproverRow: boolean;
    projectId: string;
    projectWorkspaceId: string;
    workMode: TaskWorkMode;
    expanded: boolean;
    stagedFiles: StagedTaskFile[];
  };
  setters: {
    setStatus: Dispatch<SetStateAction<string>>;
    setPriority: Dispatch<SetStateAction<string>>;
    setOwnerAgentId: Dispatch<SetStateAction<string>>;
    setReviewerValue: Dispatch<SetStateAction<string>>;
    setApproverValue: Dispatch<SetStateAction<string>>;
    setShowReviewerRow: Dispatch<SetStateAction<boolean>>;
    setShowApproverRow: Dispatch<SetStateAction<boolean>>;
    setWorkMode: Dispatch<SetStateAction<TaskWorkMode>>;
    setExpanded: Dispatch<SetStateAction<boolean>>;
  };
  refs: {
    requestEditorRef: RefObject<MarkdownEditorRef | null>;
    ownerSelectorRef: RefObject<HTMLButtonElement | null>;
    projectSelectorRef: RefObject<HTMLButtonElement | null>;
  };
  options: {
    statuses: typeof statusOptions;
    workModeOptions: WorkModeMeta[];
    agents?: Agent[];
    orderedProjects: Project[];
    mentionOptions: MentionOption[];
    ownerOptions: EntityOption[];
    participantOptions: EntityOption[];
    projectOptions: EntityOption[];
    recentOwnerOptionIds: string[];
    recentProjectIds: string[];
  };
  derived: {
    currentStatus: (typeof statusOptions)[number];
    currentPriority?: (typeof priorities)[number];
    currentProject?: Project;
    currentOwner: Agent | null;
    neededUserSecretKeys: string[];
    currentWorkMode: WorkModeMeta;
    canDiscardDraft: boolean;
    createTaskErrorMessage: string;
    stagedDocuments: StagedTaskFile[];
    stagedAttachments: StagedTaskFile[];
  };
  creation: {
    createTask: { isPending: boolean; isError: boolean };
    uploadRequestImageHandler: (file: File) => Promise<string>;
  };
  actions: {
    handleTitleChange: (value: string) => void;
    handleRequestChange: (value: string) => void;
    handleProjectChange: (value: string) => void;
    stageFiles: (files: File[]) => void;
    removeStagedFile: (id: string) => void;
    discardDraft: () => void;
    handleSubmit: () => void;
    handleKeyDown: (event: KeyboardEvent) => void;
  };
};

export const NewTaskDialogContext = createContext<NewTaskDialogViewModel | null>(null);
export function useNewTaskDialogViewModel() {
  const value = useContext(NewTaskDialogContext);
  if (!value) throw new Error("NewTaskDialog view requires its context");
  return value;
}
