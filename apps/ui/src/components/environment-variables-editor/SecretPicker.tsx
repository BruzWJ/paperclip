import { useMemo, useState } from "react";
import { Check, CornerUpLeft, Folder, KeyRound, Plus } from "lucide-react";
import type { CompanySecret, SecretStatus } from "@paperclipai/shared";

import { DomainStatus } from "@/components/patterns/DomainStatus";
import { EntityCombobox, type EntityComboboxOptionGroup } from "@/components/patterns/EntityCombobox";
import { type EntityOption } from "@/lib/entity-selector";
import { normalizeSearchText } from "@/lib/searchable-select";
import { cn } from "@/lib/utils";

const FOLDER_VALUE_PREFIX = "__secret_folder__:";
const CREATE_OPTION_ID = "__secret_create__";
const DEFAULT_SELECTABLE_SECRET_STATUSES = ["active"] as const satisfies readonly SecretStatus[];

function splitSecretPath(name: string) {
  return name.split("/").filter((part) => part.length > 0);
}

function pathKey(parts: readonly string[]) {
  return parts.join("/");
}

function pathLabel(parts: readonly string[]) {
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

function pathStartsWith(parts: readonly string[], prefix: readonly string[]) {
  return parts.length >= prefix.length && prefix.every((part, index) => parts[index] === part);
}

function folderValue(parts: readonly string[]) {
  return `${FOLDER_VALUE_PREFIX}${pathKey(parts)}`;
}

function isFolderOption(option: EntityOption) {
  return option.id.startsWith(FOLDER_VALUE_PREFIX);
}

function folderPathFromValue(value: string) {
  return value.slice(FOLDER_VALUE_PREFIX.length);
}

function canSelectSecret(
  secret: CompanySecret,
  currentSecretId: string,
  selectableStatuses: readonly SecretStatus[] | null,
) {
  return (
    selectableStatuses === null || selectableStatuses.includes(secret.status) || secret.id === currentSecretId
  );
}

function secretOption(
  secret: CompanySecret,
  scope: "recent" | "all" | "browse",
  currentSecretId: string,
  selectableStatuses: readonly SecretStatus[] | null,
  label = secret.name,
): EntityOption {
  return {
    id: secret.id,
    commandValue: `${scope}-${secret.id}`,
    label,
    searchText: `${secret.key} ${secret.name}`,
    disabled: !canSelectSecret(secret, currentSecretId, selectableStatuses),
  };
}

function buildFolderGroup(
  secrets: readonly CompanySecret[],
  currentPath: readonly string[],
  currentSecretId: string,
  selectableStatuses: readonly SecretStatus[] | null,
): EntityComboboxOptionGroup {
  const currentLength = currentPath.length;
  const folders = new Map<string, EntityOption>();
  const leafSecrets: EntityOption[] = [];

  for (const secret of secrets) {
    const parts = splitSecretPath(secret.name);
    if (!pathStartsWith(parts, currentPath)) continue;

    if (parts.length > currentLength + 1) {
      const folderParts = parts.slice(0, currentLength + 1);
      const key = pathKey(folderParts);
      if (!folders.has(key)) {
        folders.set(key, {
          id: folderValue(folderParts),
          commandValue: `folder-${key || "root"}`,
          label: folderParts.at(-1) ?? "/",
          searchText: pathLabel(folderParts),
        });
      }
      continue;
    }

    if (parts.length === currentLength + 1 || (currentLength === 0 && parts.length === 0)) {
      leafSecrets.push(
        secretOption(secret, "browse", currentSecretId, selectableStatuses, parts.at(-1) ?? secret.name),
      );
    }
  }

  const options: EntityOption[] = [];
  if (currentPath.length > 0) {
    const parentPath = currentPath.slice(0, -1);
    options.push({
      id: folderValue(parentPath),
      commandValue: `folder-up-${pathKey(currentPath)}`,
      label: "Up one folder",
      searchText: pathLabel(parentPath),
    });
  }
  options.push(...folders.values(), ...leafSecrets);
  return {
    id: "browse-secrets",
    label: currentPath.length > 0 ? pathLabel(currentPath) : "Browse secrets",
    options,
  };
}

function optionMatches(option: EntityOption, query: string) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return true;
  return normalizeSearchText(`${option.label} ${option.searchText ?? ""}`).includes(normalized);
}

