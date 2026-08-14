import type { Db } from "@paperclipai/db";
import { routineTriggers } from "@paperclipai/db";
import {
  type PluginManagedRoutineDeclaration,
  type RoutineStatus,
  ROUTINE_STATUSES,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { buildPluginManagedRoutinesPluginManagedRoutineBindings } from "./plugin-managed-routine-bindings.js";
import {
  type PluginManagedRoutineServiceOptions,
  type RoutineOverrides,
  triggerInput,
} from "./plugin-managed-routine-bindings.js";
import { routineService } from "./routines.js";

export function createPluginManagedRoutinesContext(db: Db, options: PluginManagedRoutineServiceOptions) {
  const pluginKey = options.manifest.id;

  const routinesSvc = routineService(db, {
    ordinaryTasks: options.ordinaryTasks,
    secretsRuntime: options.secretsRuntime,
  });

  return { db, options, pluginKey, routinesSvc };
}

export type PluginManagedRoutinesContext = ReturnType<typeof createPluginManagedRoutinesContext>;

export function buildPluginManagedRoutinesPluginManagedRoutineCreation(
  scope: PluginManagedRoutinesContext &
    ReturnType<typeof buildPluginManagedRoutinesPluginManagedRoutineBindings>,
) {
  const {
    db,
    options,
    pluginKey,
    routinesSvc,
    declarationFor,
    upsertBinding,
    getRoutineWithManagedBy,
    resolveRefs,
    resolution,
  } = scope;

  async function ensureDefaultTriggers(routineId: string, declaration: PluginManagedRoutineDeclaration) {
    const triggers = declaration.triggers ?? [];
    if (triggers.length === 0) return;
    const existingCount = await db
      .select({ id: routineTriggers.id })
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, routineId))
      .limit(1)
      .then((rows) => rows.length);
    if (existingCount > 0) return;

    for (const trigger of triggers) {
      await routinesSvc.createTrigger(routineId, triggerInput(trigger), {
        type: "system",
      });
    }
  }

  async function createManagedRoutine(
    companyId: string,
    declaration: PluginManagedRoutineDeclaration,
    overrides?: RoutineOverrides,
  ) {
    const refs = await resolveRefs(companyId, declaration, overrides);
    if (refs.missingRefs.length > 0) {
      return resolution(companyId, declaration, null, "missing_refs", refs.missingRefs);
    }

    const created = await routinesSvc.create(
      companyId,
      {
        projectId: refs.projectId,
        goalId: declaration.goalId ?? null,
        title: declaration.title,
        description: declaration.description ?? null,
        assigneeAgentId: refs.assigneeAgentId,
        priority: declaration.priority ?? "medium",
        status: declaration.status ?? (refs.assigneeAgentId ? "active" : "paused"),
        concurrencyPolicy: declaration.concurrencyPolicy ?? "coalesce_if_active",
        catchUpPolicy: declaration.catchUpPolicy ?? "skip_missed",
        variables: declaration.variables ?? [],
      },
      { type: "system" },
    );
    await upsertBinding(companyId, declaration, created.id);
    await ensureDefaultTriggers(created.id, declaration);
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.created",
      entityType: "routine",
      entityId: created.id,
      details: {
        sourcePluginKey: pluginKey,
        managedResourceKey: declaration.routineKey,
        assigneeAgentId: refs.assigneeAgentId,
        projectId: refs.projectId,
      },
    });
    return resolution(companyId, declaration, routine, "created");
  }

  async function get(routineKey: string, companyId: string) {
    const declaration = declarationFor(routineKey);
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    return resolution(companyId, declaration, routine, routine ? "resolved" : "missing");
  }

  return { ensureDefaultTriggers, createManagedRoutine, get };
}

