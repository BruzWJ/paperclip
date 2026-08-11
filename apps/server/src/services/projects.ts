import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  projects,
  projectGoals,
  goals,
  tasks,
  budgetPolicies,
  pluginManagedResources,
  plugins,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  deriveProjectUrlKey,
  hasNonAsciiContent,
  isUuidLike,
  normalizeProjectUrlKey,
  canonicalizeMoneyAmount,
  compareMoneyAmounts,
  parseMoneyAmount,
  type BudgetWindowKind,
  type ProjectBudgetSummary,
  type MoneyAmount,
  type ProjectCodebase,
  type ProjectGoalRef,
  type ProjectManagedByPlugin,
  type PluginManagedProjectDeclaration,
  type PluginManagedProjectResolution,
} from "@paperclipai/shared";

type ProjectRow = typeof projects.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type CreateWorkspaceInput = {
  cwd?: string | null;
  repoUrl?: string | null;
};
type UpdateWorkspaceInput = Partial<CreateWorkspaceInput>;

/**
 * Server-only workspace data used to resolve a run's working directory.
 *
 * This is deliberately not the shared public Project contract: the board and
 * plugin project APIs do not expose execution-workspace configuration.
 */
export interface InternalProjectWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  cwd: string | null;
  repoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InternalProjectCodebase = ProjectCodebase;

/** Complete server-side project aggregate, including runtime-only workspace data. */
export interface InternalProject extends ProjectRow {
  urlKey: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  codebase: InternalProjectCodebase;
  workspaces: InternalProjectWorkspace[];
  primaryWorkspace: InternalProjectWorkspace | null;
  managedByPlugin: ProjectManagedByPlugin | null;
  taskCount?: number;
  budget?: ProjectBudgetSummary | null;
}

type InternalProjectWithGoals = Omit<
  InternalProject,
  "codebase" | "workspaces" | "primaryWorkspace" | "managedByPlugin"
>;

type InternalProjectRuntimeFields = {
  codebase?: unknown;
  workspaces?: unknown;
  primaryWorkspace?: unknown;
};

/** Public-safe project projection for HTTP and plugin-host reads. */
export type PublicProject = Omit<InternalProject, keyof InternalProjectRuntimeFields>;

export function toPublicProject(project: InternalProject): PublicProject;
export function toPublicProject<T extends object>(
  project: T,
): Omit<T, keyof InternalProjectRuntimeFields>;
export function toPublicProject<T extends object>(project: T) {
  const {
    codebase: _codebase,
    workspaces: _workspaces,
    primaryWorkspace: _primaryWorkspace,
    ...publicProject
  } = project as T & InternalProjectRuntimeFields;
  return publicProject as Omit<T, keyof InternalProjectRuntimeFields>;
}

interface ProjectShortnameRow {
  id: string;
  name: string;
}

interface ResolveProjectNameOptions {
  excludeProjectId?: string | null;
}

/** Batch-load goal refs for a set of projects. */
async function attachGoals(db: Db, rows: ProjectRow[]): Promise<InternalProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);

  // Fetch join rows + goal titles in one query
  const links = await db
    .select({
      projectId: projectGoals.projectId,
      goalId: projectGoals.goalId,
      goalTitle: goals.title,
    })
    .from(projectGoals)
    .innerJoin(goals, eq(projectGoals.goalId, goals.id))
    .where(inArray(projectGoals.projectId, projectIds));

  const map = new Map<string, ProjectGoalRef[]>();
  for (const link of links) {
    let arr = map.get(link.projectId);
    if (!arr) {
      arr = [];
      map.set(link.projectId, arr);
    }
    arr.push({ id: link.goalId, title: link.goalTitle });
  }

  return rows.map((r) => {
    const g = map.get(r.id) ?? [];
    return {
      ...r,
      urlKey: deriveProjectUrlKey(r.name, r.id),
      goalIds: g.map((x) => x.id),
      goals: g,
    };
  });
}

function toWorkspace(row: ProjectWorkspaceRow): InternalProjectWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    cwd: normalizeWorkspaceCwd(row.cwd),
    repoUrl: row.repoUrl ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function deriveProjectCodebase(input: {
  primaryWorkspace: InternalProjectWorkspace | null;
  fallbackWorkspaces: InternalProjectWorkspace[];
}): InternalProjectCodebase {
  const primaryWorkspace = input.primaryWorkspace ?? input.fallbackWorkspaces[0] ?? null;

  return {
    workspaceId: primaryWorkspace?.id ?? null,
    repoUrl: primaryWorkspace?.repoUrl ?? null,
    localFolder: primaryWorkspace?.cwd ?? null,
  };
}

