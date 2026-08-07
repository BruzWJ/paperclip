import { memo, useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent, type CSSProperties, type DragEvent, type RefObject } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  normalizeContextAccess,
  type
  AgentEnvConfig,
  type
  CreateIssue,
  type
  EnvBinding,
  type
  ContextAccess,
  type
  IssueWorkMode,
} from "@paperclipai/shared";
import { pickTextColorForSolidBg } from "@/lib/color-contrast";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { MissingUserSecretsBanner } from "../pages/secrets/MissingUserSecretsBanner";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { buildMarkdownMentionOptions, isAgentTaskTarget } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { isIssueWorkMode, nextWorkMode, workModeMetaFor, workModeMetaList } from "../lib/work-mode-meta";
import { useToastActions } from "../context/ToastContext";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Check,
  CircleDot,
  Minus,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Tag,
  Calendar,
  Paperclip,
  FileText,
  Flag,
  Loader2,
  ListTree,
  X,
  Eye,
  ShieldCheck,
} from "lucide-react";
import { cn } from "../lib/utils";
import { issueStatusText, issueStatusTextDefault, priorityColor, priorityColorDefault } from "../lib/status-colors";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { AgentIcon } from "./AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { IssueContextAccessMaskMatrix } from "./IssueContextAccessMaskMatrix";

const DRAFT_KEY = "paperclip:issue-request-draft:v2";
const DEBOUNCE_MS = 800;
const MOBILE_DIALOG_HEIGHT = "calc(100dvh - max(1rem, env(safe-area-inset-top)) - max(1rem, env(safe-area-inset-bottom)))";


interface IssueDraft {
  title: string;
  request: string;
  status: string;
  priority: string;
  ownerAgentId: string;
  reviewerValue: string;
  approverValue: string;
  projectId: string;
  workMode?: IssueWorkMode;
  contextAccessMask?: ContextAccess | null;
}

type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

import { Badge } from "@/components/ui/badge";
const STAGED_FILE_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";

function loadDraft(): IssueDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as IssueDraft;
    return {
      ...draft,
      contextAccessMask: normalizeContextAccess(draft.contextAccessMask),
    };
  } catch {
    return null;
  }
}

