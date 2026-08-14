import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CornerUpLeft, Folder, KeyRound, Plus } from "lucide-react";
import type { CompanySecret, SecretStatus } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { normalizeSearchText } from "@/lib/searchable-select";
import { cn } from "@/lib/utils";

interface SecretOption {
  key: string;
  value: string;
  label: string;
  title?: string;
  searchText?: string;
  kind?: "secret" | "folder" | "back";
  missing?: boolean;
  status?: SecretStatus;
  folderPath?: string;
  pathHint?: string;
  disabled?: boolean;
}

interface SecretGroup {
  id: string;
  label?: string;
  options: SecretOption[];
}

const FOLDER_VALUE_PREFIX = "__secret_folder__:";

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

function buildFolderGroup(
  secrets: readonly CompanySecret[],
  currentPath: readonly string[],
  currentSecretId: string,
): SecretGroup {
  const currentLength = currentPath.length;
  const folders = new Map<string, SecretOption>();
  const leafSecrets: SecretOption[] = [];

  for (const secret of secrets) {
    const parts = splitSecretPath(secret.name);
    if (!pathStartsWith(parts, currentPath)) continue;

    if (parts.length > currentLength + 1) {
      const folderParts = parts.slice(0, currentLength + 1);
      const key = pathKey(folderParts);
      if (!folders.has(key)) {
        const label = folderParts.at(-1) ?? "/";
        const fullPath = pathLabel(folderParts);
        folders.set(key, {
          key: `folder-${key || "root"}`,
          value: folderValue(folderParts),
          label,
          title: fullPath,
          searchText: fullPath,
          kind: "folder",
          folderPath: key,
          pathHint: fullPath,
        });
      }
      continue;
    }

    if (parts.length === currentLength + 1 || (currentLength === 0 && parts.length === 0)) {
      const label = parts.at(-1) ?? secret.name;
      leafSecrets.push({
        key: `browse-${secret.id}`,
        value: secret.id,
        label,
        title: secret.name,
        searchText: `${secret.key} ${secret.name}`,
        status: secret.status,
        kind: "secret",
        pathHint: secret.name,
        disabled: secret.status !== "active" && secret.id !== currentSecretId,
      });
    }
  }

  const options: SecretOption[] = [];
  if (currentPath.length > 0) {
    const parentPath = currentPath.slice(0, -1);
    options.push({
      key: `folder-up-${pathKey(currentPath)}`,
      value: folderValue(parentPath),
      label: "Up one folder",
      title: pathLabel(parentPath),
      searchText: pathLabel(parentPath),
      kind: "back",
      folderPath: pathKey(parentPath),
      pathHint: pathLabel(parentPath),
    });
  }
  options.push(...folders.values(), ...leafSecrets);
  return {
    id: "browse-secrets",
    label: currentPath.length > 0 ? pathLabel(currentPath) : "Browse secrets",
    options,
  };
}

function optionMatches(option: SecretOption, query: string) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return true;
  return normalizeSearchText(`${option.label} ${option.title ?? ""} ${option.searchText ?? ""}`).includes(
    normalized,
  );
}

export interface SecretPickerProps {
  secretId: string;
  secrets: readonly CompanySecret[];
  recentlyUsedSecrets?: readonly CompanySecret[];
  disabled?: boolean;
  onSelect: (secretId: string) => void;
  onCreateNew: (query: string) => void;
  triggerClassName?: string;
}

