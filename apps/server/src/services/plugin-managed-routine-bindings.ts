import { and, eq } from "drizzle-orm";
import { agents, pluginManagedResources, plugins, projects, routines } from "@paperclipai/db";
import type {
  PluginManagedResourceRef,
  PluginManagedRoutineDeclaration,
  PluginManagedRoutineResolution,
  Routine,
  CreateRoutineTrigger,
  RoutineManagedByPlugin,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import type { PluginManagedRoutinesContext } from "./plugin-managed-routines.js";
import type { OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import type { SecretsRuntimeConfig } from "../secrets/types.js";

export function buildPluginManagedRoutinesPluginManagedRoutineBindings(scope: PluginManagedRoutinesContext) {
  const { db, options, pluginKey } = scope;

  function declarationFor(routineKey: string) {
    const declaration = options.manifest.routines?.find((routine) => routine.routineKey === routineKey);
    if (!declaration) {
      throw notFound(`Managed routine declaration not found: ${routineKey}`);
    }
    return declaration;
  }

  async function getBinding(companyId: string, routineKey: string) {
    return db
      .select({
        id: pluginManagedResources.id,
        companyId: pluginManagedResources.companyId,
        pluginId: pluginManagedResources.pluginId,
        pluginKey: pluginManagedResources.pluginKey,
        resourceKind: pluginManagedResources.resourceKind,
        resourceKey: pluginManagedResources.resourceKey,
        resourceId: pluginManagedResources.resourceId,
        defaultsJson: pluginManagedResources.defaultsJson,
        manifestJson: plugins.manifestJson,
        createdAt: pluginManagedResources.createdAt,
        updatedAt: pluginManagedResources.updatedAt,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, options.pluginId),
          eq(pluginManagedResources.resourceKind, MANAGED_ROUTINE_RESOURCE_KIND),
          eq(pluginManagedResources.resourceKey, routineKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function upsertBinding(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    routineId: string,
  ) {
    const defaultsJson = buildRoutineDefaults(declaration);
    const existing = await getBinding(companyId, declaration.routineKey);
    if (existing) {
      return db
        .update(pluginManagedResources)
        .set({
          resourceId: routineId,
          defaultsJson,
          updatedAt: new Date(),
        })
        .where(eq(pluginManagedResources.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    }
    return db
      .insert(pluginManagedResources)
      .values({
        companyId,
        pluginId: options.pluginId,
        pluginKey,
        resourceKind: MANAGED_ROUTINE_RESOURCE_KIND,
        resourceKey: declaration.routineKey,
        resourceId: routineId,
        defaultsJson,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getRoutineWithManagedBy(companyId: string, declaration: PluginManagedRoutineDeclaration) {
    const binding = await getBinding(companyId, declaration.routineKey);
    if (!binding) return null;
    const routine = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.id, binding.resourceId)))
      .then((rows) => rows[0] ?? null);
    if (!routine) return null;
    return {
      ...routine,
      managedByPlugin: managedByPlugin(binding),
    } as Routine;
  }

  async function resolveAgentId(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    if (overrides?.assigneeAgentId !== undefined) {
      if (!overrides.assigneeAgentId) return { agentId: null, missingRef: null };
      const row = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, overrides.assigneeAgentId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Assignee agent not found");
      return { agentId: row.id, missingRef: null };
    }

    const ref = normalizeRef(pluginKey, declaration.assigneeRef, "agent");
    if (!ref) return { agentId: null, missingRef: null };
    const binding = await db
      .select({ resourceId: pluginManagedResources.resourceId })
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, options.pluginId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceKey, ref.resourceKey),
          eq(pluginManagedResources.lifecycleState, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!binding) return { agentId: null, missingRef: ref };
    const row = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, binding.resourceId)))
      .then((rows) => rows[0] ?? null);
    return row ? { agentId: row.id, missingRef: null } : { agentId: null, missingRef: ref };
  }

  async function resolveProjectId(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    if (overrides?.projectId !== undefined) {
      if (!overrides.projectId) return { projectId: null, missingRef: null };
      const row = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, overrides.projectId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Project not found");
      return { projectId: row.id, missingRef: null };
    }

    const ref = normalizeRef(pluginKey, declaration.projectRef, "project");
    if (!ref) return { projectId: null, missingRef: null };
    const binding = await db
      .select({ resourceId: pluginManagedResources.resourceId })
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, options.pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, ref.resourceKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!binding) return { projectId: null, missingRef: ref };
    const row = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, binding.resourceId)))
      .then((rows) => rows[0] ?? null);
    return row ? { projectId: row.id, missingRef: null } : { projectId: null, missingRef: ref };
  }

  async function resolveRefs(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    const [agent, project] = await Promise.all([
      resolveAgentId(companyId, declaration, overrides),
      resolveProjectId(companyId, declaration, overrides),
    ]);
    const missingRefs: PluginManagedResourceRef[] = [];
    if (agent.missingRef) missingRefs.push(agent.missingRef);
    if (project.missingRef) missingRefs.push(project.missingRef);
    return {
      assigneeAgentId: agent.agentId,
      projectId: project.projectId,
      missingRefs,
    };
  }

  function resolution(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    routine: Routine | null,
    status: PluginManagedRoutineResolution["status"],
    missingRefs: PluginManagedResourceRef[] = [],
  ): PluginManagedRoutineResolution {
    return {
      pluginKey,
      resourceKind: "routine",
      resourceKey: declaration.routineKey,
      companyId,
      routineId: routine?.id ?? null,
      routine,
      status,
      missingRefs,
    };
  }

  return {
    declarationFor,
    getBinding,
    upsertBinding,
    getRoutineWithManagedBy,
    resolveAgentId,
    resolveProjectId,
    resolveRefs,
    resolution,
  };
}

