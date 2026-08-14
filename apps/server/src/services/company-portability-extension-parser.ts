import {
  PERMISSION_KEYS,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  taskCommentAuthorTypeSchema,
  taskCommentMetadataSchema,
  taskCommentPresentationSchema,
  type CompanyPortabilityAgentManifestEntry,
  type CompanyPortabilityTaskCommentManifestEntry,
  type CompanyPortabilityTaskManifestEntry,
  type CompanyPortabilityTaskRoutineManifestEntry,
  type CompanyPortabilityTaskRoutineTriggerManifestEntry,
  type PermissionKey,
  type RoutineVariable,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { validateCron } from "./cron.js";
import { isPlainRecord, asString, asBoolean } from "./company-portability-format-support.js";
import { stripEmptyValues } from "./company-portability-selection.js";

export type PortableAgentPermissionGrant = CompanyPortabilityAgentManifestEntry["permissionGrants"][number];

export const VALID_PERMISSION_KEYS = new Set<PermissionKey>(PERMISSION_KEYS);

export function normalizePortablePermissionGrants(value: unknown): PortableAgentPermissionGrant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PortableAgentPermissionGrant[] => {
    if (!isPlainRecord(entry)) return [];
    const permissionKey = asString(entry.permissionKey);
    if (!permissionKey || !VALID_PERMISSION_KEYS.has(permissionKey as PermissionKey)) return [];
    return [
      {
        permissionKey: permissionKey as PermissionKey,
        scope: isPlainRecord(entry.scope) ? entry.scope : null,
      },
    ];
  });
}

export function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function assertExactPortableKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record)
    .filter((key) => !allowedSet.has(key))
    .sort();
  if (unknown.length > 0) {
    throw unprocessable(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  }
}

export function parseExactPortableBooleanMap<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, boolean> {
  if (!isPlainRecord(value)) {
    throw unprocessable(`${label} must be an object`);
  }
  assertExactPortableKeys(value, keys, label);
  const missing = keys.filter((key) => !hasOwn(value, key));
  if (missing.length > 0) {
    throw unprocessable(`${label} is missing required fields: ${missing.join(", ")}`);
  }
  const result = {} as Record<Key, boolean>;
  for (const key of keys) {
    if (typeof value[key] !== "boolean") {
      throw unprocessable(`${label}.${key} must be boolean`);
    }
    result[key] = value[key] as boolean;
  }
  return result;
}

export function materializePortableBooleanMap<Key extends string>(
  keys: readonly Key[],
  value: Partial<Record<Key, boolean>>,
): Record<Key, boolean> {
  return Object.fromEntries(keys.map((key) => [key, value[key] === true])) as Record<Key, boolean>;
}

export function derivePortableCommentAuthorType(value: Record<string, unknown>) {
  const explicit = taskCommentAuthorTypeSchema.safeParse(value.authorType);
  if (explicit.success) return explicit.data;
  return asString(value.authorAgentSlug) ? "agent" : asString(value.authorUserId) ? "user" : "system";
}

