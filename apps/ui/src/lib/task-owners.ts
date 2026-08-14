import { deriveOriginatingActor, type Task } from "@paperclipai/shared";

export function taskOriginatorIds(task: Task) {
  const actor = deriveOriginatingActor(task);
  return {
    originatingAgentId: actor?.kind === "agent" ? actor.id : null,
    originatingUserId: actor?.kind === "user" ? actor.id : null,
    originatingViaAgentId: actor?.kind === "user" ? (actor.viaAgentId ?? null) : null,
  };
}

export function formatOwnerUserLabel(
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null,
): string | null {
  if (!userId) return null;
  if (currentUserId && userId === currentUserId) return "You";
  return formatUserLabel(userId, userLabels);
}

export function formatUserLabel(
  userId: string | null | undefined,
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null,
): string | null {
  if (!userId) return null;
  if (userLabels) {
    const label =
      userLabels instanceof Map ? userLabels.get(userId) : (userLabels as Record<string, string>)[userId];
    if (typeof label === "string" && label.trim()) return label;
  }
  return userId.slice(0, 5);
}
