import type { ReactNode, RefObject } from "react";
import { AlertCircle, KeyRound, Plus, RotateCcw, Save, UserRound } from "lucide-react";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EnvironmentVariableRow } from "./Row";
import { rowDirtyFields } from "./EnvironmentVariablesEditorState";
import { validateName, type EnvironmentVariableFocusTarget, type EnvRow } from "./model";

export interface EnvironmentVariablesEditorViewProps {
  editorRootRef: RefObject<HTMLDivElement | null>;
  attentionCount: number;
  rows: EnvRow[];
  secrets: readonly CompanySecret[];
  userSecretDefinitions?: readonly UserSecretDefinition[];
  recentlyUsedSecrets?: readonly CompanySecret[];
  disabled?: boolean;
  reservedPrefixes: readonly string[];
  duplicateNames: ReadonlySet<string>;
  touchedNames: ReadonlySet<string>;
  committedRowsById: ReadonlyMap<string, EnvRow>;
  pendingFocus: EnvironmentVariableFocusTarget | null;
  quickBind: readonly CompanySecret[];
  hasUnsavedChanges: boolean;
  changeSummaryText: string;
  hint: ReactNode | null;
  onPatchRow: (id: string, patch: Partial<EnvRow>) => void;
  onRemoveRow: (id: string) => void;
  onMarkTouched: (id: string) => void;
  onBulkImport: (text: string, id: string) => boolean;
  onAddRow: () => void;
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onToast: (message: string) => void;
  onFocusConsumed: () => void;
  onBindRecentSecret: (secret: CompanySecret) => void;
  onRevertDraft: () => void;
  onSaveDraft: () => void;
}

export function EnvironmentVariablesEditorView({
  editorRootRef,
  attentionCount,
  rows,
  secrets,
  userSecretDefinitions,
  recentlyUsedSecrets,
  disabled,
  reservedPrefixes,
  duplicateNames,
  touchedNames,
  committedRowsById,
  pendingFocus,
  quickBind,
  hasUnsavedChanges,
  changeSummaryText,
  hint,
  onPatchRow,
  onRemoveRow,
  onMarkTouched,
  onBulkImport,
  onAddRow,
  onCreateSecret,
  onToast,
  onFocusConsumed,
  onBindRecentSecret,
  onRevertDraft,
  onSaveDraft,
}: EnvironmentVariablesEditorViewProps) {
  const hasRows = rows.length > 0;

  return (
    <TooltipProvider>
      <div ref={editorRootRef} className="@container/env space-y-2">
        {attentionCount > 1 ? (
          <p className="inline-flex items-center gap-1.5 text-(length:--text-micro) font-medium text-amber-700 dark:text-amber-400">
            <AlertCircle className="size-3.5" />
            {attentionCount} bindings need attention
          </p>
        ) : null}

        {hasRows ? (
          <>
            <div className="hidden gap-x-1.5 @[40rem]/env:grid @[40rem]/env:grid-cols-(--gtc-14)">
              <span className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
                Name
              </span>
              <span className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
                Value
              </span>
              <span />
            </div>

            {rows.map((row, index) => (
              <EnvironmentVariableRow
                key={row.id}
                row={row}
                isLast={index === rows.length - 1}
                secrets={secrets}
                userSecretDefinitions={userSecretDefinitions}
                recentlyUsedSecrets={recentlyUsedSecrets}
                disabled={disabled}
                nameDiagnostic={validateName(row.name, duplicateNames, reservedPrefixes)}
                showNameDiagnostic={touchedNames.has(row.name.trim())}
                dirtyFields={rowDirtyFields(row, committedRowsById.get(row.id))}
                onPatch={(patch) => onPatchRow(row.id, patch)}
                onRemove={() => onRemoveRow(row.id)}
                onNameBlur={() => onMarkTouched(row.id)}
                onNamePaste={(text) => onBulkImport(text, row.id)}
                onEnterInValueLast={onAddRow}
                onCreateSecret={onCreateSecret}
                onToast={onToast}
                focusRequest={pendingFocus?.rowId === row.id ? pendingFocus.field : null}
                onFocusConsumed={onFocusConsumed}
              />
            ))}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No environment variables</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button type="button" onClick={onAddRow} disabled={disabled} variant="ghost" size="sm">
            <Plus className="size-3.5" />
            Add variable
          </Button>

          {quickBind.length > 0 && !disabled ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground/70">
                <KeyRound className="size-3" />
                Recently used:
              </span>
              {quickBind.map((secret) => (
                <Button
                  key={secret.id}
                  type="button"
                  onClick={() => onBindRecentSecret(secret)}
                  variant="outline"
                  size="xs"
                  className="font-mono"
                  title={`Bind ${secret.name}`}
                >
                  + {secret.name}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        {hasUnsavedChanges && !disabled ? (
          <Alert
            role="status"
            className="mt-3 flex w-full flex-col gap-3 @[34rem]/env:flex-row @[34rem]/env:items-center @[34rem]/env:justify-between"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <AlertTitle>Unsaved changes</AlertTitle>
              {changeSummaryText ? (
                <AlertDescription className="min-w-0 truncate" title={changeSummaryText}>
                  {changeSummaryText}
                </AlertDescription>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={onRevertDraft} variant="outline">
                <RotateCcw className="size-4" />
                Revert
              </Button>
              <Button type="button" onClick={onSaveDraft}>
                <Save className="size-4" />
                Save
              </Button>
            </div>
          </Alert>
        ) : null}

        {hint ? <p className="text-(length:--text-micro) text-muted-foreground/70">{hint}</p> : null}
        {rows.some((row) => row.source === "user_secret" && row.userSecretKey) ? (
          <p className="inline-flex items-start gap-1 text-(length:--text-micro) text-muted-foreground/70">
            <UserRound className="mt-0.5 size-3 shrink-0" />
            <span>
              User secrets resolve from the user responsible for the run. Required bindings fail until that
              user sets their value under Secrets → My secrets.
            </span>
          </p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
