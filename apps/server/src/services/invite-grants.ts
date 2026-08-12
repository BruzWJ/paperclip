import { PERMISSION_KEYS } from "@paperclipai/shared";

export function userJoinGrantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") {
    throw new Error("User invite defaults are missing");
  }
  const scoped = defaultsPayload.user;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    throw new Error("User invite defaults are missing grants");
  }
  const rawGrants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(rawGrants)) {
    throw new Error("User invite grants must be an array");
  }
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const grants: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of rawGrants) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("User invite grants contain an invalid entry");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.permissionKey !== "string" ||
      !validPermissionKeys.has(record.permissionKey)
    ) {
      throw new Error("User invite grants contain an invalid entry");
    }
    if (
      record.scope !== undefined &&
      record.scope !== null &&
      (typeof record.scope !== "object" || Array.isArray(record.scope))
    ) {
      throw new Error("User invite grants contain an invalid entry");
    }
    grants.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        (record.scope as Record<string, unknown> | null | undefined) ?? null,
    });
  }
  return grants;
}
