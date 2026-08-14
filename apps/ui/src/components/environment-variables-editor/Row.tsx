import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, X } from "lucide-react";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isSensitiveEnv } from "./sensitive";
import {
  computeRowHealth,
  computeUserSecretRowHealth,
  planSourceSwitch,
  secretNameFromKey,
  type EnvRow,
  type NameDiagnostic,
  type RowSource,
} from "./model";
import { EnvironmentVariableValueCell, type SecretPopoverState } from "./EnvironmentVariableValueCell";

export interface EnvironmentVariableDirtyFields {
  name: boolean;
  value: boolean;
}

export interface EnvironmentVariableRowProps {
  row: EnvRow;
  isLast: boolean;
  secrets: readonly CompanySecret[];
  userSecretDefinitions?: readonly UserSecretDefinition[];
  recentlyUsedSecrets?: readonly CompanySecret[];
  disabled?: boolean;
  nameDiagnostic: NameDiagnostic | null;
  showNameDiagnostic: boolean;
  dirtyFields: EnvironmentVariableDirtyFields;
  onPatch: (patch: Partial<EnvRow>) => void;
  onRemove: () => void;
  onNameBlur: () => void;
  onNamePaste: (text: string) => boolean;
  onEnterInValueLast: () => void;
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onToast: (message: string) => void;
  focusRequest: "name" | "value" | null;
  onFocusConsumed: () => void;
}

