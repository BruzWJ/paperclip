import { useState, useEffect, useRef, useCallback } from "react";

import {
  validateAdapterConfigSchema,
  type AdapterConfigSchema,
  type ConfigFieldSchema,
  type CreateConfigValues,
} from "@paperclipai/adapter-utils";

import type { AdapterConfigFieldsProps } from "./types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
  DraftTextarea,
  ToggleField,
} from "../components/agent-config-primitives";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { ChevronDown } from "lucide-react";

// ── Select field (extracted to keep hooks at component top level) ──────
function SelectField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedOpt = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className={!value ? "text-muted-foreground" : ""}>
            {selectedOpt?.label ?? value ?? "Select..."}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50 ${opt.value === value ? "bg-accent" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onChange(opt.value);
              setOpen(false);
            }}
          >
            <span>{opt.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";


// ---------------------------------------------------------------------------
// Combobox: type-to-filter dropdown with free text fallback
// ---------------------------------------------------------------------------

function ComboboxField({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: { label: string; value: string; group?: string }[];
  onChange: (val: string) => void;
  placeholder?: string;
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
          ref={inputRef}
          type="text"
          className="flex-1 rounded-l-md border border-r-0 border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 focus:z-10"
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
            <button className="rounded-r-md border border-border px-2 py-1.5 hover:bg-accent/50 transition-colors">
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

const schemaCache = new Map<string, AdapterConfigSchema | null>();
const schemaFetchInflight = new Map<string, Promise<AdapterConfigSchema | null>>();
const failedSchemaTypes = new Map<string, string>();

async function fetchConfigSchema(adapterType: string): Promise<AdapterConfigSchema | null> {
  const cached = schemaCache.get(adapterType);
  if (cached !== undefined) return cached;
  if (failedSchemaTypes.has(adapterType)) return null;

  const inflight = schemaFetchInflight.get(adapterType);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const res = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/config-schema`);
      if (!res.ok) {
        failedSchemaTypes.set(
          adapterType,
          `Adapter configuration schema is unavailable (${res.status}).`,
        );
        return null;
      }
      const payload: unknown = await res.json();
      const parsedSchema = validateAdapterConfigSchema(payload);
      if (!parsedSchema.success) {
        failedSchemaTypes.set(
          adapterType,
          `Adapter configuration schema response is invalid. ${parsedSchema.errors.join(" ")}`,
        );
        return null;
      }
      const schema = parsedSchema.data;
      schemaCache.set(adapterType, schema);
      return schema;
    } catch (error) {
      failedSchemaTypes.set(
        adapterType,
        error instanceof Error
          ? error.message
          : "Adapter configuration schema request failed.",
      );
      return null;
    } finally {
      schemaFetchInflight.delete(adapterType);
    }
  })();

  schemaFetchInflight.set(adapterType, promise);
  return promise;
}

export function invalidateConfigSchemaCache(adapterType: string): void {
  schemaCache.delete(adapterType);
  failedSchemaTypes.delete(adapterType);
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
  const enabled =
    (options.enabled ?? true)
    && adapterType.trim().length > 0;
  const cached = schemaCache.get(adapterType);
  const [schema, setSchema] = useState<AdapterConfigSchema | null>(
    enabled ? cached ?? null : null,
  );
  const [isLoading, setIsLoading] = useState(
    enabled
    && cached === undefined
    && !failedSchemaTypes.has(adapterType),
  );
  const [error, setError] = useState<string | null>(
    enabled ? failedSchemaTypes.get(adapterType) ?? null : null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setSchema(null);
      setIsLoading(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    const nextCached = schemaCache.get(adapterType);
    setSchema(nextCached ?? null);
    setIsLoading(
      nextCached === undefined && !failedSchemaTypes.has(adapterType),
    );
    setError(failedSchemaTypes.get(adapterType) ?? null);
    fetchConfigSchema(adapterType).then((s) => {
      if (!cancelled) {
        setSchema(s);
        setIsLoading(false);
        setError(failedSchemaTypes.get(adapterType) ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adapterType, enabled]);

  return { schema, isLoading, error };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultValue(field: ConfigFieldSchema): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "toggle":
      return false;
    case "number":
      return 0;
    case "text":
    case "textarea":
      return "";
    case "select":
      return field.options?.[0]?.value ?? "";
  }
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
  const errors: AdapterConfigSchemaFieldError[] = [];
  for (const field of schema.fields) {
    if (!fieldMatchesVisibleWhen(field, readValue, schema)) continue;
    const value = config[field.key];
    if (isMissingRequiredConfigValue(value)) {
      if (field.required === true) {
        errors.push({
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
      errors.push({
        field,
        message: `${field.label} must be a string.`,
      });
      continue;
    }
    if (field.type === "toggle" && typeof value !== "boolean") {
      errors.push({
        field,
        message: `${field.label} must be true or false.`,
      });
      continue;
    }
    if (
      field.type === "number"
      && (typeof value !== "number" || !Number.isFinite(value))
    ) {
      errors.push({
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
      errors.push({
        field,
        message: `${field.label} must use an adapter-owned option.`,
      });
    }
  }
  return errors;
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
  const { schema: fetchedSchema } = useAdapterConfigSchema(adapterType);
  const schema =
    resolvedSchema === undefined ? fetchedSchema : resolvedSchema;

  const [defaultsApplied, setDefaultsApplied] = useState(false);
  useEffect(() => {
    if (!schema || !isCreate || defaultsApplied || !applySchemaDefaults) return;
    const defaults: Record<string, unknown> = {};
    for (const field of schema.fields) {
      const def = getDefaultValue(field);
      if (def !== undefined && def !== "") {
        defaults[field.key] = def;
      }
    }
    if (Object.keys(defaults).length > 0) {
      set?.({
        adapterSchemaValues: { ...values?.adapterSchemaValues, ...defaults },
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

  if (!schema || schema.fields.length === 0) return null;

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

  return (
    <>
      {schema.fields
        .filter((field) => fieldMatchesVisibleWhen(field, readValue, schema))
        .map((field) => {
          switch (field.type) {
            case "select": {
              const currentVal = String(readValue(field) ?? "");
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <SelectField
                    value={currentVal}
                    options={[...(field.options ?? [])]}
                    onChange={(v) => writeValue(field, v)}
                  />
                </Field>
              );
            }

            case "toggle":
              return (
                <ToggleField
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  checked={readValue(field) === true}
                  onChange={(v) => writeValue(field, v)}
                />
              );

            case "number":
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <DraftNumberInput
                    value={Number(readValue(field) ?? 0)}
                    onCommit={(v) => writeValue(field, v)}
                    immediate
                    className={inputClass}
                  />
                </Field>
              );

            case "textarea":
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <DraftTextarea
                    value={String(readValue(field) ?? "")}
                    onCommit={(v) => writeValue(field, v || undefined)}
                    immediate
                  />
                </Field>
              );

            case "combobox": {
              const currentVal = String(readValue(field) ?? "");
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <ComboboxField
                    value={currentVal}
                    options={[...(field.options ?? [])]}
                    onChange={(v) => writeValue(field, v || undefined)}
                    placeholder={field.hint}
                  />
                </Field>
              );
            }

            case "text":
            default:
              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <DraftInput
                    value={String(readValue(field) ?? "")}
                    onCommit={(v) => writeValue(field, v || undefined)}
                    immediate
                    className={inputClass}
                  />
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
