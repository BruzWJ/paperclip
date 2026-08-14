import type { CompanyPortabilityOperationScope } from "./company-portability.js";
import { runBuildPreviewPhase1 } from "./company-portability-preview-phase-1.js";
import type { CompanyPortabilityPreview } from "@paperclipai/shared";
import {
  type ImportPlanInternal,
  type ImportPreviewOptions,
  portableTaskDisplayLabel,
} from "./company-portability-manifest-types.js";

import { notFound } from "../errors.js";
import { stableEntitySlugMap } from "./company-portability-selection.js";

export async function runBuildPreviewPhase2(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { companies, agents, projects, secrets, strictSecretsMode, input } = scope;
  state.targetCompanyId = null;

  state.targetCompanyName = null;

  if (input.target.mode === "existing_company") {
    const targetCompany = await companies.getById(input.target.companyId);
    if (!targetCompany) throw notFound("Target company not found");
    state.targetCompanyId = targetCompany.id;
    state.targetCompanyName = targetCompany.name;
  }

  if (state.mode === "agent_safe" && state.include.projects && state.targetCompanyId) {
    for (const project of state.manifest.projects) {
      if (!project.env) continue;
      try {
        await secrets.normalizeEnvBindingsForPersistence(state.targetCompanyId, project.env, {
          strictMode: strictSecretsMode,
          fieldPath: `projects.${project.slug}.env`,
        });
      } catch (err) {
        state.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  state.agentPlans = [];

  state.existingSlugToAgent = new Map<
    string,
    {
      id: string;
      name: string;
    }
  >();

  state.existingAgentIds = new Set<string>();

  state.projectPlans = [];

  state.taskPlans = [];

  state.existingProjectSlugToProject = new Map<
    string,
    {
      id: string;
      name: string;
    }
  >();

  state.existingProjectSlugs = new Set<string>();

  if (input.target.mode === "existing_company") {
    const existingAgents = await agents.list(input.target.companyId);
    const existingAgentSlugById = stableEntitySlugMap(existingAgents, "agent");
    for (const existing of existingAgents) {
      const slug = existingAgentSlugById.get(existing.id)!;
      if (!state.existingSlugToAgent.has(slug)) state.existingSlugToAgent.set(slug, existing);
      state.existingAgentIds.add(existing.id);
    }
    const existingProjects = await projects.list(input.target.companyId);
    const existingProjectSlugById = stableEntitySlugMap(existingProjects, "project");
    for (const existing of existingProjects) {
      const slug = existingProjectSlugById.get(existing.id)!;
      if (!state.existingProjectSlugToProject.has(slug)) {
        state.existingProjectSlugToProject.set(slug, {
          id: existing.id,
          name: existing.name,
        });
      }
      state.existingProjectSlugs.add(slug);
    }
  }

  for (const manifestAgent of state.selectedAgents) {
    if (
      manifestAgent.reportsToExistingAgentId &&
      !state.existingAgentIds.has(manifestAgent.reportsToExistingAgentId)
    ) {
      state.errors.push(
        `Agent ${manifestAgent.slug} references existing manager id ${manifestAgent.reportsToExistingAgentId}, but that agent is not present in the target company.`,
      );
    }
    if (
      manifestAgent.reportsToExistingAgentSlug &&
      !state.existingSlugToAgent.has(manifestAgent.reportsToExistingAgentSlug)
    ) {
      state.errors.push(
        `Agent ${manifestAgent.slug} references existing manager slug ${manifestAgent.reportsToExistingAgentSlug}, but that agent is not present in the target company.`,
      );
    }
    if (
      manifestAgent.reportsToSlug &&
      !state.selectedAgents.some((candidate: any) => candidate.slug === manifestAgent.reportsToSlug) &&
      !state.existingSlugToAgent.has(manifestAgent.reportsToSlug)
    ) {
      state.errors.push(
        `Agent ${manifestAgent.slug} references unresolved manager ${manifestAgent.reportsToSlug}.`,
      );
    }
    const existing = state.existingSlugToAgent.get(manifestAgent.slug) ?? null;
    if (!existing) {
      state.agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: manifestAgent.name,
        existingAgentId: null,
        reason: null,
      });
      continue;
    }
    if (state.mode === "board_full" && state.collisionStrategy === "replace") {
      state.agentPlans.push({
        slug: manifestAgent.slug,
        action: "update",
        plannedName: existing.name,
        existingAgentId: existing.id,
        reason: "Existing slug matched; replace strategy.",
      });
      continue;
    }
    if (state.collisionStrategy === "skip") {
      state.agentPlans.push({
        slug: manifestAgent.slug,
        action: "skip",
        plannedName: existing.name,
        existingAgentId: existing.id,
        reason: "Existing slug matched; skip strategy.",
      });
      continue;
    }
    state.agentPlans.push({
      slug: manifestAgent.slug,
      action: "create",
      plannedName: manifestAgent.name,
      existingAgentId: existing.id,
      reason: "Existing slug matched; rename strategy.",
    });
  }

  if (state.include.projects) {
    for (const manifestProject of state.manifest.projects) {
      const existing = state.existingProjectSlugToProject.get(manifestProject.slug) ?? null;
      if (!existing) {
        state.projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: manifestProject.name,
          existingProjectId: null,
          reason: null,
        });
        continue;
      }
      if (state.mode === "board_full" && state.collisionStrategy === "replace") {
        state.projectPlans.push({
          slug: manifestProject.slug,
          action: "update",
          plannedName: existing.name,
          existingProjectId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }
      if (state.collisionStrategy === "skip") {
        state.projectPlans.push({
          slug: manifestProject.slug,
          action: "skip",
          plannedName: existing.name,
          existingProjectId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }
      state.projectPlans.push({
        slug: manifestProject.slug,
        action: "create",
        plannedName: manifestProject.name,
        existingProjectId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }
  }
}

export async function runBuildPreviewPhase3(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { input } = scope;
  // Apply user-specified name overrides (keyed by slug)
  if (input.nameOverrides) {
    for (const ap of state.agentPlans) {
      const override = input.nameOverrides[ap.slug];
      if (override) {
        ap.plannedName = override;
      }
    }
    for (const pp of state.projectPlans) {
      const override = input.nameOverrides[pp.slug];
      if (override) {
        pp.plannedName = override;
      }
    }
    for (const ip of state.taskPlans) {
      const override = input.nameOverrides[ip.slug];
      if (override) {
        ip.plannedTitle = override;
      }
    }
  }

  // Warn about agents that will be overwritten/updated
  for (const ap of state.agentPlans) {
    if (ap.action === "update") {
      state.warnings.push(`Existing agent "${ap.plannedName}" (${ap.slug}) will be overwritten by import.`);
    }
  }

  // Warn about projects that will be overwritten/updated
  for (const pp of state.projectPlans) {
    if (pp.action === "update") {
      state.warnings.push(`Existing project "${pp.plannedName}" (${pp.slug}) will be overwritten by import.`);
    }
  }

  if (state.include.tasks) {
    for (const manifestTask of state.manifest.tasks) {
      state.taskPlans.push({
        slug: manifestTask.slug,
        action: "create",
        plannedTitle: portableTaskDisplayLabel(manifestTask),
        reason: manifestTask.recurring ? "Recurring task will be imported as a routine." : null,
      });
    }
  }

  state.preview = {
    include: state.include,
    targetCompanyId: state.targetCompanyId,
    targetCompanyName: state.targetCompanyName,
    collisionStrategy: state.collisionStrategy,
    selectedAgentSlugs: state.selectedAgents.map((agent: any) => agent.slug),
    plan: {
      companyAction:
        input.target.mode === "new_company"
          ? "create"
          : state.include.company && state.mode === "board_full"
            ? "update"
            : "none",
      agentPlans: state.agentPlans,
      projectPlans: state.projectPlans,
      taskPlans: state.taskPlans,
    },
    manifest: state.manifest,
    files: state.source.files,
    envInputs: state.manifest.envInputs ?? [],
    warnings: state.warnings,
    errors: state.errors,
  };

  return {
    preview: state.preview,
    source: state.source,
    include: state.include,
    collisionStrategy: state.collisionStrategy,
    selectedAgents: state.selectedAgents,
  };
}

export async function buildPreview(
  context: CompanyPortabilityOperationScope,
  input: CompanyPortabilityPreview,
  options?: ImportPreviewOptions,
): Promise<ImportPlanInternal> {
  const scope = { ...context, input, options };
  const state: Record<string, any> = {};
  await runBuildPreviewPhase1(scope, state);
  await runBuildPreviewPhase2(scope, state);
  return runBuildPreviewPhase3(scope, state);
}
