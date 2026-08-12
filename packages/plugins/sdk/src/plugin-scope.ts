import { isCanonicalUuid, type PluginStateScopeKind } from "@paperclipai/shared";

/** Validate and return one exact plugin data scope received across a runtime boundary. */
export function requireExactPluginScopeId(
  scopeKind: PluginStateScopeKind,
  scopeId: string | undefined,
): string | null {
  if (scopeKind === "instance") {
    if (scopeId !== undefined) {
      throw new Error("instance-scoped plugin data must not include scopeId");
    }
    return null;
  }
  if (!isCanonicalUuid(scopeId)) {
    throw new Error(
      `${scopeKind}-scoped plugin data requires an exact canonical UUID scopeId`,
    );
  }
  return scopeId;
}
