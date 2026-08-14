import type { CompanySecret } from "@paperclipai/shared";

/** Minimal entity shapes shared by presentation adapters and filters. */
export interface NamedEntity {
  id: string;
  name: string;
}

export interface LabeledValue {
  label: string;
  value: string;
}

export interface KeyedLabel {
  key: string;
  label: string;
}

export interface NameValuePair {
  name: string;
  value: string;
}

export interface NamedColor {
  name: string;
  color: string | null;
}

export interface TimestampedEntity {
  id: string;
  createdAt: Date | string;
}

export interface TaskScope {
  companyId: string;
  taskId: string;
}

export interface ProjectScope {
  companyId: string;
  projectId: string;
}

export interface RoutineScope {
  companyId: string;
  routineId: string;
}

export interface ParentedEntity {
  id: string;
  parentId: string | null;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface OpenStateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Shared controlled/uncontrolled open-state contract for app-owned popover wrappers. */
export type ControlledOpenStateProps = Partial<OpenStateProps>;

export type SortDirection = "asc" | "desc";

export interface NamedAgentSummary {
  name: string;
  icon?: string | null;
}

export interface TaskOwnerReference {
  ownerKind: "agent" | "user" | "board";
  ownerAgentId: string | null;
  ownerUserId: string | null;
}

export interface ColoredNamedEntity extends NamedEntity {
  color: string;
}

export interface NamedEntityWithColor extends NamedEntity {
  color: string | null;
}

export interface CreatorOption {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
}

/** Shared local draft for the company-secret creation surfaces. */
export interface SecretCreationDraft {
  name: string;
  value: string;
  description: string;
}

export function createSecretCreationDraft(initial: Partial<SecretCreationDraft> = {}): SecretCreationDraft {
  return {
    name: initial.name ?? "",
    value: initial.value ?? "",
    description: initial.description ?? "",
  };
}

export type NamedEntityLookup = ReadonlyMap<string, NamedEntity>;
export type SecretLookup = ReadonlyMap<string, CompanySecret>;

/** Builds the shared ID lookup used by app presentation adapters. */
export function indexEntitiesById<T extends { id: string }>(
  entities: readonly T[] | null | undefined,
): Map<string, T> {
  return new Map((entities ?? []).map((entity) => [entity.id, entity]));
}

export interface EnvDiffCounts {
  added: number;
  removed: number;
  changed: number;
  total: number;
}
