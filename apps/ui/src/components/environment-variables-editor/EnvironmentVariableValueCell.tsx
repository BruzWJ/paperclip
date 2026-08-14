import type { Dispatch, RefObject, SetStateAction } from "react";
import { ChevronDown, KeyRound, ShieldAlert, Type as TypeIcon, UserRound, X } from "lucide-react";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SecretPicker } from "./SecretPicker";
import { CreateSecretPopover, ConvertToSecretPopover } from "./CreateSecretPopover";
import { secretNameFromKey, type EnvRow, type RowSource, type SecretHealth } from "./model";
import type { EnvironmentVariableDirtyFields } from "./Row";

export type SecretPopoverState = {
  mode: "create" | "store";
  name: string;
  value: string;
} | null;

interface EnvironmentVariableValueCellProps {
  row: EnvRow;
  isLast: boolean;
  secrets: readonly CompanySecret[];
  userSecretDefinitions?: readonly UserSecretDefinition[];
  recentlyUsedSecrets?: readonly CompanySecret[];
  disabled?: boolean;
  dirtyFields: EnvironmentVariableDirtyFields;
  isPending: boolean;
  sensitive: boolean;
  boundSecret: CompanySecret | null;
  userSecretsEnabled: boolean;
  sourceLabel: string;
  versions: number;
  versionTagLabel: string;
  versionPinned: boolean;
  health: SecretHealth | null;
  healthId: string;
  undoPrev: EnvRow | null;
  valueInputRef: RefObject<HTMLInputElement | null>;
  valueCellRef: RefObject<HTMLDivElement | null>;
  secretPopover: SecretPopoverState;
  setSecretPopover: Dispatch<SetStateAction<SecretPopoverState>>;
  versionOpen: boolean;
  setVersionOpen: Dispatch<SetStateAction<boolean>>;
  onPatch: (patch: Partial<EnvRow>) => void;
  onEnterInValueLast: () => void;
  onSwitchSource: (next: RowSource) => void;
  onOpenStoreAsSecret: () => void;
  onSubmitSecretPopover: (name: string, value: string) => Promise<void>;
  onUndo: () => void;
}

