import { and, eq, inArray, ne } from "drizzle-orm";
import {
  agents,
  companySecrets,
  projects,
  routines,
  tasks,
  type companySecretBindings,
} from "@paperclipai/db";
import {
  type CompanySecretBindingTarget,
  type RemoteSecretImportConflict,
  type SecretBindingTargetType,
  type SecretProvider,
  isCanonicalUuid,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { readTaskExecutionRun, resolveTaskExecutionRunIdentityById } from "./task-execution-run-service.js";
import { requireExactOpaqueSecretReference } from "./secrets.js";
import { assertSelectableProviderConfig } from "./secret-resolution-errors.js";
import { type SecretsContext } from "./secrets.js";
import { buildSecretsSecretRecordQueries } from "./secret-record-queries.js";
import { buildSecretsSecretValueResolution } from "./secret-value-resolution.js";

export function buildSecretsSecretBindingResolution(
  scope: SecretsContext &
    ReturnType<typeof buildSecretsSecretRecordQueries> &
    ReturnType<typeof buildSecretsSecretValueResolution>,
) {
  type NormalizeEnvOptions = {
    strictMode?: boolean;
    fieldPath?: string;
  };

  function collectTargetIds(
    bindings: Array<typeof companySecretBindings.$inferSelect>,
    targetType: SecretBindingTargetType,
  ) {
    return [
      ...new Set(
        bindings
          .filter((binding) => binding.targetType === targetType)
          .map((binding) => binding.targetId)
          .filter(isCanonicalUuid),
      ),
    ];
  }

  async function buildBindingTargetMap(
    companyId: string,
    bindings: Array<typeof companySecretBindings.$inferSelect>,
  ) {
    const targetMap = new Map<string, CompanySecretBindingTarget>();
    const setTarget = (target: CompanySecretBindingTarget) => {
      targetMap.set(`${target.type}:${target.id}`, target);
    };
    const agentIds = collectTargetIds(bindings, "agent");
    if (agentIds.length > 0) {
      const rows = await scope.db
        .select({
          id: agents.id,
          name: agents.name,
          title: agents.title,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      for (const row of rows) {
        setTarget({
          type: "agent",
          id: row.id,
          label: row.title ? `${row.name} (${row.title})` : row.name,
          routeTarget: { kind: "agent", id: row.id },
          status: row.status,
        });
      }
    }

    const projectIds = collectTargetIds(bindings, "project");
    if (projectIds.length > 0) {
      const rows = await scope.db
        .select({
          id: projects.id,
          name: projects.name,
          status: projects.status,
        })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
      for (const row of rows) {
        setTarget({
          type: "project",
          id: row.id,
          label: row.name,
          routeTarget: { kind: "project", id: row.id },
          status: row.status,
        });
      }
    }

    const routineIds = collectTargetIds(bindings, "routine");
    if (routineIds.length > 0) {
      const rows = await scope.db
        .select({
          id: routines.id,
          title: routines.title,
          status: routines.status,
        })
        .from(routines)
        .where(and(eq(routines.companyId, companyId), inArray(routines.id, routineIds)));
      for (const row of rows) {
        setTarget({
          type: "routine",
          id: row.id,
          label: row.title,
          routeTarget: { kind: "routine", id: row.id },
          status: row.status,
        });
      }
    }

    const taskIds = collectTargetIds(bindings, "task");
    const taskTargetIds = new Set(taskIds);
    const runIds = collectTargetIds(bindings, "run");
    const runTargets = await Promise.all(
      runIds.map(async (runId) => {
        const identity = await resolveTaskExecutionRunIdentityById(scope.db, runId);
        if (!identity || identity.companyId !== companyId) return null;
        const run = await readTaskExecutionRun(scope.db, identity);
        if (!run) return null;
        return { run, taskId: identity.taskId };
      }),
    );
    const linkedTaskIds = [
      ...new Set([...taskIds, ...runTargets.flatMap((target) => (target ? [target.taskId] : []))]),
    ];
    const taskRows =
      linkedTaskIds.length > 0
        ? await scope.db
            .select({
              id: tasks.id,
              taskNumber: tasks.taskNumber,
              identifier: tasks.identifier,
              title: tasks.title,
              boardPresentationStatus: tasks.boardPresentationStatus,
            })
            .from(tasks)
            .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, linkedTaskIds)))
        : [];
    const taskById = new Map(taskRows.map((row) => [row.id, row]));
    for (const row of taskRows) {
      if (taskTargetIds.has(row.id)) {
        setTarget({
          type: "task",
          id: row.id,
          label: row.title ?? row.identifier,
          routeTarget: { kind: "task", taskNumber: row.taskNumber, hash: null },
          status: row.boardPresentationStatus,
        });
      }
    }

    for (const target of runTargets) {
      if (target) {
        const task = taskById.get(target.taskId);
        setTarget({
          type: "run",
          id: target.run.runId,
          label: `Run ${target.run.runId.slice(0, 8)}`,
          routeTarget: task ? { kind: "task", taskNumber: task.taskNumber, hash: null } : null,
          status: target.run.status,
        });
      }
    }

    return targetMap;
  }

  async function buildRemoteImportConflictMaps(companyId: string, provider: SecretProvider) {
    const activeSecrets = await scope.db
      .select({
        id: companySecrets.id,
        name: companySecrets.name,
        key: companySecrets.key,
        provider: companySecrets.provider,
        providerConfigId: companySecrets.providerConfigId,
        externalRef: companySecrets.externalRef,
        status: companySecrets.status,
      })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), ne(companySecrets.status, "deleted")));
    const externalReferenceSecrets = activeSecrets.filter(
      (secret) => secret.provider === provider && typeof secret.externalRef === "string",
    );
    return {
      byProviderConfigExternalRef: new Map(
        externalReferenceSecrets.map((secret) => [
          remoteImportExternalRefKey(
            secret.providerConfigId,
            requireExactOpaqueSecretReference(secret.externalRef!, "Stored provider secret reference"),
          ),
          secret,
        ]),
      ),
      byName: new Map(activeSecrets.map((secret) => [secret.name, secret])),
      byKey: new Map(activeSecrets.map((secret) => [secret.key, secret])),
    };
  }

  function remoteImportExternalRefKey(providerConfigId: string | null | undefined, externalRef: string) {
    return `${providerConfigId ?? "default"}\0${requireExactOpaqueSecretReference(
      externalRef,
      "Provider secret reference",
    )}`;
  }

  function sanitizeRemoteProviderMetadata(
    provider: SecretProvider,
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!metadata || provider !== "aws_secrets_manager") return null;
    const safe: Record<string, unknown> = {};
    for (const key of ["createdDate", "lastAccessedDate", "lastChangedDate", "deletedDate"]) {
      const value = metadata[key];
      if (typeof value === "string" || value === null) safe[key] = value;
    }
    for (const key of ["hasDescription", "hasKmsKey", "tagCount"]) {
      const value = metadata[key];
      if (typeof value === "boolean" || typeof value === "number") safe[key] = value;
    }
    return Object.keys(safe).length > 0 ? safe : null;
  }

  function remoteImportConflictsFor(input: {
    providerConfigId: string | null;
    externalRef: string;
    name: string;
    key: string;
    maps: Awaited<ReturnType<typeof buildRemoteImportConflictMaps>>;
  }): RemoteSecretImportConflict[] {
    const conflicts: RemoteSecretImportConflict[] = [];
    const duplicate = input.maps.byProviderConfigExternalRef.get(
      remoteImportExternalRefKey(input.providerConfigId, input.externalRef),
    );
    if (duplicate) {
      conflicts.push({
        type: "exact_reference",
        existingSecretId: duplicate.id,
        message: "An existing secret already links this exact provider reference.",
      });
      return conflicts;
    }
    const nameConflict = input.maps.byName.get(input.name);
    if (nameConflict) {
      conflicts.push({
        type: "name",
        existingSecretId: nameConflict.id,
        message: `Secret name already exists: ${input.name}`,
      });
    }
    const keyConflict = input.maps.byKey.get(input.key);
    if (keyConflict) {
      conflicts.push({
        type: "key",
        existingSecretId: keyConflict.id,
        message: `Secret key already exists: ${input.key}`,
      });
    }
    return conflicts;
  }

  async function getRemoteImportProviderConfig(companyId: string, providerConfigId: string) {
    const providerConfig = await scope.getProviderConfigById(providerConfigId);
    if (!providerConfig) throw notFound("Provider vault not found");
    const provider = providerConfig.provider as SecretProvider;
    assertSelectableProviderConfig(providerConfig, companyId, provider);
    return {
      providerConfig,
      provider,
      runtimeConfig: scope.toProviderVaultRuntimeConfig(providerConfig),
    };
  }

  return {
    collectTargetIds,
    buildBindingTargetMap,
    buildRemoteImportConflictMaps,
    remoteImportExternalRefKey,
    sanitizeRemoteProviderMetadata,
    remoteImportConflictsFor,
    getRemoteImportProviderConfig,
  };
}