export function buildPluginManagedRoutinesPluginManagedRoutineOperations(
  scope: PluginManagedRoutinesContext &
    ReturnType<typeof buildPluginManagedRoutinesPluginManagedRoutineBindings> &
    ReturnType<typeof buildPluginManagedRoutinesPluginManagedRoutineCreation>,
) {
  const {
    db,
    options,
    pluginKey,
    routinesSvc,
    declarationFor,
    upsertBinding,
    getRoutineWithManagedBy,
    resolveRefs,
    resolution,
    ensureDefaultTriggers,
    createManagedRoutine,
    get,
  } = scope;

  async function reconcile(routineKey: string, companyId: string, overrides?: RoutineOverrides) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (current.routine) {
      await upsertBinding(companyId, declaration, current.routine.id);
      await ensureDefaultTriggers(current.routine.id, declaration);
      return current;
    }
    return createManagedRoutine(companyId, declaration, overrides);
  }

  async function reset(routineKey: string, companyId: string, overrides?: RoutineOverrides) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (!current.routine) {
      return createManagedRoutine(companyId, declaration, overrides);
    }

    const refs = await resolveRefs(companyId, declaration, overrides);
    if (refs.missingRefs.length > 0) {
      return resolution(companyId, declaration, current.routine, "missing_refs", refs.missingRefs);
    }
    const updated = await routinesSvc.update(
      current.routine.id,
      {
        baseRevisionId:
          current.routine.latestRevisionId ??
          (() => {
            throw new Error("Managed routine has no canonical revision");
          })(),
        projectId: refs.projectId,
        goalId: declaration.goalId ?? null,
        title: declaration.title,
        description: declaration.description ?? null,
        assigneeAgentId: refs.assigneeAgentId,
        priority: declaration.priority ?? "medium",
        status: declaration.status ?? (refs.assigneeAgentId ? "active" : "paused"),
        concurrencyPolicy: declaration.concurrencyPolicy ?? "coalesce_if_active",
        catchUpPolicy: declaration.catchUpPolicy ?? "skip_missed",
        variables: declaration.variables ?? [],
      },
      { type: "system" },
    );
    if (!updated) throw notFound("Managed routine not found");
    await upsertBinding(companyId, declaration, updated.id);
    await ensureDefaultTriggers(updated.id, declaration);
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.reset",
      entityType: "routine",
      entityId: updated.id,
      details: {
        sourcePluginKey: pluginKey,
        managedResourceKey: declaration.routineKey,
        assigneeAgentId: refs.assigneeAgentId,
        projectId: refs.projectId,
      },
    });
    return resolution(companyId, declaration, routine, "reset");
  }

  async function update(routineKey: string, companyId: string, patch: { status?: RoutineStatus }) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (!current.routine) throw notFound("Managed routine not found");
    if (!current.routine.latestRevisionId) {
      throw new Error("Managed routine has no canonical revision");
    }
    const updatePatch: {
      status?: RoutineStatus;
      baseRevisionId: string;
    } = { baseRevisionId: current.routine.latestRevisionId };
    if (patch.status !== undefined) {
      if (!ROUTINE_STATUSES.includes(patch.status)) {
        throw unprocessable("Invalid routine status");
      }
      updatePatch.status = patch.status;
    }
    const updated = await routinesSvc.update(current.routine.id, updatePatch, {
      type: "system",
    });
    if (!updated) throw notFound("Managed routine not found");
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.updated",
      entityType: "routine",
      entityId: updated.id,
      details: {
        sourcePluginKey: pluginKey,
        managedResourceKey: declaration.routineKey,
        status: updated.status,
      },
    });
    const routine = await getRoutineWithManagedBy(companyId, declaration);
    if (!routine) {
      throw new Error(`Updated managed routine disappeared: ${updated.id}`);
    }
    return routine;
  }

  async function run(routineKey: string, companyId: string, overrides?: RoutineOverrides) {
    const declaration = declarationFor(routineKey);
    const current = await get(routineKey, companyId);
    if (!current.routine) throw notFound("Managed routine not found");
    const run = await routinesSvc.runRoutine(
      current.routine.id,
      {
        source: "manual",
        assigneeAgentId: overrides?.assigneeAgentId,
        projectId: overrides?.projectId,
      },
      { type: "system" },
    );
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: {
        sourcePluginKey: pluginKey,
        managedResourceKey: declaration.routineKey,
        routineId: current.routine.id,
        status: run.status,
      },
    });
    return run;
  }

  return { reconcile, reset, update, run };
}

export function createPluginManagedRoutinesMethods1(
  scope: PluginManagedRoutinesContext &
    ReturnType<typeof buildPluginManagedRoutinesPluginManagedRoutineBindings> &
    ReturnType<typeof buildPluginManagedRoutinesPluginManagedRoutineCreation> &
    ReturnType<typeof buildPluginManagedRoutinesPluginManagedRoutineOperations>,
) {
  const { get, reconcile, reset, update, run } = scope;

  return {
    get,

    reconcile,

    reset,

    update,

    run,
  };
}

export function pluginManagedRoutineService(db: Db, options: PluginManagedRoutineServiceOptions) {
  const context = createPluginManagedRoutinesContext(db, options);
  const helpers1 = buildPluginManagedRoutinesPluginManagedRoutineBindings(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildPluginManagedRoutinesPluginManagedRoutineCreation(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildPluginManagedRoutinesPluginManagedRoutineOperations(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createPluginManagedRoutinesMethods1(scope);
  return { ...methods1 };
}
