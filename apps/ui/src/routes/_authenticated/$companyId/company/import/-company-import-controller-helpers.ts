import { getUIAdapter } from "@/adapters";
import type { AdapterPickerItem } from "@/routes/_authenticated/$companyId/company/import/-CompanyImportControls";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type {
  CompanyPortabilityAdapterOverride,
  CompanyPortabilityFileEntry,
  CompanyPortabilityPreviewResult,
  CompanyPortabilitySource,
} from "@paperclipai/shared";

export type LocalCompanyImportPackage = {
  name: string;
  rootPath: string | null;
  files: Record<string, CompanyPortabilityFileEntry>;
};

export function buildCompanyImportSource(input: {
  sourceMode: "github" | "local";
  importUrl: string;
  localPackage: LocalCompanyImportPackage | null;
}): CompanyPortabilitySource | null {
  if (input.sourceMode === "local") {
    if (!input.localPackage) return null;
    return {
      type: "inline",
      rootPath: input.localPackage.rootPath,
      files: input.localPackage.files,
    };
  }
  return input.importUrl.length === 0 ? null : { type: "github", url: input.importUrl };
}

export function buildCompanyImportNameOverrides(
  preview: CompanyPortabilityPreviewResult | null,
  nameOverrides: Record<string, string>,
): Record<string, string> | undefined {
  if (!preview) return undefined;
  const overrides = Object.fromEntries(
    Object.entries(nameOverrides)
      .map(([slug, name]) => [slug, name.trim()] as const)
      .filter(([, name]) => name.length > 0),
  );
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function buildCompanyImportSelectedFiles(checkedFiles: ReadonlySet<string>): string[] | undefined {
  const selected = Array.from(checkedFiles).sort();
  return selected.length > 0 ? selected : undefined;
}

export function buildCompanyImportAdapterOverrides(input: {
  adapterAgents: AdapterPickerItem[];
  adapterOverrides: Record<string, string>;
  adapterConfigValues: Record<string, CreateConfigValues>;
}): Record<string, CompanyPortabilityAdapterOverride> | undefined {
  const overrides: Record<string, CompanyPortabilityAdapterOverride> = {};
  for (const agent of input.adapterAgents) {
    const adapterType = input.adapterOverrides[agent.slug];
    if (!adapterType) continue;
    const configValues = input.adapterConfigValues[agent.slug];
    overrides[agent.slug] = {
      adapterType,
      adapterConfig: configValues ? getUIAdapter(adapterType).buildAdapterConfig(configValues) : {},
    };
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
