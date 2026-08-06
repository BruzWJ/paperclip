import type { PluginStateScopeKind } from "@paperclipai/shared";

/** Validate and normalize one plugin data scope received across a runtime boundary. */
export function normalizePluginScopeId(
  scopeKind: PluginStateScopeKind,
  scopeId: string | undefined,
): string | null {
  if (scopeKind === "instance") {
    if (scopeId !== undefined) {
      throw new Error("instance-scoped plugin data must not include scopeId");
    }
    return null;
  }
  if (typeof scopeId !== "string" || scopeId.length === 0 || scopeId !== scopeId.trim()) {
    throw new Error(`${scopeKind}-scoped plugin data requires a canonical non-empty scopeId`);
  }
  return scopeId;
}