export function EnvironmentVariableValueCell({
  row,
  isLast,
  secrets,
  userSecretDefinitions,
  recentlyUsedSecrets,
  disabled,
  dirtyFields,
  isPending,
  sensitive,
  boundSecret,
  userSecretsEnabled,
  sourceLabel,
  versions,
  versionTagLabel,
  versionPinned,
  health,
  healthId,
  undoPrev,
  valueInputRef,
  valueCellRef,
  secretPopover,
  setSecretPopover,
  versionOpen,
  setVersionOpen,
  onPatch,
  onEnterInValueLast,
  onSwitchSource,
  onOpenStoreAsSecret,
  onSubmitSecretPopover,
  onUndo,
}: EnvironmentVariableValueCellProps) {
  return (
    <div className="col-span-2 col-start-1 row-start-2 min-w-0 @[40rem]/env:col-span-1 @[40rem]/env:col-start-2 @[40rem]/env:row-start-1">
      <Popover
        open={secretPopover !== null}
        onOpenChange={(open) => {
          if (!open) setSecretPopover(null);
        }}
      >
        <PopoverAnchor asChild>
          <InputGroup
            ref={valueCellRef}
            data-disabled={disabled || isPending || undefined}
            className={cn(
              "overflow-hidden",
              dirtyFields.value && "border-amber-500/70 bg-amber-500/10",
              disabled && "opacity-60",
            )}
          >
            <InputGroupAddon align="inline-start" className="border-r px-1">
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild disabled={disabled || isPending}>
                      <InputGroupButton size="sm" aria-label="Value source">
                        {row.source === "text" ? (
                          <TypeIcon />
                        ) : row.source === "secret" ? (
                          <KeyRound />
                        ) : (
                          <UserRound />
                        )}
                        <ChevronDown />
                      </InputGroupButton>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">{sourceLabel}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem
                    className="flex-col items-start gap-0.5"
                    onSelect={() => onSwitchSource("text")}
                  >
                    <span className="text-sm">Text value</span>
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      Store the value inline as plain text.
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="flex-col items-start gap-0.5"
                    onSelect={() => onSwitchSource("secret")}
                  >
                    <span className="text-sm">Company secret</span>
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      Resolve a stored company secret at run start.
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="flex-col items-start gap-0.5"
                    onSelect={() => onSwitchSource("user_secret")}
                  >
                    <span className="text-sm">User secret</span>
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      Resolve the responsible user&apos;s own value at run start.
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </InputGroupAddon>

            {row.source === "text" ? (
              <>
                <InputGroupInput
                  ref={valueInputRef}
                  className="font-mono"
                  placeholder="value"
                  value={row.textValue}
                  type={sensitive ? "password" : "text"}
                  spellCheck={false}
                  disabled={disabled || isPending}
                  aria-label="Variable value"
                  onChange={(event) => onPatch({ textValue: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && isLast) {
                      event.preventDefault();
                      onEnterInValueLast();
                    }
                  }}
                />
                {sensitive ? (
                  <InputGroupAddon align="inline-end" className="gap-0 border-l px-1">
                    <InputGroupButton
                      onClick={onOpenStoreAsSecret}
                      disabled={disabled || isPending}
                      title="This value looks sensitive — store it as a secret"
                    >
                      <ShieldAlert />
                      <span className="hidden @[30rem]/env:inline">Store as secret</span>
                    </InputGroupButton>
                    <InputGroupButton
                      size="icon-xs"
                      onClick={() => onPatch({ sensitiveDismissed: true })}
                      disabled={disabled || isPending}
                      aria-label="Dismiss sensitive-value suggestion"
                      title="Dismiss — keep this value as plain text"
                    >
                      <X />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </>
            ) : row.source === "secret" ? (
              <div className="relative min-w-0 flex-1">
                <SecretPicker
                  secretId={row.secretId}
                  secrets={secrets}
                  recentlyUsedSecrets={recentlyUsedSecrets}
                  disabled={disabled || isPending}
                  onSelect={(id) => onPatch({ secretId: id, version: "latest" })}
                  onCreateNew={(query) =>
                    setSecretPopover({
                      mode: "create",
                      name: secretNameFromKey(query) || query.trim(),
                      value: "",
                    })
                  }
                  triggerClassName={cn(
                    "rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0",
                    boundSecret && boundSecret.status === "active" && "pr-24 has-[>svg]:!pr-24",
                  )}
                />
                {boundSecret && boundSecret.status === "active" ? (
                  <Popover open={versionOpen} onOpenChange={setVersionOpen}>
                    <PopoverAnchor asChild>
                      <Button
                        type="button"
                        variant={versionPinned ? "secondary" : "ghost"}
                        size="xs"
                        disabled={disabled || isPending}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setVersionOpen((prev) => !prev);
                        }}
                        aria-label="Version"
                        className="absolute right-8 top-1/2 z-10 h-6 -translate-y-1/2"
                      >
                        {versionTagLabel}
                      </Button>
                    </PopoverAnchor>
                    <PopoverContent align="end" className="w-44 p-1">
                      <RadioGroup
                        aria-label="Secret version"
                        value={String(row.version)}
                        className="gap-1"
                        onValueChange={(value) => {
                          onPatch({
                            version: value === "latest" ? "latest" : Number.parseInt(value, 10),
                          });
                          setVersionOpen(false);
                        }}
                      >
                        <Field orientation="horizontal" className="gap-2 px-2 py-1.5">
                          <RadioGroupItem id={`${healthId}-version-latest`} value="latest" />
                          <FieldLabel
                            htmlFor={`${healthId}-version-latest`}
                            className="w-full justify-between"
                          >
                            latest
                            <span className="text-(length:--text-micro) text-muted-foreground">
                              (recommended)
                            </span>
                          </FieldLabel>
                        </Field>
                        {Array.from({ length: versions }, (_, idx) => versions - idx)
                          .filter((version) => version > 0)
                          .map((version) => (
                            <Field key={version} orientation="horizontal" className="gap-2 px-2 py-1.5">
                              <RadioGroupItem id={`${healthId}-version-${version}`} value={String(version)} />
                              <FieldLabel htmlFor={`${healthId}-version-${version}`}>v{version}</FieldLabel>
                            </Field>
                          ))}
                      </RadioGroup>
                    </PopoverContent>
                  </Popover>
                ) : null}
              </div>
            ) : (
              <div className="grid min-w-0 flex-1 grid-cols-(--gtc-13)">
                {userSecretsEnabled ? (
                  <Select
                    value={row.userSecretKey}
                    onValueChange={(key) => {
                      const definition = userSecretDefinitions?.find((candidate) => candidate.key === key);
                      onPatch({
                        userSecretKey: key,
                        ...(definition && !row.name.trim() ? { name: definition.key.toUpperCase() } : {}),
                      });
                    }}
                    disabled={disabled || isPending}
                  >
                    <SelectTrigger
                      className="min-w-0 bg-transparent border-0 px-2 py-1.5 text-sm font-mono outline-none h-auto"
                      aria-label="User secret"
                    >
                      <SelectValue placeholder="Select user secret..." />
                    </SelectTrigger>
                    <SelectContent>
                      {row.userSecretKey &&
                      !userSecretDefinitions?.some((definition) => definition.key === row.userSecretKey) ? (
                        <SelectItem value={row.userSecretKey}>Unknown ({row.userSecretKey})</SelectItem>
                      ) : null}
                      {(userSecretDefinitions ?? []).map((definition) => (
                        <SelectItem key={definition.id} value={definition.key}>
                          {definition.name}
                          {definition.status !== "active" ? ` (${definition.status})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <InputGroupInput
                    className="font-mono"
                    placeholder="user-secret key"
                    value={row.userSecretKey}
                    spellCheck={false}
                    disabled={disabled || isPending}
                    aria-label="User secret key"
                    onChange={(event) => onPatch({ userSecretKey: event.target.value })}
                  />
                )}
                <Select
                  value={row.required ? "required" : "optional"}
                  onValueChange={(value) => onPatch({ required: value === "required" })}
                  disabled={disabled || isPending}
                >
                  <SelectTrigger
                    className="border-l border-border bg-transparent px-2 py-1.5 text-xs font-medium text-muted-foreground border-0 rounded-none h-auto"
                    aria-label="Requirement"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="required">Required</SelectItem>
                    <SelectItem value="optional">Optional</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </InputGroup>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-auto p-3"
          onInteractOutside={(event) => {
            const target = event.detail.originalEvent.target as Node | null;
            if (target && valueCellRef.current?.contains(target)) {
              event.preventDefault();
            }
          }}
        >
          {secretPopover?.mode === "store" ? (
            <ConvertToSecretPopover
              initialName={secretPopover.name}
              initialValue={secretPopover.value}
              existingSecretNames={secrets.map((secret) => secret.name)}
              onCancel={() => setSecretPopover(null)}
              onSubmit={onSubmitSecretPopover}
            />
          ) : secretPopover?.mode === "create" ? (
            <CreateSecretPopover
              initialName={secretPopover.name}
              initialValue={secretPopover.value}
              existingSecretNames={secrets.map((secret) => secret.name)}
              onCancel={() => setSecretPopover(null)}
              onSubmit={onSubmitSecretPopover}
            />
          ) : null}
        </PopoverContent>
      </Popover>

      {isPending ? (
        <p
          aria-live="polite"
          role="status"
          className="mt-0.5 text-(length:--text-micro) text-muted-foreground"
        >
          Creating and binding secret…
        </p>
      ) : null}
      {health ? (
        <p
          id={healthId}
          role="status"
          className={cn(
            "mt-0.5 text-(length:--text-micro)",
            health.level === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
          )}
        >
          {health.message}
        </p>
      ) : null}

      {undoPrev ? (
        <p className="mt-0.5 inline-flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
          Reverted to text —{" "}
          <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={onUndo}>
            Undo
          </Button>
        </p>
      ) : null}
    </div>
  );
}
