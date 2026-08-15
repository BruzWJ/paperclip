import type { AgentEnvConfig, EnvBinding, TaskWorkMode } from "@paperclipai/shared";
import { AlertTriangle, ArrowDown, ArrowUp, Minus } from "lucide-react";

const DRAFT_KEY = "paperclip:task-request-draft:v2";

export const DEBOUNCE_MS = 800;
export const MOBILE_DIALOG_HEIGHT =
  "calc(100dvh - max(1rem, env(safe-area-inset-top)) - max(1rem, env(safe-area-inset-bottom)))";
export const STAGED_FILE_ACCEPT = {
  "image/*": [],
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
  "text/markdown": [".md", ".markdown"],
  "application/json": [".json"],
  "text/csv": [".csv"],
  "text/html": [".html", ".htm"],
};

export interface TaskDraft {
  title: string;
  request: string;
  status: string;
  priority: string;
  ownerAgentId: string;
  reviewerValue: string;
  approverValue: string;
  projectId: string;
  workMode?: TaskWorkMode;
}

export type StagedTaskFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

export function loadDraft(): TaskDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as TaskDraft) : null;
  } catch {
    return null;
  }
}

export function saveDraft(draft: TaskDraft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}
export function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

export function isTextDocumentFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".txt") ||
    file.type === "text/markdown" ||
    file.type === "text/plain"
  );
}

export function createUniqueDocumentKey(baseKey: string, stagedFiles: StagedTaskFile[]) {
  const existingKeys = new Set(
    stagedFiles
      .filter((file) => file.kind === "document")
      .map((file) => file.documentKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (!existingKeys.has(baseKey)) return baseKey;
  let suffix = 2;
  while (existingKeys.has(`${baseKey}-${suffix}`)) suffix += 1;
  return `${baseKey}-${suffix}`;
}

export function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

export const statusOptions: ReadonlyArray<{ value: string; label: string; description?: string }> = [
  { value: "backlog", label: "Backlog", description: "Parked - owner will not be dispatched" },
  { value: "todo", label: "Todo", description: "Executable - owner will be woken" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRequiredUserSecretBinding(
  value: unknown,
): value is Extract<EnvBinding, { type: "user_secret_ref" }> {
  return (
    isRecord(value) &&
    value.type === "user_secret_ref" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0 &&
    value.required !== false &&
    value.allowMissingOverride !== true
  );
}

function collectRequiredUserSecretKeysFromEnv(
  env: AgentEnvConfig | Record<string, unknown> | null | undefined,
): string[] {
  if (!isRecord(env)) return [];
  return Object.values(env).flatMap((binding) =>
    isRequiredUserSecretBinding(binding) ? [binding.key.trim()] : [],
  );
}

export function uniqueRequiredUserSecretKeys(
  inputs: Array<AgentEnvConfig | Record<string, unknown> | null | undefined>,
): string[] {
  return [...new Set(inputs.flatMap(collectRequiredUserSecretKeysFromEnv))];
}

export function shouldWarnAboutRunUserSecrets(status: string, ownerAgentId: string | null | undefined) {
  return Boolean(ownerAgentId) && (status === "todo" || status === "in_progress");
}

export function participantAgentId(value: string): string | null {
  return value.startsWith("agent:") ? value.slice("agent:".length) || null : null;
}

export const priorities = [
  { value: "critical", label: "Critical", icon: AlertTriangle },
  { value: "high", label: "High", icon: ArrowUp },
  { value: "medium", label: "Medium", icon: Minus },
  { value: "low", label: "Low", icon: ArrowDown },
];

export function isWorkModePeriodShortcut(
  event: Pick<React.KeyboardEvent, "code" | "ctrlKey" | "key" | "metaKey">,
) {
  return (event.metaKey || event.ctrlKey) && (event.code === "Period" || event.key === ".");
}

export function isWorkModeEscapeShortcut(event: Pick<KeyboardEvent, "key" | "metaKey">) {
  return event.metaKey && event.key === "Escape";
}
