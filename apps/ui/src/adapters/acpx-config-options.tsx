import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type AcpAdapterConfigOption,
  type CreateConfigValues,
} from "@paperclipai/adapter-utils";
import type { AdapterConfigFieldsProps } from "./types";
import type { AdapterInfo, ReadyAdapterInfo } from "../api/adapters";
import { queryKeys } from "../lib/queryKeys";
import { publicRuntimeMessage } from "../lib/public-runtime-message";
import { fetchAdapterCatalog } from "./use-adapter-catalog";
import { Field, DraftInput, ToggleField } from "../components/agent-config-primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const inputClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none placeholder:text-muted-foreground/40 aria-invalid:border-destructive";

function optionsFromCatalog(
  catalog: readonly AdapterInfo[] | undefined,
  adapterType: string,
): readonly AcpAdapterConfigOption[] | undefined {
  const adapter = catalog?.find(
    (entry): entry is ReadyAdapterInfo =>
      entry.loaded && entry.type === adapterType,
  );
  return adapter?.configOptions;
}

export function useAdapterConfigOptions(
  adapterType: string,
  options: { enabled?: boolean } = {},
): {
  configOptions: readonly AcpAdapterConfigOption[] | null;
  isLoading: boolean;
  error: string | null;
} {
  const enabled = (options.enabled ?? true) && adapterType.length > 0;
  const query = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: fetchAdapterCatalog,
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  return {
    configOptions: enabled
      ? optionsFromCatalog(query.data, adapterType) ?? null
      : null,
    isLoading: enabled && query.isPending,
    error:
      enabled && query.error
        ? query.error instanceof Error
          ? publicRuntimeMessage(
              query.error.message,
              "ACPX configuration options request failed.",
            )
          : "ACPX configuration options request failed."
        : null,
  };
}

function initialValue(option: AcpAdapterConfigOption): string | boolean | undefined {
  return option.currentValue;
}

export interface AdapterConfigOptionError {
  option: AcpAdapterConfigOption;
  message: string;
}

export function adapterConfigOptionErrors(
  options: readonly AcpAdapterConfigOption[] | null,
  config: Readonly<Record<string, unknown>>,
): AdapterConfigOptionError[] {
  if (!options) return [];
  const expectedIds = new Set(options.map((option) => option.id));
  const unknown = Object.keys(config).find((key) => !expectedIds.has(key));
  if (unknown) {
    return [{
      option: options[0]!,
      message: `Unknown ACPX configuration option "${unknown}".`,
    }];
  }
  const errors: AdapterConfigOptionError[] = [];
  for (const option of options) {
    const value = config[option.id];
    if (option.type === "toggle") {
      if (typeof value !== "boolean") {
        errors.push({ option, message: `${option.label} must be enabled or disabled.` });
      }
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      errors.push({ option, message: `${option.label} requires an exact value.` });
      continue;
    }
    if (
      option.type === "select" &&
      !option.values.some((entry) => entry.value === value)
    ) {
      errors.push({ option, message: `${option.label} must use an advertised value.` });
    }
  }
  return errors;
}

function OptionError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

export function AcpxConfigOptions({
  adapterType,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  applySchemaDefaults = true,
  resolvedOptions,
}: AdapterConfigFieldsProps & {
  resolvedOptions?: readonly AcpAdapterConfigOption[] | null;
}) {
  const idPrefix = useId();
  const {
    configOptions: fetchedOptions,
    isLoading,
    error,
  } = useAdapterConfigOptions(adapterType, {
    enabled: resolvedOptions === undefined,
  });
  const options = resolvedOptions === undefined ? fetchedOptions : resolvedOptions;
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  useEffect(() => setDefaultsApplied(false), [adapterType, options]);
  useEffect(() => {
    if (
      !options ||
      !isCreate ||
      defaultsApplied ||
      !applySchemaDefaults
    ) return;
    const defaults = Object.fromEntries(
      options.flatMap((option) => {
        const value = initialValue(option);
        return value === undefined || values?.adapterSchemaValues?.[option.id] !== undefined
          ? []
          : [[option.id, value]];
      }),
    );
    if (Object.keys(defaults).length > 0) {
      set?.({
        adapterSchemaValues: {
          ...defaults,
          ...values?.adapterSchemaValues,
        },
      });
    }
    setDefaultsApplied(true);
  }, [
    applySchemaDefaults,
    defaultsApplied,
    isCreate,
    options,
    set,
    values?.adapterSchemaValues,
  ]);

  if (!options) {
    return (
      <p
        role={error ? "alert" : "status"}
        className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      >
        {isLoading
          ? "Loading ACPX configuration options…"
          : error ?? "ACPX configuration options are unavailable."}
      </p>
    );
  }
  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This local agent advertises no configurable session options.
      </p>
    );
  }

  function readValue(option: AcpAdapterConfigOption): unknown {
    if (isCreate) {
      return values?.adapterSchemaValues?.[option.id];
    }
    return eff("adapterConfig", option.id, config[option.id]);
  }

  function writeValue(option: AcpAdapterConfigOption, value: string | boolean) {
    if (isCreate) {
      set?.({
        adapterSchemaValues: {
          ...values?.adapterSchemaValues,
          [option.id]: value,
        },
      });
    } else {
      mark("adapterConfig", option.id, value);
    }
  }

  const current = Object.fromEntries(
    options.map((option) => [option.id, readValue(option)]),
  );
  const errors = new Map(
    adapterConfigOptionErrors(options, current).map(({ option, message }) => [
      option.id,
      message,
    ]),
  );

  return (
    <>
      {options.map((option) => {
        const fieldId = `${idPrefix}-${option.id}`;
        const errorId = `${fieldId}-error`;
        const message = errors.get(option.id);
        if (option.type === "toggle") {
          return (
            <div key={option.id} className="space-y-1">
              <ToggleField
                label={option.label}
                hint={option.description}
                checked={readValue(option) === true}
                onChange={(value) => writeValue(option, value)}
              />
              <OptionError id={errorId} message={message} />
            </div>
          );
        }
        if (option.type === "select") {
          return (
            <Field key={option.id} label={option.label} hint={option.description}>
              <div className="space-y-1">
                <Select
                  value={typeof readValue(option) === "string" ? String(readValue(option)) : ""}
                  onValueChange={(value) => writeValue(option, value)}
                >
                  <SelectTrigger
                    id={fieldId}
                    aria-label={option.label}
                    aria-invalid={Boolean(message) || undefined}
                    aria-describedby={message ? errorId : undefined}
                    className="w-full"
                  >
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {option.values.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <OptionError id={errorId} message={message} />
              </div>
            </Field>
          );
        }
        return (
          <Field key={option.id} label={option.label} hint={option.description}>
            <div className="space-y-1">
              <DraftInput
                id={fieldId}
                aria-label={option.label}
                aria-invalid={Boolean(message) || undefined}
                aria-describedby={message ? errorId : undefined}
                value={typeof readValue(option) === "string" ? String(readValue(option)) : ""}
                onCommit={(value) => writeValue(option, value)}
                immediate
                className={inputClass}
              />
              <OptionError id={errorId} message={message} />
            </div>
          </Field>
        );
      })}
    </>
  );
}

export function buildAcpxAdapterConfig(
  values: CreateConfigValues,
): Record<string, string | boolean> {
  return { ...(values.adapterSchemaValues ?? {}) };
}