function pickPrimaryWorkspace(rows: ProjectWorkspaceRow[]): InternalProjectWorkspace | null {
  if (rows.length === 0) return null;
  return toWorkspace(rows[0]!);
}

/** Batch-load workspace refs for a set of projects. */
async function attachWorkspaces(db: Db, rows: InternalProjectWithGoals[]): Promise<InternalProject[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);
  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(inArray(projectWorkspaces.projectId, projectIds));

  const map = new Map<string, ProjectWorkspaceRow[]>();
  for (const row of workspaceRows) {
    let arr = map.get(row.projectId);
    if (!arr) {
      arr = [];
      map.set(row.projectId, arr);
    }
    arr.push(row);
  }

  const managedRows = await db
    .select({
      id: pluginManagedResources.id,
      pluginId: pluginManagedResources.pluginId,
      pluginKey: pluginManagedResources.pluginKey,
      manifestJson: plugins.manifestJson,
      resourceKind: pluginManagedResources.resourceKind,
      resourceKey: pluginManagedResources.resourceKey,
      resourceId: pluginManagedResources.resourceId,
      defaultsJson: pluginManagedResources.defaultsJson,
      createdAt: pluginManagedResources.createdAt,
      updatedAt: pluginManagedResources.updatedAt,
    })
    .from(pluginManagedResources)
    .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
    .where(and(
      eq(pluginManagedResources.resourceKind, "project"),
      inArray(pluginManagedResources.resourceId, projectIds),
    ));
  const managedByProjectId = new Map<string, ProjectManagedByPlugin>();
  for (const row of managedRows) {
    managedByProjectId.set(row.resourceId, {
      id: row.id,
      pluginId: row.pluginId,
      pluginKey: row.pluginKey,
      pluginDisplayName: row.manifestJson.displayName,
      resourceKind: "project",
      resourceKey: row.resourceKey,
      defaultsJson: row.defaultsJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return rows.map((row) => {
    const projectWorkspaceRows = map.get(row.id) ?? [];
    const workspaces = projectWorkspaceRows.map(toWorkspace);
    const primaryWorkspace = pickPrimaryWorkspace(projectWorkspaceRows);
    return {
      ...row,
      codebase: deriveProjectCodebase({
        primaryWorkspace,
        fallbackWorkspaces: workspaces,
      }),
      workspaces,
      primaryWorkspace,
      managedByPlugin: managedByProjectId.get(row.id) ?? null,
    };
  });
}

type TaskCountRow = { projectId: string | null; count: number };
type ProjectBudgetRow = {
  scopeId: string;
  limitAmount: string;
  windowKind: string;
};

/**
 * Build the per-project task-count and budget lookups from the aggregate query
 * rows. Pure (no DB) so the merge logic can be unit-tested in isolation.
 * Only active policies with a positive canonical limit surface as a budget.
 */
export function buildProjectListMetricMaps(taskCountRows: TaskCountRow[], budgetRows: ProjectBudgetRow[]) {
  const taskCountByProjectId = new Map<string, number>();
  for (const row of taskCountRows) {
    if (row.projectId) taskCountByProjectId.set(row.projectId, Number(row.count) || 0);
  }

  const budgetByProjectId = new Map<string, ProjectBudgetSummary>();
  for (const row of budgetRows) {
    const limitAmount = canonicalizeMoneyAmount(row.limitAmount);
    if (compareMoneyAmounts(limitAmount, parseMoneyAmount("0")) > 0) {
      budgetByProjectId.set(row.scopeId, {
        limitAmount: limitAmount as MoneyAmount,
        windowKind: row.windowKind as BudgetWindowKind,
      });
    }
  }

  return { taskCountByProjectId, budgetByProjectId };
}

/**
 * Attach lightweight list-only metrics (task count + budget) to a set of
 * projects using two aggregate queries (no N+1). Used by the projects list
 * view (IA Phase 4 — PAP-60).
 */
async function attachListMetrics(
  db: Db,
  companyId: string,
  rows: InternalProject[],
): Promise<InternalProject[]> {
  if (rows.length === 0) return rows;

  const projectIds = rows.map((r) => r.id);

  const [taskCountRows, budgetRows] = await Promise.all([
    db
      .select({
        projectId: tasks.projectId,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), inArray(tasks.projectId, projectIds)))
      .groupBy(tasks.projectId),
    db
      .select({
        scopeId: budgetPolicies.scopeId,
        limitAmount: budgetPolicies.limitAmount,
        windowKind: budgetPolicies.windowKind,
      })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "project"),
          eq(budgetPolicies.isActive, true),
          inArray(budgetPolicies.scopeId, projectIds),
        ),
      ),
  ]);

  const { taskCountByProjectId, budgetByProjectId } = buildProjectListMetricMaps(
    taskCountRows,
    budgetRows,
  );

  return rows.map((row) => ({
    ...row,
    taskCount: taskCountByProjectId.get(row.id) ?? 0,
    budget: budgetByProjectId.get(row.id) ?? null,
  }));
}

