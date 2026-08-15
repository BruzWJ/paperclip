import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import type { CompanySecret, EnvBinding, UserSecretDefinition } from "@paperclipai/shared";
import { parseDotenv } from "./parse-dotenv";
import {
  computeDuplicateNames,
  computeRowHealth,
  computeUserSecretRowHealth,
  emptyRow,
  envKeyFromSecretName,
  rowsFromValue,
  valueFromRows,
  type EnvironmentVariableFocusTarget,
  type EnvRow,
} from "./model";
import {
  cloneRows,
  DEFAULT_HINT,
  DEFAULT_RESERVED_PREFIXES,
  formatChangedNames,
  normalizedEnvEntries,
  normalizedEnvKey,
} from "./EnvironmentVariablesEditorState";
import { EnvironmentVariablesEditorView } from "./EnvironmentVariablesEditorView";

export interface EnvironmentVariablesEditorProps {
  value: Record<string, EnvBinding>;
  onChange: (next: Record<string, EnvBinding> | undefined) => void;
  secrets: readonly CompanySecret[];
  /**
   * Optional company user-secret definitions. When present, the "User secret"
   * source becomes a picker; otherwise operators can type the definition key.
   */
  userSecretDefinitions?: readonly UserSecretDefinition[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  /** Optional "Recently used" picker group + quick-bind chips. */
  recentlyUsedSecrets?: readonly CompanySecret[];
  /** Read-only rendering. */
  disabled?: boolean;
  /** Prefixes flagged as reserved/auto-provided. Default `["PAPERCLIP_"]`. */
  reservedPrefixes?: readonly string[];
  /** Context-specific hint line. `null` hides the default copy; omit for default. */
  footerHint?: ReactNode | null;
  /** Reports editor-local draft changes that are not yet promoted to the parent value. */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface EnvironmentVariablesEditorHandle {
  /**
   * Promote the editor-local draft into the controlled value before an outer
   * action reads parent state. Returns the promoted value when a draft existed.
   */
  flushPendingDraft: () => Record<string, EnvBinding> | null;
}

export const EnvironmentVariablesEditor = forwardRef<
  EnvironmentVariablesEditorHandle,
  EnvironmentVariablesEditorProps
>(function EnvironmentVariablesEditor(
  {
    value,
    onChange,
    secrets,
    userSecretDefinitions,
    onCreateSecret,
    recentlyUsedSecrets,
    disabled,
    reservedPrefixes = DEFAULT_RESERVED_PREFIXES,
    footerHint,
    onDirtyChange,
  }: EnvironmentVariablesEditorProps,
  ref,
) {
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<EnvRow[]>(() => rowsFromValue(value));
  const rowsRef = useRef(rows);
  const [committedRows, setCommittedRows] = useState<EnvRow[]>(() => cloneRows(rows));
  const initialValueKey = useMemo(() => normalizedEnvKey(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const committedValueKeyRef = useRef(initialValueKey);
  const lastPropValueKeyRef = useRef(initialValueKey);
  const pendingSaveValueKeyRef = useRef<string | null>(null);
  const [committedValueKey, setCommittedValueKey] = useState(initialValueKey);
  // Seeded (already-committed) names are "touched" so a saved reserved/invalid
  // var surfaces its message on load; freshly-typed rows wait for blur (§6.2).
  const [touchedNames, setTouchedNames] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        rowsFromValue(value)
          .map((row) => row.name.trim())
          .filter(Boolean),
      ),
  );
  const [pendingFocus, setPendingFocus] = useState<EnvironmentVariableFocusTarget | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  function markCommitted(nextValueKey: string, nextRows: readonly EnvRow[] = rowsRef.current) {
    committedValueKeyRef.current = nextValueKey;
    setCommittedValueKey(nextValueKey);
    setCommittedRows(cloneRows(nextRows));
  }

  function touchCommittedNames(nextRows: EnvRow[]) {
    setTouchedNames((prev) => {
      const next = new Set(prev);
      for (const row of nextRows) {
        const name = row.name.trim();
        if (name) next.add(name);
      }
      return next;
    });
  }

  function adoptExternalValue(nextValue: Record<string, EnvBinding>): EnvRow[] {
    const nextRows = rowsFromValue(nextValue);
    setRows(nextRows);
    touchCommittedNames(nextRows);
    return nextRows;
  }

  // Controlled sync: clean external changes replace the editor rows, but dirty
  // local drafts are never clobbered by refetches. A save echo only advances the
  // committed baseline so the focused row keeps its local id.
  useEffect(() => {
    const incomingValueKey = normalizedEnvKey(value);
    if (incomingValueKey === lastPropValueKeyRef.current) {
      return;
    }
    lastPropValueKeyRef.current = incomingValueKey;

    const draftValueKey = normalizedEnvKey(valueFromRows(rowsRef.current));
    const draftIsDirty = draftValueKey !== committedValueKeyRef.current;
    const matchesPendingSave = pendingSaveValueKeyRef.current === incomingValueKey;
    if (matchesPendingSave) {
      pendingSaveValueKeyRef.current = null;
    }

    if (!draftIsDirty) {
      const nextRows = adoptExternalValue(value);
      markCommitted(incomingValueKey, nextRows);
      return;
    }

    if (matchesPendingSave || draftValueKey === incomingValueKey) {
      touchCommittedNames(rowsRef.current);
      markCommitted(incomingValueKey);
    }
  }, [value]);

  const draftValue = useMemo(() => valueFromRows(rows), [rows]);
  const draftValueKey = useMemo(() => normalizedEnvKey(draftValue), [draftValue]);
  const hasUnsavedChanges = draftValueKey !== committedValueKey;

  useEffect(() => {
    onDirtyChange?.(!disabled && hasUnsavedChanges);
  }, [disabled, hasUnsavedChanges, onDirtyChange]);

  // Which variables differ from the committed baseline, so the unsaved-changes
  // banner can say *what* is unsaved instead of a bare label. A rename shows
  // as one addition plus one removal.
  const changeSummary = useMemo(() => {
    const committed = new Map(
      normalizedEnvEntries(valueFromRows(committedRows)).map(([name, binding]) => [
        name,
        JSON.stringify(binding),
      ]),
    );
    const draft = new Map(
      normalizedEnvEntries(draftValue).map(([name, binding]) => [name, JSON.stringify(binding)]),
    );
    const added: string[] = [];
    const changed: string[] = [];
    for (const [name, bindingKey] of draft) {
      if (!committed.has(name)) added.push(name);
      else if (committed.get(name) !== bindingKey) changed.push(name);
    }
    const removed = [...committed.keys()].filter((name) => !draft.has(name));
    return { added, changed, removed };
  }, [committedRows, draftValue]);

  const changeSummaryText = useMemo(() => {
    const parts: string[] = [];
    if (changeSummary.added.length > 0) parts.push(`New: ${formatChangedNames(changeSummary.added)}`);
    if (changeSummary.changed.length > 0) parts.push(`Edited: ${formatChangedNames(changeSummary.changed)}`);
    if (changeSummary.removed.length > 0) parts.push(`Removed: ${formatChangedNames(changeSummary.removed)}`);
    return parts.join(" · ");
  }, [changeSummary]);

  // Warn before the tab unloads with a dirty draft. In-app navigation is not
  // intercepted here.
  useEffect(() => {
    if (disabled || !hasUnsavedChanges) return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [disabled, hasUnsavedChanges]);

  const flushPendingDraft = useCallback(() => {
    if (disabled || !hasUnsavedChanges) return null;
    pendingSaveValueKeyRef.current = draftValueKey;
    flushSync(() => {
      onChange(draftValue);
    });
    return draftValue ?? {};
  }, [disabled, draftValue, draftValueKey, hasUnsavedChanges, onChange]);

  useImperativeHandle(ref, () => ({ flushPendingDraft }), [flushPendingDraft]);

  useEffect(() => {
    const form = editorRootRef.current?.closest("form");
    if (!form) return;

    function handleSubmit() {
      flushPendingDraft();
    }

    form.addEventListener("submit", handleSubmit, true);
    return () => form.removeEventListener("submit", handleSubmit, true);
  }, [flushPendingDraft]);

  useEffect(() => {
    const root = editorRootRef.current;
    if (!root) return;
    const currentRoot = root;

    function handleDocumentClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || currentRoot.contains(target)) return;
      const button = target.closest("button");
      if (!button || button.disabled) return;
      const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`;
      if (button.type === "submit" || /\b(save|create|update|test|import)\b/i.test(label)) {
        flushPendingDraft();
      }
    }

    document.addEventListener("click", handleDocumentClick, true);
    return () => document.removeEventListener("click", handleDocumentClick, true);
  }, [flushPendingDraft]);

  function updateDraft(nextRows: EnvRow[]) {
    setRows(nextRows);
  }

  function patchRow(id: string, patch: Partial<EnvRow>) {
    updateDraft(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    updateDraft(rows.filter((row) => row.id !== id));
  }

  function addRow() {
    const row = emptyRow();
    setRows([...rows, row]);
    setPendingFocus({ rowId: row.id, field: "name" });
  }

  function markTouched(id: string) {
    const rowName = rows.find((row) => row.id === id)?.name.trim();
    if (!rowName) return;
    setTouchedNames((prev) => {
      if (prev.has(rowName)) return prev;
      const next = new Set(prev);
      next.add(rowName);
      return next;
    });
  }

  function bulkImport(text: string, targetRowId: string): boolean {
    const pairs = parseDotenv(text);
    if (pairs.length === 0) return false;
    // Drop the empty row that received the paste, then upsert each pair.
    const working = rows.filter((row) => row.id !== targetRowId).map((row) => ({ ...row }));
    for (const { key, value: pairValue } of pairs) {
      const existing = working.find((row) => row.name.trim() === key);
      if (existing) {
        existing.name = key;
        existing.source = "text";
        existing.textValue = pairValue;
        existing.secretId = "";
        existing.sensitiveDismissed = false;
        existing.userSecretKey = "";
        existing.required = true;
      } else {
        working.push({ ...emptyRow(), name: key, textValue: pairValue });
      }
    }
    updateDraft(working);
    toast.success(`Imported ${pairs.length} variable${pairs.length === 1 ? "" : "s"}`);
    return true;
  }

  function bindRecentSecret(secret: CompanySecret) {
    const next = rows.map((row) => ({ ...row }));
    const trailing = next[next.length - 1];
    let target: EnvRow;
    if (trailing && !trailing.name && !trailing.textValue && !trailing.secretId && !trailing.userSecretKey) {
      target = trailing;
    } else {
      target = emptyRow();
      next.push(target);
    }
    target.source = "secret";
    target.secretId = secret.id;
    target.version = "latest";
    if (!target.name) target.name = envKeyFromSecretName(secret.name);
    updateDraft(next);
  }

  function saveDraft() {
    if (!hasUnsavedChanges) return;
    pendingSaveValueKeyRef.current = draftValueKey;
    onChange(draftValue);
  }

  function revertDraft() {
    pendingSaveValueKeyRef.current = null;
    lastPropValueKeyRef.current = normalizedEnvKey(value);
    const nextRows = adoptExternalValue(value);
    markCommitted(lastPropValueKeyRef.current, nextRows);
  }

  const duplicateNames = useMemo(() => computeDuplicateNames(rows), [rows]);

  const attentionCount = useMemo(
    () =>
      rows.reduce(
        (count, row) =>
          computeRowHealth(row, secrets) || computeUserSecretRowHealth(row, userSecretDefinitions)
            ? count + 1
            : count,
        0,
      ),
    [rows, secrets, userSecretDefinitions],
  );

  const quickBind = useMemo(() => {
    const boundIds = new Set(
      rows.filter((row) => row.source === "secret" && row.secretId).map((row) => row.secretId),
    );
    return (recentlyUsedSecrets ?? [])
      .filter((secret) => secret.status === "active" && !boundIds.has(secret.id))
      .slice(0, 8);
  }, [recentlyUsedSecrets, rows]);

  const hint = footerHint === undefined ? DEFAULT_HINT : footerHint;
  const committedRowsById = useMemo(
    () => new Map(committedRows.map((row) => [row.id, row])),
    [committedRows],
  );

  return (
    <EnvironmentVariablesEditorView
      editorRootRef={editorRootRef}
      attentionCount={attentionCount}
      rows={rows}
      secrets={secrets}
      userSecretDefinitions={userSecretDefinitions}
      recentlyUsedSecrets={recentlyUsedSecrets}
      disabled={disabled}
      reservedPrefixes={reservedPrefixes}
      duplicateNames={duplicateNames}
      touchedNames={touchedNames}
      committedRowsById={committedRowsById}
      pendingFocus={pendingFocus}
      quickBind={quickBind}
      hasUnsavedChanges={hasUnsavedChanges}
      changeSummaryText={changeSummaryText}
      hint={hint}
      onPatchRow={patchRow}
      onRemoveRow={removeRow}
      onMarkTouched={markTouched}
      onBulkImport={bulkImport}
      onAddRow={addRow}
      onCreateSecret={onCreateSecret}
      onToast={(message) => toast.success(message)}
      onFocusConsumed={() => setPendingFocus(null)}
      onBindRecentSecret={bindRecentSecret}
      onRevertDraft={revertDraft}
      onSaveDraft={saveDraft}
    />
  );
});
