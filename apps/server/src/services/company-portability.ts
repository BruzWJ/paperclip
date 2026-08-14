import { type Db, agentAdapterConfigRevisions } from "@paperclipai/db";
import * as shared from "@paperclipai/shared";
import { and, eq, inArray } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import { renderOrgChartPng } from "../routes/org-chart-svg.js";
import type { SecretsRuntimeConfig } from "../secrets/types.js";
import type { StorageService } from "../storage/types.js";
import { accessService } from "./access.js";
import { createAgentAdapterConfigurationService } from "./agent-adapter-config-revisions.js";
import { createAgentOperationalConfigurationService } from "./agent-operational-configuration.js";
import { agentService } from "./agents.js";
import { assetService } from "./assets.js";
import { companyService } from "./companies.js";
import { generateReadme } from "./company-export-readme.js";
import { runExportBundlePhase1 } from "./company-portability-export-phase-1.js";
import { runExportBundlePhase3 } from "./company-portability-export-phase-3.js";
import { materializePortableBooleanMap } from "./company-portability-extension-parser.js";
import type { CompanyPortabilityHelpers } from "./company-portability-helpers.js";
import { buildCompanyPortabilityHelpers } from "./company-portability-helpers.js";
import { importBundle } from "./company-portability-import.js";
import { buildManifestFromPackageFiles } from "./company-portability-manifest-parser.js";
import * as portabilityManifest from "./company-portability-manifest-types.js";
import { buildPreview } from "./company-portability-preview.js";
import * as portabilitySelection from "./company-portability-selection.js";
import {
  buildMarkdown,
  buildYamlFile,
  dedupeEnvInputs,
  isPlainRecord,
} from "./company-portability-format-support.js";
import type { OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import { projectService } from "./projects.js";
import { createRuntimeAgentConfigurationService } from "./runtime-agent-configuration.js";
import { secretService } from "./secrets.js";

export type CompanyPortabilityOperationScope = CompanyPortabilityContext &
  CompanyPortabilityHelpers & {
    [key: string]: any;
  };

export function createCompanyPortabilityContext(
  db: Db,
  storage: StorageService | undefined,
  ordinaryTasks: OrdinaryTaskRuntime,
  secretsRuntime: SecretsRuntimeConfig,
) {
  const companies = companyService(db);
  const agents = agentService(db);
  const assetRecords = assetService(db);
  const access = accessService(db);
  const projects = projectService(db);
  const secrets = secretService(db, secretsRuntime);
  const runtimeAgentConfigurations = createRuntimeAgentConfigurationService(db);
  const adapterConfigurations = createAgentAdapterConfigurationService(db);
  const operationalConfigurations = createAgentOperationalConfigurationService(db);
  const strictSecretsMode = secretsRuntime.strictMode;
  const defaultSecretProvider = secretsRuntime.defaultProvider;
  return {
    db,
    storage,
    ordinaryTasks,
    secretsRuntime,
    companies,
    agents,
    assetRecords,
    access,
    projects,
    secrets,
    runtimeAgentConfigurations,
    adapterConfigurations,
    operationalConfigurations,
    strictSecretsMode,
    defaultSecretProvider,
  };
}

export type CompanyPortabilityContext = ReturnType<typeof createCompanyPortabilityContext>;

export async function runExportBundlePhase2(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { db, storage, agents, assetRecords, runtimeAgentConfigurations, companyId } = scope;
  state.companyPath = "COMPANY.md";

  state.files[state.companyPath] = buildMarkdown(
    {
      name: state.company.name,
      description: state.company.description ?? null,
      schema: "agentcompanies/v1",
      slug: state.rootPath,
    },
    "",
  );

  if (state.include.company && state.company.logoAssetId) {
    if (!storage) {
      state.warnings.push("Skipped company logo from export because storage is unavailable.");
    } else {
      const logoAsset = await assetRecords.getById(state.company.logoAssetId);
      if (!logoAsset) {
        state.warnings.push(
          `Skipped company logo ${state.company.logoAssetId} because the asset record was not found.`,
        );
      } else {
        try {
          const object = await storage.getObject(state.company.id, logoAsset.objectKey);
          const body = await portabilitySelection.streamToBuffer(object.stream);
          state.companyLogoPath = `images/${portabilityManifest.COMPANY_LOGO_FILE_NAME}${portabilitySelection.resolveCompanyLogoExtension(logoAsset.contentType, logoAsset.originalFilename)}`;
          state.files[state.companyLogoPath] = portabilitySelection.bufferToPortableBinaryFile(
            body,
            logoAsset.contentType,
          );
        } catch (err) {
          state.warnings.push(
            `Failed to export company logo ${state.company.logoAssetId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  state.paperclipAgentsOut = {};

  state.paperclipProjectsOut = {};

  state.paperclipTasksOut = {};

  state.paperclipRoutinesOut = {};

  state.runtimeConfigurationByAgentId = new Map(
    await Promise.all(
      state.agentRows.map(
        async (agent: any) =>
          [
            agent.id,
            await runtimeAgentConfigurations.get({
              companyId,
              targetAgentId: agent.id,
            }),
          ] as const,
      ),
    ),
  );

  state.currentAdapterRevisionIds = state.agentRows.flatMap((agent: any) =>
    agent.currentAdapterConfigRevisionId ? [agent.currentAdapterConfigRevisionId] : [],
  );

  state.currentAdapterRevisionRows =
    state.currentAdapterRevisionIds.length === 0
      ? []
      : await db
          .select()
          .from(agentAdapterConfigRevisions)
          .where(
            and(
              eq(agentAdapterConfigRevisions.companyId, companyId),
              inArray(agentAdapterConfigRevisions.id, state.currentAdapterRevisionIds),
            ),
          );

  state.currentAdapterRevisionByAgentId = new Map(
    state.currentAdapterRevisionRows.map((revision: any) => [revision.agentId, revision]),
  );

  if (state.include.agents) {
    for (const agent of state.agentRows) {
      const slug = state.idToSlug.get(agent.id)!;
      const currentAdapterRevision = state.currentAdapterRevisionByAgentId.get(agent.id) ?? null;
      if (
        !agent.currentAdapterConfigRevisionId ||
        !currentAdapterRevision ||
        currentAdapterRevision.id !== agent.currentAdapterConfigRevisionId
      ) {
        throw unprocessable(
          `Agent ${slug} has no complete canonical adapter revision and cannot be exported.`,
        );
      }
      const runtimeConfiguration = state.runtimeConfigurationByAgentId.get(agent.id);
      if (!runtimeConfiguration) {
        throw unprocessable(`Agent ${slug} has no canonical runtime configuration and cannot be exported.`);
      }
      const portablePermissionGrants = state.permissionGrantsByAgentId.get(agent.id) ?? [];
      const reportsToSlug = agent.reportsTo ? (state.idToSlug.get(agent.reportsTo) ?? null) : null;
      state.files[`agents/${slug}/AGENTS.md`] = buildMarkdown(
        {
          kind: "agent",
          slug,
          name: agent.name,
          title: agent.title ?? null,
          reportsTo: reportsToSlug,
        },
        "",
      );
      const optionalExtension = portabilitySelection.stripEmptyValues({
        icon: agent.icon ?? null,
        capabilities: agent.capabilities ?? null,
        permissionGrants: portablePermissionGrants.length > 0 ? portablePermissionGrants : undefined,
        budgetMonthlyAmount: agent.budgetMonthlyAmount,
      });
      const extension: Record<string, unknown> = {
        ...(isPlainRecord(optionalExtension) ? optionalExtension : {}),
        capabilities: agent.capabilities ?? null,
        adapterRevision: {
          sourceRevisionId: agent.currentAdapterConfigRevisionId,
          acpConfiguration: currentAdapterRevision.acpConfiguration,
        },
        contextGrants: materializePortableBooleanMap(
          shared.AGENT_CONTEXT_GRANT_KEYS,
          runtimeConfiguration.contextGrants,
        ),
        actionGrants: materializePortableBooleanMap(
          shared.PAPERCLIP_ACTION_KEYS,
          runtimeConfiguration.actionGrants,
        ),
        mentionReachGrants: materializePortableBooleanMap(
          shared.AGENT_MENTION_REACH_GRANT_KEYS,
          runtimeConfiguration.mentionReachGrants,
        ),
      };
      state.paperclipAgentsOut[slug] = isPlainRecord(extension) ? extension : {};
    }
  }
}

export async function runExportBundlePhase4(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { agents, projects, companyId, input } = scope;
  state.paperclipExtensionPath = ".paperclip.yaml";

  state.paperclipAgents = Object.fromEntries(
    Object.entries(state.paperclipAgentsOut).filter(
      ([, value]) => isPlainRecord(value) && Object.keys(value).length > 0,
    ),
  );

  state.paperclipProjects = Object.fromEntries(
    Object.entries(state.paperclipProjectsOut).filter(
      ([, value]) => isPlainRecord(value) && Object.keys(value).length > 0,
    ),
  );

  state.paperclipTasks = Object.fromEntries(
    Object.entries(state.paperclipTasksOut).filter(
      ([, value]) => isPlainRecord(value) && Object.keys(value).length > 0,
    ),
  );

  state.paperclipRoutines = Object.fromEntries(
    Object.entries(state.paperclipRoutinesOut).filter(
      ([, value]) => isPlainRecord(value) && Object.keys(value).length > 0,
    ),
  );

  state.files[state.paperclipExtensionPath] = buildYamlFile(
    {
      schema: "paperclip/v1",
      company: portabilitySelection.stripEmptyValues({
        brandColor: state.company.brandColor ?? null,
        logoPath: state.companyLogoPath,
        budgetCurrency: state.company.budgetCurrency,
        budgetMonthlyAmount: state.company.budgetMonthlyAmount,
        attachmentMaxBytes: state.company.attachmentMaxBytes,
        requireBoardApprovalForNewAgents: state.company.requireBoardApprovalForNewAgents ? true : undefined,
      }),
      sidebar: portabilitySelection.stripEmptyValues(state.sidebarOrder),
      agents: Object.keys(state.paperclipAgents).length > 0 ? state.paperclipAgents : undefined,
      projects: Object.keys(state.paperclipProjects).length > 0 ? state.paperclipProjects : undefined,
      tasks: Object.keys(state.paperclipTasks).length > 0 ? state.paperclipTasks : undefined,
      routines: Object.keys(state.paperclipRoutines).length > 0 ? state.paperclipRoutines : undefined,
    },
    {
      preserveEmptyStrings: true,
      preserveEmptyCollections: true,
      preserveNullKeys: ["structuredResult"],
    },
  );

  state.finalFiles = portabilitySelection.filterExportFiles(
    state.files,
    input.selectedFiles,
    state.paperclipExtensionPath,
  );

  state.resolved = buildManifestFromPackageFiles(state.finalFiles, {
    sourceLabel: {
      companyId: state.company.id,
      companyName: state.company.name,
    },
  });

  state.resolved.manifest.includes = {
    company: state.resolved.manifest.company !== null,
    agents: state.resolved.manifest.agents.length > 0,
    projects: state.resolved.manifest.projects.length > 0,
    tasks: state.resolved.manifest.tasks.length > 0,
  };

  state.resolved.manifest.envInputs = dedupeEnvInputs(state.envInputs);

  state.resolved.warnings.unshift(...state.warnings);

  // Generate org chart PNG from manifest agents
  if (state.resolved.manifest.agents.length > 0) {
    try {
      const orgNodes = portabilityManifest.buildOrgTreeFromManifest(state.resolved.manifest.agents);
      const pngBuffer = await renderOrgChartPng(orgNodes);
      state.finalFiles["images/org-chart.png"] = portabilitySelection.bufferToPortableBinaryFile(
        pngBuffer,
        "image/png",
      );
    } catch {
      // Non-fatal: export still works without the org chart image
    }
  }

  if (!input.selectedFiles || input.selectedFiles.includes("README.md")) {
    state.finalFiles["README.md"] = generateReadme(state.resolved.manifest, {
      companyName: state.company.name,
      companyDescription: state.company.description ?? null,
    });
  }

  state.resolved = buildManifestFromPackageFiles(state.finalFiles, {
    sourceLabel: {
      companyId: state.company.id,
      companyName: state.company.name,
    },
  });

  state.resolved.manifest.includes = {
    company: state.resolved.manifest.company !== null,
    agents: state.resolved.manifest.agents.length > 0,
    projects: state.resolved.manifest.projects.length > 0,
    tasks: state.resolved.manifest.tasks.length > 0,
  };

  state.resolved.manifest.envInputs = dedupeEnvInputs(state.envInputs);

  state.resolved.warnings.unshift(...state.warnings);

  return {
    rootPath: state.rootPath,
    manifest: state.resolved.manifest,
    files: state.finalFiles,
    warnings: state.resolved.warnings,
    paperclipExtensionPath: state.paperclipExtensionPath,
  };
}

export async function exportBundle(
  context: CompanyPortabilityOperationScope,
  companyId: string,
  input: shared.CompanyPortabilityExport,
): Promise<shared.CompanyPortabilityExportResult> {
  const scope = { ...context, companyId, input };
  const state: Record<string, any> = {};
  await runExportBundlePhase1(scope, state);
  await runExportBundlePhase2(scope, state);
  await runExportBundlePhase3(scope, state);
  return runExportBundlePhase4(scope, state);
}

export function companyPortabilityService(
  db: Db,
  storage: StorageService | undefined,
  ordinaryTasks: OrdinaryTaskRuntime,
  secretsRuntime: SecretsRuntimeConfig,
) {
  const context = createCompanyPortabilityContext(db, storage, ordinaryTasks, secretsRuntime);
  const helpers = buildCompanyPortabilityHelpers(context);
  const scope = { ...context, ...helpers };

  async function previewExport(
    companyId: string,
    input: shared.CompanyPortabilityExport,
  ): Promise<shared.CompanyPortabilityExportPreviewResult> {
    const previewInput: shared.CompanyPortabilityExport = {
      ...input,
      include: {
        ...input.include,
        tasks:
          input.include?.tasks ??
          Boolean(
            (input.tasks && input.tasks.length > 0) || (input.projectTasks && input.projectTasks.length > 0),
          ) ??
          false,
      },
    };
    if (previewInput.include && previewInput.include.tasks === undefined) {
      previewInput.include.tasks = false;
    }
    const exported = await exportBundle(scope, companyId, previewInput);
    return {
      ...exported,
      fileInventory: Object.keys(exported.files)
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => ({
          path: filePath,
          kind: portabilityManifest.classifyPortableFileKind(filePath),
        })),
      counts: {
        files: Object.keys(exported.files).length,
        agents: exported.manifest.agents.length,
        projects: exported.manifest.projects.length,
        tasks: exported.manifest.tasks.length,
      },
    };
  }

  async function previewImport(
    input: shared.CompanyPortabilityPreview,
    options?: portabilityManifest.ImportPreviewOptions,
  ): Promise<shared.CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(scope, input, options);
    return plan.preview;
  }

  return {
    exportBundle: (companyId: string, input: shared.CompanyPortabilityExport) =>
      exportBundle(scope, companyId, input),
    previewExport,
    previewImport,
    importBundle: (
      input: shared.CompanyPortabilityImport,
      actorUserId: string | null | undefined,
      options: portabilityManifest.ImportApplyOptions,
    ) => importBundle(scope, input, actorUserId, options),
  };
}
