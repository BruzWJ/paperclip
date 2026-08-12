import { isCanonicalUuid } from "@paperclipai/shared";

export function parseExactCanonicalUuidList(
  value: string | undefined,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",");
  if (
    ids.length === 0
    || ids.some((id) => !isCanonicalUuid(id))
    || new Set(ids).size !== ids.length
  ) {
    throw new Error(`${label} must be a non-empty, duplicate-free list of exact canonical UUIDs.`);
  }
  return ids;
}
