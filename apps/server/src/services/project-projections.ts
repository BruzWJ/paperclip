import { and, eq, inArray, sql } from "drizzle-orm";
import {
  budgetPolicies,
  goals,
  pluginManagedResources,
  plugins,
  projectGoals,
  projectWorkspaces,
  tasks,
  type Db,
  type projects,
} from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  compareMoneyAmounts,
  parseMoneyAmount,
  type BudgetWindowKind,
  type MoneyAmount,
  type PluginManagedProjectDeclaration,
  type ProjectBudgetSummary,
  type ProjectCodebase,
  type ProjectGoalRef,
  type ProjectManagedByPlugin,
} from "@paperclipai/shared";

export type ProjectRow = typeof projects.$inferSelect;

export type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;

export type CreateWorkspaceInput = {
  cwd?: string | null;
  repoUrl?: string | null;
};

export type UpdateWorkspaceInput = Partial<CreateWorkspaceInput>;

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

/** Complete server-side project aggregate, including runtime-only workspace data. */
export interface InternalProject extends ProjectRow {
  goalIds: string[];
  goals: ProjectGoalRef[];
  codebase: ProjectCodebase;
  workspaces: InternalProjectWorkspace[];
  primaryWorkspace: InternalProjectWorkspace | null;
  managedByPlugin: ProjectManagedByPlugin | null;
  taskCount?: number;
  budget?: ProjectBudgetSummary | null;
}

export type InternalProjectWithGoals = Omit<
  InternalProject,
  "codebase" | "workspaces" | "primaryWorkspace" | "managedByPlugin"
>;

export type InternalProjectRuntimeFields = {
  codebase?: unknown;
  workspaces?: unknown;
  primaryWorkspace?: unknown;
};

/** Public-safe project projection for HTTP and plugin-host reads. */
export type PublicProject = Omit<InternalProject, keyof InternalProjectRuntimeFields>;

export function toPublicProject(project: InternalProject): PublicProject;

export function toPublicProject<T extends object>(project: T): Omit<T, keyof InternalProjectRuntimeFields>;

export function toPublicProject<T extends object>(project: T) {
  const {
    codebase: _codebase,
    workspaces: _workspaces,
    primaryWorkspace: _primaryWorkspace,
    ...publicProject
  } = project as T & InternalProjectRuntimeFields;
  return publicProject as Omit<T, keyof InternalProjectRuntimeFields>;
}

/** Batch-load goal refs for a set of projects. */
export async function attachGoals(db: Db, rows: ProjectRow[]): Promise<InternalProjectWithGoals[]> {
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
      goalIds: g.map((x) => x.id),
      goals: g,
    };
  });
}

export function toWorkspace(row: ProjectWorkspaceRow): InternalProjectWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function deriveProjectCodebase(input: {
  primaryWorkspace: InternalProjectWorkspace | null;
  fallbackWorkspaces: InternalProjectWorkspace[];
}): ProjectCodebase {
  const primaryWorkspace = input.primaryWorkspace ?? input.fallbackWorkspaces[0] ?? null;

  return {
    workspaceId: primaryWorkspace?.id ?? null,
    repoUrl: primaryWorkspace?.repoUrl ?? null,
    localFolder: primaryWorkspace?.cwd ?? null,
  };
}

export function pickPrimaryWorkspace(rows: ProjectWorkspaceRow[]): InternalProjectWorkspace | null {
  if (rows.length === 0) return null;
  return toWorkspace(rows[0]!);
}

/** Batch-load workspace refs for a set of projects. */
export async function attachWorkspaces(db: Db, rows: InternalProjectWithGoals[]): Promise<InternalProject[]> {
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
    .where(
      and(
        eq(pluginManagedResources.resourceKind, "project"),
        inArray(pluginManagedResources.resourceId, projectIds),
      ),
    );
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

export type TaskCountRow = { projectId: string | null; count: number };

export type ProjectBudgetRow = {
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
export async function attachListMetrics(
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

  const { taskCountByProjectId, budgetByProjectId } = buildProjectListMetricMaps(taskCountRows, budgetRows);

  return rows.map((row) => ({
    ...row,
    taskCount: taskCountByProjectId.get(row.id) ?? 0,
    budget: budgetByProjectId.get(row.id) ?? null,
  }));
}

/** Sync the project_goals join table for a single project. */
export async function syncGoalLinks(db: Db, projectId: string, companyId: string, goalIds: string[]) {
  // Delete existing links
  await db.delete(projectGoals).where(eq(projectGoals.projectId, projectId));

  // Insert new links
  if (goalIds.length > 0) {
    await db.insert(projectGoals).values(goalIds.map((goalId) => ({ projectId, goalId, companyId })));
  }
}

export function buildManagedProjectDefaults(declaration: PluginManagedProjectDeclaration) {
  return {
    projectKey: declaration.projectKey,
    displayName: declaration.displayName,
    description: declaration.description ?? null,
    status: declaration.status ?? "in_progress",
    color: declaration.color ?? null,
    settings: declaration.settings ?? {},
  };
}