function createGroup(query: string): EntityComboboxOptionGroup {
  const name = query.trim();
  return {
    id: "secret-actions",
    options: [
      {
        id: CREATE_OPTION_ID,
        label: name ? `Create secret “${name}”…` : "Create new secret…",
      },
    ],
  };
}

export interface SecretPickerProps {
  secretId: string;
  secrets: readonly CompanySecret[];
  recentlyUsedSecrets?: readonly CompanySecret[];
  selectableStatuses?: readonly SecretStatus[] | null;
  disabled?: boolean;
  onSelect: (secretId: string) => void;
  onCreateNew: (query: string) => void;
  triggerId?: string;
  ariaLabel?: string;
  placeholder?: string;
  triggerClassName?: string;
}

export function SecretPicker({
  secretId,
  secrets,
  recentlyUsedSecrets,
  selectableStatuses = DEFAULT_SELECTABLE_SECRET_STATUSES,
  disabled,
  onSelect,
  onCreateNew,
  triggerId,
  ariaLabel,
  placeholder = "Select secret…",
  triggerClassName,
}: SecretPickerProps) {
  const [currentPathKey, setCurrentPathKey] = useState("");
  const boundSecret = useMemo(
    () => secrets.find((secret) => secret.id === secretId) ?? null,
    [secrets, secretId],
  );
  const secretById = useMemo(
    () => new Map([...secrets, ...(recentlyUsedSecrets ?? [])].map((secret) => [secret.id, secret] as const)),
    [recentlyUsedSecrets, secrets],
  );
  const boundMissing = Boolean(secretId) && !boundSecret;
  const currentPath = useMemo(() => (currentPathKey ? currentPathKey.split("/") : []), [currentPathKey]);
  const hasFolderPaths = useMemo(
    () => secrets.some((secret) => splitSecretPath(secret.name).length > 1),
    [secrets],
  );
  const groups = useMemo<EntityComboboxOptionGroup[]>(() => {
    const result: EntityComboboxOptionGroup[] = [];
    if (boundMissing) {
      result.push({
        id: "current-missing",
        label: "Current",
        options: [
          {
            id: secretId,
            commandValue: `missing-${secretId}`,
            label: `Missing secret (${secretId.slice(0, 8)}…)`,
            searchText: `Missing secret (${secretId})`,
            disabled: true,
          },
        ],
      });
    }

    const recent = (recentlyUsedSecrets ?? []).filter(
      (secret) => canSelectSecret(secret, secretId, selectableStatuses) && secret.id !== secretId,
    );
    if (recent.length > 0) {
      result.push({
        id: "recently-used",
        label: "Recently used",
        options: recent.map((secret) => secretOption(secret, "recent", secretId, selectableStatuses)),
      });
    }

    result.push({
      id: "all-secrets",
      label: recent.length > 0 ? "All secrets" : undefined,
      options: secrets.map((secret) => secretOption(secret, "all", secretId, selectableStatuses)),
    });
    return result;
  }, [boundMissing, recentlyUsedSecrets, secretId, secrets, selectableStatuses]);

  const optionGroups = useMemo(
    () => (query: string) => {
      if (hasFolderPaths && !normalizeSearchText(query)) {
        const stable = groups.filter(
          (group) => group.id === "current-missing" || group.id === "recently-used",
        );
        const browse = buildFolderGroup(secrets, currentPath, secretId, selectableStatuses);
        const visible = browse.options.length > 0 ? [...stable, browse] : stable;
        return [...visible, createGroup(query)];
      }
      const visible = groups
        .map((group) => ({
          ...group,
          options: group.options.filter((option) => optionMatches(option, query)),
        }))
        .filter((group) => group.options.length > 0);
      return [...visible, createGroup(query)];
    },
    [currentPath, groups, hasFolderPaths, secretId, secrets, selectableStatuses],
  );

  const triggerLabel = boundMissing ? `Missing secret (${secretId.slice(0, 8)}…)` : boundSecret?.name;

  return (
    <EntityCombobox
      value={secretId}
      options={groups.flatMap((group) => group.options)}
      optionGroups={optionGroups}
      type="secret"
      ariaLabel={ariaLabel ?? "Secret"}
      placeholder={placeholder}
      noneLabel="No secret"
      includeNone={false}
      disabled={disabled}
      shouldFilter={false}
      searchPlaceholder="Search secrets…"
      emptyMessage="No matching secrets"
      contentClassName="min-w-64"
      triggerProps={{ id: triggerId }}
      triggerClassName={cn(
        "h-(--sz-34px) min-h-(--sz-34px) font-mono text-sm",
        boundMissing && "border-destructive text-destructive",
        boundSecret && boundSecret.status !== "active" && "border-amber-500/60",
        triggerClassName,
      )}
      onValueChange={onSelect}
      onOptionSelect={(option, query) => {
        if (option.id === CREATE_OPTION_ID) {
          window.setTimeout(() => onCreateNew(query), 0);
          return "close-without-focus";
        }
        if (isFolderOption(option)) {
          setCurrentPathKey(folderPathFromValue(option.id));
          return "keep-open";
        }
        setCurrentPathKey("");
        return "select";
      }}
      showSelectionIndicator={false}
      renderValue={() =>
        triggerLabel ? (
          <span
            className={cn("flex w-full min-w-0 items-center gap-1.5", boundMissing && "text-destructive")}
            title={boundMissing ? `Missing secret (${secretId})` : triggerLabel}
          >
            <KeyRound
              className={cn(
                "size-3.5 shrink-0",
                boundSecret && boundSecret.status !== "active" ? "text-amber-600" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
            {boundSecret && boundSecret.status !== "active" ? (
              <span className="text-amber-600">({boundSecret.status})</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )
      }
      renderOption={(option) => {
        if (option.id === CREATE_OPTION_ID) {
          return (
            <>
              <Plus className="size-3.5 shrink-0" />
              <span>{option.label}</span>
            </>
          );
        }
        const selected = option.id === secretId;
        if (isFolderOption(option)) {
          const isBack = option.commandValue?.startsWith("folder-up-") ?? false;
          const FolderIcon = isBack ? CornerUpLeft : Folder;
          const fullPath = option.searchText ?? option.label;
          return (
            <span className="flex min-w-0 flex-1 items-center gap-1.5" title={fullPath}>
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className={cn("truncate text-sm", selected && "font-medium")}>{option.label}</span>
                <span className="truncate font-mono text-(length:--text-micro) text-muted-foreground">
                  {fullPath}
                </span>
              </span>
            </span>
          );
        }

        const secret = secretById.get(option.id);
        const title = secret?.name ?? option.searchText ?? option.label;
        return (
          <span
            className={cn("flex min-w-0 flex-1 items-center gap-1.5", option.disabled && "opacity-60")}
            title={title}
          >
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className={cn("min-w-0 truncate font-mono text-sm", selected && "font-medium")}>
                {option.label}
              </span>
              {secret?.name && secret.name !== option.label ? (
                <span className="truncate font-mono text-(length:--text-micro) text-muted-foreground">
                  {secret.name}
                </span>
              ) : null}
            </span>
            {secret && secret.status !== "active" ? (
              <DomainStatus
                status={secret.status}
                className="ml-auto text-(length:--text-nano) font-normal text-muted-foreground"
              />
            ) : null}
            {selected ? <Check className="ml-auto size-4" /> : null}
          </span>
        );
      }}
    />
  );
}