function saveDraft(draft: IssueDraft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function isTextDocumentFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".txt") ||
    file.type === "text/markdown" ||
    file.type === "text/plain"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createUniqueDocumentKey(baseKey: string, stagedFiles: StagedIssueFile[]) {
  const existingKeys = new Set(
    stagedFiles
      .filter((file) => file.kind === "document")
      .map((file) => file.documentKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (!existingKeys.has(baseKey)) return baseKey;
  let suffix = 2;
  while (existingKeys.has(`${baseKey}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseKey}-${suffix}`;
}

function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

function buildStatusOptions(): ReadonlyArray<{ value: string; label: string; color: string; description?: string }> {
  const palette = issueStatusText;
  return [
    {
      value: "backlog",
      label: "Backlog",
      color: palette.backlog ?? issueStatusTextDefault,
      description: "Parked - owner will not be dispatched",
    },
    {
      value: "todo",
      label: "Todo",
      color: palette.todo ?? issueStatusTextDefault,
      description: "Executable - owner will be woken",
    },
    { value: "in_progress", label: "In Progress", color: palette.in_progress ?? issueStatusTextDefault },
    { value: "in_review", label: "In Review", color: palette.in_review ?? issueStatusTextDefault },
    { value: "done", label: "Done", color: palette.done ?? issueStatusTextDefault },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRequiredUserSecretBinding(value: unknown): value is Extract<EnvBinding, { type: "user_secret_ref" }> {
  return isRecord(value)
    && value.type === "user_secret_ref"
    && typeof value.key === "string"
    && value.key.trim().length > 0
    && value.required !== false
    && value.allowMissingOverride !== true;
}

function collectRequiredUserSecretKeysFromEnv(env: AgentEnvConfig | Record<string, unknown> | null | undefined): string[] {
  if (!isRecord(env)) return [];
  return Object.values(env).flatMap((binding) =>
    isRequiredUserSecretBinding(binding) ? [binding.key.trim()] : [],
  );
}

function uniqueRequiredUserSecretKeys(inputs: Array<AgentEnvConfig | Record<string, unknown> | null | undefined>): string[] {
  return [...new Set(inputs.flatMap(collectRequiredUserSecretKeysFromEnv))];
}

function shouldWarnAboutRunUserSecrets(status: string, ownerAgentId: string | null | undefined) {
  return Boolean(ownerAgentId) && (status === "todo" || status === "in_progress");
}

function participantAgentId(value: string): string | null {
  if (!value.startsWith("agent:")) return null;
  return value.slice("agent:".length) || null;
}

const priorities = [
  { value: "critical", label: "Critical", icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
  { value: "high", label: "High", icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
  { value: "medium", label: "Medium", icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
  { value: "low", label: "Low", icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
];

function isWorkModePeriodShortcut(e: Pick<React.KeyboardEvent, "code" | "ctrlKey" | "key" | "metaKey">) {
  const isPeriod = e.code === "Period" || e.key === ".";
  return (e.metaKey || e.ctrlKey) && isPeriod;
}

function isWorkModeEscapeShortcut(e: Pick<KeyboardEvent, "key" | "metaKey">) {
  return e.metaKey && e.key === "Escape";
}

const IssueTitleTextarea = memo(function IssueTitleTextarea({
  value,
  pending,
  ownerAgentId,
  projectId,
  requestEditorRef,
  ownerSelectorRef,
  projectSelectorRef,
  onChange,
}: {
  value: string;
  pending: boolean;
  ownerAgentId: string;
  projectId: string;
  requestEditorRef: RefObject<MarkdownEditorRef | null>;
  ownerSelectorRef: RefObject<HTMLButtonElement | null>;
  projectSelectorRef: RefObject<HTMLButtonElement | null>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <textarea
      aria-label="Issue title"
      className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
      placeholder="Optional task title"
      rows={1}
      value={draftValue}
      onChange={(e) => {
        const nextValue = e.target.value;
        setDraftValue(nextValue);
        onChange(nextValue);
        e.target.style.height = "auto";
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
      readOnly={pending}
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.nativeEvent.isComposing
        ) {
          e.preventDefault();
          requestEditorRef.current?.focus();
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          if (ownerAgentId) {
            if (projectId) {
              requestEditorRef.current?.focus();
            } else {
              projectSelectorRef.current?.focus();
            }
          } else {
            ownerSelectorRef.current?.focus();
          }
        }
      }}
      autoFocus
    />
  );
});

const IssueRequestEditor = memo(function IssueRequestEditor({
  value,
  expanded,
  mentions,
  requestEditorRef,
  imageUploadHandler,
  onChange,
}: {
  value: string;
  expanded: boolean;
  mentions: MentionOption[];
  requestEditorRef: RefObject<MarkdownEditorRef | null>;
  imageUploadHandler: (file: File) => Promise<string>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <MarkdownEditor
      ref={requestEditorRef}
      value={draftValue}
      onChange={(nextValue) => {
        setDraftValue(nextValue);
        onChange(nextValue);
      }}
      placeholder="Describe the request..."
      bordered={false}
      mentions={mentions}
      contentClassName={cn("text-sm text-muted-foreground pb-12", expanded ? "min-h-(--sz-220px)" : "min-h-(--sz-120px)")}
      imageUploadHandler={imageUploadHandler}
    />
  );
});

export function NewIssueDialog() {
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const workModeOptions = useMemo(() => workModeMetaList(), []);
  const statuses = useMemo(() => buildStatusOptions(), []);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const titleRef = useRef("");
  const requestRef = useRef("");
  const [requestHasText, setRequestHasText] = useState(false);
  const [draftHasText, setDraftHasText] = useState(false);
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [contextAccessMask, setContextAccessMask] = useState<ContextAccess | null>(null);
  const [reviewerValue, setReviewerValue] = useState("");
  const [approverValue, setApproverValue] = useState("");
  const [showReviewerRow, setShowReviewerRow] = useState(false);
  const [showApproverRow, setShowApproverRow] = useState(false);
  const [participantMenuOpen, setParticipantMenuOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [workMode, setWorkMode] = useState<IssueWorkMode>("standard");
  const [expanded, setExpanded] = useState(false);
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedIssueFile[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializationKeyRef = useRef<string | null>(null);
  const createIdempotencyKeyRef = useRef<string | null>(null);

  const effectiveCompanyId = dialogCompanyId ?? selectedCompanyId;
  const dialogCompany = companies.find((c) => c.id === effectiveCompanyId) ?? selectedCompany;
  const isSubIssueMode = Boolean(newIssueDefaults.parentId);
  const parentIssueLabel = newIssueDefaults.parentIdentifier
    ?? (newIssueDefaults.parentId ? newIssueDefaults.parentId.slice(0, 8) : "");

  // Popover states
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [workModeOpen, setWorkModeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const requestEditorRef = useRef<MarkdownEditorRef>(null);
  const stageFileInputRef = useRef<HTMLInputElement | null>(null);
  const ownerSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(effectiveCompanyId!),
    queryFn: () => agentsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const issueOwnerCatalogQuery = useQuery({
    queryKey: queryKeys.agents.issueOwnerCatalog(effectiveCompanyId!),
    queryFn: () => agentsApi.listInvokableIssueOwners(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(effectiveCompanyId!),
    queryFn: () => projectsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(effectiveCompanyId!),
    queryFn: () => accessApi.listUserDirectory(effectiveCompanyId!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const activeProjects = useMemo(
    () => (projects ?? []).filter((p) => !p.archivedAt),
    [projects],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId: effectiveCompanyId,
    userId: currentUserId,
  });

  const selectedOwnerAgentId = ownerAgentId || null;
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, orderedProjects]);

  const createIssue = useMutation({
    mutationFn: async ({
      companyId,
      stagedFiles: pendingStagedFiles,
      ...data
    }: {
      companyId: string;
      stagedFiles: StagedIssueFile[];
    } & CreateIssue) => {
      const issue = await issuesApi.create(companyId, data);
      const failures: string[] = [];

      for (const stagedFile of pendingStagedFiles) {
        try {
          if (stagedFile.kind === "document") {
            const body = await stagedFile.file.text();
            await issuesApi.upsertDocument(issue.id, stagedFile.documentKey ?? "document", {
              title: stagedFile.documentKey === "plan" ? null : stagedFile.title ?? null,
              format: "markdown",
              body,
              baseRevisionId: null,
            });
          } else {
            await issuesApi.uploadAttachment(companyId, issue.id, stagedFile.file);
          }
        } catch {
          failures.push(stagedFile.file.name);
        }
      }

      return { issue, companyId, failures };
    },
    onSuccess: ({ issue, companyId, failures }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (failures.length > 0) {
        const prefix = (companies.find((company) => company.id === companyId)?.issuePrefix ?? "").trim();
        const issueRef = issue.identifier ?? issue.id;
        pushToast({
          title: `Created ${issueRef} with upload warnings`,
          body: `${failures.length} staged ${failures.length === 1 ? "file" : "files"} could not be added.`,
          tone: "warn",
          action: prefix
            ? { label: `Open ${issueRef}`, href: `/${prefix}/issues/${issueRef}` }
            : undefined,
        });
      }
      clearDraft();
      reset();
      closeNewIssue();
    },
  });

  const uploadRequestImage = useMutation({
    mutationFn: async (file: File) => {
      if (!effectiveCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(effectiveCompanyId, file, "issues/drafts");
    },
  });
  const uploadRequestImageHandler = useCallback(async (file: File) => {
    const asset = await uploadRequestImage.mutateAsync(file);
    return asset.contentPath;
  }, [uploadRequestImage.mutateAsync]);

  // Debounced draft saving
  const scheduleSave = useCallback(
    (draft: IssueDraft) => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        if (draft.title.trim() || draft.request.trim()) saveDraft(draft);
      }, DEBOUNCE_MS);
    },
    [],
  );

  const setIssueText = useCallback((nextTitle: string, nextRequest: string) => {
    titleRef.current = nextTitle;
    requestRef.current = nextRequest;
    setTitle(nextTitle);
    setRequest(nextRequest);
    setRequestHasText(nextRequest.trim().length > 0);
    setDraftHasText(nextTitle.trim().length > 0 || nextRequest.trim().length > 0);
  }, []);

  const queueDraftSave = useCallback((overrides: { title?: string; request?: string } = {}) => {
    if (!newIssueOpen) return;
    const nextTitle = overrides.title ?? titleRef.current;
    const nextRequest = overrides.request ?? requestRef.current;
    scheduleSave({
      title: nextTitle,
      request: nextRequest,
      status,
      priority,
      ownerAgentId,
      reviewerValue,
      approverValue,
      projectId,
      workMode,
      contextAccessMask,
    });
  }, [
    newIssueOpen,
    scheduleSave,
    status,
    priority,
    ownerAgentId,
    reviewerValue,
    approverValue,
    projectId,
    workMode,
    contextAccessMask,
  ]);

  const handleTitleChange = useCallback((nextTitle: string) => {
    titleRef.current = nextTitle;
    const nextTitleHasText = nextTitle.trim().length > 0;
    const nextDraftHasText = nextTitleHasText || requestRef.current.trim().length > 0;
    setDraftHasText((current) => current === nextDraftHasText ? current : nextDraftHasText);
    queueDraftSave({ title: nextTitle });
  }, [queueDraftSave]);

  const handleRequestChange = useCallback((nextRequest: string) => {
    requestRef.current = nextRequest;
    const nextRequestHasText = nextRequest.trim().length > 0;
    const nextDraftHasText = titleRef.current.trim().length > 0 || nextRequest.trim().length > 0;
    setRequestHasText((current) => current === nextRequestHasText ? current : nextRequestHasText);
    setDraftHasText((current) => current === nextDraftHasText ? current : nextDraftHasText);
    queueDraftSave({ request: nextRequest });
  }, [queueDraftSave]);

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newIssueOpen) return;
    queueDraftSave();
  }, [
    status,
    priority,
    ownerAgentId,
    reviewerValue,
    approverValue,
    projectId,
    workMode,
    contextAccessMask,
    newIssueOpen,
    queueDraftSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newIssueOpen) {
      initializationKeyRef.current = null;
      createIdempotencyKeyRef.current = null;
      return;
    }
    const initializationKey = `${selectedCompanyId ?? ""}:${JSON.stringify(newIssueDefaults)}`;
    if (initializationKeyRef.current === initializationKey) return;
    initializationKeyRef.current = initializationKey;
    setDialogCompanyId(selectedCompanyId);

    const draft = loadDraft();
    if (newIssueDefaults.parentId) {
      const nextWorkMode = isIssueWorkMode(newIssueDefaults.workMode) ? newIssueDefaults.workMode : "standard";
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      setIssueText(newIssueDefaults.title ?? "", newIssueDefaults.request ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setOwnerAgentId(newIssueDefaults.ownerAgentId ?? "");
      setContextAccessMask(null);
      setWorkMode(nextWorkMode);
    } else if (newIssueDefaults.title || newIssueDefaults.request) {
      const nextWorkMode = isIssueWorkMode(newIssueDefaults.workMode) ? newIssueDefaults.workMode : "standard";
      setIssueText(newIssueDefaults.title ?? "", newIssueDefaults.request ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      setProjectId(defaultProjectId);
      setOwnerAgentId(newIssueDefaults.ownerAgentId ?? "");
      setContextAccessMask(null);
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
      setWorkMode(nextWorkMode);
    } else if (draft && (draft.title.trim() || draft.request.trim())) {
      const nextWorkMode = isIssueWorkMode(draft.workMode) ? draft.workMode : "standard";
      const restoredProjectId = newIssueDefaults.projectId ?? draft.projectId;
      setIssueText(draft.title, draft.request);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setOwnerAgentId(newIssueDefaults.ownerAgentId ?? draft.ownerAgentId);
      setContextAccessMask(draft.contextAccessMask ?? null);
      setReviewerValue(draft.reviewerValue ?? "");
      setApproverValue(draft.approverValue ?? "");
      setShowReviewerRow(!!(draft.reviewerValue));
      setShowApproverRow(!!(draft.approverValue));
      setProjectId(restoredProjectId);
      setWorkMode(nextWorkMode);
    } else {
      setWorkMode("standard");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      setIssueText("", "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setOwnerAgentId(newIssueDefaults.ownerAgentId ?? "");
      setContextAccessMask(null);
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
    }
  }, [newIssueOpen, newIssueDefaults, orderedProjects, selectedCompanyId, setIssueText]);

  useEffect(() => {
    if (
      !ownerAgentId ||
      !issueOwnerCatalogQuery.isSuccess
    ) {
      return;
    }
    if (
      !(issueOwnerCatalogQuery.data ?? []).some(
        (owner) => owner.id === ownerAgentId,
      )
    ) {
      setOwnerAgentId("");
    }
  }, [
    issueOwnerCatalogQuery.data,
    issueOwnerCatalogQuery.isSuccess,
    ownerAgentId,
  ]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setIssueText("", "");
    setStatus("todo");
    setPriority("");
    setOwnerAgentId("");
    setContextAccessMask(null);
    setReviewerValue("");
    setApproverValue("");
    setShowReviewerRow(false);
    setShowApproverRow(false);
    setProjectId("");
    setWorkMode("standard");
    setExpanded(false);
    setDialogCompanyId(null);
    setStagedFiles([]);
    setIsFileDragOver(false);
    setCompanyOpen(false);
    initializationKeyRef.current = null;
    createIdempotencyKeyRef.current = null;
  }

  function handleCompanyChange(companyId: string) {
    if (isSubIssueMode) return;
    if (companyId === effectiveCompanyId) return;
    setDialogCompanyId(companyId);
    setOwnerAgentId("");
    setContextAccessMask(null);
    setReviewerValue("");
    setApproverValue("");
    setShowReviewerRow(false);
    setShowApproverRow(false);
    setProjectId("");
    setWorkMode("standard");
    createIdempotencyKeyRef.current = null;
  }

  function discardDraft() {
    clearDraft();
    reset();
    closeNewIssue();
  }

  function handleSubmit() {
    const currentTitle = titleRef.current.trim();
    const issueRequest = requestRef.current;
    if (
      !effectiveCompanyId ||
      !issueRequest.trim() ||
      !selectedOwnerAgentId ||
      createIssue.isPending
    ) return;
    const canonicalContextAccessMask =
      normalizeContextAccess(contextAccessMask);
    createIdempotencyKeyRef.current ??= crypto.randomUUID();
    createIssue.mutate({
      companyId: effectiveCompanyId,
      stagedFiles,
      request: issueRequest,
      ownerAgentId: selectedOwnerAgentId,
      idempotencyKey: createIdempotencyKeyRef.current,
      ...(currentTitle ? { title: currentTitle } : {}),
      priority: (priority || "medium") as NonNullable<CreateIssue["priority"]>,
      ...(newIssueDefaults.parentId ? { parentId: newIssueDefaults.parentId } : {}),
      ...(newIssueDefaults.goalId ? { goalId: newIssueDefaults.goalId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(canonicalContextAccessMask
        ? { contextAccessMask: canonicalContextAccessMask }
        : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (isWorkModePeriodShortcut(e)) {
      e.preventDefault();
      setWorkMode((current) => nextWorkMode(current));
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function stageFiles(files: File[]) {
    if (files.length === 0) return;
    setStagedFiles((current) => {
      const next = [...current];
      for (const file of files) {
        if (isTextDocumentFile(file)) {
          const baseName = fileBaseName(file.name);
          const documentKey = createUniqueDocumentKey(slugifyDocumentKey(baseName), next);
          next.push({
            id: `${file.name}:${file.size}:${file.lastModified}:${documentKey}`,
            file,
            kind: "document",
            documentKey,
            title: titleizeFilename(baseName),
          });
          continue;
        }
        next.push({
          id: `${file.name}:${file.size}:${file.lastModified}`,
          file,
          kind: "attachment",
        });
      }
      return next;
    });
  }

  function handleStageFilesPicked(evt: ChangeEvent<HTMLInputElement>) {
    stageFiles(Array.from(evt.target.files ?? []));
    if (stageFileInputRef.current) {
      stageFileInputRef.current.value = "";
    }
  }

  function handleFileDragEnter(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    setIsFileDragOver(true);
  }

  function handleFileDragOver(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleFileDragLeave(evt: DragEvent<HTMLDivElement>) {
    if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
    setIsFileDragOver(false);
  }

  function handleFileDrop(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.files.length) return;
    evt.preventDefault();
    setIsFileDragOver(false);
    stageFiles(Array.from(evt.dataTransfer.files));
  }

  function removeStagedFile(id: string) {
    setStagedFiles((current) => current.filter((file) => file.id !== id));
  }

  const hasDraft = draftHasText || stagedFiles.length > 0;
  const currentStatus = statuses.find((s) => s.value === status) ?? statuses[1]!;
  const currentPriority = priorities.find((p) => p.value === priority);
  const currentOwner = selectedOwnerAgentId
    ? (agents ?? []).find((agent) => agent.id === selectedOwnerAgentId)
    : null;
  const currentProject = orderedProjects.find((project) => project.id === projectId);
  const neededUserSecretKeys = useMemo(
    () => {
      if (!shouldWarnAboutRunUserSecrets(status, selectedOwnerAgentId)) return [];
      return uniqueRequiredUserSecretKeys([
        isRecord(currentOwner?.adapterConfig) ? currentOwner.adapterConfig.env as Record<string, unknown> : null,
        currentProject?.env ?? null,
      ]);
    },
    [currentOwner?.adapterConfig, currentProject?.env, selectedOwnerAgentId, status],
  );
  const recentOwnerAgentIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const recentOwnerOptionIds = recentOwnerAgentIds;
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [newIssueOpen]);
  const ownerOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...sortAgentsByRecency(
        issueOwnerCatalogQuery.data ?? [],
        recentOwnerAgentIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.title ?? ""}`,
      })),
    ],
    [issueOwnerCatalogQuery.data, recentOwnerAgentIds],
  );
  const participantOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter(isAgentTaskTarget),
        recentOwnerAgentIds,
      ).map((agent) => ({
        id: `agent:${agent.id}`,
        label: agent.name,
        searchText: `${agent.name} ${agent.title ?? ""}`,
      })),
    [agents, recentOwnerAgentIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const savedDraft = useMemo(() => newIssueOpen ? loadDraft() : null, [newIssueOpen]);
  const hasSavedDraft = Boolean(savedDraft?.title.trim() || savedDraft?.request.trim());
  const canDiscardDraft = hasDraft || hasSavedDraft;
  const createIssueErrorMessage =
    createIssue.error instanceof Error ? createIssue.error.message : "Failed to create task. Try again.";
  const stagedDocuments = stagedFiles.filter((file) => file.kind === "document");
  const stagedAttachments = stagedFiles.filter((file) => file.kind === "attachment");

  const handleProjectChange = useCallback((nextProjectId: string) => {
    if (nextProjectId) trackRecentProject(nextProjectId);
    setProjectId(nextProjectId);
  }, []);
  const currentWorkMode = workModeMetaFor(workMode);
  const CurrentWorkModeIcon = currentWorkMode.icon;

  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open && !createIssue.isPending) closeNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        style={{ "--new-issue-dialog-height": MOBILE_DIALOG_HEIGHT } as CSSProperties}
        className={cn(
          "flex h-(--new-issue-dialog-height) max-h-(--new-issue-dialog-height) flex-col gap-0 overflow-hidden p-0 sm:h-auto",
          expanded
            ? "sm:max-w-2xl sm:h-(--new-issue-dialog-height)"
            : "sm:max-w-lg"
        )}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (event.defaultPrevented) return;
          // iOS Safari maps command-period to Escape for hardware keyboards.
          // Treat modifier-Escape as the same mode-cycle shortcut so the
          // dialog does not dismiss before the shortcut can run.
          if (isWorkModeEscapeShortcut(event)) {
            event.preventDefault();
            setWorkMode((current) => nextWorkMode(current));
            return;
          }
          if (createIssue.isPending) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (createIssue.isPending) {
            event.preventDefault();
            return;
          }
          // Radix Dialog's modal DismissableLayer calls preventDefault() on
          // pointerdown events that originate outside the Dialog DOM tree.
          // Popover and editor autocomplete portals render at the body level
          // (outside the Dialog), so touch/click events on their content get
          // their default prevented. Telling Radix "this event is handled" skips
          // that preventDefault, restoring popover scroll and autocomplete taps.
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper], [data-paperclip-floating-ui]")) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle className="sr-only">Create a task</DialogTitle>
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity",
                    !dialogCompany?.brandColor && "bg-muted",
                  )}
                  disabled={isSubIssueMode}
                  style={
                    dialogCompany?.brandColor
                      ? {
                          backgroundColor: dialogCompany.brandColor,
                          color: pickTextColorForSolidBg(dialogCompany.brandColor),
                        }
                      : undefined
                  }
                >
                  {(dialogCompany?.name ?? "").slice(0, 3).toUpperCase()}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                {companies.filter((c) => c.status !== "archived").map((c) => (
                  <button
                    key={c.id}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      c.id === effectiveCompanyId && "bg-accent",
                    )}
                    onClick={() => {
                      handleCompanyChange(c.id);
                      setCompanyOpen(false);
                    }}
                  >
                    <span
                      className={cn(
                        "px-1 py-0.5 rounded text-(length:--text-nano) font-semibold leading-none",
                        !c.brandColor && "bg-muted",
                      )}
                      style={
                        c.brandColor
                          ? {
                              backgroundColor: c.brandColor,
                              color: pickTextColorForSolidBg(c.brandColor),
                            }
                          : undefined
                      }
                    >
                      {c.name.slice(0, 3).toUpperCase()}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{isSubIssueMode ? "New sub-task" : "New task"}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              disabled={createIssue.isPending}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => closeNewIssue()}
              disabled={createIssue.isPending}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* Title */}
          <div className="px-4 pt-4 pb-2">
            <IssueTitleTextarea
              value={title}
              pending={createIssue.isPending}
              ownerAgentId={ownerAgentId}
              projectId={projectId}
              requestEditorRef={requestEditorRef}
              ownerSelectorRef={ownerSelectorRef}
              projectSelectorRef={projectSelectorRef}
              onChange={handleTitleChange}
            />
          </div>

          {effectiveCompanyId ? (
            <div className="px-4 pb-2">
              {neededUserSecretKeys.length > 0 ? (
                <MissingUserSecretsBanner
                  companyId={effectiveCompanyId}
                  definitionKeys={neededUserSecretKeys}
                />
              ) : null}
            </div>
          ) : null}

          <div className="px-4 pb-2">
            <div className="overflow-x-auto overscroll-x-contain">
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground flex-wrap sm:flex-nowrap sm:min-w-max">
              <span className="w-6 shrink-0 text-center">For</span>
              <InlineEntitySelector
                ref={ownerSelectorRef}
                value={ownerAgentId}
                options={ownerOptions}
                recentOptionIds={recentOwnerOptionIds}
                placeholder="Owner"
                noneLabel="Choose owner"
                disablePortal
                searchPlaceholder="Search owners..."
                emptyMessage="No invokable agents found."
                onChange={(value) => {
                  if (value) trackRecentAssignee(value);
                  setOwnerAgentId(value);
                  if (value && status === "backlog") {
                    setStatus("todo");
                  }
                }}
                onConfirm={() => {
                  if (projectId) {
                    requestEditorRef.current?.focus();
                  } else {
                    projectSelectorRef.current?.focus();
                  }
                }}
                renderTriggerValue={(option) =>
                  option ? (
                    currentOwner ? (
                      <>
                        <AgentIcon icon={currentOwner.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">Owner</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const owner = (issueOwnerCatalogQuery.data ?? [])
                    .find((agent) => agent.id === option.id) ?? null;
                  return (
                    <>
                      {owner ? <AgentIcon icon={owner.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
              <span>in</span>
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={projectId}
                options={projectOptions}
                recentOptionIds={recentProjectIds}
                placeholder="Project"
                disablePortal
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                onChange={handleProjectChange}
                onConfirm={() => {
                  requestEditorRef.current?.focus();
                }}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: currentProject.color ?? "var(--project-seed)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Project</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = orderedProjects.find((item) => item.id === option.id);
                  return (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project?.color ?? "var(--project-seed)" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />

              {/* Three-dot menu to add Reviewer / Approver rows */}
              <Popover open={participantMenuOpen} onOpenChange={setParticipantMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-accent/50 transition-colors"
                    title="Add reviewer or approver"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-44 p-1" align="start">
                  <button
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      showReviewerRow && "bg-accent",
                    )}
                    onClick={() => {
                      setShowReviewerRow((v) => !v);
                      if (showReviewerRow) setReviewerValue("");
                      setParticipantMenuOpen(false);
                    }}
                  >
                    <Eye className="h-3 w-3" />
                    Reviewer
                  </button>
                  <button
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      showApproverRow && "bg-accent",
                    )}
                    onClick={() => {
                      setShowApproverRow((v) => !v);
                      if (showApproverRow) setApproverValue("");
                      setParticipantMenuOpen(false);
                    }}
                  >
                    <ShieldCheck className="h-3 w-3" />
                    Approver
                  </button>
                </PopoverContent>
              </Popover>
              </div>
            </div>

            {/* Reviewer row */}
            {showReviewerRow && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="w-6 shrink-0 flex items-center justify-center"><Eye className="h-3.5 w-3.5" /></span>
                <InlineEntitySelector
                value={reviewerValue}
                options={participantOptions}
                recentOptionIds={recentOwnerAgentIds.map((id) => `agent:${id}`)}
                placeholder="Reviewer"
                disablePortal
                noneLabel="No reviewer"
                searchPlaceholder="Search reviewers..."
                emptyMessage="No reviewers found."
                onChange={setReviewerValue}
                renderTriggerValue={(option) =>
                  option ? (
                    <>
                      {(() => {
                        const reviewerId = participantAgentId(option.id);
                        const reviewer = reviewerId
                          ? (agents ?? []).find((agent) => agent.id === reviewerId)
                          : null;
                        return reviewer ? <AgentIcon icon={reviewer.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null;
                      })()}
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Reviewer</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const reviewerId = participantAgentId(option.id);
                  const reviewer = reviewerId
                    ? (agents ?? []).find((agent) => agent.id === reviewerId)
                    : null;
                  return (
                    <>
                      {reviewer ? <AgentIcon icon={reviewer.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
                />
              </div>
            )}

            {/* Approver row */}
            {showApproverRow && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="w-6 shrink-0 flex items-center justify-center"><ShieldCheck className="h-3.5 w-3.5" /></span>
                <InlineEntitySelector
                value={approverValue}
                options={participantOptions}
                recentOptionIds={recentOwnerAgentIds.map((id) => `agent:${id}`)}
                placeholder="Approver"
                disablePortal
                noneLabel="No approver"
                searchPlaceholder="Search approvers..."
                emptyMessage="No approvers found."
                onChange={setApproverValue}
                renderTriggerValue={(option) =>
                  option ? (
                    <>
                      {(() => {
                        const approverId = participantAgentId(option.id);
                        const approver = approverId
                          ? (agents ?? []).find((agent) => agent.id === approverId)
                          : null;
                        return approver ? <AgentIcon icon={approver.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null;
                      })()}
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Approver</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const approverId = participantAgentId(option.id);
                  const approver = approverId
                    ? (agents ?? []).find((agent) => agent.id === approverId)
                    : null;
                  return (
                    <>
                      {approver ? <AgentIcon icon={approver.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
                />
              </div>
            )}

          </div>

          {ownerAgentId ? (
            <div className="border-t border-border/60 px-4 py-3">
              <IssueContextAccessMaskMatrix
                value={contextAccessMask}
                onChange={setContextAccessMask}
              />
            </div>
          ) : null}

          {isSubIssueMode ? (
            <div className="px-4 pb-2">
            <div className="max-w-full rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <ListTree className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0">Sub-task of</span>
                <span className="font-medium text-foreground">{parentIssueLabel}</span>
              </div>
              {newIssueDefaults.parentTitle ? (
                <div className="pl-5 text-foreground/80 truncate">
                  {newIssueDefaults.parentTitle}
                </div>
              ) : null}
            </div>
            </div>
          ) : null}

          {/* Immutable request */}
          <div
            className="border-t border-border/60 px-4 pb-2 pt-3"
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          >
            <div
              className={cn(
                "rounded-md transition-colors",
                isFileDragOver && "bg-accent/20",
              )}
            >
              <IssueRequestEditor
                value={request}
                expanded={expanded}
                mentions={mentionOptions}
                requestEditorRef={requestEditorRef}
                imageUploadHandler={uploadRequestImageHandler}
                onChange={handleRequestChange}
              />
            </div>
            {stagedFiles.length > 0 ? (
              <div className="mt-4 space-y-3 rounded-lg border border-border/70 p-3">
              {stagedDocuments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Documents</div>
                  <div className="space-y-2">
                    {stagedDocuments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="border-border font-mono text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                              {file.documentKey}
                            </Badge>
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            <span>{file.title || file.file.name}</span>
                            <span>•</span>
                            <span>{formatFileSize(file.file)}</span>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                          onClick={() => removeStagedFile(file.id)}
                          disabled={createIssue.isPending}
                          title="Remove document"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {stagedAttachments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Attachments</div>
                  <div className="space-y-2">
                    {stagedAttachments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 text-(length:--text-micro) text-muted-foreground">
                            {file.file.type || "application/octet-stream"} • {formatFileSize(file.file)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                          onClick={() => removeStagedFile(file.id)}
                          disabled={createIssue.isPending}
                          title="Remove attachment"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Property chips bar */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap shrink-0">
          {/* Status chip */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <CircleDot className={cn("h-3 w-3", currentStatus.color)} />
                {currentStatus.label}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {statuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex w-full items-start gap-2 px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  <CircleDot className={cn("h-3 w-3 mt-0.5 shrink-0", s.color)} />
                  <span className="flex flex-col text-left leading-tight">
                    <span>{s.label}</span>
                    {s.description ? (
                      <span className="text-(length:--text-nano) text-muted-foreground">{s.description}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Priority chip */}
          <Popover open={priorityOpen} onOpenChange={setPriorityOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="new-issue-priority-chip"
                className="hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent/50 sm:inline-flex"
              >
                {currentPriority ? (
                  <>
                    <currentPriority.icon className={cn("h-3 w-3", currentPriority.color)} />
                    {currentPriority.label}
                  </>
                ) : (
                  <>
                    <Minus className="h-3 w-3 text-muted-foreground" />
                    Priority
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {priorities.map((p) => (
                <button
                  key={p.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    p.value === priority && "bg-accent"
                  )}
                  onClick={() => { setPriority(p.value); setPriorityOpen(false); }}
                >
                  <p.icon className={cn("h-3 w-3", p.color)} />
                  {p.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Labels chip — disabled, not wired up yet */}
          {/* <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground">
            <Tag className="h-3 w-3" />
            Labels
          </button> */}

          <input
            ref={stageFileInputRef}
            type="file"
            aria-label="Upload issue attachments"
            accept={STAGED_FILE_ACCEPT}
            className="hidden"
            onChange={handleStageFilesPicked}
            multiple
          />
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground"
            onClick={() => stageFileInputRef.current?.click()}
            disabled={createIssue.isPending}
          >
            <Paperclip className="h-3 w-3" />
            Upload
          </button>

          {/* Work mode chip */}
          <Popover open={workModeOpen} onOpenChange={setWorkModeOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-issue-work-mode-chip={workMode}
                aria-keyshortcuts="Meta+Period Control+Period"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                  currentWorkMode.classes.chip,
                )}
              >
                <CurrentWorkModeIcon className="h-3 w-3" />
                {currentWorkMode.shortLabel}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {workModeOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    data-issue-work-mode={option.value}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                      option.value === workMode && "bg-accent",
                      option.classes.menuItem,
                    )}
                    onClick={() => {
                      setWorkMode(option.value);
                      setWorkModeOpen(false);
                    }}
                  >
                    <Icon className="h-3 w-3" />
                    {option.label}
                    {option.value === workMode ? <Check className="ml-auto h-3 w-3" aria-hidden /> : null}
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>

          {/* More */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="new-issue-more-menu-trigger"
                aria-label="More issue options"
                className="inline-flex items-center justify-center rounded-md border border-border p-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50"
              >
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start" data-testid="new-issue-more-menu">
              <div className="sm:hidden">
                <div className="px-2 py-1 text-(length:--text-nano) font-medium uppercase text-muted-foreground">
                  Priority
                </div>
                {priorities.map((p) => (
                  <button
                    type="button"
                    key={p.value}
                    data-testid={`new-issue-more-priority-${p.value}`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                      p.value === priority && "bg-accent",
                    )}
                    onClick={() => {
                      setPriority(p.value);
                      setMoreOpen(false);
                    }}
                  >
                    <p.icon className={cn("h-3 w-3", p.color)} />
                    {p.label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
              </div>
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                Start date
              </button>
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                Due date
              </button>
            </PopoverContent>
          </Popover>
        </div>

        {ownerAgentId && status === "backlog" ? (
          <div
            data-testid="new-issue-assigned-backlog-note"
            className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
          >
            <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
            <span className="leading-snug">
              Agent ownership implies executable intent - leave status as <span className="font-medium">Backlog</span> only to deliberately park this. The owner will not be dispatched until status moves to <span className="font-medium">Todo</span> or <span className="font-medium">In Progress</span>.
            </span>
          </div>
        ) : null}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={discardDraft}
            disabled={createIssue.isPending || !canDiscardDraft}
          >
            Discard Draft
          </Button>
          <div className="flex items-center gap-3">
            <div className="min-h-5 text-right">
              {createIssue.isPending ? (
                <span role="status" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Creating issue...
                </span>
              ) : createIssue.isError ? (
                <span role="alert" className="text-xs text-destructive">{createIssueErrorMessage}</span>
              ) : null}
            </div>
            <Button
              size="sm"
              className="min-w-(--sz-8_5rem) disabled:opacity-100"
              disabled={
                !draftHasText ||
                !requestHasText ||
                !selectedOwnerAgentId ||
                createIssue.isPending
              }
              onClick={handleSubmit}
              aria-busy={createIssue.isPending}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{createIssue.isPending ? "Creating..." : isSubIssueMode ? "Create Sub-Task" : "Create Task"}</span>
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