export function EnvironmentVariableRow({
  row,
  isLast,
  secrets,
  userSecretDefinitions,
  recentlyUsedSecrets,
  disabled,
  nameDiagnostic,
  showNameDiagnostic,
  dirtyFields,
  onPatch,
  onRemove,
  onNameBlur,
  onNamePaste,
  onEnterInValueLast,
  onCreateSecret,
  onToast,
  focusRequest,
  onFocusConsumed,
}: EnvironmentVariableRowProps) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const valueInputRef = useRef<HTMLInputElement | null>(null);
  const valueCellRef = useRef<HTMLDivElement | null>(null);
  const [secretPopover, setSecretPopover] = useState<SecretPopoverState>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  const [undoPrev, setUndoPrev] = useState<EnvRow | null>(null);
  const [isPending, setIsPending] = useState(false);

  const health = computeRowHealth(row, secrets) ?? computeUserSecretRowHealth(row, userSecretDefinitions);
  const boundSecret =
    row.source === "secret" ? (secrets.find((secret) => secret.id === row.secretId) ?? null) : null;
  const userSecretsEnabled = (userSecretDefinitions?.length ?? 0) > 0;
  const sensitive =
    row.source === "text" && !row.sensitiveDismissed && isSensitiveEnv(row.name, row.textValue);

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest === "name") {
      nameInputRef.current?.focus();
    } else if (row.source === "text") {
      valueInputRef.current?.focus();
    } else if (row.source === "secret") {
      valueCellRef.current?.querySelector<HTMLElement>("[role=combobox]")?.focus();
    } else {
      valueCellRef.current?.querySelector<HTMLElement>("select,input")?.focus();
    }
    onFocusConsumed();
  }, [focusRequest, onFocusConsumed, row.source]);

  useEffect(() => {
    if (!undoPrev) return;
    const handle = window.setTimeout(() => setUndoPrev(null), 5000);
    return () => window.clearTimeout(handle);
  }, [undoPrev]);

  function switchSource(next: RowSource) {
    if (next === "user_secret") {
      if (row.source === "user_secret") return;
      onPatch({ source: "user_secret", secretId: "", version: "latest" });
      window.setTimeout(() => valueCellRef.current?.querySelector<HTMLElement>("select,input")?.focus(), 0);
      return;
    }

    const plan = planSourceSwitch(row, next);
    switch (plan.kind) {
      case "noop":
        return;
      case "open-store":
        window.setTimeout(
          () =>
            setSecretPopover({
              mode: "store",
              name: plan.name,
              value: plan.value,
            }),
          0,
        );
        return;
      case "to-secret":
        onPatch({ source: "secret", userSecretKey: "", required: true });
        window.setTimeout(() => {
          valueCellRef.current?.querySelector<HTMLElement>("[role=combobox]")?.focus();
        }, 0);
        return;
      case "to-text":
        if (plan.undoFrom) setUndoPrev(plan.undoFrom);
        onPatch({
          source: "text",
          secretId: "",
          userSecretKey: "",
          required: true,
          version: "latest",
        });
        window.setTimeout(() => valueInputRef.current?.focus(), 0);
    }
  }

  async function submitSecretPopover(name: string, value: string) {
    if (isPending) return;
    setIsPending(true);
    try {
      const created = await onCreateSecret(name, value);
      onPatch({
        source: "secret",
        secretId: created.id,
        userSecretKey: "",
        required: true,
        version: "latest",
        textValue: "",
      });
      onToast(`Secret ${created.name} created`);
      setSecretPopover(null);
    } finally {
      setIsPending(false);
    }
  }

  function openStoreAsSecret() {
    const name = secretNameFromKey(row.name) || "secret";
    window.setTimeout(
      () =>
        setSecretPopover({
          mode: "store",
          name,
          value: row.textValue,
        }),
      0,
    );
  }

  const sourceLabel =
    row.source === "text"
      ? "Text value"
      : row.source === "secret"
        ? "Company secret reference"
        : "User secret reference";
  const nameErrorId = `${row.id}-name-error`;
  const healthId = `${row.id}-health`;
  const isDirty = dirtyFields.name || dirtyFields.value;
  const versions = boundSecret ? Math.max(0, boundSecret.latestVersion) : 0;
  const versionTagLabel = row.version === "latest" ? "latest" : `v${row.version}`;
  const versionPinned = row.version !== "latest";

  return (
    <Item
      aria-busy={isPending}
      variant={isDirty ? "muted" : "default"}
      className={cn(
        "group/row grid grid-cols-(--gtc-13) items-start gap-x-1.5 gap-y-1 border-0 px-1 py-1",
        "@[40rem]/env:grid-cols-(--gtc-14) @[40rem]/env:items-center",
      )}
    >
      <div className="col-start-1 row-start-1 min-w-0 @[40rem]/env:row-start-1 @[40rem]/env:self-start">
        <Input
          ref={nameInputRef}
          className={cn(
            "font-mono",
            dirtyFields.name && "border-amber-500/70 bg-amber-500/10 focus-visible:ring-amber-500/40",
            showNameDiagnostic &&
              nameDiagnostic?.level === "error" &&
              "border-destructive focus-visible:ring-destructive/40",
            showNameDiagnostic &&
              nameDiagnostic?.level === "warn" &&
              "border-amber-500 focus-visible:ring-amber-500/40",
          )}
          placeholder="KEY"
          value={row.name}
          spellCheck={false}
          disabled={disabled || isPending}
          aria-label="Variable name"
          aria-invalid={showNameDiagnostic && nameDiagnostic?.level === "error" ? true : undefined}
          aria-describedby={showNameDiagnostic && nameDiagnostic ? nameErrorId : undefined}
          onChange={(event) => onPatch({ name: event.target.value })}
          onBlur={onNameBlur}
          onPaste={(event) => {
            if (row.name) return;
            const text = event.clipboardData.getData("text");
            if (onNamePaste(text)) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (row.source === "text") valueInputRef.current?.focus();
              else valueCellRef.current?.querySelector<HTMLElement>("[role=combobox],select,input")?.focus();
            }
          }}
        />
      </div>

      <EnvironmentVariableValueCell
        row={row}
        isLast={isLast}
        secrets={secrets}
        userSecretDefinitions={userSecretDefinitions}
        recentlyUsedSecrets={recentlyUsedSecrets}
        disabled={disabled}
        dirtyFields={dirtyFields}
        isPending={isPending}
        sensitive={sensitive}
        boundSecret={boundSecret}
        userSecretsEnabled={userSecretsEnabled}
        sourceLabel={sourceLabel}
        versions={versions}
        versionTagLabel={versionTagLabel}
        versionPinned={versionPinned}
        health={health}
        healthId={healthId}
        undoPrev={undoPrev}
        valueInputRef={valueInputRef}
        valueCellRef={valueCellRef}
        secretPopover={secretPopover}
        setSecretPopover={setSecretPopover}
        versionOpen={versionOpen}
        setVersionOpen={setVersionOpen}
        onPatch={onPatch}
        onEnterInValueLast={onEnterInValueLast}
        onSwitchSource={switchSource}
        onOpenStoreAsSecret={openStoreAsSecret}
        onSubmitSecretPopover={submitSecretPopover}
        onUndo={() => {
          if (!undoPrev) return;
          onPatch({
            source: "secret",
            secretId: undoPrev.secretId,
            version: undoPrev.version,
            textValue: "",
          });
          setUndoPrev(null);
        }}
      />

      {showNameDiagnostic && nameDiagnostic ? (
        <p
          id={nameErrorId}
          className={cn(
            "col-span-2 col-start-1 row-start-3 min-w-0 text-(length:--text-micro) @[40rem]/env:col-span-2 @[40rem]/env:row-start-2",
            nameDiagnostic.level === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
          )}
        >
          {nameDiagnostic.message}
        </p>
      ) : null}

      <div className="col-start-2 row-start-1 flex items-center justify-end gap-0.5 self-start @[40rem]/env:col-start-3 @[40rem]/env:self-center">
        {row.source === "text" && !sensitive && (row.name.trim() || row.textValue) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled || isPending}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="More actions"
                className="opacity-100 @[40rem]/env:opacity-0 @[40rem]/env:group-hover/row:opacity-100 @[40rem]/env:group-focus-within/row:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => window.setTimeout(openStoreAsSecret, 0)}>
                Store as secret…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          disabled={disabled || isPending}
          aria-label={`Remove ${row.name.trim() || "variable"}`}
          className="opacity-100 hover:text-destructive @[40rem]/env:opacity-0 @[40rem]/env:group-hover/row:opacity-100 @[40rem]/env:group-focus-within/row:opacity-100"
        >
          <X className="size-4" />
        </Button>
      </div>
    </Item>
  );
}
