import {
  type EnvBinding,
  type EnvSecretRefBinding,
  type RoutineEnvConfig,
  type RoutineRevision,
  type RoutineRevisionSnapshotTriggerV1,
  type RoutineVariable,
  type SecretVersionSelector,
} from "@paperclipai/shared";
import type { EnvDiffCounts, NamedEntityLookup, SecretLookup } from "@/lib/presentation-contracts";

interface RoutineFieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export function getActorLabel(revision: RoutineRevision): string {
  if (revision.createdByUserId) return "board";
  if (revision.createdByAgentId) return "agent";
  return "system";
}

export function resolveAgentName(agentId: string | null, lookup: NamedEntityLookup) {
  if (!agentId) return "Unassigned";
  return lookup.get(agentId)?.name ?? agentId;
}

export function resolveProjectName(projectId: string | null, lookup: NamedEntityLookup) {
  if (!projectId) return "No project";
  return lookup.get(projectId)?.name ?? projectId;
}

export function summarizeTriggerSnapshot(trigger: RoutineRevisionSnapshotTriggerV1): string {
  if (trigger.kind === "schedule") {
    return [trigger.cronExpression, trigger.timezone].filter(Boolean).join(" · ");
  }
  if (trigger.kind === "webhook") {
    const replay = trigger.replayWindowSec != null ? `replay ${trigger.replayWindowSec}s` : "";
    return [trigger.signingMode, replay].filter(Boolean).join(" · ");
  }
  return "API";
}

export function formatVariableDefault(variable: RoutineVariable): string {
  if (variable.defaultValue == null) return "—";
  return String(variable.defaultValue);
}