/** Sync the project_goals join table for a single project. */
async function syncGoalLinks(db: Db, projectId: string, companyId: string, goalIds: string[]) {
  // Delete existing links
  await db.delete(projectGoals).where(eq(projectGoals.projectId, projectId));

  // Insert new links
  if (goalIds.length > 0) {
    await db.insert(projectGoals).values(
      goalIds.map((goalId) => ({ projectId, goalId, companyId })),
    );
  }
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceCwd(value: unknown): string | null {
  const cwd = readNonEmptyString(value);
  return cwd;
}

function buildManagedProjectDefaults(declaration: PluginManagedProjectDeclaration) {
  return {
    projectKey: declaration.projectKey,
    displayName: declaration.displayName,
    description: declaration.description ?? null,
    status: declaration.status ?? "in_progress",
    color: declaration.color ?? null,
    settings: declaration.settings ?? {},
  };
}

export function resolveProjectNameForUniqueShortname(
  requestedName: string,
  existingProjects: ProjectShortnameRow[],
  options?: ResolveProjectNameOptions,
): string {
  const requestedShortname = normalizeProjectUrlKey(requestedName);
  if (!requestedShortname) return requestedName;
  // Non-ASCII names get a UUID suffix in deriveProjectUrlKey, making slugs inherently unique.
  if (hasNonAsciiContent(requestedName)) return requestedName;

  const usedShortnames = new Set(
    existingProjects
      .filter((project) => !(options?.excludeProjectId && project.id === options.excludeProjectId))
      .map((project) => normalizeProjectUrlKey(project.name))
      .filter((value): value is string => value !== null),
  );
  if (!usedShortnames.has(requestedShortname)) return requestedName;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidateName = `${requestedName} ${suffix}`;
    const candidateShortname = normalizeProjectUrlKey(candidateName);
    if (candidateShortname && !usedShortnames.has(candidateShortname)) {
      return candidateName;
    }
  }

  // Fallback guard for pathological naming collisions.
  return `${requestedName} ${Date.now()}`;
}

