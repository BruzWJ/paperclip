import type { Task } from "./types/task.js";

export type ResponsibleUserSource = "explicit" | "creator" | "none";

export interface ResponsibleUserAttribution {
  userId: string | null;
  source: ResponsibleUserSource;
  isAutoDerived: boolean;
}

export function deriveResponsibleUser(
  task: Pick<Task, "responsibleUserId" | "creatorKind" | "creatorUserId">,
): ResponsibleUserAttribution {
  if (task.responsibleUserId) {
    return { userId: task.responsibleUserId, source: "explicit", isAutoDerived: false };
  }

  if (task.creatorKind === "user/board" && task.creatorUserId) {
    return { userId: task.creatorUserId, source: "creator", isAutoDerived: true };
  }

  return { userId: null, source: "none", isAutoDerived: false };
}

/**
 * The actor to display as a task's "Originating" attribution.
 *
 * A human creator always wins (`creatorUserId`). When an agent created the
 * task but a transitive human responsible user is known, we attribute the
 * originator to that human and record the creating agent as `viaAgentId` so the
 * UI can show a "via <agent>" affordance. Agent-only creators fall back to the
 * agent, and non-human control-plane creators surface the responsible user.
 */
export type OriginatingActor =
  | { kind: "user"; id: string; viaAgentId?: string }
  | { kind: "agent"; id: string };

export function deriveOriginatingActor(
  task: Pick<
    Task,
    "creatorKind" | "creatorUserId" | "creatorAuthorityId" | "responsibleUserId"
  >,
): OriginatingActor | null {
  if (task.creatorKind === "user/board" && task.creatorUserId) {
    return { kind: "user", id: task.creatorUserId };
  }

  if (task.creatorKind === "agent-execution" && task.creatorAuthorityId) {
    if (task.responsibleUserId) {
      return {
        kind: "user",
        id: task.responsibleUserId,
        viaAgentId: task.creatorAuthorityId,
      };
    }
    return { kind: "agent", id: task.creatorAuthorityId };
  }

  if (task.responsibleUserId) {
    return { kind: "user", id: task.responsibleUserId };
  }

  return null;
}
