import { and, eq, inArray } from "drizzle-orm";
import { type Db, projects, pluginManagedResources, plugins, projectWorkspaces } from "@paperclipai/db";
import {
  isAbsoluteProjectFolder,
  isCanonicalUuid,
  isCanonicalProjectRepositoryUrl,
  type PluginManagedProjectResolution,
} from "@paperclipai/shared";
import {
  attachGoals,
  attachListMetrics,
  attachWorkspaces,
  buildManagedProjectDefaults,
  type CreateWorkspaceInput,
  type InternalProject,
  type InternalProjectWorkspace,
  syncGoalLinks,
  toPublicProject,
  toWorkspace,
  type UpdateWorkspaceInput,
} from "./project-projections.js";

export function projectService(db: Db) {
  const createProject = async (
    companyId: string,
    data: Omit<typeof projects.$inferInsert, "companyId"> & {
      goalIds?: string[];
    },
  ): Promise<InternalProject> => {
    const { goalIds: inputGoalIds, ...projectData } = data;

    // Note: color is intentionally NOT auto-assigned. New projects default to
    // `color = null` (neutral gray) unless an explicit color is supplied. See PAP-68.

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
    if (!isCanonicalUuid(id)) return null;
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
      return dedupedIds
        .map((id) => byId.get(id))
        .filter((project): project is InternalProject => Boolean(project));
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
      if (!plugin || plugin.pluginKey !== input.pluginKey || plugin.status !== "ready") {
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

      const declaration = plugin.manifestJson.projects?.find(
        (project) => project.projectKey === input.projectKey,
      );
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
        .where(
          and(
            eq(pluginManagedResources.companyId, input.companyId),
            eq(pluginManagedResources.pluginId, input.pluginId),
            eq(pluginManagedResources.resourceKind, "project"),
            eq(pluginManagedResources.resourceKey, input.projectKey),
          ),
        )
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
              .where(
                and(eq(projects.companyId, input.companyId), eq(projects.id, existingBinding.resourceId)),
              );
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
          .set({
            resourceId: project.id,
            defaultsJson: defaults,
            updatedAt: new Date(),
          })
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
          return row;
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

      if (
        (data.cwd != null && !isAbsoluteProjectFolder(data.cwd)) ||
        (data.repoUrl != null && !isCanonicalProjectRepositoryUrl(data.repoUrl))
      ) {
        return null;
      }
      const cwd = data.cwd ?? null;
      const repoUrl = data.repoUrl ?? null;
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
        .where(and(eq(projectWorkspaces.id, workspaceId), eq(projectWorkspaces.projectId, projectId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      if (
        (data.cwd != null && !isAbsoluteProjectFolder(data.cwd)) ||
        (data.repoUrl != null && !isCanonicalProjectRepositoryUrl(data.repoUrl))
      ) {
        return null;
      }
      const nextCwd = data.cwd !== undefined ? data.cwd : existing.cwd;
      const nextRepoUrl = data.repoUrl !== undefined ? data.repoUrl : existing.repoUrl;
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
  };
}
