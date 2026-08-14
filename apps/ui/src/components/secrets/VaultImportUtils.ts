import { ApiError } from "@/api/client";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  RemoteSecretImportCandidate,
} from "@paperclipai/shared";
import { useEffect, useState } from "react";

export interface DraftSelection {
  candidate: RemoteSecretImportCandidate;
  name: string;
  key: string;
  description: string;
}

const KEY_PATTERN = /^[a-z0-9_.-]+$/;

export function isAwsSelectable(config: CompanySecretProviderConfig) {
  if (config.provider !== "aws_secrets_manager") return false;
  return config.status === "ready" || config.status === "warning";
}

export function eligibleVaults(configs: CompanySecretProviderConfig[]): CompanySecretProviderConfig[] {
  return configs.filter(isAwsSelectable);
}

export function pickDefaultVault(
  configs: CompanySecretProviderConfig[],
  preferredId?: string | null,
): string | null {
  const eligible = eligibleVaults(configs);
  if (eligible.length === 0) return null;
  if (preferredId && eligible.some((vault) => vault.id === preferredId)) {
    return preferredId;
  }
  return (eligible.find((vault) => vault.isDefault) ?? eligible[0]).id;
}

export function awsVaultOptions(configs: CompanySecretProviderConfig[]): CompanySecretProviderConfig[] {
  return configs.filter((vault) => vault.provider === "aws_secrets_manager");
}

export function statusBadgeLabel(status: RemoteSecretImportCandidate["status"]) {
  switch (status) {
    case "duplicate":
      return "Imported";
    case "conflict":
      return "Conflict";
    case "ready":
    default:
      return "Ready";
  }
}

export function middleTruncate(value: string, max = 60) {
  if (value.length <= max) return value;
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function formatRelativeShort(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleDateString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function readableErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message || `Request failed: ${error.status}`;
  }
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function apiErrorCode(error: ApiError): string | null {
  const body = error.body;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  const details = record.details;
  if (details && typeof details === "object") {
    const code = (details as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return null;
}

export function isPermissionError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (apiErrorCode(error) === "access_denied") return true;
  if (error.status === 401 || error.status === 403) return true;
  const message = error.message.toLowerCase();
  return (
    message.includes("accessdenied") ||
    message.includes("access denied") ||
    message.includes("not authorized")
  );
}

export function isThrottlingError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (apiErrorCode(error) === "throttled") return true;
  const message = error.message.toLowerCase();
  return message.includes("throttl") || message.includes("toomanyrequests");
}

export function buildDraft(candidate: RemoteSecretImportCandidate): DraftSelection {
  return {
    candidate,
    name: candidate.name,
    key: candidate.key,
    description: "",
  };
}

export function safeImportProviderMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const safe: Record<string, unknown> = {};
  for (const key of ["createdDate", "lastAccessedDate", "lastChangedDate", "deletedDate"]) {
    const value = metadata[key];
    if (typeof value === "string" || value === null) safe[key] = value;
  }
  for (const key of ["hasDescription", "hasKmsKey", "tagCount"]) {
    const value = metadata[key];
    if (typeof value === "boolean" || typeof value === "number") safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

export function validateDraftRow(
  draft: DraftSelection,
  existing: CompanySecret[],
  otherDrafts: DraftSelection[],
): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (draft.name.length > 160) return "Name must be 160 characters or fewer.";
  if (!draft.key.trim()) return "Key is required.";
  if (!KEY_PATTERN.test(draft.key)) {
    return "Key may only contain lowercase letters, numbers, dot, underscore, or hyphen.";
  }
  if (draft.key.length > 120) return "Key must be 120 characters or fewer.";
  if (draft.description.length > 500) return "Description must be 500 characters or fewer.";

  const lowerName = draft.name.trim().toLowerCase();
  const lowerKey = draft.key.trim().toLowerCase();

  for (const existingSecret of existing) {
    if (existingSecret.name.trim().toLowerCase() === lowerName) {
      return "A Paperclip secret already uses this name.";
    }
    if (existingSecret.key.trim().toLowerCase() === lowerKey) {
      return "A Paperclip secret already uses this key.";
    }
  }

  for (const other of otherDrafts) {
    if (other === draft) continue;
    if (other.name.trim().toLowerCase() === lowerName) {
      return "Another row in this batch already uses this name.";
    }
    if (other.key.trim().toLowerCase() === lowerKey) {
      return "Another row in this batch already uses this key.";
    }
  }

  return null;
}

export function normalizeDraftKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