export const MANAGED_ROUTINE_RESOURCE_KIND = "routine";

export interface PluginManagedRoutineServiceOptions {
  pluginId: string;
  manifest: import("@paperclipai/shared").PaperclipPluginManifestV1;
  ordinaryTasks: OrdinaryTaskRuntime;
  secretsRuntime: SecretsRuntimeConfig;
}

export interface RoutineOverrides {
  assigneeAgentId?: string | null;
  projectId?: string | null;
}

export function buildRoutineDefaults(declaration: PluginManagedRoutineDeclaration) {
  return {
    routineKey: declaration.routineKey,
    title: declaration.title,
    description: declaration.description ?? null,
    assigneeRef: declaration.assigneeRef ?? null,
    projectRef: declaration.projectRef ?? null,
    goalId: declaration.goalId ?? null,
    status: declaration.status ?? null,
    priority: declaration.priority ?? "medium",
    concurrencyPolicy: declaration.concurrencyPolicy ?? "coalesce_if_active",
    catchUpPolicy: declaration.catchUpPolicy ?? "skip_missed",
    variables: declaration.variables ?? [],
    triggers: declaration.triggers ?? [],
    taskTemplate: declaration.taskTemplate ?? null,
  };
}

export function normalizeRef(
  pluginKey: string,
  ref: PluginManagedResourceRef | null | undefined,
  resourceKind: "agent" | "project",
) {
  if (!ref) return null;
  if (ref.resourceKind !== resourceKind) {
    throw unprocessable(`Managed routine ${resourceKind} ref must target ${resourceKind}`);
  }
  if (ref.pluginKey && ref.pluginKey !== pluginKey) {
    throw unprocessable("Managed routine refs must target the declaring plugin");
  }
  return { ...ref, pluginKey };
}

export function managedByPlugin(row: {
  id: string;
  pluginId: string;
  pluginKey: string;
  manifestJson: { displayName: string };
  resourceKey: string;
  defaultsJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}): RoutineManagedByPlugin {
  return {
    id: row.id,
    pluginId: row.pluginId,
    pluginKey: row.pluginKey,
    pluginDisplayName: row.manifestJson.displayName,
    resourceKind: "routine",
    resourceKey: row.resourceKey,
    defaultsJson: row.defaultsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function triggerInput(
  trigger: NonNullable<PluginManagedRoutineDeclaration["triggers"]>[number],
): CreateRoutineTrigger {
  if (trigger.kind === "schedule") {
    if (!trigger.cronExpression) {
      throw unprocessable("Managed schedule routine triggers require cronExpression");
    }
    return {
      kind: "schedule",
      label: trigger.label ?? null,
      enabled: trigger.enabled ?? true,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone ?? "UTC",
    };
  }
  if (trigger.kind === "webhook") {
    return {
      kind: "webhook",
      label: trigger.label ?? null,
      enabled: trigger.enabled ?? true,
      signingMode: (trigger.signingMode ?? "bearer") as Extract<
        CreateRoutineTrigger,
        { kind: "webhook" }
      >["signingMode"],
      replayWindowSec: trigger.replayWindowSec ?? 300,
    };
  }
  return {
    kind: "api",
    label: trigger.label ?? null,
    enabled: trigger.enabled ?? true,
  };
}
