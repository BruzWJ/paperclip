import type { ComponentType } from "react";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { EnvironmentDriver } from "@paperclipai/shared";

export type { CreateConfigValues } from "@paperclipai/adapter-utils";

export interface AdapterConfigFieldsProps {
  mode: "create" | "edit";
  isCreate: boolean;
  adapterType: string;
  /** Create mode: raw form values */
  values: CreateConfigValues | null;
  /** Create mode: setter for form values */
  set: ((patch: Partial<CreateConfigValues>) => void) | null;
  /** Edit mode: original adapterConfig from agent */
  config: Record<string, unknown>;
  /** Edit mode: read effective value */
  eff: <T>(group: "adapterConfig", field: string, original: T) => T;
  /** Edit mode: mark field dirty */
  mark: (group: "adapterConfig", field: string, value: unknown) => void;
  /** Create mode may suppress schema defaults when every value must be explicit. */
  applySchemaDefaults?: boolean;
}

export interface UIAdapterModule {
  type: string;
  label: string;
  /** Exact driver membership supplied by the current server agent catalog. */
  drivers: readonly EnvironmentDriver[];
  ConfigFields: ComponentType<AdapterConfigFieldsProps>;
  buildAdapterConfig: (values: CreateConfigValues) => Record<string, unknown>;
}