export function SecretPicker({
  secretId,
  secrets,
  recentlyUsedSecrets,
  disabled,
  onSelect,
  onCreateNew,
  triggerClassName,
}: SecretPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentPathKey, setCurrentPathKey] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pointerFocusRef = useRef(false);
  const suppressNextTriggerFocusRef = useRef(false);
  const boundSecret = useMemo(
    () => secrets.find((secret) => secret.id === secretId) ?? null,
    [secrets, secretId],
  );
  const boundMissing = Boolean(secretId) && !boundSecret;
  const currentPath = useMemo(() => (currentPathKey ? currentPathKey.split("/") : []), [currentPathKey]);
  const hasFolderPaths = useMemo(
    () => secrets.some((secret) => splitSecretPath(secret.name).length > 1),
    [secrets],
  );

  const groups = useMemo<SecretGroup[]>(() => {
    const result: SecretGroup[] = [];
    if (boundMissing) {
      result.push({
        id: "current-missing",
        label: "Current",
        options: [
          {
            key: `missing-${secretId}`,
            value: secretId,
            label: `Missing secret (${secretId.slice(0, 8)}…)`,
            title: `Missing secret (${secretId})`,
            missing: true,
            disabled: true,
          },
        ],
      });
    }

    const recent = (recentlyUsedSecrets ?? []).filter(
      (secret) => secret.status === "active" && secret.id !== secretId,
    );
    if (recent.length > 0) {
      result.push({
        id: "recently-used",
        label: "Recently used",
        options: recent.map((secret) => ({
          key: `recent-${secret.id}`,
          value: secret.id,
          label: secret.name,
          title: secret.name,
          searchText: `${secret.key} ${secret.name}`,
          status: secret.status,
          kind: "secret",
        })),
      });
    }

    result.push({
      id: "all-secrets",
      label: recent.length > 0 ? "All secrets" : undefined,
      options: secrets.map((secret) => ({
        key: `all-${secret.id}`,
        value: secret.id,
        label: secret.name,
        title: secret.name,
        searchText: `${secret.key} ${secret.name}`,
        status: secret.status,
        kind: "secret",
        disabled: secret.status !== "active" && secret.id !== secretId,
      })),
    });
    return result;
  }, [boundMissing, recentlyUsedSecrets, secretId, secrets]);

  const visibleGroups = useMemo(() => {
    if (hasFolderPaths && !normalizeSearchText(query)) {
      const stable = groups.filter((group) => group.id === "current-missing" || group.id === "recently-used");
      const browse = buildFolderGroup(secrets, currentPath, secretId);
      return browse.options.length > 0 ? [...stable, browse] : stable;
    }
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => optionMatches(option, query)),
      }))
      .filter((group) => group.options.length > 0);
  }, [currentPath, groups, hasFolderPaths, query, secretId, secrets]);

  function choose(option: SecretOption) {
    if (option.disabled) return;
    if (option.folderPath !== undefined) {
      setCurrentPathKey(option.folderPath);
      setQuery("");
      window.setTimeout(() => searchRef.current?.focus(), 0);
      return;
    }
    setCurrentPathKey("");
    setQuery("");
    suppressNextTriggerFocusRef.current = true;
    setOpen(false);
    onSelect(option.value);
  }

  const triggerLabel = boundMissing ? `Missing secret (${secretId.slice(0, 8)}…)` : boundSecret?.name;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          onPointerDown={() => {
            pointerFocusRef.current = true;
          }}
          onFocus={() => {
            const shouldIgnoreFocus = pointerFocusRef.current || suppressNextTriggerFocusRef.current;
            pointerFocusRef.current = false;
            suppressNextTriggerFocusRef.current = false;
            if (!disabled && !shouldIgnoreFocus) setOpen(true);
          }}
          className={cn(
            "h-(--sz-34px) min-h-(--sz-34px) w-full justify-between font-mono text-sm",
            boundMissing && "border-destructive text-destructive",
            boundSecret && boundSecret.status !== "active" && "border-amber-500/60",
            triggerClassName,
          )}
        >
          {triggerLabel ? (
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
            <span className="text-muted-foreground">Select secret…</span>
          )}
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={searchRef}
            value={query}
            onValueChange={setQuery}
            placeholder="Search secrets…"
          />
          <CommandList>
            {visibleGroups.length === 0 ? <CommandEmpty>No matching secrets</CommandEmpty> : null}
            {visibleGroups.map((group) => (
              <CommandGroup key={group.id} heading={group.label}>
                {group.options.map((option) => {
                  const selected = option.value === secretId;
                  const FolderIcon = option.kind === "back" ? CornerUpLeft : Folder;
                  return (
                    <CommandItem
                      key={option.key}
                      value={option.key}
                      disabled={option.disabled}
                      onSelect={() => choose(option)}
                    >
                      {option.kind === "folder" || option.kind === "back" ? (
                        <span
                          className="flex min-w-0 flex-1 items-center gap-1.5"
                          title={option.title ?? option.label}
                        >
                          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex min-w-0 flex-col">
                            <span className={cn("truncate text-sm", selected && "font-medium")}>
                              {option.label}
                            </span>
                            {option.pathHint ? (
                              <span className="truncate font-mono text-(length:--text-micro) text-muted-foreground">
                                {option.pathHint}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-1.5",
                            option.disabled && "opacity-60",
                          )}
                          title={option.title ?? option.label}
                        >
                          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex min-w-0 flex-col">
                            <span
                              className={cn("min-w-0 truncate font-mono text-sm", selected && "font-medium")}
                            >
                              {option.label}
                            </span>
                            {option.pathHint && option.pathHint !== option.label ? (
                              <span className="truncate font-mono text-(length:--text-micro) text-muted-foreground">
                                {option.pathHint}
                              </span>
                            ) : null}
                          </span>
                          {option.status && option.status !== "active" ? (
                            <Badge
                              variant="outline"
                              className="ml-auto text-(length:--text-nano) font-normal text-muted-foreground"
                            >
                              {option.status}
                            </Badge>
                          ) : null}
                          {selected ? <Check className="ml-auto size-4" /> : null}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
            <CommandGroup>
              <CommandItem
                value={`create-${query}`}
                onSelect={() => {
                  const createQuery = query;
                  suppressNextTriggerFocusRef.current = true;
                  setOpen(false);
                  setQuery("");
                  window.setTimeout(() => onCreateNew(createQuery), 0);
                }}
              >
                <Plus className="size-3.5 shrink-0" />
                {query.trim() ? (
                  <span>
                    Create secret <span className="font-mono">&ldquo;{query.trim()}&rdquo;</span>…
                  </span>
                ) : (
                  <span>Create new secret…</span>
                )}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