export function projectService(db: Db) {
  const createProject = async (
    companyId: string,
    data: Omit<typeof projects.$inferInsert, "companyId"> & { goalIds?: string[] },
  ): Promise<InternalProject> => {
    const { goalIds: inputGoalIds, ...projectData } = data;

    // Note: color is intentionally NOT auto-assigned. New projects default to
    // `color = null` (neutral gray) unless an explicit color is supplied. See PAP-68.

    const existingProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects);

    const row = await db
      .insert(projects)
      .values({ ...projectData, companyId })
      .returning()
      .then((rows) => rows[0]);

    if (inputGoalIds && inputGoalIds.length > 0) {
      await syncGoalLinks(db, row.id, companyId, inputGoalIds);
    }

    const [withGoals] = await attachGoals(db, [row]);
    const [enriched] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
    return enriched!;
  };

  const getProjectById = async (id: string): Promise<InternalProject | null> => {
    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [withGoals] = await attachGoals(db, [row]);
    if (!withGoals) return null;
    const [enriched] = await attachWorkspaces(db, [withGoals]);
    return enriched ?? null;
  };

  return {
    list: async (companyId: string): Promise<InternalProject[]> => {
      const rows = await db.select().from(projects).where(eq(projects.companyId, companyId));
      const withGoals = await attachGoals(db, rows);
      const withWorkspaces = await attachWorkspaces(db, withGoals);
      return attachListMetrics(db, companyId, withWorkspaces);
    },

    listByIds: async (companyId: string, ids: string[]): Promise<InternalProject[]> => {
      const dedupedIds = [...new Set(ids)];
      if (dedupedIds.length === 0) return [];
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, dedupedIds)));
      const withGoals = await attachGoals(db, rows);
      const withWorkspaces = await attachWorkspaces(db, withGoals);
      const byId = new Map(withWorkspaces.map((project) => [project.id, project]));
      return dedupedIds.map((id) => byId.get(id)).filter((project): project is InternalProject => Boolean(project));
    },

    getById: getProjectById,

    resolveManagedProject: async (input: {
      companyId: string;
      pluginId: string;
      pluginKey: string;
      projectKey: string;
      reset?: boolean;
      createIfMissing?: boolean;
    }): Promise<PluginManagedProjectResolution> => {
      const plugin = await db
        .select({
          id: plugins.id,
          pluginKey: plugins.pluginKey,
          manifestJson: plugins.manifestJson,
          status: plugins.status,
        })
        .from(plugins)
        .where(eq(plugins.id, input.pluginId))
        .then((rows) => rows[0] ?? null);
      if (
        !plugin ||
        plugin.pluginKey !== input.pluginKey ||
        plugin.status !== "ready"
      ) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const declaration = plugin.manifestJson.projects?.find((project) => project.projectKey === input.projectKey);
      if (!declaration) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const defaults = buildManagedProjectDefaults(declaration);
      const existingBinding = await db
        .select()
        .from(pluginManagedResources)
        .where(and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.pluginId, input.pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, input.projectKey),
        ))
        .then((rows) => rows[0] ?? null);

      if (existingBinding) {
        const existingProject = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, input.companyId), eq(projects.id, existingBinding.resourceId)))
          .then((rows) => rows[0] ?? null);
        if (existingProject) {
          if (input.reset) {
            await db
              .update(projects)
              .set({
                name: declaration.displayName,
                description: declaration.description ?? null,
                status: declaration.status ?? "in_progress",
                color: declaration.color ?? null,
                updatedAt: new Date(),
              })
              .where(and(eq(projects.companyId, input.companyId), eq(projects.id, existingBinding.resourceId)));
          }
          if (input.createIfMissing !== false) {
            await db
              .update(pluginManagedResources)
              .set({ defaultsJson: defaults, updatedAt: new Date() })
              .where(eq(pluginManagedResources.id, existingBinding.id));
          }
          const project = await getProjectById(existingBinding.resourceId);
          return {
            pluginKey: input.pluginKey,
            resourceKind: "project",
            resourceKey: input.projectKey,
            companyId: input.companyId,
            projectId: project?.id ?? existingBinding.resourceId,
            project: project ? toPublicProject(project) : null,
            status: input.reset ? "reset" : "resolved",
          };
        }

        if (input.createIfMissing === false) {
          return {
            pluginKey: input.pluginKey,
            resourceKind: "project",
            resourceKey: input.projectKey,
            companyId: input.companyId,
            projectId: null,
            project: null,
            status: "missing",
          };
        }

        const project = await createProject(input.companyId, {
          name: declaration.displayName,
          description: declaration.description ?? null,
          status: declaration.status ?? "in_progress",
          color: declaration.color ?? undefined,
        });
        await db
          .update(pluginManagedResources)
          .set({ resourceId: project.id, defaultsJson: defaults, updatedAt: new Date() })
          .where(eq(pluginManagedResources.id, existingBinding.id));
        const hydrated = await getProjectById(project.id);
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: hydrated?.id ?? project.id,
          project: hydrated ? toPublicProject(hydrated) : null,
          status: "relinked",
        };
      }

      if (input.createIfMissing === false) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const project = await createProject(input.companyId, {
        name: declaration.displayName,
        description: declaration.description ?? null,
        status: declaration.status ?? "in_progress",
        color: declaration.color ?? undefined,
      });
      await db.insert(pluginManagedResources).values({
        companyId: input.companyId,
        pluginId: input.pluginId,
        pluginKey: input.pluginKey,
        resourceKind: "project",
        resourceKey: input.projectKey,
        resourceId: project.id,
        defaultsJson: defaults,
      });
      const hydrated = await getProjectById(project.id);
      return {
        pluginKey: input.pluginKey,
        resourceKind: "project",
        resourceKey: input.projectKey,
        companyId: input.companyId,
        projectId: hydrated?.id ?? project.id,
        project: hydrated ? toPublicProject(hydrated) : null,
        status: "created",
      };
    },

    create: createProject,

    update: async (
      id: string,
      data: Partial<typeof projects.$inferInsert> & { goalIds?: string[] },
    ): Promise<InternalProject | null> => {
      const { goalIds: inputGoalIds, ...projectData } = data;
      const existingProject = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existingProject) return null;

      if (projectData.name !== undefined) {
        const existingShortname = normalizeProjectUrlKey(existingProject.name);
        const nextShortname = normalizeProjectUrlKey(projectData.name);
        if (existingShortname !== nextShortname) {
          const existingProjects = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(eq(projects.companyId, existingProject.companyId));
          projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects, {
            excludeProjectId: id,
          });
        }
      }

      const updates: Partial<typeof projects.$inferInsert> = {
        ...projectData,
        updatedAt: new Date(),
      };

      const row = await db
        .update(projects)
        .set(updates)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      if (inputGoalIds !== undefined) {
        await syncGoalLinks(db, id, row.companyId, inputGoalIds);
      }

      const [withGoals] = await attachGoals(db, [row]);
      const [enriched] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
      return enriched ?? null;
    },

    remove: (id: string) =>
      db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => {
          const row = rows[0] ?? null;
          if (!row) return null;
          return { ...row, urlKey: deriveProjectUrlKey(row.name, row.id) };
        }),

    listWorkspaces: async (projectId: string): Promise<InternalProjectWorkspace[]> => {
      const rows = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId));
      return rows.map(toWorkspace);
    },

    createWorkspace: async (
      projectId: string,
      data: CreateWorkspaceInput,
    ): Promise<InternalProjectWorkspace | null> => {
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) return null;

      const cwd = normalizeWorkspaceCwd(data.cwd);
      const repoUrl = readNonEmptyString(data.repoUrl);
      if (!cwd && !repoUrl) return null;

      const existing = await db
        .select({ id: projectWorkspaces.id })
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .then((rows) => rows[0] ?? null);
      if (existing) return null;

      const created = await db
        .insert(projectWorkspaces)
        .values({
          companyId: project.companyId,
          projectId,
          cwd: cwd ?? null,
          repoUrl: repoUrl ?? null,
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      return created ? toWorkspace(created) : null;
    },

    updateWorkspace: async (
      projectId: string,
      workspaceId: string,
      data: UpdateWorkspaceInput,
    ): Promise<InternalProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextCwd =
        data.cwd !== undefined
          ? normalizeWorkspaceCwd(data.cwd)
          : normalizeWorkspaceCwd(existing.cwd);
      const nextRepoUrl =
        data.repoUrl !== undefined
          ? readNonEmptyString(data.repoUrl)
          : readNonEmptyString(existing.repoUrl);
      if (!nextCwd && !nextRepoUrl) return null;

      const patch: Partial<typeof projectWorkspaces.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (data.cwd !== undefined) patch.cwd = nextCwd ?? null;
      if (data.repoUrl !== undefined) patch.repoUrl = nextRepoUrl ?? null;

      const updated = await db
        .update(projectWorkspaces)
        .set(patch)
        .where(eq(projectWorkspaces.id, workspaceId))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? toWorkspace(updated) : null;
    },

    clearWorkspaces: (projectId: string) =>
      db
        .delete(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .returning({ id: projectWorkspaces.id }),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { project: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const row = await db
          .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
          .from(projects)
          .where(and(eq(projects.id, raw), eq(projects.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) return { project: null, ambiguous: false } as const;
        return {
          project: { id: row.id, companyId: row.companyId, urlKey: deriveProjectUrlKey(row.name, row.id) },
          ambiguous: false,
        } as const;
      }

      const urlKey = normalizeProjectUrlKey(raw);
      if (!urlKey) {
        return { project: null, ambiguous: false } as const;
      }

      const rows = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      const matches = rows.filter((row) => deriveProjectUrlKey(row.name, row.id) === urlKey);
      if (matches.length === 1) {
        const match = matches[0]!;
        return {
          project: { id: match.id, companyId: match.companyId, urlKey: deriveProjectUrlKey(match.name, match.id) },
          ambiguous: false,
        } as const;
      }
      if (matches.length > 1) {
        return { project: null, ambiguous: true } as const;
      }
      return { project: null, ambiguous: false } as const;
    },
  };
}