export function readPortableTaskComments(
  value: unknown,
  warnings: string[],
  sourceLabel: string,
): CompanyPortabilityTaskCommentManifestEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${sourceLabel} comments were ignored because they are not an array.`);
    return [];
  }

  const comments: CompanyPortabilityTaskCommentManifestEntry[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainRecord(entry)) {
      warnings.push(`${sourceLabel} comment ${index + 1} was ignored because it is not an object.`);
      continue;
    }
    const body = asString(entry.body);
    if (!body) {
      warnings.push(`${sourceLabel} comment ${index + 1} was ignored because it has no body.`);
      continue;
    }
    const presentation =
      entry.presentation == null ? null : taskCommentPresentationSchema.safeParse(entry.presentation);
    if (presentation && !presentation.success) {
      warnings.push(`${sourceLabel} comment ${index + 1} has invalid presentation metadata and was ignored.`);
      continue;
    }
    const metadata = entry.metadata == null ? null : taskCommentMetadataSchema.safeParse(entry.metadata);
    if (metadata && !metadata.success) {
      warnings.push(`${sourceLabel} comment ${index + 1} has invalid hidden metadata and was ignored.`);
      continue;
    }
    const createdAt = asString(entry.createdAt);
    comments.push({
      body,
      authorType: derivePortableCommentAuthorType(entry),
      authorAgentSlug: asString(entry.authorAgentSlug),
      authorUserId: asString(entry.authorUserId),
      presentation: presentation ? presentation.data : null,
      metadata: metadata ? metadata.data : null,
      createdAt: createdAt && Number.isNaN(Date.parse(createdAt)) ? null : createdAt,
    });
  }
  return comments;
}

export function normalizeRoutineTriggerExtension(
  value: unknown,
): CompanyPortabilityTaskRoutineTriggerManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const kind = asString(value.kind);
  if (!kind) return null;
  return {
    kind,
    label: asString(value.label),
    enabled: asBoolean(value.enabled) ?? true,
    cronExpression: asString(value.cronExpression),
    timezone: asString(value.timezone),
    signingMode: asString(value.signingMode),
    replayWindowSec: asInteger(value.replayWindowSec),
  };
}

export function normalizeRoutineVariableExtension(value: unknown): RoutineVariable | null {
  if (!isPlainRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  const type = asString(value.type) ?? "text";
  if (!["text", "textarea", "number", "boolean", "select"].includes(type)) return null;
  const options = Array.isArray(value.options)
    ? value.options.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  const defaultValue =
    typeof value.defaultValue === "string" ||
    typeof value.defaultValue === "number" ||
    typeof value.defaultValue === "boolean"
      ? value.defaultValue
      : null;
  return {
    name,
    label: asString(value.label),
    type: type as RoutineVariable["type"],
    defaultValue,
    required: asBoolean(value.required) ?? true,
    options,
  };
}

export function normalizeRoutineExtension(value: unknown): CompanyPortabilityTaskRoutineManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  if (hasOwn(value, "contextAccessMask")) {
    throw unprocessable("Routine manifest contains unsupported fields: contextAccessMask");
  }
  const triggers = Array.isArray(value.triggers)
    ? value.triggers
        .map((entry) => normalizeRoutineTriggerExtension(entry))
        .filter((entry): entry is CompanyPortabilityTaskRoutineTriggerManifestEntry => entry !== null)
    : [];
  const variables = Array.isArray(value.variables)
    ? value.variables
        .map((entry) => normalizeRoutineVariableExtension(entry))
        .filter((entry): entry is RoutineVariable => entry !== null)
    : null;
  const routine = {
    concurrencyPolicy: asString(value.concurrencyPolicy),
    catchUpPolicy: asString(value.catchUpPolicy),
    variables,
    triggers,
  };
  return stripEmptyValues(routine) ? routine : null;
}

export function resolvePortableRoutineDefinition(
  task: Pick<CompanyPortabilityTaskManifestEntry, "slug" | "recurring" | "routine">,
) {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!task.recurring) {
    return { routine: null, warnings, errors };
  }

  const routine = task.routine
    ? {
        concurrencyPolicy: task.routine.concurrencyPolicy,
        catchUpPolicy: task.routine.catchUpPolicy,
        variables: task.routine.variables ?? null,
        triggers: [...task.routine.triggers],
      }
    : {
        concurrencyPolicy: null,
        catchUpPolicy: null,
        variables: null,
        triggers: [] as CompanyPortabilityTaskRoutineTriggerManifestEntry[],
      };

  if (routine.concurrencyPolicy && !ROUTINE_CONCURRENCY_POLICIES.includes(routine.concurrencyPolicy as any)) {
    errors.push(
      `Recurring task ${task.slug} uses unsupported routine concurrencyPolicy "${routine.concurrencyPolicy}".`,
    );
  }
  if (routine.catchUpPolicy && !ROUTINE_CATCH_UP_POLICIES.includes(routine.catchUpPolicy as any)) {
    errors.push(
      `Recurring task ${task.slug} uses unsupported routine catchUpPolicy "${routine.catchUpPolicy}".`,
    );
  }

  for (const trigger of routine.triggers) {
    if (!ROUTINE_TRIGGER_KINDS.includes(trigger.kind as any)) {
      errors.push(`Recurring task ${task.slug} uses unsupported trigger kind "${trigger.kind}".`);
      continue;
    }
    if (trigger.kind === "schedule") {
      if (!trigger.cronExpression || !trigger.timezone) {
        errors.push(`Recurring task ${task.slug} has a schedule trigger missing cronExpression/timezone.`);
        continue;
      }
      const cronError = validateCron(trigger.cronExpression);
      if (cronError) {
        errors.push(`Recurring task ${task.slug} has an invalid schedule trigger: ${cronError}`);
      }
      continue;
    }
    if (
      trigger.kind === "webhook" &&
      trigger.signingMode &&
      !ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)
    ) {
      errors.push(
        `Recurring task ${task.slug} uses unsupported webhook signingMode "${trigger.signingMode}".`,
      );
    }
  }

  if (routine.triggers.length === 0) {
    errors.push(`Recurring task ${task.slug} requires at least one canonical routine trigger.`);
  }

  return { routine, warnings, errors };
}
