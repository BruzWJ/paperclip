import type { EnvBinding } from "@paperclipai/shared";
import type { EnvironmentVariableDirtyFields } from "./-Row";
import type { EnvRow } from "./-model";

export const DEFAULT_RESERVED_PREFIXES = ["PAPERCLIP_"];

export const DEFAULT_HINT =
  "Set the KEY to the env var name the process expects, for example GH_TOKEN. Choose a secret to resolve a stored value at run start. PAPERCLIP_* variables are injected automatically.";

export function normalizedEnvEntries(
  value: Record<string, EnvBinding> | null | undefined,
): Array<[string, Record<string, unknown>]> {
  if (!value || typeof value !== "object") return [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const [rawName, binding] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name) continue;
    if (binding.type === "secret_ref") {
      const secretId = typeof binding.secretId === "string" ? binding.secretId : "";
      if (!secretId) continue;
      byName.set(name, {
        type: "secret_ref",
        secretId,
        version: typeof binding.version === "number" ? binding.version : "latest",
      });
    } else if (binding.type === "user_secret_ref") {
      const key = typeof binding.key === "string" ? binding.key.trim() : "";
      if (!key) continue;
      byName.set(name, {
        type: "user_secret_ref",
        key,
        version: typeof binding.version === "number" ? binding.version : "latest",
        required: binding.required !== false,
      });
    } else if (binding.type === "plain") {
      byName.set(name, {
        type: "plain",
        value: typeof binding.value === "string" ? binding.value : "",
      });
    }
  }
  return [...byName.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function normalizedEnvKey(value: Record<string, EnvBinding> | null | undefined): string {
  return JSON.stringify(normalizedEnvEntries(value));
}

const CHANGE_SUMMARY_MAX_NAMES = 3;

export function formatChangedNames(names: readonly string[]): string {
  const shown = names.slice(0, CHANGE_SUMMARY_MAX_NAMES).join(", ");
  return names.length > CHANGE_SUMMARY_MAX_NAMES
    ? `${shown} +${names.length - CHANGE_SUMMARY_MAX_NAMES} more`
    : shown;
}

export function cloneRows(rows: readonly EnvRow[]): EnvRow[] {
  return rows.map((row) => ({ ...row }));
}

export function rowDirtyFields(
  row: EnvRow,
  committedRow: EnvRow | undefined,
): EnvironmentVariableDirtyFields {
  if (!committedRow) {
    return {
      name: Boolean(row.name.trim()),
      value:
        row.source !== "text" || Boolean(row.textValue) || Boolean(row.secretId) || row.version !== "latest",
    };
  }

  return {
    name: row.name.trim() !== committedRow.name.trim(),
    value:
      row.source !== committedRow.source ||
      row.textValue !== committedRow.textValue ||
      row.secretId !== committedRow.secretId ||
      row.userSecretKey !== committedRow.userSecretKey ||
      row.required !== committedRow.required ||
      row.version !== committedRow.version,
  };
}
