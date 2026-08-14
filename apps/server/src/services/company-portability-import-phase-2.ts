import { unprocessable } from "../errors.js";
import type { CompanyPortabilityOperationScope } from "./company-portability.js";

export async function runCompanyImportPhase2(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const {
    agents,
    access,
    runtimeAgentConfigurations,
    adapterConfigurations,
    operationalConfigurations,
    applyImportedAgentPermissionGrants,
    prepareImportedAgentAdapter,
    input,
    actorUserId,
  } = scope;
  if (state.include.agents) {
    for (const planAgent of state.plan.preview.plan.agentPlans) {
      const manifestAgent = state.plan.selectedAgents.find((agent: any) => agent.slug === planAgent.slug);
      if (!manifestAgent) continue;
      if (planAgent.action === "skip") {
        state.resultAgents.push({
          slug: planAgent.slug,
          id: planAgent.existingAgentId,
          action: "skipped",
          name: planAgent.plannedName,
          reason: planAgent.reason,
        });
        continue;
      }
      const adapterOverride = input.adapterOverrides?.[planAgent.slug];
      if (!adapterOverride) {
        throw unprocessable(
          `Selected imported agent ${planAgent.slug} requires an explicit target adapter override.`,
        );
      }
      const normalizedAdapter = adapterOverride
        ? await prepareImportedAgentAdapter(adapterOverride.adapterType, {
            ...adapterOverride.adapterConfig,
          })
        : null;
      if (!state.boardActor) {
        throw unprocessable("Importing agents requires board authorization context.");
      }
      let importedAgentId: string;
      let importedAction: "created" | "updated";
      if (planAgent.action === "update" && planAgent.existingAgentId) {
        await runtimeAgentConfigurations.update({
          companyId: state.targetCompany.id,
          targetAgentId: planAgent.existingAgentId,
          actor: state.boardActor,
          source: "board",
          configuration: {
            name: planAgent.plannedName,
            title: manifestAgent.title,
            capabilities: manifestAgent.capabilities,
            reportsTo: null,
            contextGrants: manifestAgent.contextGrants,
            actionGrants: manifestAgent.actionGrants,
            mentionReachGrants: manifestAgent.mentionReachGrants,
          },
        });
        importedAgentId = planAgent.existingAgentId;
        importedAction = "updated";
      } else {
        const identity = await runtimeAgentConfigurations.create({
          companyId: state.targetCompany.id,
          actor: state.boardActor,
          source: "board",
          configuration: {
            name: planAgent.plannedName,
            title: manifestAgent.title,
            capabilities: manifestAgent.capabilities,
            reportsTo: null,
            contextGrants: manifestAgent.contextGrants,
            actionGrants: manifestAgent.actionGrants,
            mentionReachGrants: manifestAgent.mentionReachGrants,
          },
        });
        importedAgentId = identity.agentId;
        importedAction = "created";
      }
      await operationalConfigurations.update({
        companyId: state.targetCompany.id,
        agentId: importedAgentId,
        actorUserId: actorUserId ?? null,
        configuration: {
          icon: manifestAgent.icon,
          budgetMonthlyAmount: manifestAgent.budgetMonthlyAmount,
        },
      });
      if (normalizedAdapter && adapterOverride) {
        await adapterConfigurations.createRevision({
          companyId: state.targetCompany.id,
          agentId: importedAgentId,
          configuration: {
            adapterType: normalizedAdapter.adapterType,
            adapterConfig: normalizedAdapter.adapterConfig,
          },
          actor: state.secretMutationActor,
        });
      }
      const importedAgent = await agents.getById(importedAgentId);
      if (!importedAgent) {
        throw unprocessable(`Imported agent ${planAgent.slug} could not be loaded after configuration.`);
      }
      await access.ensureMembership(state.targetCompany.id, "agent", importedAgent.id, "member", "active");
      await applyImportedAgentPermissionGrants(
        state.targetCompany.id,
        importedAgent.id,
        manifestAgent.permissionGrants ?? [],
        actorUserId ?? null,
      );
      state.agentStatusById.set(importedAgent.id, importedAgent.status ?? "idle");
      state.importedSlugToAgentId.set(planAgent.slug, importedAgent.id);
      state.resultAgents.push({
        slug: planAgent.slug,
        id: importedAgent.id,
        action: importedAction,
        name: importedAgent.name,
        reason: planAgent.reason,
      });
    }
    // Apply reporting links once all imported agent ids are available.
    for (const manifestAgent of state.plan.selectedAgents) {
      const agentId = state.importedSlugToAgentId.get(manifestAgent.slug);
      if (!agentId) continue;
      const managerSlug = manifestAgent.reportsToSlug;
      let existingManagerId: string | null = null;
      if (
        manifestAgent.reportsToExistingAgentId &&
        state.preImportExistingAgentIds.has(manifestAgent.reportsToExistingAgentId)
      ) {
        existingManagerId = manifestAgent.reportsToExistingAgentId;
      } else if (manifestAgent.reportsToExistingAgentSlug) {
        existingManagerId =
          state.preImportExistingSlugToAgentId.get(manifestAgent.reportsToExistingAgentSlug) ?? null;
      }
      if (!managerSlug && !existingManagerId) continue;
      const managerId =
        existingManagerId ??
        (managerSlug
          ? (state.importedSlugToAgentId.get(managerSlug) ??
            state.existingSlugToAgentId.get(managerSlug) ??
            null)
          : null);
      if (!managerId || managerId === agentId) continue;
      try {
        if (!state.boardActor) {
          throw unprocessable("Importing agent reporting lines requires board authorization context.");
        }
        await runtimeAgentConfigurations.update({
          companyId: state.targetCompany.id,
          targetAgentId: agentId,
          actor: state.boardActor,
          source: "board",
          configuration: { reportsTo: managerId },
        });
      } catch (error) {
        const managerRef =
          managerSlug ?? manifestAgent.reportsToExistingAgentSlug ?? manifestAgent.reportsToExistingAgentId;
        throw unprocessable(
          `Could not assign manager ${managerRef} for imported agent ${manifestAgent.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
