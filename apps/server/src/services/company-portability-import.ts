import {
  type CompanyPortabilityImport,
  type CompanyPortabilityImportResult,
  PROJECT_STATUSES,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { requireSecretMutationActor } from "./secrets.js";
import {
  resolveImportMode,
  type ImportApplyOptions,
  COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS,
} from "./company-portability-manifest-types.js";
import { buildPreview } from "./company-portability-preview.js";
import { asString } from "./company-portability-format-support.js";
import type { CompanyPortabilityOperationScope } from "./company-portability.js";

import path from "node:path";
import {
  stableEntitySlugMap,
  isPortableBinaryFile,
  inferContentTypeFromPath,
  portableFileToBuffer,
} from "./company-portability-selection.js";

export async function runCompanyImportPhase1(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const {
    storage,
    companies,
    agents,
    assetRecords,
    projects,
    materializeImportEnvInputValues,
    input,
    actorUserId,
  } = scope;
  await materializeImportEnvInputValues(
    state.targetCompany.id,
    state.sourceManifest,
    state.importEnvInputs,
    input.secretValues,
    state.secretMutationActor,
    state.createdImportSecretIds,
  );

  if (state.include.company) {
    const logoPath = state.sourceManifest.company?.logoPath ?? null;
    if (!logoPath) {
      const cleared = await companies.update(state.targetCompany.id, {
        logoAssetId: null,
      });
      state.targetCompany = cleared ?? state.targetCompany;
    } else {
      const logoFile = state.plan.source.files[logoPath];
      if (!logoFile) {
        state.warnings.push(`Skipped company logo import because ${logoPath} is missing from the package.`);
      } else if (!storage) {
        state.warnings.push("Skipped company logo import because storage is unavailable.");
      } else {
        const contentType = isPortableBinaryFile(logoFile)
          ? (logoFile.contentType ?? inferContentTypeFromPath(logoPath))
          : inferContentTypeFromPath(logoPath);
        if (!contentType || !COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType]) {
          state.warnings.push(
            `Skipped company logo import for ${logoPath} because the file type is unsupported.`,
          );
        } else {
          try {
            const body = portableFileToBuffer(logoFile, logoPath);
            const stored = await storage.putFile({
              companyId: state.targetCompany.id,
              namespace: "assets/companies",
              originalFilename: path.posix.basename(logoPath),
              contentType,
              body,
            });
            const createdAsset = await assetRecords.create(state.targetCompany.id, {
              provider: stored.provider,
              objectKey: stored.objectKey,
              contentType: stored.contentType,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              originalFilename: stored.originalFilename,
              createdByAgentId: null,
              createdByUserId: actorUserId ?? null,
            });
            const updated = await companies.update(state.targetCompany.id, {
              logoAssetId: createdAsset.id,
            });
            state.targetCompany = updated ?? state.targetCompany;
          } catch (err) {
            state.warnings.push(
              `Failed to import company logo ${logoPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  }

  state.resultAgents = [];

  state.resultProjects = [];

  state.importedSlugToAgentId = new Map<string, string>();

  state.existingSlugToAgentId = new Map<string, string>();

  state.preImportExistingSlugToAgentId = new Map<string, string>();

  state.preImportExistingAgentIds = new Set<string>();

  state.agentStatusById = new Map<string, string | null | undefined>();

  state.existingAgents = await agents.list(state.targetCompany.id);

  state.existingAgentSlugById = stableEntitySlugMap(state.existingAgents, "agent");

  for (const existing of state.existingAgents) {
    const slug = state.existingAgentSlugById.get(existing.id)!;
    state.existingSlugToAgentId.set(slug, existing.id);
    state.preImportExistingSlugToAgentId.set(slug, existing.id);
    state.preImportExistingAgentIds.add(existing.id);
    state.agentStatusById.set(existing.id, existing.status);
  }

  state.importedSlugToProjectId = new Map<string, string>();

  state.existingProjectSlugToId = new Map<string, string>();

  state.existingProjects = await projects.list(state.targetCompany.id);

  state.existingProjectSlugById = stableEntitySlugMap(state.existingProjects, "project");

  for (const existing of state.existingProjects) {
    state.existingProjectSlugToId.set(state.existingProjectSlugById.get(existing.id)!, existing.id);
  }
}
import { runCompanyImportPhase2 } from "./company-portability-import-phase-2.js";
import { runCompanyImportPhase4 } from "./company-portability-import-phase-4.js";

export async function runCompanyImportPhase3(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { projects, secrets, strictSecretsMode } = scope;
  if (state.include.projects) {
    for (const planProject of state.plan.preview.plan.projectPlans) {
      const manifestProject = state.sourceManifest.projects.find(
        (project: any) => project.slug === planProject.slug,
      );
      if (!manifestProject) continue;
      if (planProject.action === "skip") {
        state.resultProjects.push({
          slug: planProject.slug,
          id: planProject.existingProjectId,
          action: "skipped",
          name: planProject.plannedName,
          reason: planProject.reason,
        });
        continue;
      }
      const projectLeadAgentId = manifestProject.leadAgentSlug
        ? (state.importedSlugToAgentId.get(manifestProject.leadAgentSlug) ??
          state.existingSlugToAgentId.get(manifestProject.leadAgentSlug) ??
          null)
        : null;
      const normalizedProjectEnv = manifestProject.env
        ? await secrets.normalizeEnvBindingsForPersistence(state.targetCompany.id, manifestProject.env, {
            strictMode: strictSecretsMode,
            fieldPath: `projects.${manifestProject.slug}.env`,
          })
        : null;
      const projectPatch = {
        name: planProject.plannedName,
        description: manifestProject.description,
        leadAgentId: projectLeadAgentId,
        targetDate: manifestProject.targetDate,
        color: manifestProject.color,
        icon: manifestProject.icon,
        status:
          manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
            ? (manifestProject.status as (typeof PROJECT_STATUSES)[number])
            : "backlog",
        env: normalizedProjectEnv,
      };
      let projectId: string | null = null;
      if (planProject.action === "update" && planProject.existingProjectId) {
        const updated = await projects.update(planProject.existingProjectId, projectPatch);
        if (!updated) {
          state.warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
          state.resultProjects.push({
            slug: planProject.slug,
            id: null,
            action: "skipped",
            name: planProject.plannedName,
            reason: "Existing target project not found.",
          });
          continue;
        }
        projectId = updated.id;
        state.importedSlugToProjectId.set(planProject.slug, updated.id);
        state.resultProjects.push({
          slug: planProject.slug,
          id: updated.id,
          action: "updated",
          name: updated.name,
          reason: planProject.reason,
        });
      } else {
        const created = await projects.create(state.targetCompany.id, projectPatch);
        projectId = created.id;
        state.importedSlugToProjectId.set(planProject.slug, created.id);
        state.resultProjects.push({
          slug: planProject.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planProject.reason,
        });
      }
      if (!projectId) continue;
      await secrets.syncEnvBindingsForTarget(
        state.targetCompany.id,
        { targetType: "project", targetId: projectId },
        normalizedProjectEnv ?? {},
        { actor: state.secretMutationActor },
      );
    }
  }
}

export async function importBundle(
  context: CompanyPortabilityOperationScope,
  input: CompanyPortabilityImport,
  actorUserId: string | null | undefined,
  options: ImportApplyOptions,
): Promise<CompanyPortabilityImportResult> {
  const scope = { ...context, input, actorUserId, options };
  const state: Record<string, any> = {};
  const { companies, agents, access, projects, secrets } = scope;
  state.secretMutationActor = options.secretMutationActor;

  requireSecretMutationActor(state.secretMutationActor);

  state.mode = resolveImportMode(options);

  state.plan = await buildPreview(context, input, options);

  if (state.plan.preview.errors.length > 0) {
    throw unprocessable(`Import preview has errors: ${state.plan.preview.errors.join("; ")}`);
  }

  if (
    state.mode === "agent_safe" &&
    (state.plan.preview.plan.companyAction === "update" ||
      state.plan.preview.plan.agentPlans.some((entry: any) => entry.action === "update") ||
      state.plan.preview.plan.projectPlans.some((entry: any) => entry.action === "update"))
  ) {
    throw unprocessable("Safe import routes only allow create or skip actions.");
  }

  state.sourceManifest = state.plan.source.manifest;

  state.warnings = [...state.plan.preview.warnings];

  state.include = state.plan.include;

  state.boardAuthorization = options.authorizationActor?.type === "board" ? options.authorizationActor : null;

  if (state.include.agents && !state.boardAuthorization) {
    throw unprocessable("Importing agents requires board authorization context.");
  }

  state.boardActor = state.boardAuthorization
    ? {
        kind: "board" as const,
        actorId: asString(actorUserId) ?? asString(state.boardAuthorization.userId) ?? "board",
        authorization: state.boardAuthorization,
      }
    : null;

  state.targetCompany = null;

  state.companyAction = "unchanged";

  if (input.target.mode === "new_company") {
    if (state.mode === "agent_safe" && !options?.sourceCompanyId) {
      throw unprocessable("Safe new-company imports require a source company context.");
    }
    if (state.mode === "agent_safe" && options?.sourceCompanyId) {
      const sourceMemberships = await access.listActiveUserMemberships(options.sourceCompanyId);
      if (sourceMemberships.length === 0) {
        throw unprocessable(
          "Safe new-company import requires at least one active user membership on the source company.",
        );
      }
    }
    const companyName =
      asString(input.target.newCompanyName) ??
      state.sourceManifest.company?.name ??
      state.sourceManifest.source?.companyName ??
      "Imported Company";
    const created = await companies.create(
      {
        name: companyName,
        description: state.include.company ? (state.sourceManifest.company?.description ?? null) : null,
        budgetCurrency: state.include.company ? state.sourceManifest.company?.budgetCurrency : undefined,
        budgetMonthlyAmount: state.include.company
          ? state.sourceManifest.company?.budgetMonthlyAmount
          : undefined,
        brandColor: state.include.company ? (state.sourceManifest.company?.brandColor ?? null) : null,
        attachmentMaxBytes: state.include.company
          ? (state.sourceManifest.company?.attachmentMaxBytes ?? undefined)
          : undefined,
        requireBoardApprovalForNewAgents: state.include.company
          ? (state.sourceManifest.company?.requireBoardApprovalForNewAgents ?? false)
          : false,
      },
      actorUserId ?? null,
    );
    if (state.mode === "agent_safe" && options?.sourceCompanyId) {
      await access.copyActiveUserMemberships(options.sourceCompanyId, created.id);
    } else {
      const ownerPrincipalId = actorUserId ?? "board";
      await access.ensureMembership(created.id, "user", ownerPrincipalId, "owner", "active");
      await access.stampRoleGrants(created.id, ownerPrincipalId, "owner", actorUserId ?? null);
    }
    state.targetCompany = created;
    state.companyAction = "created";
  } else {
    state.targetCompany = await companies.getById(input.target.companyId);
    if (!state.targetCompany) throw notFound("Target company not found");
    if (state.include.company && state.sourceManifest.company && state.mode === "board_full") {
      const updated = await companies.update(state.targetCompany.id, {
        name: state.sourceManifest.company.name,
        description: state.sourceManifest.company.description,
        brandColor: state.sourceManifest.company.brandColor,
        attachmentMaxBytes: state.sourceManifest.company.attachmentMaxBytes ?? undefined,
        requireBoardApprovalForNewAgents: state.sourceManifest.company.requireBoardApprovalForNewAgents,
      });
      state.targetCompany = updated ?? state.targetCompany;
      state.companyAction = "updated";
    }
  }

  if (!state.targetCompany) throw notFound("Target company not found");

  state.importedProjectEnvSlugs = new Set(
    state.plan.preview.plan.projectPlans
      .filter((entry: any) => entry.action !== "skip")
      .map((entry: any) => entry.slug),
  );

  state.importEnvInputs = (state.sourceManifest.envInputs ?? []).filter((inputValue: any) => {
    if (inputValue.projectSlug) {
      return state.include.projects && state.importedProjectEnvSlugs.has(inputValue.projectSlug);
    }
    return true;
  });

  state.createdImportSecretIds = [];
  try {
    await runCompanyImportPhase1(scope, state);
    await runCompanyImportPhase2(scope, state);
    await runCompanyImportPhase3(scope, state);
    await runCompanyImportPhase4(scope, state);
    return {
      company: {
        id: state.targetCompany.id,
        name: state.targetCompany.name,
        action: state.companyAction,
      },
      agents: state.resultAgents,
      projects: state.resultProjects,
      envInputs: state.sourceManifest.envInputs ?? [],
      warnings: state.warnings,
    };
  } catch (error) {
    for (const secretId of state.createdImportSecretIds) {
      await secrets.remove(secretId, state.secretMutationActor).catch(() => undefined);
    }

    throw error;
  }
}
