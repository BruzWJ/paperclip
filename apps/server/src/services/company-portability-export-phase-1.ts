import { and, eq, inArray } from "drizzle-orm";
import { principalPermissionGrants } from "@paperclipai/db";
import { type PermissionKey, isCanonicalUuid } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { taskService } from "./tasks.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";
import { normalizeSlug } from "./slug.js";
import {
  type PortableAgentPermissionGrant,
  VALID_PERMISSION_KEYS,
} from "./company-portability-extension-parser.js";
import { taskDisplayLabel, type RoutineLike } from "./company-portability-manifest-types.js";
import * as portabilitySelection from "./company-portability-selection.js";
import { isPlainRecord } from "./company-portability-format-support.js";
import type { CompanyPortabilityOperationScope } from "./company-portability.js";

export async function runExportBundlePhase1(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { db, ordinaryTasks, secretsRuntime, companies, agents, projects, companyId, input } = scope;
  state.include = portabilitySelection.normalizeInclude({
    ...input.include,
    agents: input.agents && input.agents.length > 0 ? true : input.include?.agents,
    projects: input.projects && input.projects.length > 0 ? true : input.include?.projects,
    tasks:
      (input.tasks && input.tasks.length > 0) || (input.projectTasks && input.projectTasks.length > 0)
        ? true
        : input.include?.tasks,
  });

  state.company = await companies.getById(companyId);

  if (!state.company) throw notFound("Company not found");

  state.files = {};

  state.warnings = [];

  state.envInputs = [];

  state.requestedSidebarOrderIds = portabilitySelection.normalizePortableSidebarOrder(input.sidebarOrder);

  state.rootPath = normalizeSlug(state.company.name) ?? "company-package";

  state.companyLogoPath = null;

  state.hasAgentSelectors = (input.agents?.length ?? 0) > 0;

  state.hasProjectSelectors = (input.projects?.length ?? 0) > 0;

  state.hasTaskSelectors = (input.tasks?.length ?? 0) > 0;

  state.hasProjectTaskSelectors = (input.projectTasks?.length ?? 0) > 0;

  state.allAgentRows =
    state.include.agents || state.include.projects || state.include.tasks
      ? await agents.list(companyId, { includeTerminated: true })
      : [];

  state.liveAgentRows = state.allAgentRows.filter((agent: any) => agent.status !== "terminated");

  if (state.include.agents) {
    const skipped = state.allAgentRows.length - state.liveAgentRows.length;
    if (skipped > 0) {
      state.warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
    }
  }

  state.agentById = new Map(state.liveAgentRows.map((agent: any) => [agent.id, agent]));

  state.selectedAgents = new Map<string, (typeof state.liveAgentRows)[number]>();

  for (const selector of input.agents ?? []) {
    if (!isCanonicalUuid(selector)) {
      throw unprocessable(`Agent selector "${selector}" must be a canonical UUID`);
    }
    const match = state.agentById.get(selector);
    if (!match) {
      throw unprocessable(`Agent ID "${selector}" was not found`);
    }
    state.selectedAgents.set(match.id, match);
  }

  if (state.include.agents && !state.hasAgentSelectors) {
    for (const agent of state.liveAgentRows) {
      state.selectedAgents.set(agent.id, agent);
    }
  }

  state.agentRows = Array.from(state.selectedAgents.values()).sort((left: any, right: any) =>
    left.name.localeCompare(right.name),
  );

  state.idToSlug = portabilitySelection.stableEntitySlugMap(state.liveAgentRows, "agent");

  state.agentPermissionGrantRows =
    state.agentRows.length > 0 &&
    typeof (
      db as {
        select?: unknown;
      }
    ).select === "function"
      ? await db
          .select({
            principalId: principalPermissionGrants.principalAgentId,
            permissionKey: principalPermissionGrants.permissionKey,
            scope: principalPermissionGrants.scope,
          })
          .from(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, "agent"),
              inArray(
                principalPermissionGrants.principalAgentId,
                state.agentRows.map((agent: any) => agent.id),
              ),
            ),
          )
      : [];

  state.permissionGrantsByAgentId = new Map<string, PortableAgentPermissionGrant[]>();

  for (const row of state.agentPermissionGrantRows) {
    if (!row.principalId) {
      throw new Error("Agent permission grant is missing its typed agent principal id");
    }
    if (!VALID_PERMISSION_KEYS.has(row.permissionKey as PermissionKey)) continue;
    const grants = state.permissionGrantsByAgentId.get(row.principalId) ?? [];
    grants.push({
      permissionKey: row.permissionKey as PermissionKey,
      scope: isPlainRecord(row.scope) ? row.scope : null,
    });
    state.permissionGrantsByAgentId.set(row.principalId, grants);
  }

  for (const grants of state.permissionGrantsByAgentId.values()) {
    grants.sort((left: any, right: any) => left.permissionKey.localeCompare(right.permissionKey));
  }

  state.projectsSvc = projectService(db);

  state.tasksSvc = taskService(db);

  state.routinesSvc = routineService(db, {
    ordinaryTasks,
    secretsRuntime,
  });

  state.allProjectsRaw =
    state.include.projects || state.include.tasks ? await state.projectsSvc.list(companyId) : [];

  state.allProjects = state.allProjectsRaw.filter((project: any) => !project.archivedAt);

  state.allRoutinesRaw = state.include.tasks ? await state.routinesSvc.list(companyId) : [];

  state.allRoutines = state.allRoutinesRaw;

  state.projectById = new Map(state.allProjects.map((project: any) => [project.id, project]));

  state.selectedProjects = new Map<string, (typeof state.allProjects)[number]>();

  for (const selector of input.projects ?? []) {
    if (!isCanonicalUuid(selector)) {
      throw unprocessable(`Project selector "${selector}" must be a canonical UUID`);
    }
    const match = state.projectById.get(selector);
    if (!match) {
      throw unprocessable(`Project ID "${selector}" was not found`);
    }
    state.selectedProjects.set(match.id, match);
  }

  type SelectedTaskRow =
    | NonNullable<Awaited<ReturnType<typeof state.tasksSvc.getById>>>
    | Awaited<ReturnType<typeof state.tasksSvc.list>>[number];

  state.selectedTasks = new Map<string, SelectedTaskRow>();

  state.selectedRoutines = new Map<string, (typeof state.allRoutines)[number]>();

  state.routineById = new Map(state.allRoutines.map((routine: any) => [routine.id, routine]));

  for (const selector of input.tasks ?? []) {
    if (!isCanonicalUuid(selector)) {
      throw unprocessable(`Task selector "${selector}" must be a canonical UUID`);
    }
    const task = await state.tasksSvc.getById(selector);
    if (!task || task.companyId !== companyId) {
      const routine = state.routineById.get(selector);
      if (!routine) {
        throw unprocessable(`Task or routine ID "${selector}" was not found`);
      }
      state.selectedRoutines.set(routine.id, routine);
      if (routine.projectId) {
        const parentProject = state.projectById.get(routine.projectId);
        if (parentProject) state.selectedProjects.set(parentProject.id, parentProject);
      }
      continue;
    }
    state.selectedTasks.set(task.id, task);
    if (task.projectId) {
      const parentProject = state.projectById.get(task.projectId);
      if (parentProject) state.selectedProjects.set(parentProject.id, parentProject);
    }
  }

  for (const selector of input.projectTasks ?? []) {
    if (!isCanonicalUuid(selector)) {
      throw unprocessable(`Project-tasks selector "${selector}" must be a canonical UUID`);
    }
    const match = state.projectById.get(selector);
    if (!match) {
      throw unprocessable(`Project ID "${selector}" was not found`);
    }
    state.selectedProjects.set(match.id, match);
    const projectTasks = await state.tasksSvc.list(companyId, {
      projectId: match.id,
    });
    for (const task of projectTasks) {
      state.selectedTasks.set(task.id, task);
    }
    for (const routine of state.allRoutines.filter((entry: any) => entry.projectId === match.id)) {
      state.selectedRoutines.set(routine.id, routine);
    }
  }

  if (
    state.include.projects &&
    !state.hasProjectSelectors &&
    !state.hasTaskSelectors &&
    !state.hasProjectTaskSelectors
  ) {
    for (const project of state.allProjects) {
      state.selectedProjects.set(project.id, project);
    }
  }

  if (state.include.tasks && !state.hasTaskSelectors && !state.hasProjectTaskSelectors) {
    const allTasks = await state.tasksSvc.list(companyId);
    for (const task of allTasks) {
      state.selectedTasks.set(task.id, task);
      if (task.projectId) {
        const parentProject = state.projectById.get(task.projectId);
        if (parentProject) state.selectedProjects.set(parentProject.id, parentProject);
      }
    }
    if (state.selectedRoutines.size === 0) {
      for (const routine of state.allRoutines) {
        state.selectedRoutines.set(routine.id, routine);
        if (routine.projectId) {
          const parentProject = state.projectById.get(routine.projectId);
          if (parentProject) state.selectedProjects.set(parentProject.id, parentProject);
        }
      }
    }
  }

  state.selectedProjectRows = Array.from(state.selectedProjects.values()).sort((left: any, right: any) =>
    left.name.localeCompare(right.name),
  );

  state.selectedTaskRows = Array.from(state.selectedTasks.values())
    .filter((task): task is NonNullable<typeof task> => task != null)
    .sort((left: any, right: any) => taskDisplayLabel(left).localeCompare(taskDisplayLabel(right)));

  state.selectedRoutineSummaries = Array.from(state.selectedRoutines.values()).sort((left: any, right: any) =>
    left.title.localeCompare(right.title),
  );

  state.selectedRoutineRows = (
    await Promise.all(
      state.selectedRoutineSummaries.map((routine: any) => state.routinesSvc.getDetail(routine.id)),
    )
  ).filter((routine): routine is RoutineLike => routine !== null);

  state.taskSlugByTaskId = new Map<string, string>();

  state.taskSlugByRoutineId = new Map<string, string>();

  state.usedTaskSlugs = new Set<string>();

  for (const task of state.selectedTaskRows) {
    const baseSlug = normalizeSlug(taskDisplayLabel(task)) ?? "task";
    state.taskSlugByTaskId.set(task.id, portabilitySelection.uniqueSlug(baseSlug, state.usedTaskSlugs));
  }

  for (const routine of state.selectedRoutineRows) {
    const baseSlug = normalizeSlug(routine.title) ?? "task";
    state.taskSlugByRoutineId.set(routine.id, portabilitySelection.uniqueSlug(baseSlug, state.usedTaskSlugs));
  }

  state.projectSlugById = portabilitySelection.stableEntitySlugMap(state.selectedProjectRows, "project");

  state.requestedSidebarOrder = state.requestedSidebarOrderIds
    ? {
        agents: state.requestedSidebarOrderIds.agents.map((agentId: any) => {
          if (!isCanonicalUuid(agentId)) {
            throw unprocessable(`Sidebar agent selector "${agentId}" must be a canonical UUID`);
          }
          const slug = state.selectedAgents.has(agentId) ? state.idToSlug.get(agentId) : null;
          if (!slug) {
            throw unprocessable(`Sidebar agent ID "${agentId}" is not selected for export`);
          }
          return slug;
        }),
        projects: state.requestedSidebarOrderIds.projects.map((projectId: any) => {
          if (!isCanonicalUuid(projectId)) {
            throw unprocessable(`Sidebar project selector "${projectId}" must be a canonical UUID`);
          }
          const slug = state.selectedProjects.has(projectId) ? state.projectSlugById.get(projectId) : null;
          if (!slug) {
            throw unprocessable(`Sidebar project ID "${projectId}" is not selected for export`);
          }
          return slug;
        }),
      }
    : null;

  state.sidebarOrder =
    state.requestedSidebarOrder ??
    portabilitySelection.stripEmptyValues({
      agents: portabilitySelection
        .sortAgentsBySidebarOrder(
          Array.from(state.selectedAgents.values()) as Array<{
            id: string;
            name: string;
            reportsTo: string | null;
          }>,
        )
        .map((agent) => state.idToSlug.get(agent.id))
        .filter((slug): slug is string => Boolean(slug)),
      projects: state.selectedProjectRows
        .map((project: any) => state.projectSlugById.get(project.id))
        .filter((slug: any): slug is string => Boolean(slug)),
    });
}
