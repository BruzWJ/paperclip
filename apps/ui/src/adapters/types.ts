import type { ComponentType } from "react";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export type { CreateConfigValues } from "@paperclipai/adapter-utils";

export interface AdapterConfigFieldsProps {
  mode: "create" | "edit";
  isCreate: boolean;
  adapterType: string;
  /** Create mode: raw form values */
  values: CreateConfigValues | null;
  /** Create mode: setter for form values */
  set: ((patch: Partial<CreateConfigValues>) => void) | null;
  /** Edit mode: values derived from the immutable current ACPX revision. */
  config: Record<string, string | boolean>;
  /** Edit mode: read effective value */
  eff: <T>(group: "adapterConfig", field: string, original: T) => T;
  /** Edit mode: mark field dirty */
  mark: (group: "adapterConfig", field: string, value: unknown) => void;
  /** Whether ACPX-observed current values are copied into the draft. */
  applySchemaDefaults?: boolean;
}

export interface UIAdapterModule {
  type: string;
  label: string;
  ConfigFields: ComponentType<AdapterConfigFieldsProps>;
  buildAdapterConfig: (values: CreateConfigValues) => Record<string, string | boolean>;
}
