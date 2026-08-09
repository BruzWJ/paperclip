import { useState, useEffect, useRef, useCallback, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  validateAdapterConfigSchema,
  type AdapterConfigSchema,
  type ConfigFieldSchema,
  type CreateConfigValues,
} from "@paperclipai/adapter-utils";

import type { AdapterConfigFieldsProps } from "./types";
import type { AdapterInfo, ReadyAdapterInfo } from "../api/adapters";
import { api } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { publicRuntimeMessage } from "../lib/public-runtime-message";
import {
  Field,
  DraftInput,
  DraftNumberInput,
  DraftTextarea,
  ToggleField,
} from "../components/agent-config-primitives";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ChevronDown } from "lucide-react";

// ── Select field (extracted to keep hooks at component top level) ──────
function SelectField({
  value,
  options,
  onChange,
  id,
  label,
  invalid,
  errorId,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  id: string;
  label: string;
  invalid?: boolean;
  errorId?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        className="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const inputClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none placeholder:text-muted-foreground/40 aria-invalid:border-destructive";


// ---------------------------------------------------------------------------
// Combobox: type-to-filter dropdown with free text fallback
// ---------------------------------------------------------------------------

function ComboboxField({
  value,
  options,
  onChange,
  placeholder,
  id,
  label,
  invalid,
  errorId,
}: {
  value: string;
  options: { label: string; value: string; group?: string }[];
  onChange: (val: string) => void;
  placeholder?: string;
  id: string;
  label: string;
  invalid?: boolean;
  errorId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Clear a transient filter when the committed schema value changes.
  useEffect(() => {
    setFilter("");
  }, [value]);

  const filtered = options.filter((opt) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      opt.value.toLowerCase().includes(q) ||
      opt.label.toLowerCase().includes(q) ||
      (opt.group && opt.group.toLowerCase().includes(q))
    );
  });

  const selectedOpt = options.find((o) => o.value === value);
  const displayValue = filter || selectedOpt?.value || value || "";

  // Group filtered options by `group` field if present
  const grouped = new Map<string, typeof filtered>();
  for (const opt of filtered) {
    const g = opt.group ?? "";
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(opt);
  }

  const select = useCallback(
    (val: string) => {
      onChange(val);
      setOpen(false);
      setFilter("");
      inputRef.current?.blur();
    },
    [onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // If exactly one match, select it. Otherwise commit the typed value.
      if (filtered.length === 1) {
        select(filtered[0].value);
      } else if (filter) {
        select(filter);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setFilter("");
    } else if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-0">
        <input
          id={id}
          ref={inputRef}
          type="text"
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={errorId}
          className="flex-1 rounded-l-md border border-r-0 border-border bg-transparent px-2.5 py-1.5 text-sm font-mono placeholder:text-muted-foreground/40 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive"
          value={displayValue}
          placeholder={placeholder ?? "Type or select..."}
          onChange={(e) => {
            setFilter(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            if (!open) setOpen(true);
          }}
          onBlur={() => {
            // Delay close to allow click on option to register
            setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={handleKeyDown}
        />
        <Popover open={open && filtered.length > 0} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Show ${label} options`}
              className="rounded-r-md border border-border px-2 py-1.5 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="p-1 max-h-60 overflow-y-auto"
            style={{ minWidth: 280 }}
            align="start"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {Array.from(grouped.entries()).map(([group, opts]) => (
              <div key={group || "_ungrouped"}>
                {group && (
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {group}
                  </div>
                )}
                {opts.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50 ${
                      opt.value === value ? "bg-accent" : ""
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent input blur
                      select(opt.value);
                    }}
                  >
                    <span className="truncate">{opt.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {filter && filtered.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                Use &quot;{filter}&quot; as custom value (press Enter)
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchemaConfigFields component
// ---------------------------------------------------------------------------

async function fetchConfigSchema(
  adapterType: string,
  signal?: AbortSignal,
): Promise<AdapterConfigSchema> {
  const payload = await api.get<unknown>(
    `/adapters/${encodeURIComponent(adapterType)}/config-schema`,
    { signal },
  );
  const parsedSchema = validateAdapterConfigSchema(payload);
  if (!parsedSchema.success) {
    const { errors: schemaErrors } = parsedSchema;
    throw new Error(
      `Adapter configuration schema response is invalid. ${schemaErrors.join(" ")}`,
    );
  }
  return parsedSchema.data;
}

function schemaFromCatalog(
  catalog: readonly AdapterInfo[] | undefined,
  adapterType: string,
): AdapterConfigSchema | undefined {
  const adapter = catalog?.find(
    (entry): entry is ReadyAdapterInfo =>
      entry.loaded && entry.type === adapterType,
  );
  if (!adapter) return undefined;

  const parsedSchema = validateAdapterConfigSchema(adapter.configSchema);
  return parsedSchema.success ? parsedSchema.data : undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAdapterConfigSchema(
  adapterType: string,
  options: { enabled?: boolean } = {},
): {
  schema: AdapterConfigSchema | null;
  isLoading: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const enabled =
    (options.enabled ?? true)
    && adapterType.trim().length > 0;
  const catalog = queryClient.getQueryData<AdapterInfo[]>(
    queryKeys.adapters.all,
  );
  const catalogSchema = schemaFromCatalog(catalog, adapterType);
  const catalogUpdatedAt = queryClient.getQueryState(
    queryKeys.adapters.all,
  )?.dataUpdatedAt;
  const query = useQuery({
    queryKey: queryKeys.adapters.configSchema(adapterType),
    queryFn: ({ signal }) => fetchConfigSchema(adapterType, signal),
    enabled,
    // The complete ready catalog is the authoritative ACPX snapshot. It
    // primes this query for every selectable adapter and replaces it on each
    // catalog refresh, so revisiting a picker option never causes a second
    // request just because its fields temporarily unmounted.
    initialData: catalogSchema,
    initialDataUpdatedAt: catalogSchema === undefined ? undefined : catalogUpdatedAt,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  return {
    schema: enabled ? query.data ?? null : null,
    isLoading: enabled && query.isPending,
    error:
      enabled && query.error
        ? query.error instanceof Error
          ? publicRuntimeMessage(
              query.error.message,
              "Adapter configuration schema request failed.",
            )
          : "Adapter configuration schema request failed."
        : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultValue(field: ConfigFieldSchema): unknown {
  return field.default;
}

export function fieldMatchesVisibleWhen(
  field: ConfigFieldSchema,
  readValue: (field: ConfigFieldSchema) => unknown,
  schema: AdapterConfigSchema,
): boolean {
  const visibleWhen = field.meta?.visibleWhen;
  if (!visibleWhen || typeof visibleWhen !== "object" || Array.isArray(visibleWhen)) return true;

  const condition = visibleWhen as {
    key?: unknown;
    value?: unknown;
    values?: unknown;
    notValues?: unknown;
  };
  if (typeof condition.key !== "string" || condition.key.length === 0) return true;

  const sourceField = schema.fields.find((candidate) => candidate.key === condition.key);
  if (!sourceField) return true;

  const actual = String(readValue(sourceField) ?? "");
  if (typeof condition.value === "string") return actual === condition.value;
  if (Array.isArray(condition.values)) {
    const values = condition.values.filter((value): value is string => typeof value === "string");
    return values.length > 0 && values.includes(actual);
  }
  if (Array.isArray(condition.notValues)) {
    const values = condition.notValues.filter((value): value is string => typeof value === "string");
    return !values.includes(actual);
  }
  return true;
}

function isMissingRequiredConfigValue(value: unknown): boolean {
  return value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0);
}

export function missingRequiredAdapterConfigFields(
  schema: AdapterConfigSchema | null,
  config: Record<string, unknown>,
): ConfigFieldSchema[] {
  if (!schema) return [];
  const readValue = (field: ConfigFieldSchema) => config[field.key];
  return schema.fields.filter(
    (field) =>
      field.required === true &&
      fieldMatchesVisibleWhen(field, readValue, schema) &&
      isMissingRequiredConfigValue(config[field.key]),
  );
}

export interface AdapterConfigSchemaFieldError {
  field: ConfigFieldSchema;
  message: string;
}

function SchemaFieldError({
  id,
  message,
}: {
  id: string;
  message: string | undefined;
}) {
  if (!message) return null;

  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

function AdapterConfigEmptyState({
  message,
  tone = "status",
}: {
  message: string;
  tone?: "status" | "alert";
}) {
  return (
    <p role={tone} className={tone === "alert" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
      {message}
    </p>
  );
}

/**
 * Mirror the server adapter-schema readiness checks without inventing values.
 * The server remains authoritative at preflight; this only keeps the catalog
 * wizard closed until the exact schema-owned object is locally well-formed.
 */
export function adapterConfigSchemaFieldErrors(
  schema: AdapterConfigSchema | null,
  config: Record<string, unknown>,
): AdapterConfigSchemaFieldError[] {
  if (!schema) return [];
  const readValue = (field: ConfigFieldSchema) => config[field.key];
  const validationIssues: AdapterConfigSchemaFieldError[] = [];
  for (const field of schema.fields) {
    if (!fieldMatchesVisibleWhen(field, readValue, schema)) continue;
    const value = config[field.key];
    if (isMissingRequiredConfigValue(value)) {
      if (field.required === true) {
        validationIssues.push({
          field,
          message: `${field.label} is required.`,
        });
      }
      continue;
    }
    if (
      (
        field.type === "text"
        || field.type === "textarea"
        || field.type === "select"
        || field.type === "combobox"
      )
      && typeof value !== "string"
    ) {
      validationIssues.push({
        field,
        message: `${field.label} must be a string.`,
      });
      continue;
    }
    if (field.type === "toggle" && typeof value !== "boolean") {
      validationIssues.push({
        field,
        message: `${field.label} must be true or false.`,
      });
      continue;
    }
    if (
      field.type === "number"
      && (typeof value !== "number" || !Number.isFinite(value))
    ) {
      validationIssues.push({
        field,
        message: `${field.label} must be a finite number.`,
      });
      continue;
    }
    if (
      field.type === "select"
      && typeof value === "string"
      && Array.isArray(field.options)
      && !field.options.some((option) => option.value === value)
    ) {
      validationIssues.push({
        field,
        message: `${field.label} must use an adapter-owned option.`,
      });
    }
  }
  return validationIssues;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchemaConfigFields({
  adapterType,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  applySchemaDefaults = true,
  resolvedSchema,
}: AdapterConfigFieldsProps & {
  /** Reuse a caller's already resolved server schema as the exact editor contract. */
  resolvedSchema?: AdapterConfigSchema | null;
}) {
  const fieldIdPrefix = useId();
  const {
    schema: fetchedSchema,
    isLoading: isSchemaLoading,
    error: schemaError,
  } = useAdapterConfigSchema(adapterType, { enabled: resolvedSchema === undefined });
  const schema =
    resolvedSchema === undefined ? fetchedSchema : resolvedSchema;

  const [defaultsApplied, setDefaultsApplied] = useState(false);
  useEffect(() => {
    setDefaultsApplied(false);
  }, [adapterType, schema]);

  useEffect(() => {
    if (!schema || !isCreate || defaultsApplied || !applySchemaDefaults) return;
    const defaults: Record<string, unknown> = {};
    for (const field of schema.fields) {
      const def = getDefaultValue(field);
      if (
        def !== undefined
        && def !== ""
        && values?.adapterSchemaValues?.[field.key] === undefined
      ) {
        defaults[field.key] = def;
      }
    }
    if (Object.keys(defaults).length > 0) {
      set?.({
        adapterSchemaValues: { ...defaults, ...values?.adapterSchemaValues },
      });
    }
    setDefaultsApplied(true);
  }, [
    schema,
    isCreate,
    defaultsApplied,
    set,
    values?.adapterSchemaValues,
    applySchemaDefaults,
  ]);

  if (!schema) {
    if (isSchemaLoading) {
      return <AdapterConfigEmptyState message="Loading adapter configuration fields…" />;
    }

    return (
      <AdapterConfigEmptyState
        tone="alert"
        message={schemaError ?? "No adapter configuration fields are available for this adapter."}
      />
    );
  }

  if (schema.fields.length === 0) {
    return <AdapterConfigEmptyState message="No additional configuration fields are available for this adapter." />;
  }

  function readValue(field: ConfigFieldSchema): unknown {
    if (isCreate) {
      return values?.adapterSchemaValues?.[field.key]
        ?? (applySchemaDefaults ? getDefaultValue(field) : undefined);
    }
    const stored = config[field.key];
    return eff("adapterConfig", field.key, (stored ?? getDefaultValue(field)) as string);
  }

  function writeValue(field: ConfigFieldSchema, value: unknown): void {
    if (isCreate) {
      set?.({
        adapterSchemaValues: {
          ...values?.adapterSchemaValues,
          [field.key]: value,
        },
      });
    } else {
      mark("adapterConfig", field.key, value);
    }
  }

  const errorsByFieldKey = new Map(
    adapterConfigSchemaFieldErrors(
      schema,
      Object.fromEntries(schema.fields.map((field) => [field.key, readValue(field)])),
    ).map(({ field, message }) => [field.key, message]),
  );

  return (
    <>
      <p className="sr-only" role="status">
        {errorsByFieldKey.size > 0 ? "Adapter configuration needs attention." : ""}
      </p>
      {schema.fields
        .filter((field) => fieldMatchesVisibleWhen(field, readValue, schema))
        .map((field) => {
          const fieldId = `${fieldIdPrefix}-${field.key}`;
          const errorId = `${fieldId}-error`;
          const errorMessage = errorsByFieldKey.get(field.key);

          switch (field.type) {
            case "select": {
              const currentVal = String(readValue(field) ?? "");
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <div className="space-y-1">
                    <SelectField
                      id={fieldId}
                      label={field.label}
                      value={currentVal}
                      options={[...(field.options ?? [])]}
                      invalid={Boolean(errorMessage)}
                      errorId={errorMessage ? errorId : undefined}
                      onChange={(v) => writeValue(field, v)}
                    />
                    <SchemaFieldError id={errorId} message={errorMessage} />
                  </div>
                </Field>
              );
            }

            case "toggle":
              return (
                <div
                  key={field.key}
                  role="group"
                  aria-label={field.label}
                  aria-describedby={errorMessage ? errorId : undefined}
                  className="space-y-1"
                >
                  <ToggleField
                    label={field.label}
                    hint={field.hint}
                    checked={readValue(field) === true}
                    onChange={(v) => writeValue(field, v)}
                  />
                  <SchemaFieldError id={errorId} message={errorMessage} />
                </div>
              );

            case "number":
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <div className="space-y-1">
                    <DraftNumberInput
                      id={fieldId}
                      aria-label={field.label}
                      aria-invalid={Boolean(errorMessage) || undefined}
                      aria-describedby={errorMessage ? errorId : undefined}
                      value={Number(readValue(field) ?? 0)}
                      onCommit={(v) => writeValue(field, v)}
                      immediate
                      className={inputClass}
                    />
                    <SchemaFieldError id={errorId} message={errorMessage} />
                  </div>
                </Field>
              );

            case "textarea":
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <div
                    role="group"
                    aria-label={field.label}
                    aria-describedby={errorMessage ? errorId : undefined}
                    className="space-y-1"
                  >
                    <DraftTextarea
                      value={String(readValue(field) ?? "")}
                      onCommit={(v) => writeValue(field, v || undefined)}
                      immediate
                    />
                    <SchemaFieldError id={errorId} message={errorMessage} />
                  </div>
                </Field>
              );

            case "combobox": {
              const currentVal = String(readValue(field) ?? "");
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <div className="space-y-1">
                    <ComboboxField
                      id={fieldId}
                      label={field.label}
                      value={currentVal}
                      options={[...(field.options ?? [])]}
                      invalid={Boolean(errorMessage)}
                      errorId={errorMessage ? errorId : undefined}
                      onChange={(v) => writeValue(field, v || undefined)}
                      placeholder={field.hint}
                    />
                    <SchemaFieldError id={errorId} message={errorMessage} />
                  </div>
                </Field>
              );
            }

            case "text":
            default:
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <div className="space-y-1">
                    <DraftInput
                      id={fieldId}
                      aria-label={field.label}
                      aria-invalid={Boolean(errorMessage) || undefined}
                      aria-describedby={errorMessage ? errorId : undefined}
                      value={String(readValue(field) ?? "")}
                      onCommit={(v) => writeValue(field, v || undefined)}
                      immediate
                      className={inputClass}
                    />
                    <SchemaFieldError id={errorId} message={errorMessage} />
                  </div>
                </Field>
              );
          }
        })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Build adapter config from the server-admitted ACP schema values.
// ---------------------------------------------------------------------------

export function buildSchemaAdapterConfig(
  values: CreateConfigValues,
): Record<string, unknown> {
  return { ...(values.adapterSchemaValues ?? {}) };
}