export function formatDirtyFieldList(labels: string[]): string {
  if (labels.length === 0) return "the routine";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function collectWebhookTriggerDifferences(
  target: RoutineRevision,
  current: RoutineRevision,
): string[] {
  const currentIds = new Set(current.snapshot.triggers.map((t) => t.id));
  return target.snapshot.triggers
    .filter((trigger) => trigger.kind === "webhook" && !currentIds.has(trigger.id))
    .map((trigger) => trigger.label ?? "webhook");
}

function describeSnapshotField(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function collectFieldChanges(
  left: RoutineRevision,
  right: RoutineRevision,
  agents: NamedEntityLookup,
  projects: NamedEntityLookup,
  secrets: SecretLookup,
): RoutineFieldChange[] {
  const oldRoutine = left.snapshot.routine;
  const newRoutine = right.snapshot.routine;
  const changes: RoutineFieldChange[] = [];
  const compareScalar = (
    label: string,
    oldVal: unknown,
    newVal: unknown,
    transform: (value: unknown) => string = describeSnapshotField,
  ) => {
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({
        field: label,
        oldValue: transform(oldVal),
        newValue: transform(newVal),
      });
    }
  };
  compareScalar("Title", oldRoutine.title, newRoutine.title);
  compareScalar("Priority", oldRoutine.priority, newRoutine.priority);
  compareScalar(
    "Default agent",
    resolveAgentName(oldRoutine.assigneeAgentId, agents),
    resolveAgentName(newRoutine.assigneeAgentId, agents),
  );
  compareScalar(
    "Project",
    resolveProjectName(oldRoutine.projectId, projects),
    resolveProjectName(newRoutine.projectId, projects),
  );
  compareScalar("Concurrency", oldRoutine.concurrencyPolicy, newRoutine.concurrencyPolicy);
  compareScalar("Catch-up", oldRoutine.catchUpPolicy, newRoutine.catchUpPolicy);
  compareScalar("Status", oldRoutine.status, newRoutine.status);
  if (JSON.stringify(oldRoutine.variables) !== JSON.stringify(newRoutine.variables)) {
    changes.push({
      field: "Variables",
      oldValue: summarizeVariables(oldRoutine.variables),
      newValue: summarizeVariables(newRoutine.variables),
    });
  }
  compareEnv(oldRoutine.env ?? null, newRoutine.env ?? null, secrets, changes);
  compareTriggers(left.snapshot.triggers, right.snapshot.triggers, changes);
  return changes;
}

export function formatRoutineFieldDiff(
  left: RoutineRevision,
  right: RoutineRevision,
  agents: NamedEntityLookup,
  projects: NamedEntityLookup,
  secrets: SecretLookup,
) {
  const changes = collectFieldChanges(left, right, agents, projects, secrets);
  return {
    oldText: changes.map((change) => `${change.field}: ${change.oldValue ?? "—"}`).join("\n"),
    newText: changes.map((change) => `${change.field}: ${change.newValue ?? "—"}`).join("\n"),
  };
}

export function normalizeEnv(env: RoutineEnvConfig | null): Record<string, EnvBinding> {
  if (!env) return {};
  return env;
}

function envBindingKind(binding: EnvBinding): "plain" | "secret_ref" {
  if (binding && typeof binding === "object" && "type" in binding && binding.type === "secret_ref") {
    return "secret_ref";
  }
  return "plain";
}

function asSecretRef(binding: EnvBinding): EnvSecretRefBinding | null {
  if (binding && typeof binding === "object" && "type" in binding && binding.type === "secret_ref") {
    return binding;
  }
  return null;
}

function formatVersionSelector(version: SecretVersionSelector | undefined): string {
  if (version == null || version === "latest") return "latest";
  return `v${version}`;
}

function describeSecretRef(ref: EnvSecretRefBinding, secrets: SecretLookup): string {
  const secret = secrets.get(ref.secretId);
  const name = secret?.name ?? "<missing-secret>";
  return `${name} ${formatVersionSelector(ref.version)}`;
}

function describeEnvBinding(binding: EnvBinding | undefined, secrets: SecretLookup): string {
  if (binding === undefined) return "—";
  const ref = asSecretRef(binding);
  if (ref) return `secret_ref → ${describeSecretRef(ref, secrets)}`;
  return "plain (set)";
}

export function summarizeEnv(env: RoutineEnvConfig | null): string {
  const entries = Object.entries(normalizeEnv(env));
  if (entries.length === 0) return "";
  const secretCount = entries.filter(([, binding]) => envBindingKind(binding) === "secret_ref").length;
  const keyLabel = entries.length === 1 ? "key" : "keys";
  if (secretCount === 0) return `${entries.length} ${keyLabel}`;
  return `${entries.length} ${keyLabel} (${secretCount} secret ${secretCount === 1 ? "ref" : "refs"})`;
}

export function summarizeEnvDiffCounts(
  current: RoutineEnvConfig | null,
  target: RoutineEnvConfig | null,
): EnvDiffCounts {
  const currentRec = normalizeEnv(current);
  const targetRec = normalizeEnv(target);
  let added = 0;
  let removed = 0;
  let changed = 0;
  const keys = new Set<string>([...Object.keys(currentRec), ...Object.keys(targetRec)]);
  for (const key of keys) {
    const inCurrent = key in currentRec;
    const inTarget = key in targetRec;
    if (inTarget && !inCurrent) {
      added += 1;
      continue;
    }
    if (!inTarget && inCurrent) {
      removed += 1;
      continue;
    }
    if (JSON.stringify(currentRec[key]) !== JSON.stringify(targetRec[key])) {
      changed += 1;
    }
  }
  return { added, removed, changed, total: added + removed + changed };
}

export function formatEnvDiffCounts(counts: EnvDiffCounts): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} ${counts.added === 1 ? "key" : "keys"} added`);
  if (counts.removed > 0) parts.push(`${counts.removed} ${counts.removed === 1 ? "key" : "keys"} removed`);
  if (counts.changed > 0) parts.push(`${counts.changed} ${counts.changed === 1 ? "key" : "keys"} changed`);
  return parts.join(", ");
}

function compareEnv(
  oldEnv: RoutineEnvConfig | null,
  newEnv: RoutineEnvConfig | null,
  secrets: SecretLookup,
  changes: RoutineFieldChange[],
) {
  const oldRec = normalizeEnv(oldEnv);
  const newRec = normalizeEnv(newEnv);
  const keys = new Set<string>([...Object.keys(oldRec), ...Object.keys(newRec)]);
  const sortedKeys = [...keys].sort();
  for (const key of sortedKeys) {
    const oldBinding = oldRec[key];
    const newBinding = newRec[key];
    const inOld = key in oldRec;
    const inNew = key in newRec;
    if (inNew && !inOld) {
      changes.push({
        field: `Env added (${key})`,
        oldValue: "—",
        newValue: describeEnvBinding(newBinding, secrets),
      });
      continue;
    }
    if (!inNew && inOld) {
      changes.push({
        field: `Env removed (${key})`,
        oldValue: describeEnvBinding(oldBinding, secrets),
        newValue: "—",
      });
      continue;
    }
    if (JSON.stringify(oldBinding) === JSON.stringify(newBinding)) continue;
    const oldKind = envBindingKind(oldBinding);
    const newKind = envBindingKind(newBinding);
    if (oldKind !== newKind) {
      changes.push({
        field: `Env ${key} binding kind`,
        oldValue: describeEnvBinding(oldBinding, secrets),
        newValue: describeEnvBinding(newBinding, secrets),
      });
      continue;
    }
    if (newKind === "secret_ref") {
      const oldRef = asSecretRef(oldBinding)!;
      const newRef = asSecretRef(newBinding)!;
      if (oldRef.secretId !== newRef.secretId) {
        changes.push({
          field: `Env ${key} secret`,
          oldValue: describeEnvBinding(oldBinding, secrets),
          newValue: describeEnvBinding(newBinding, secrets),
        });
        continue;
      }
      changes.push({
        field: `Env ${key} version`,
        oldValue: describeSecretRef(oldRef, secrets),
        newValue: describeSecretRef(newRef, secrets),
      });
      continue;
    }
    changes.push({
      field: `Env ${key} value`,
      oldValue: "plain (set)",
      newValue: "plain (changed)",
    });
  }
}

function summarizeVariables(variables: RoutineVariable[]): string {
  if (variables.length === 0) return "(none)";
  return variables.map((variable) => `${variable.name}=${formatVariableDefault(variable)}`).join(", ");
}

function compareTriggers(
  oldTriggers: RoutineRevisionSnapshotTriggerV1[],
  newTriggers: RoutineRevisionSnapshotTriggerV1[],
  changes: RoutineFieldChange[],
) {
  const byId = new Map<
    string,
    {
      old?: RoutineRevisionSnapshotTriggerV1;
      next?: RoutineRevisionSnapshotTriggerV1;
    }
  >();
  for (const trigger of oldTriggers) byId.set(trigger.id, { old: trigger });
  for (const trigger of newTriggers) {
    const existing = byId.get(trigger.id) ?? {};
    byId.set(trigger.id, { ...existing, next: trigger });
  }
  for (const [, pair] of byId) {
    if (pair.old && !pair.next) {
      changes.push({
        field: `Trigger removed (${pair.old.label ?? pair.old.kind})`,
        oldValue: summarizeTriggerSnapshot(pair.old),
        newValue: null,
      });
    } else if (!pair.old && pair.next) {
      changes.push({
        field: `Trigger added (${pair.next.label ?? pair.next.kind})`,
        oldValue: null,
        newValue: summarizeTriggerSnapshot(pair.next),
      });
    } else if (pair.old && pair.next) {
      const oldSummary = summarizeTriggerSnapshot(pair.old);
      const newSummary = summarizeTriggerSnapshot(pair.next);
      if (oldSummary !== newSummary || pair.old.enabled !== pair.next.enabled) {
        changes.push({
          field: `Trigger ${pair.next.label ?? pair.next.kind}`,
          oldValue: `${oldSummary} (${pair.old.enabled ? "enabled" : "disabled"})`,
          newValue: `${newSummary} (${pair.next.enabled ? "enabled" : "disabled"})`,
        });
      }
    }
  }
}
