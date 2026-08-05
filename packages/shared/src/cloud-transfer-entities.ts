import type {
  CompanyPortabilityExportResult,
  CompanyPortabilityFileEntry,
} from "./types/company-portability.js";

export interface SourceEntityKey {
  sourceInstanceId: string;
  sourceCompanyId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceNaturalKey?: string;
}

export interface UpstreamTransferWarning {
  code: string;
  severity: "info" | "warning" | "blocker";
  message: string;
  entity?: SourceEntityKey;
}

export interface LocalUpstreamExportEntityInput {
  key: SourceEntityKey;
  body: Record<string, unknown>;
  dependencies?: SourceEntityKey[];
  warnings?: UpstreamTransferWarning[];
  conflictKeys?: string[];
}

/**
 * Maps a company portability export onto local-upstream transfer entities.
 *
 * `hashFileId` produces the stable `sourceEntityId` for each portable file.
 * It is caller-supplied because the server and CLI historically derive ids
 * with different digest lengths; unifying it here would silently change
 * previously pushed entity identities on one side.
 */
export function buildEntitiesFromPortableExport(
  localCompanyId: string,
  sourceInstanceId: string,
  exported: CompanyPortabilityExportResult,
  hashFileId: (value: string) => string,
): LocalUpstreamExportEntityInput[] {
  const companyKey: SourceEntityKey = {
    sourceInstanceId,
    sourceCompanyId: localCompanyId,
    sourceEntityType: "company",
    sourceEntityId: localCompanyId,
    sourceNaturalKey: exported.manifest.company?.name ?? localCompanyId,
  };
  const entities: LocalUpstreamExportEntityInput[] = [
    {
      key: companyKey,
      body: {
        kind: "paperclip_company_portability_manifest",
        manifest: exported.manifest,
        rootPath: exported.rootPath,
        paperclipExtensionPath: exported.paperclipExtensionPath,
        fileCount: Object.keys(exported.files).length,
      },
      conflictKeys: [`company:${companyKey.sourceNaturalKey ?? localCompanyId}`],
    },
  ];

  for (const [filePath, entry] of Object.entries(exported.files).sort(([left], [right]) => left.localeCompare(right))) {
    entities.push({
      key: {
        sourceInstanceId,
        sourceCompanyId: localCompanyId,
        sourceEntityType: "company_setting",
        sourceEntityId: hashFileId(filePath),
        sourceNaturalKey: filePath,
      },
      body: {
        kind: "paperclip_portable_file",
        path: filePath,
        entry: normalizePortableFileEntry(entry),
      },
      dependencies: [companyKey],
      conflictKeys: [`portable_file:${filePath}`],
    });
  }
  return entities;
}

function normalizePortableFileEntry(entry: CompanyPortabilityFileEntry): Record<string, unknown> {
  if (typeof entry === "string") {
    return { encoding: "utf8", data: entry };
  }
  return { ...entry };
}
